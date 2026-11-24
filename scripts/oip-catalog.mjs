import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * Load OIP's live part catalog JSON via `npm --prefix Open-Industry-Project run catalog -- --json`.
 */
export function loadOipCatalog({ repoRoot = REPO_ROOT } = {}) {
  const oipDir = join(repoRoot, 'Open-Industry-Project')
  const raw = execFileSync(NPM_CMD, ['run', 'catalog', '--', '--json'], {
    cwd: oipDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const start = raw.indexOf('{')
  if (start < 0) {
    throw new Error(`OIP catalog CLI did not return JSON output: ${raw.slice(0, 200)}`)
  }
  return JSON.parse(raw.slice(start))
}

/**
 * Format a compact, prompt-friendly summary of OIP parts and their Modbus-mappable signals.
 */
export function formatCatalogSummary(catalog) {
  const parts = Array.isArray(catalog?.parts) ? catalog.parts : []
  return parts
    .map((p) => {
      const sigs = (p.signals ?? []).map((s) => `${s.name}(${s.dir}:${s.type})`).join(', ')
      return `- ${p.id} (${p.name}): ${sigs || 'no PLC signals (structural/cargo)'}`
    })
    .join('\n')
}
