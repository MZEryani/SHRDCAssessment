import { generateCell, slugifyPrompt } from '../scripts/orchestrate-cell.mjs'
import { PROTECTED_CELL_SLUG } from './cell-store.mjs'

export const DEFAULT_DAILY_GENERATION_CAP = 10
const MAX_PROMPT_LENGTH = 2000
const MAX_LOG_LINES = 120
const SSE_KEEPALIVE_MS = 15_000
const SLUG_RX = /^[a-z0-9][a-z0-9_-]{0,47}$/

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
}

function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function formatSseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function createGenerationManager({
  cellStore,
  generateCellFn = generateCell,
  dailyCap = DEFAULT_DAILY_GENERATION_CAP,
  now = () => Date.now(),
  onEvent = () => {},
} = {}) {
  const parsedCap = Number(dailyCap)
  const effectiveCap =
    Number.isFinite(parsedCap) && parsedCap >= 0
      ? Math.floor(parsedCap)
      : DEFAULT_DAILY_GENERATION_CAP
  const subscribers = new Set()

  let quotaDay = utcDayKey(now())
  let quotaUsed = 0
  let jobCounter = 0
  let activeJob = null
  let lastResult = null

  function getQuota() {
    const today = utcDayKey(now())
    if (today !== quotaDay) {
      quotaDay = today
      quotaUsed = 0
    }
    return {
      day: quotaDay,
      used: quotaUsed,
      cap: effectiveCap,
      remaining: Math.max(0, effectiveCap - quotaUsed),
    }
  }

  function broadcast(event, payload) {
    const frame = formatSseFrame(event, payload)
    for (const res of [...subscribers]) {
      try {
        if (res.writableEnded || res.destroyed) {
          subscribers.delete(res)
          continue
        }
        res.write(frame)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  const keepaliveTimer = setInterval(() => {
    for (const res of [...subscribers]) {
      try {
        if (res.writableEnded || res.destroyed) {
          subscribers.delete(res)
          continue
        }
        res.write(': keepalive\n\n')
      } catch {
        subscribers.delete(res)
      }
    }
  }, SSE_KEEPALIVE_MS)
  keepaliveTimer.unref?.()

  function status() {
    return {
      running: Boolean(activeJob),
      activeJob: activeJob
        ? {
            id: activeJob.id,
            slug: activeJob.slug,
            prompt: activeJob.prompt,
            startedAt: activeJob.startedAt,
            stage: activeJob.stage,
            model: activeJob.model,
            logs: activeJob.logs.slice(-40),
          }
        : null,
      lastResult,
      quota: getQuota(),
    }
  }

  function subscribe(req, res) {
    res.writeHead(200, SSE_HEADERS)
    res.write(formatSseFrame('snapshot', status()))
    subscribers.add(res)

    const cleanup = () => {
      subscribers.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  function start({ prompt, name } = {}) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : ''
    if (!trimmedPrompt) {
      return { ok: false, status: 400, error: 'Prompt is required to generate a Cell.' }
    }
    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      return {
        ok: false,
        status: 400,
        error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`,
      }
    }

    let slug
    if (name !== undefined && name !== null && String(name).trim() !== '') {
      const candidate = String(name).trim().toLowerCase()
      if (!SLUG_RX.test(candidate)) {
        return {
          ok: false,
          status: 400,
          error: 'Cell name must start with a letter or digit and contain only lowercase letters, digits, hyphens, or underscores.',
        }
      }
      if (candidate === PROTECTED_CELL_SLUG) {
        return {
          ok: false,
          status: 403,
          error: `Cannot overwrite the protected reference Cell "${PROTECTED_CELL_SLUG}".`,
        }
      }
      slug = candidate
    } else {
      const derived = slugifyPrompt(trimmedPrompt)
      slug = derived === PROTECTED_CELL_SLUG ? `${derived}-gen` : derived
    }

    const outDir = cellStore?.ensureGeneratedCellsDir?.() ?? cellStore?.generatedCellsDir ?? null
    if (!outDir) {
      return {
        ok: false,
        status: 503,
        error: 'Generated Cells storage directory (PORTAL_CELLS_DIR) is not configured.',
      }
    }

    const existing = cellStore?.resolveCellEntry?.(slug)
    if (existing && !existing.error) {
      return {
        ok: false,
        status: 409,
        error: `Cell "${slug}" already exists. Delete it in Act 3 or choose a different Cell slug.`,
      }
    }

    if (activeJob) {
      return {
        ok: false,
        status: 409,
        error: `Cell generation "${activeJob.slug}" is already running. Wait for it to finish before starting another.`,
      }
    }

    const quota = getQuota()
    if (quota.used >= quota.cap) {
      return {
        ok: false,
        status: 429,
        error: `Daily AI generation cap (${quota.cap}/${quota.cap}) reached for ${quota.day} UTC.`,
      }
    }

    quotaUsed += 1
    jobCounter += 1
    const jobId = `job-${jobCounter}`
    const startedAt = new Date(now()).toISOString()

    activeJob = {
      id: jobId,
      slug,
      prompt: trimmedPrompt,
      startedAt,
      stage: 'queued',
      model: null,
      logs: [],
    }

    onEvent(`AI generation started for "${slug}" (${quotaUsed}/${effectiveCap} daily quota)`)
    broadcast('stage', {
      jobId,
      slug,
      stage: 'queued',
      quota: getQuota(),
      ts: startedAt,
    })

    void Promise.resolve()
      .then(() =>
        generateCellFn({
          prompt: trimmedPrompt,
          name: slug,
          cellsDir: outDir,
          usePreflight: true,
          onEvent: (ev) => {
            if (!ev || typeof ev !== 'object') return
            const stage = String(ev.stage || '')
            if (!stage || stage === 'done') return
            if (activeJob && activeJob.id === jobId) {
              activeJob.stage = stage
              if (ev.model) activeJob.model = ev.model
            }
            broadcast('stage', {
              jobId,
              slug: ev.slug || slug,
              stage,
              model: ev.model ?? null,
              ts: new Date(now()).toISOString(),
            })
          },
          log: (line) => {
            const text = String(line ?? '')
            if (!text) return
            if (activeJob && activeJob.id === jobId) {
              activeJob.logs.push(text)
              if (activeJob.logs.length > MAX_LOG_LINES) {
                activeJob.logs.shift()
              }
            }
            broadcast('log', {
              jobId,
              slug,
              line: text,
              ts: new Date(now()).toISOString(),
            })
          },
        }),
      )
      .then((report) => {
        const finalSlug = report?.slug || slug
        const finishedAt = new Date(now()).toISOString()
        lastResult = {
          ok: true,
          jobId,
          slug: finalSlug,
          runId: report?.runId ?? null,
          durationMs: report?.totals?.durationMs ?? null,
          costUsd: report?.totals?.costUsd ?? null,
          finishedAt,
        }
        activeJob = null
        onEvent(`AI generation completed for "${finalSlug}"`)
        broadcast('done', {
          ...lastResult,
          quota: getQuota(),
        })
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        const finishedAt = new Date(now()).toISOString()
        const failedStage = activeJob?.stage ?? null
        lastResult = {
          ok: false,
          jobId,
          slug,
          stage: failedStage,
          error: message,
          finishedAt,
        }
        activeJob = null
        onEvent(`AI generation failed for "${slug}": ${message.slice(0, 120)}`)
        broadcast('error', {
          ...lastResult,
          quota: getQuota(),
        })
      })

    return {
      ok: true,
      status: 202,
      jobId,
      slug,
      quota: getQuota(),
    }
  }

  function close() {
    clearInterval(keepaliveTimer)
    for (const res of [...subscribers]) {
      try {
        res.end()
      } catch {
        // Ignore already-closed sockets
      }
    }
    subscribers.clear()
  }

  return {
    status,
    subscribe,
    start,
    close,
  }
}
