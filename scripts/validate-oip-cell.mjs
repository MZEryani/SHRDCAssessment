#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OIP_DIR = join(REPO_ROOT, 'Open-Industry-Project')
const CELL_DIR = join(REPO_ROOT, 'scenes', 'conveyor-cell')
const CONTRACT_PATH = join(REPO_ROOT, 'openplc', 'io-contract.json')

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
const scene = JSON.parse(readFileSync(join(CELL_DIR, 'scene.json'), 'utf8'))

// 1. Verify every signal in io-contract.json is wired 1:1 in scene.json
const sceneTags = new Set()
for (const part of scene.parts) {
  for (const [key, val] of Object.entries(part.params ?? {})) {
    if (key.endsWith('Tag') || key === 'tag') {
      if (typeof val === 'string' && val.length > 0) sceneTags.add(val)
    }
  }
}

const contractAddresses = contract.signals.map((s) => s.iecAddress)
const missing = contractAddresses.filter((addr) => !sceneTags.has(addr))
const extra = [...sceneTags].filter((addr) => !contractAddresses.includes(addr))
if (missing.length > 0 || extra.length > 0) {
  console.error('I/O Contract mismatch between openplc/io-contract.json and scenes/conveyor-cell/scene.json:')
  if (missing.length > 0) console.error('  Missing in scene.json:', missing.join(', '))
  if (extra.length > 0) console.error('  Unexpected in scene.json:', extra.join(', '))
  process.exit(1)
}
console.log(`✓ I/O Contract 1:1 match: ${contractAddresses.length} signals verified`)

// 2. Verify scenes/conveyor-cell/plc/program.st stays identical to openplc/conveyor_cell.st
const canonicalSt = readFileSync(join(REPO_ROOT, 'openplc', 'conveyor_cell.st'), 'utf8')
const sceneSt = readFileSync(join(CELL_DIR, 'plc', 'program.st'), 'utf8')
if (canonicalSt !== sceneSt) {
  console.error('ST drift detected: scenes/conveyor-cell/plc/program.st differs from openplc/conveyor_cell.st')
  process.exit(1)
}
console.log('✓ ST parity verified: scenes/conveyor-cell/plc/program.st matches openplc/conveyor_cell.st')

// 3. Run OIP's own strict CLI validators
for (const script of [
  ['run', 'validate-project', '--', CELL_DIR, '--strict'],
  ['run', 'check-st', '--', CELL_DIR],
  ['run', 'check-wiring', '--', CELL_DIR, '--strict'],
  ['run', 'check-layout', '--', CELL_DIR, '--strict'],
]) {
  execFileSync('npm', script, { cwd: OIP_DIR, stdio: 'inherit' })
}
