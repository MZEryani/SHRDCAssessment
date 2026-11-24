#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ORCHESTRATOR_CANDIDATES,
  DEFAULT_WORKER_CANDIDATES,
  createLineSplitter,
  inspectNdjsonRetryLine,
  probeModelPair,
  probeSingleModel,
} from './opencode-runner.mjs'

export {
  DEFAULT_ORCHESTRATOR_CANDIDATES,
  DEFAULT_WORKER_CANDIDATES,
  createLineSplitter,
  inspectNdjsonRetryLine,
  probeModelPair,
  probeSingleModel,
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const timeoutIdx = args.indexOf('--timeout-ms')
  const timeoutMs = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 12000

  probeModelPair({ timeoutMs })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
