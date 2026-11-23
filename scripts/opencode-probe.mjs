#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_ORCHESTRATOR_CANDIDATES = [
  'google/gemini-4-neon',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview',
]

export const DEFAULT_WORKER_CANDIDATES = [
  'google/gemini-3.8-flash',
  'google/gemini-3-flash-preview',
  'google/gemini-flash-lite-latest',
]

export function inspectNdjsonRetryLine(rawLine, { maxRetryAttempts = 2 } = {}) {
  const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (!line.startsWith('{')) return null
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event.type !== 'retry') return null
  const status = event.error?.status
  if (event.attempt > maxRetryAttempts && (status === 429 || status === 503)) {
    const msg = event.error?.message ?? 'upstream capacity/quota failure'
    return `Fail-fast abort on HTTP ${status} retry attempt ${event.attempt}: ${msg}`
  }
  return null
}

export function createLineSplitter(onLine) {
  let pending = ''
  return {
    push(chunk) {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    },
    flush() {
      if (pending.length > 0) {
        onLine(pending)
        pending = ''
      }
    },
  }
}

export function probeSingleModel(
  model,
  { timeoutMs = 12000, cwd = REPO_ROOT, spawnFn = spawn } = {},
) {
  return new Promise((resolvePromise) => {
    const startMs = performance.now()
    const child = spawnFn(
      'opencode',
      ['run', '--standalone', '--auto', '--archived', '--format', 'json', '-m', model, 'Reply READY'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let settled = false
    let stdoutBuf = ''
    let stderrBuf = ''

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!child.killed) child.kill('SIGTERM')
      resolvePromise({
        model,
        durationMs: Math.round(performance.now() - startMs),
        ...result,
      })
    }

    const timer = setTimeout(() => {
      finish({ ok: false, reason: `Timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    const splitter = createLineSplitter((rawLine) => {
      const retryAbort = inspectNdjsonRetryLine(rawLine, { maxRetryAttempts: 1 })
      if (retryAbort) {
        finish({ ok: false, reason: retryAbort.slice(0, 180) })
        return
      }
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim()
      if (!line.startsWith('{')) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'error' && event.error) {
        const status = event.error.status ? `HTTP ${event.error.status} ` : ''
        finish({ ok: false, reason: `${status}${event.error.message ?? 'provider failure'}`.slice(0, 180) })
      }
    })

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdoutBuf += text
      splitter.push(text)
    })
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8')
    })
    child.on('error', (err) => finish({ ok: false, reason: err.message }))
    child.on('close', (code) => {
      splitter.flush()
      if (code === 0 && stdoutBuf.includes('"step_finish"')) {
        finish({ ok: true })
      } else {
        finish({ ok: false, reason: (stderrBuf.trim() || `Exited with code ${code}`).slice(0, 180) })
      }
    })
  })
}

async function pickFirstLive(candidates, tier, { timeoutMs, probeFn, attempts, exclude }) {
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]
    if (exclude && model === exclude && candidates.length > 1) continue
    const res = await probeFn(model, { timeoutMs })
    attempts.push({ tier, model, ok: res.ok, durationMs: res.durationMs, reason: res.reason ?? null })
    if (res.ok) return { model, fallbackUsed: i > 0 }
  }
  return null
}

export async function probeModelPair({
  orchestratorCandidates = DEFAULT_ORCHESTRATOR_CANDIDATES,
  workerCandidates = DEFAULT_WORKER_CANDIDATES,
  timeoutMs = 12000,
  probeFn = probeSingleModel,
} = {}) {
  const attempts = []
  const orch = await pickFirstLive(orchestratorCandidates, 'orchestrator', {
    timeoutMs,
    probeFn,
    attempts,
  })
  if (!orch) {
    return { ok: false, orchestratorModel: null, workerModel: null, fallbackUsed: false, attempts }
  }

  let worker = await pickFirstLive(workerCandidates, 'worker', {
    timeoutMs,
    probeFn,
    attempts,
    exclude: orch.model,
  })
  if (!worker) {
    worker = await pickFirstLive(workerCandidates, 'worker', {
      timeoutMs,
      probeFn,
      attempts,
    })
  }
  if (!worker) {
    return {
      ok: false,
      orchestratorModel: orch.model,
      workerModel: null,
      fallbackUsed: orch.fallbackUsed,
      attempts,
    }
  }

  return {
    ok: true,
    orchestratorModel: orch.model,
    workerModel: worker.model,
    fallbackUsed: orch.fallbackUsed || worker.fallbackUsed,
    attempts,
  }
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
