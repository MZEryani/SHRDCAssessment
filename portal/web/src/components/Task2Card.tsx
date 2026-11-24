import { useState, type FormEvent } from 'react'
import {
  Sparkles,
  FileCheck2,
  Loader2,
  Terminal,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import type { QuotaStatus } from '../types'

export interface PipelineState {
  running: boolean
  stage: string | null
  model: string | null
  outcome: 'idle' | 'running' | 'done' | 'error'
  logs: string[]
  message: string | null
}

interface Task2CardProps {
  pipeline: PipelineState
  quota: QuotaStatus | null
  onStartGenerate: (prompt: string, name?: string) => Promise<void>
  onViewProof: () => void
}

const PRESETS = [
  {
    label: '4-Box Inspection Batch',
    name: 'batch-counter',
    prompt:
      'A belt conveyor with a spawner, start/stop/reset/E-stop buttons, and a Photo-Eye that pauses each box for 2 seconds and stops the batch after 4 boxes until reset.',
  },
  {
    label: 'Alternating Diverter',
    name: 'diverter-gate',
    prompt:
      'A conveyor cell with a box spawner, start/stop/E-stop controls, a Photo-Eye, and a pneumatic pusher that diverts every second box onto a side chute while counting total items.',
  },
] as const

const STAGES = [
  { id: 'stage1', label: '1. I/O Contract' },
  { id: 'stage2', label: '2. 3 Worktrees' },
  { id: 'stage3', label: '3. Merge' },
  { id: 'stage4', label: '4. Verify' },
] as const

const STAGE_ORDER = ['stage1', 'stage2', 'stage3', 'stage4']

function stageIndex(stage: string | null): number {
  if (!stage) return -1
  if (stage === 'stage4_repair') return 3
  return STAGE_ORDER.indexOf(stage)
}

export function Task2Card({
  pipeline,
  quota,
  onStartGenerate,
  onViewProof,
}: Task2CardProps) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const idx = stageIndex(pipeline.stage)
  const progressValue =
    pipeline.outcome === 'done'
      ? 4
      : pipeline.running
        ? idx >= 0
          ? idx + 1
          : 0.25
        : 0

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onStartGenerate(prompt.trim(), name.trim() || undefined)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || pipeline.running

  return (
    <section
      aria-labelledby="task2-heading"
      className="rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand text-xs font-bold text-white font-mono">
            2
          </span>
          <h2 id="task2-heading" className="text-base font-semibold tracking-tight">
            AI Cell Generator · Plain-English → OpenPLC + OIP
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {quota && (
            <span className="rounded-full border border-line bg-subtle px-2.5 py-0.5 text-xs font-mono text-muted">
              Quota {quota.used}/{quota.cap}
            </span>
          )}
          <button
            type="button"
            onClick={onViewProof}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-subtle transition-colors cursor-pointer"
          >
            <FileCheck2 className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
            <span>Committed Proof</span>
          </button>
        </div>
      </div>

      <div role="group" aria-label="Example prompts" className="flex flex-wrap gap-2 mb-3">
        {PRESETS.map((preset) => (
          <button
            key={preset.name}
            type="button"
            onClick={() => {
              setPrompt(preset.prompt)
              setName(preset.name)
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-subtle/70 px-3 py-1 text-xs font-medium text-muted hover:text-ink hover:border-brand/50 transition-colors cursor-pointer"
          >
            <Sparkles className="h-3 w-3 text-brand" aria-hidden="true" />
            <span>{preset.label}</span>
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="prompt-input" className="block text-xs font-semibold text-muted mb-1">
            Process Description
          </label>
          <textarea
            id="prompt-input"
            name="prompt"
            required
            maxLength={2000}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe parts, Photo-Eye / push buttons, actuators, and operating rules…"
            className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-muted/70 resize-y"
          />
        </div>

        <div className="flex flex-wrap items-end gap-2.5">
          <div className="flex-1 min-w-[180px]">
            <label
              htmlFor="cell-name-input"
              className="block text-xs font-semibold text-muted mb-1"
            >
              Cell Name <span className="font-normal">(optional)</span>
            </label>
            <input
              id="cell-name-input"
              name="name"
              type="text"
              pattern="[a-z0-9][a-z0-9_-]{0,47}"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. inspection-sorter"
              className="w-full min-h-[40px] rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm font-mono placeholder:text-muted/70"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 min-h-[40px] rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60 transition cursor-pointer"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{pipeline.running ? 'Generating…' : 'Generate Cell'}</span>
          </button>
        </div>
      </form>

      {(submitError || pipeline.message) && (
        <div
          role={submitError || pipeline.outcome === 'error' ? 'alert' : 'status'}
          className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-mono ${
            submitError || pipeline.outcome === 'error'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-ok/35 bg-ok/10 text-ok'
          }`}
        >
          {submitError || pipeline.outcome === 'error' ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>{submitError || pipeline.message}</span>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-line bg-canvas p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-2">
          <span id="gen-stage-label" aria-live="polite" className="font-semibold text-ink">
            {pipeline.outcome === 'done'
              ? 'Generation complete'
              : pipeline.outcome === 'error'
                ? 'Generation failed'
                : pipeline.running
                  ? pipeline.stage === 'stage4_repair'
                    ? 'Stage 4/4 · Orchestrator repair pass'
                    : `Running · ${pipeline.stage || 'queued'}`
                  : 'Pipeline idle'}
          </span>
          <span className="font-mono text-muted">
            {pipeline.model || 'parallel git worktrees'}
          </span>
        </div>

        <progress
          max={4}
          value={progressValue}
          aria-labelledby="gen-stage-label"
          className="w-full h-1.5 rounded-full overflow-hidden accent-brand mb-2.5"
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2.5">
          {STAGES.map((s, i) => {
            let state: 'idle' | 'active' | 'done' | 'error' = 'idle'
            if (pipeline.outcome === 'done') state = 'done'
            else if (pipeline.outcome === 'error') {
              state = i === idx ? 'error' : i < idx ? 'done' : 'idle'
            } else if (pipeline.running && idx >= 0) {
              state = i < idx ? 'done' : i === idx ? 'active' : 'idle'
            }

            const styles = {
              idle: 'border-line bg-surface text-muted',
              active: 'border-brand bg-brand/10 text-ink font-semibold',
              done: 'border-ok/40 bg-ok/10 text-ok font-semibold',
              error: 'border-danger/50 bg-danger/10 text-danger font-semibold',
            }[state]

            return (
              <div
                key={s.id}
                className={`rounded-md border px-2 py-1 text-[11px] font-mono truncate ${styles}`}
              >
                {s.label}
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted mb-1">
          <Terminal className="h-3 w-3" aria-hidden="true" />
          <span>SSE Stream</span>
        </div>
        <pre className="m-0 max-h-36 overflow-y-auto rounded-md border border-line bg-surface p-2.5 text-[11px] font-mono leading-relaxed text-muted whitespace-pre-wrap">
          {pipeline.logs.length > 0
            ? pipeline.logs.join('\n')
            : 'Ready — submit a prompt or open Committed Proof.'}
        </pre>
      </div>
    </section>
  )
}
