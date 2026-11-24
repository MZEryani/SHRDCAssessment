#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deployProgram } from './openplc-deploy.mjs'
import { resolveCellPaths } from './verify-cell.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function defaultLaunchDesktop({ cellDir, repoRoot = REPO_ROOT }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      NPX_CMD,
      [
        '--prefix',
        'Open-Industry-Project/apps/desktop',
        'electron',
        'Open-Industry-Project/apps/desktop',
        cellDir,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, OIP_DESKTOP_PROD: '1' },
      },
    )
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0 || code === null) resolvePromise()
      else reject(new Error(`OIP Desktop exited with code ${code}`))
    })
  })
}

export async function runCell({
  slug,
  repoRoot = REPO_ROOT,
  deployOnly = false,
  openOnly = false,
  runtimeUrl = process.env.OPENPLC_URL || 'https://127.0.0.1:8443',
  oipModbusHost = process.env.OIP_MODBUS_HOST || undefined,
  deploy = deployProgram,
  launchDesktop = defaultLaunchDesktop,
  pollIntervals,
  log = console.log,
} = {}) {
  if (deployOnly && openOnly) {
    throw new Error('Cannot combine --deploy-only and --open-only')
  }
  const paths = resolveCellPaths({ repoRoot, slug })
  if (!existsSync(paths.cellDir)) {
    throw new Error(`Cell directory not found: ${paths.cellDir}`)
  }

  let deployed = null
  if (!openOnly) {
    if (!existsSync(paths.stPath)) {
      throw new Error(`Missing PLC program for Cell "${slug}": ${paths.stPath}`)
    }
    if (!existsSync(paths.modbusMasterPath)) {
      throw new Error(`Missing Modbus master config for Cell "${slug}": ${paths.modbusMasterPath}`)
    }

    log(
      `[cell:run:${slug}] Deploying ${paths.stPath} to OpenPLC (${runtimeUrl})${oipModbusHost ? ` with OIP_MODBUS_HOST=${oipModbusHost}` : ''}...`,
    )
    deployed = await deploy({
      stPath: paths.stPath,
      modbusMasterPath: paths.modbusMasterPath,
      runtimeUrl,
      oipModbusHost,
      startAfterDeploy: true,
      pollIntervals,
    })
    log(
      `✓ [${slug}] Deployed to OpenPLC ${deployed.version}: compile=${deployed.compilationStatus}, status=${deployed.plcStatus}`,
    )
  }

  let launched = false
  if (!deployOnly) {
    log(`[cell:run:${slug}] Launching OIP Desktop on ${paths.cellDir}...`)
    await launchDesktop({ cellDir: paths.cellDir, repoRoot })
    launched = true
  }

  return {
    slug,
    cellDir: paths.cellDir,
    runtimeUrl,
    oipModbusHost: oipModbusHost ?? null,
    deployed,
    launched,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const slug = args.find((a) => !a.startsWith('--'))
  if (!slug) {
    console.error('Usage: npm run cell:run -- <cell-slug> [--deploy-only | --open-only]')
    process.exit(2)
  }
  runCell({
    slug,
    deployOnly: args.includes('--deploy-only'),
    openOnly: args.includes('--open-only'),
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
