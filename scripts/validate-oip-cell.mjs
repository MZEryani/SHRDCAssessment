#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConformance } from './io-contract.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function runStrictOipValidators({ oipDir, cellDir }) {
  for (const script of [
    ['run', 'validate-project', '--', cellDir, '--strict'],
    ['run', 'check-st', '--', cellDir],
    ['run', 'check-wiring', '--', cellDir, '--strict'],
    ['run', 'check-layout', '--', cellDir, '--strict'],
  ]) {
    execFileSync(NPM_CMD, script, { cwd: oipDir, stdio: 'inherit' })
  }
}

export function validateOipCell({
  repoRoot = REPO_ROOT,
  runOipValidators = runStrictOipValidators,
  log = console.log,
  error = console.error,
} = {}) {
  const oipDir = join(repoRoot, 'Open-Industry-Project')
  const cellDir = join(repoRoot, 'scenes', 'conveyor-cell')
  const contract = JSON.parse(readFileSync(join(repoRoot, 'openplc', 'io-contract.json'), 'utf8'))
  const stSource = readFileSync(join(cellDir, 'plc', 'program.st'), 'utf8')
  const modbusMaster = JSON.parse(
    readFileSync(join(repoRoot, 'openplc', 'conveyor_cell_modbus_master.json'), 'utf8'),
  )
  const scene = JSON.parse(readFileSync(join(cellDir, 'scene.json'), 'utf8'))

  // 1. Run role-aware I/O Contract conformance across ST, Modbus master, and OIP scene
  const problems = checkConformance({ contract, stSource, modbusMaster, scene })
  if (problems.length > 0) {
    error('I/O Contract conformance check failed:')
    for (const { artifact, message } of problems) {
      error(`  [${artifact}] ${message}`)
    }
    return { ok: false, problems }
  }
  log(
    `✓ I/O Contract conformance verified: ${contract.signals.length} signals across ST, Modbus master, and OIP scene`,
  )

  // 2. Run OIP's own strict CLI validators
  runOipValidators({ oipDir, cellDir })
  return { ok: true, problems: [] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateOipCell()
  if (!result.ok) process.exit(1)
}
