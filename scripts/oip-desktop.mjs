#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const child = spawn(
  NPX_CMD,
  [
    '--prefix',
    'Open-Industry-Project/apps/desktop',
    'electron',
    'Open-Industry-Project/apps/desktop',
    'scenes/conveyor-cell',
  ],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, OIP_DESKTOP_PROD: '1' },
  },
)

child.on('exit', (code) => process.exit(code ?? 0))
