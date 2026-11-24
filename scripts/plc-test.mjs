#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveStrucppBin } from './plc-bundle.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strucppBin = resolveStrucppBin()
const stPath = join(REPO_ROOT, 'scenes', 'conveyor-cell', 'plc', 'program.st')
const testPath = join(REPO_ROOT, 'tests', 'conveyor_cell.test.st')

execFileSync(strucppBin, [stPath, '--test', testPath], { cwd: REPO_ROOT, stdio: 'inherit' })
