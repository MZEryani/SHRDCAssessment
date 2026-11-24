import { execFileSync, spawn } from 'node:child_process'
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

function parseNdjsonEvent(rawLine) {
  const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (!line.startsWith('{')) return { line, event: null }
  try {
    return { line, event: JSON.parse(line) }
  } catch {
    return { line, event: null }
  }
}

/**
 * Inspect a raw NDJSON line for HTTP 429/503 retry events past maxRetryAttempts.
 */
export function inspectNdjsonRetryLine(rawLine, { maxRetryAttempts = 2 } = {}) {
  const { event } = parseNdjsonEvent(rawLine)
  if (!event || event.type !== 'retry') return null
  const status = event.error?.status
  if (event.attempt > maxRetryAttempts && (status === 429 || status === 503)) {
    const msg = event.error?.message ?? 'upstream capacity/quota failure'
    return `Fail-fast abort on HTTP ${status} retry attempt ${event.attempt}: ${msg}`
  }
  return null
}

/**
 * Split chunked stream data into complete newline-delimited lines.
 */
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
        const rest = pending
        pending = ''
        onLine(rest)
      }
    },
  }
}

function extractWorktreeFromSkillPart(part) {
  const skillDir = part?.state?.metadata?.metadata?.directory
  if (typeof skillDir === 'string') {
    const normalized = skillDir.replaceAll('\\', '/')
    if (normalized.includes('/.opencode/skills/')) {
      return normalized.split('/.opencode/skills/')[0]
    }
  }
  return null
}

/**
 * Parse an OpenCode NDJSON stream for worktree path, session, skills, tools, tokens, cost, text, and errors.
 */
export function parseOpenCodeNdjson(rawOutput) {
  let worktreePath = null
  let sessionId = null
  const skillsLoaded = new Set()
  const toolsUsed = {}
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let costUsd = 0
  let finalText = ''
  let error = null

  for (const rawLine of rawOutput.split('\n')) {
    const { line, event } = parseNdjsonEvent(rawLine)
    if (!line) continue
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length).trim()
      continue
    }
    if (!event) continue

    if (event.sessionID && !sessionId) sessionId = event.sessionID

    if (event.type === 'tool_use' && event.part) {
      const tool = event.part.tool
      if (tool) toolsUsed[tool] = (toolsUsed[tool] ?? 0) + 1
      if (tool === 'skill' && event.part.state?.input?.id) {
        skillsLoaded.add(event.part.state.input.id)
        if (!worktreePath) {
          worktreePath = extractWorktreeFromSkillPart(event.part)
        }
      }
    } else if (event.type === 'step_finish' && event.part) {
      if (typeof event.part.cost === 'number') costUsd += event.part.cost
      const t = event.part.tokens
      if (t) {
        tokens.input += t.input ?? 0
        tokens.output += t.output ?? 0
        tokens.reasoning += t.reasoning ?? 0
        tokens.cacheRead += t.cache?.read ?? 0
        tokens.cacheWrite += t.cache?.write ?? 0
      }
    } else if (event.type === 'text' && event.part?.text) {
      finalText = event.part.text
    } else if (event.type === 'error' && event.error) {
      error = event.error.message ?? JSON.stringify(event.error)
    }
  }

  return {
    worktreePath,
    sessionId,
    skillsLoaded: [...skillsLoaded],
    toolsUsed,
    tokens,
    costUsd: Number(costUsd.toFixed(6)),
    finalText: finalText.trim(),
    error,
  }
}

/**
 * Spawn an OpenCode CLI subprocess with unified streaming, timeout, and fail-fast retry/error guards.
 */
export function runOpenCodeSubprocess({
  args,
  cwd = REPO_ROOT,
  timeoutMs = 240000,
  maxRetryAttempts = 2,
  abortOnErrorEvent = false,
  spawnFn = spawn,
}) {
  return new Promise((resolvePromise) => {
    const startedAt = new Date().toISOString()
    const startMs = performance.now()
    const child = spawnFn('opencode', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    let settled = false
    let stdout = ''
    let stderr = ''

    const settle = (fields) => {
      resolvePromise({
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startMs),
        startedAt,
        finishedAt: new Date().toISOString(),
        ...fields,
      })
    }

    const abortWith = (abortReason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!child.killed) child.kill('SIGTERM')
      splitter.flush()
      settle({
        ok: false,
        aborted: true,
        abortReason,
        spawnError: null,
        code: null,
      })
    }

    const timer = setTimeout(() => {
      abortWith(`Timed out after ${timeoutMs}ms`)
    }, timeoutMs)

    const splitter = createLineSplitter((rawLine) => {
      const retryAbort = inspectNdjsonRetryLine(rawLine, { maxRetryAttempts })
      if (retryAbort) {
        abortWith(retryAbort)
        return
      }
      if (!abortOnErrorEvent) return
      const { event } = parseNdjsonEvent(rawLine)
      if (event?.type === 'error' && event.error) {
        const status = event.error.status ? `HTTP ${event.error.status} ` : ''
        abortWith(`${status}${event.error.message ?? 'provider failure'}`)
      }
    })

    child.stdout?.on('data', (chunk) => {
      if (settled) return
      const text = chunk.toString('utf8')
      stdout += text
      splitter.push(text)
    })

    child.stderr?.on('data', (chunk) => {
      if (settled) return
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle({
        ok: false,
        aborted: false,
        abortReason: null,
        spawnError: err,
        code: null,
      })
    })

    child.on('close', (code) => {
      if (settled) return
      splitter.flush()
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle({
        ok: code === 0,
        aborted: false,
        abortReason: null,
        spawnError: null,
        code,
      })
    })
  })
}

/**
 * Execute an OpenCode agent run and return parsed session telemetry.
 */
export async function runOpenCodeAgent({
  agent,
  model,
  worktreeName,
  prompt,
  cwd = REPO_ROOT,
  timeoutMs = 240000,
  maxRetryAttempts = 2,
  spawnFn = spawn,
}) {
  const args = [
    'run',
    '--standalone',
    '--auto',
    '--archived',
    '--format',
    'json',
    '--agent',
    agent,
    ...(worktreeName ? ['--worktree', worktreeName] : []),
    ...(model ? ['--model', model] : []),
    prompt,
  ]

  const res = await runOpenCodeSubprocess({
    args,
    cwd,
    timeoutMs,
    maxRetryAttempts,
    abortOnErrorEvent: false,
    spawnFn,
  })

  if (res.spawnError) throw res.spawnError

  const parsed = parseOpenCodeNdjson(`${res.stderr}\n${res.stdout}`)

  if (res.aborted) {
    throw new Error(`Agent "${agent}" ${res.abortReason} (tools=${JSON.stringify(parsed.toolsUsed)})`)
  }

  if (res.code !== 0 || parsed.error) {
    throw new Error(
      `OpenCode agent "${agent}" failed (exit ${res.code}): ${parsed.error ?? res.stderr.trim()}`,
    )
  }

  return {
    agent,
    model,
    startedAt: res.startedAt,
    finishedAt: res.finishedAt,
    durationMs: res.durationMs,
    ...parsed,
  }
}

/**
 * Probe a single model with a minimal prompt and fail-fast error/retry guards.
 */
export async function probeSingleModel(
  model,
  { timeoutMs = 12000, cwd = REPO_ROOT, spawnFn = spawn } = {},
) {
  const res = await runOpenCodeSubprocess({
    args: ['run', '--standalone', '--auto', '--archived', '--format', 'json', '-m', model, 'Reply READY'],
    cwd,
    timeoutMs,
    maxRetryAttempts: 1,
    abortOnErrorEvent: true,
    spawnFn,
  })

  if (res.spawnError) {
    return { model, durationMs: res.durationMs, ok: false, reason: res.spawnError.message }
  }
  if (res.aborted) {
    return { model, durationMs: res.durationMs, ok: false, reason: res.abortReason.slice(0, 180) }
  }
  if (res.code === 0 && res.stdout.includes('"step_finish"')) {
    return { model, durationMs: res.durationMs, ok: true }
  }
  return {
    model,
    durationMs: res.durationMs,
    ok: false,
    reason: (res.stderr.trim() || `Exited with code ${res.code}`).slice(0, 180),
  }
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

/**
 * Probe prioritized orchestrator and worker model candidates and pick the first live distinct pair.
 */
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

/**
 * Resolve default orchestrator and worker models from OpenCode agent config and environment overrides.
 */
export function resolveDefaultModels({
  cwd = REPO_ROOT,
  env = process.env,
  execFileSyncFn = execFileSync,
} = {}) {
  const agents = JSON.parse(
    execFileSyncFn('opencode', ['debug', 'agents', '--standalone'], {
      cwd,
      encoding: 'utf8',
    }),
  )
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const formatModelId = (agentId) => {
    const model = agentsById.get(agentId)?.model
    return model ? `${model.providerID ?? model.provider}/${model.modelID ?? model.id}` : undefined
  }
  return {
    orchestrator: env.OPENCODE_ORCHESTRATOR_MODEL || formatModelId('orchestrator'),
    worker: env.OPENCODE_WORKER_MODEL || formatModelId('plc-coder'),
  }
}
