#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConformance } from './io-contract.mjs'
import { resolveStrucppBin } from './plc-bundle.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const SLUG_RX = /^[a-z0-9][a-z0-9_-]*$/

export function resolveCellPaths({ repoRoot = REPO_ROOT, slug }) {
  if (typeof slug !== 'string' || !SLUG_RX.test(slug)) {
    throw new Error(`Invalid Cell slug "${slug}". Use lowercase letters, digits, hyphens, or underscores.`)
  }

  const cellDir = join(repoRoot, 'scenes', slug)
  const selfContainedContract = join(cellDir, 'io-contract.json')
  const isLegacyConveyor = slug === 'conveyor-cell' && !existsSync(selfContainedContract)

  return {
    slug,
    cellDir,
    oipDir: join(repoRoot, 'Open-Industry-Project'),
    contractPath: isLegacyConveyor ? join(repoRoot, 'openplc', 'io-contract.json') : selfContainedContract,
    modbusMasterPath: isLegacyConveyor
      ? join(repoRoot, 'openplc', 'conveyor_cell_modbus_master.json')
      : join(cellDir, 'plc', 'modbus_master.json'),
    stPath: join(cellDir, 'plc', 'program.st'),
    scenePath: join(cellDir, 'scene.json'),
    testPath: isLegacyConveyor
      ? join(repoRoot, 'tests', 'conveyor_cell.test.st')
      : join(cellDir, 'tests', 'program.test.st'),
  }
}

function formatExecError(err) {
  return String(err.stderr || err.stdout || err.message).trim().slice(-600)
}

function defaultRunPlcTest({ stPath, testPath, repoRoot }) {
  if (!existsSync(testPath)) {
    return { passed: false, summary: `Missing PLC test file: ${testPath}` }
  }
  const strucppBin = resolveStrucppBin()
  try {
    const out = execFileSync(strucppBin, [stPath, '--test', testPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { passed: true, summary: out.trim().split('\n').slice(-6).join('\n') }
  } catch (err) {
    return {
      passed: false,
      summary: formatExecError(err),
    }
  }
}

export function extractLayoutWarnings(rawStdout) {
  const start = rawStdout.indexOf('{')
  if (start < 0) return []
  try {
    const parsed = JSON.parse(rawStdout.slice(start))
    const warnings = []
    for (const proj of parsed.projects ?? []) {
      for (const f of proj.findings ?? []) {
        if (f?.severity === 'warning') {
          const prefix = f.partId ? `${f.partId}: ` : ''
          warnings.push(`${prefix}${f.detail || f.kind || JSON.stringify(f)}`)
        }
      }
    }
    return warnings
  } catch {
    return []
  }
}

function defaultRunOipValidators({ oipDir, cellDir }) {
  const strictSteps = [
    ['run', 'validate-project', '--', cellDir, '--strict'],
    ['run', 'check-st', '--', cellDir],
    ['run', 'check-wiring', '--', cellDir, '--strict'],
  ]

  for (const args of strictSteps) {
    try {
      execFileSync(NPM_CMD, args, { cwd: oipDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return {
        passed: false,
        warnings: [],
        summary: `${args[1]} failed:\n${formatExecError(err)}`,
      }
    }
  }

  // Pragmatic layout bar: check-layout without --strict fails on errors (exit 1)
  // while surfacing non-fatal warnings without failing the gate.
  try {
    const out = execFileSync(NPM_CMD, ['run', 'check-layout', '--', cellDir, '--json'], {
      cwd: oipDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const warnings = extractLayoutWarnings(out)
    return {
      passed: true,
      warnings,
      summary: warnings.length > 0 ? `passed with ${warnings.length} layout warning(s)` : 'passed',
    }
  } catch (err) {
    return {
      passed: false,
      warnings: [],
      summary: `check-layout failed:\n${formatExecError(err)}`,
    }
  }
}

export function verifyCell({
  slug,
  repoRoot = REPO_ROOT,
  runPlcTest = defaultRunPlcTest,
  runOipValidators = defaultRunOipValidators,
  log = console.log,
  error = console.error,
} = {}) {
  const paths = resolveCellPaths({ repoRoot, slug })

  for (const [label, p] of [
    ['io-contract.json', paths.contractPath],
    ['program.st', paths.stPath],
    ['modbus_master.json', paths.modbusMasterPath],
    ['scene.json', paths.scenePath],
  ]) {
    if (!existsSync(p)) {
      const msg = `Missing required Cell artifact ${label} at ${p}`
      error(msg)
      return {
        ok: false,
        slug,
        gates: {
          contract: { passed: false, problems: [{ artifact: label, message: msg }] },
          plcTest: { passed: false, skipped: true, summary: 'Skipped due to missing artifact' },
          oipValidate: { passed: false, skipped: true, summary: 'Skipped due to missing artifact' },
        },
        warnings: [],
      }
    }
  }

  const contract = JSON.parse(readFileSync(paths.contractPath, 'utf8'))
  const stSource = readFileSync(paths.stPath, 'utf8')
  const modbusMaster = JSON.parse(readFileSync(paths.modbusMasterPath, 'utf8'))
  const scene = JSON.parse(readFileSync(paths.scenePath, 'utf8'))

  // Gate 1: Canonical I/O Contract conformance
  const problems = checkConformance({ contract, stSource, modbusMaster, scene })
  if (problems.length > 0) {
    error(`✗ [${slug}] I/O Contract conformance failed:`)
    for (const { artifact, message } of problems) {
      error(`  [${artifact}] ${message}`)
    }
    return {
      ok: false,
      slug,
      gates: {
        contract: { passed: false, problems },
        plcTest: { passed: false, skipped: true, summary: 'Skipped until contract conformance passes' },
        oipValidate: { passed: false, skipped: true, summary: 'Skipped until contract conformance passes' },
      },
      warnings: [],
    }
  }
  log(`✓ [${slug}] Gate 1 — I/O Contract conformance (${contract.signals.length} signals)`)

  // Gate 2: STruC++ compilation & PLC unit tests
  const plcTest = runPlcTest({ stPath: paths.stPath, testPath: paths.testPath, repoRoot })
  if (plcTest.passed) {
    log(`✓ [${slug}] Gate 2 — STruC++ PLC unit tests`)
  } else {
    error(`✗ [${slug}] Gate 2 — STruC++ PLC unit tests failed:\n${plcTest.summary}`)
  }

  // Gate 3: OIP strict validators + pragmatic layout check
  const oipValidate = runOipValidators({ oipDir: paths.oipDir, cellDir: paths.cellDir })
  const warnings = oipValidate.warnings ?? []
  if (oipValidate.passed) {
    log(
      `✓ [${slug}] Gate 3 — OIP validators${warnings.length > 0 ? ` (${warnings.length} layout warning(s))` : ''}`,
    )
    for (const w of warnings) {
      log(`  ⚠ layout warning: ${w}`)
    }
  } else {
    error(`✗ [${slug}] Gate 3 — OIP validators failed:\n${oipValidate.summary}`)
  }

  const ok = plcTest.passed && oipValidate.passed
  return {
    ok,
    slug,
    gates: {
      contract: { passed: true, problems: [] },
      plcTest,
      oipValidate,
    },
    warnings,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const slug = process.argv[2]
  if (!slug) {
    console.error('Usage: npm run cell:verify -- <cell-slug>')
    process.exit(2)
  }
  const result = verifyCell({ slug })
  if (!result.ok) process.exit(1)
}
