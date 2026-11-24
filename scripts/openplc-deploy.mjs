#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgramZip, resolveStrucppBin } from './plc-bundle.mjs'
import { OpenPlcClient, deployBundle } from './openplc-runtime.mjs'

export { OpenPlcClient, buildProgramZip, deployBundle, resolveStrucppBin }

/**
 * Compile an IEC 61131-3 program with STruC++ and deploy the resulting bundle to OpenPLC Runtime.
 */
export async function deployProgram({
  stPath,
  modbusMasterPath,
  runtimeUrl,
  username,
  password,
  startAfterDeploy = true,
  client,
  pollIntervals,
}) {
  const { zipBuffer, md5 } = buildProgramZip({ stPath, modbusMasterPath })
  return deployBundle({
    zipBuffer,
    md5,
    runtimeUrl,
    username,
    password,
    startAfterDeploy,
    client,
    pollIntervals,
  })
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
