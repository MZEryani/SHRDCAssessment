#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgramZip, resolveStrucppBin } from './plc-bundle.mjs'
import { OpenPlcClient, deployBundle } from './openplc-runtime.mjs'

export { OpenPlcClient, buildProgramZip, deployBundle, resolveStrucppBin }

function prepareModbusOverride(modbusMasterPath, oipModbusHost) {
  if (!oipModbusHost || !modbusMasterPath) {
    return { path: modbusMasterPath, cleanup: () => {} }
  }
  const parsed = JSON.parse(readFileSync(modbusMasterPath, 'utf8'))
  const mutated = parsed.map((entry) =>
    entry?.config ? { ...entry, config: { ...entry.config, host: oipModbusHost } } : entry,
  )
  const tempDir = mkdtempSync(join(tmpdir(), 'openplc-modbus-'))
  const tempPath = join(tempDir, 'modbus_master.json')
  writeFileSync(tempPath, `${JSON.stringify(mutated, null, 2)}\n`, 'utf8')
  return {
    path: tempPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

/**
 * Compile an IEC 61131-3 program with STruC++ and deploy the resulting bundle to OpenPLC Runtime.
 */
export async function deployProgram({
  stPath,
  modbusMasterPath,
  runtimeUrl,
  oipModbusHost = process.env.OIP_MODBUS_HOST || undefined,
  username,
  password,
  startAfterDeploy = true,
  client,
  pollIntervals,
}) {
  const modbusCfg = prepareModbusOverride(modbusMasterPath, oipModbusHost)
  try {
    const { zipBuffer, md5 } = buildProgramZip({ stPath, modbusMasterPath: modbusCfg.path })
    return await deployBundle({
      zipBuffer,
      md5,
      runtimeUrl,
      username,
      password,
      startAfterDeploy,
      client,
      pollIntervals,
    })
  } finally {
    modbusCfg.cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stPath, modbusMasterPath] = process.argv.slice(2)
  if (!stPath) {
    console.error('Usage: node scripts/openplc-deploy.mjs <program.st> [modbus_master.json]')
    process.exit(1)
  }
  deployProgram({ stPath, modbusMasterPath, startAfterDeploy: true })
    .then((res) => {
      console.log(
        `Deployed ${stPath} (md5=${res.md5.slice(0, 8)}) to OpenPLC ${res.version}: compile=${res.compilationStatus}, status=${res.plcStatus}`,
      )
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
