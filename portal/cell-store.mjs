import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveCellPaths } from '../scripts/verify-cell.mjs'

export const PROTECTED_CELL_SLUG = 'conveyor-cell'
const SLUG_RX = /^[a-z0-9][a-z0-9_-]*$/
const ROOT_FILES = ['project.json', 'scene.json', 'program.st']
const SUBDIRS = ['plc', 'scenes', 'parts', 'tests', 'assemblies']
const TEXT_EXTENSIONS = ['.json', '.st', '.ld', '.js']
const MAX_DEPTH = 3

export function isValidCellSlug(slug) {
  return typeof slug === 'string' && SLUG_RX.test(slug) && slug.length <= 64
}

function isTextFile(name) {
  const lower = name.toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function isAssetFile(rel) {
  return /(^|\/)assets\/[0-9a-f]{64}\.[a-z0-9]+$/.test(rel)
}

function walkOipProjectFolder(rootDir) {
  const files = []
  const sigHash = createHash('sha256')

  const visit = (rel, abs) => {
    const raw = readFileSync(abs)
    sigHash.update(rel)
    sigHash.update('\0')
    sigHash.update(raw)
    sigHash.update('\0')

    if (isAssetFile(rel)) {
      files.push({
        path: rel,
        encoding: 'base64',
        contents: raw.toString('base64'),
      })
    } else {
      files.push({
        path: rel,
        encoding: 'utf8',
        contents: raw.toString('utf8'),
      })
    }
  }

  for (const name of ROOT_FILES) {
    const abs = join(rootDir, name)
    if (existsSync(abs) && statSync(abs).isFile()) {
      visit(name, abs)
    }
  }

  const walk = (dir, rel, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const childAbs = join(dir, entry.name)
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(childAbs, childRel, depth + 1)
      } else if (entry.isFile() && (isTextFile(entry.name) || isAssetFile(childRel))) {
        visit(childRel, childAbs)
      }
    }
  }

  for (const sub of SUBDIRS) {
    walk(join(rootDir, sub), sub, 1)
  }

  return {
    files,
    signature: sigHash.digest('hex').slice(0, 16),
  }
}

export function createCellStore({ repoRoot, generatedCellsDir = null }) {
  const resolvedGenDir = generatedCellsDir ? resolve(generatedCellsDir) : null

  function resolveGeneratedDir(slug) {
    if (!resolvedGenDir) return null
    const candidate = resolve(resolvedGenDir, slug)
    if (!candidate.startsWith(`${resolvedGenDir}/`)) return null
    return candidate
  }

  function resolveCellEntry(slug) {
    if (!isValidCellSlug(slug)) {
      return { error: 'Invalid Cell slug', status: 400 }
    }

    if (slug === PROTECTED_CELL_SLUG) {
      const paths = resolveCellPaths({ repoRoot: resolve(repoRoot), slug: PROTECTED_CELL_SLUG })
      if (!existsSync(paths.cellDir)) {
        return { error: `Cell "${slug}" not found`, status: 404 }
      }
      return {
        slug,
        protected: true,
        ...paths,
      }
    }

    const genDir = resolveGeneratedDir(slug)
    if (genDir && existsSync(join(genDir, 'project.json'))) {
      return {
        slug,
        protected: false,
        cellDir: genDir,
        contractPath: join(genDir, 'io-contract.json'),
        stPath: join(genDir, 'plc', 'program.st'),
        modbusMasterPath: join(genDir, 'plc', 'modbus_master.json'),
        scenePath: join(genDir, 'scene.json'),
        testPath: join(genDir, 'tests', 'program.test.st'),
        processSpecPath: join(genDir, 'process-spec.md'),
        reportJsonPath: join(genDir, 'generation-report.json'),
      }
    }

    return { error: `Cell "${slug}" not found`, status: 404 }
  }

  function summarizeCell(entry) {
    let signalCount = 0
    try {
      const contract = JSON.parse(readFileSync(entry.contractPath, 'utf8'))
      signalCount = Array.isArray(contract.signals) ? contract.signals.length : 0
    } catch {
      // Optional metadata
    }

    let report = null
    if (entry.reportJsonPath && existsSync(entry.reportJsonPath)) {
      try {
        report = JSON.parse(readFileSync(entry.reportJsonPath, 'utf8'))
      } catch {
        // Ignore malformed report
      }
    }

    let description = ''
    if (entry.slug === PROTECTED_CELL_SLUG) {
      description =
        'Photo-Eye-gated 5-box Batch conveyor with 2s Inspection Dwell, Jam Fault, and fail-safe NC E-Stop.'
    } else if (entry.processSpecPath && existsSync(entry.processSpecPath)) {
      description =
        readFileSync(entry.processSpecPath, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('#')) ?? ''
    }

    return {
      slug: entry.slug,
      protected: entry.protected,
      signalCount,
      description,
      capturedAt: report?.capturedAt ?? null,
      costUsd: report?.totals?.costUsd ?? null,
      wallTimeMs: report?.totals?.durationMs ?? null,
    }
  }

  function listCells() {
    const items = []
    const refEntry = resolveCellEntry(PROTECTED_CELL_SLUG)
    if (!refEntry.error) {
      items.push(summarizeCell(refEntry))
    }

    if (resolvedGenDir && existsSync(resolvedGenDir)) {
      const entries = readdirSync(resolvedGenDir, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const dirent of entries) {
        if (!dirent.isDirectory()) continue
        const slug = dirent.name
        if (slug === PROTECTED_CELL_SLUG || !isValidCellSlug(slug)) continue
        const entry = resolveCellEntry(slug)
        if (!entry.error) items.push(summarizeCell(entry))
      }
    }

    return items
  }

  function getCellDetails(slug) {
    const entry = resolveCellEntry(slug)
    if (entry.error) return entry

    const stSource = existsSync(entry.stPath) ? readFileSync(entry.stPath, 'utf8') : ''
    let ioContract = null
    if (existsSync(entry.contractPath)) {
      try {
        ioContract = JSON.parse(readFileSync(entry.contractPath, 'utf8'))
      } catch {
        ioContract = null
      }
    }
    const specPath =
      slug === PROTECTED_CELL_SLUG
        ? join(repoRoot, 'docs', 'cell-process-spec.md')
        : entry.processSpecPath
    const processSpec = specPath && existsSync(specPath) ? readFileSync(specPath, 'utf8') : ''
    let generationReport = null
    if (entry.reportJsonPath && existsSync(entry.reportJsonPath)) {
      try {
        generationReport = JSON.parse(readFileSync(entry.reportJsonPath, 'utf8'))
      } catch {
        // Optional
      }
    }

    return {
      slug: entry.slug,
      protected: entry.protected,
      stSource,
      ioContract,
      processSpec,
      generationReport,
    }
  }

  function readOipFolderBundle(slug) {
    const entry = resolveCellEntry(slug)
    if (entry.error) return entry
    const { files, signature } = walkOipProjectFolder(entry.cellDir)
    return {
      slug: entry.slug,
      root: `ec2://scenes/${entry.slug}`,
      docId: `ec2-cell-${entry.slug}`,
      signature,
      files,
    }
  }

  function deleteCell(slug) {
    if (!isValidCellSlug(slug)) {
      return { error: 'Invalid Cell slug', status: 400 }
    }
    if (slug === PROTECTED_CELL_SLUG) {
      return { error: `Protected reference Cell "${PROTECTED_CELL_SLUG}" cannot be deleted`, status: 403 }
    }
    const genDir = resolveGeneratedDir(slug)
    if (!genDir || !existsSync(genDir)) {
      return { error: `Cell "${slug}" not found`, status: 404 }
    }
    rmSync(genDir, { recursive: true, force: true })
    return { ok: true, deleted: slug }
  }

  function ensureGeneratedCellsDir() {
    if (resolvedGenDir) mkdirSync(resolvedGenDir, { recursive: true })
    return resolvedGenDir
  }

  return {
    generatedCellsDir: resolvedGenDir,
    ensureGeneratedCellsDir,
    resolveCellEntry,
    listCells,
    getCellDetails,
    readOipFolderBundle,
    deleteCell,
  }
}
