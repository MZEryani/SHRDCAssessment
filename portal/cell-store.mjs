import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

export function createCellStore({ repoRoot }) {
  function resolveCellEntry(slug) {
    if (!isValidCellSlug(slug)) {
      return { error: 'Invalid Cell slug', status: 400 }
    }

    if (slug !== PROTECTED_CELL_SLUG) {
      return { error: `Cell "${slug}" not found`, status: 404 }
    }

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

  function getCellDetails(slug) {
    const entry = resolveCellEntry(slug)
    if (entry.error) return entry

    const stSource = existsSync(entry.stPath) ? readFileSync(entry.stPath, 'utf8') : ''
    const ioContract = existsSync(entry.contractPath)
      ? JSON.parse(readFileSync(entry.contractPath, 'utf8'))
      : null
    const specPath = join(repoRoot, 'docs', 'cell-process-spec.md')
    const processSpec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : ''

    return {
      slug: entry.slug,
      protected: entry.protected,
      stSource,
      ioContract,
      processSpec,
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

  return {
    resolveCellEntry,
    getCellDetails,
    readOipFolderBundle,
  }
}
