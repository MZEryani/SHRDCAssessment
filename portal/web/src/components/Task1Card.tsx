import { useState } from 'react'
import {
  Play,
  FileCode2,
  ExternalLink,
  ChevronDown,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import type { DeployResponse } from '../types'

interface Task1CardProps {
  activeCell: string | null
  onDeploy: (slug: string) => Promise<DeployResponse>
  onInspect: (slug: string) => void
}

export function Task1Card({ activeCell, onDeploy, onInspect }: Task1CardProps) {
  const [deploying, setDeploying] = useState(false)
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'err'
    text: string
    launchUrl?: string
  } | null>(null)

  const isLoaded = activeCell === 'conveyor-cell'

  const handleDeployAndLaunch = async () => {
    setDeploying(true)
    setFeedback(null)
    try {
      const res = await onDeploy('conveyor-cell')
      setFeedback({
        kind: 'ok',
        text: `OpenPLC ${res.version} (${res.plcStatus.replace(/^STATUS:/, '')})`,
        launchUrl: res.launchUrl,
      })
      window.open(res.launchUrl, '_blank', 'noopener')
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeploying(false)
    }
  }

  return (
    <section
      aria-labelledby="task1-heading"
      className="rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand text-xs font-bold text-white font-mono">
            1
          </span>
          <h2 id="task1-heading" className="text-base font-semibold tracking-tight">
            Basic Conveyor Cell · Live OpenPLC ↔ OIP 3D
          </h2>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-mono font-medium border ${
            isLoaded
              ? 'border-ok/35 bg-ok/10 text-ok'
              : 'border-line bg-subtle text-muted'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${isLoaded ? 'bg-ok' : 'bg-muted'}`}
            aria-hidden="true"
          />
          {isLoaded ? 'Loaded in OpenPLC' : 'conveyor-cell · 11 signals'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={handleDeployAndLaunch}
          disabled={deploying}
          className="inline-flex items-center gap-2 min-h-[40px] rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60 transition cursor-pointer"
        >
          {deploying ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{deploying ? 'Deploying…' : 'Deploy & Launch OIP 3D'}</span>
        </button>

        <button
          type="button"
          onClick={() => onInspect('conveyor-cell')}
          className="inline-flex items-center gap-2 min-h-[40px] rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-subtle transition-colors cursor-pointer"
        >
          <FileCode2 className="h-4 w-4 text-muted" aria-hidden="true" />
          <span>Inspect ST &amp; I/O</span>
        </button>

        <a
          href="/app/?cell=conveyor-cell"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 min-h-[40px] rounded-lg border border-line bg-subtle/60 px-3.5 py-2 text-sm font-medium text-muted hover:text-ink hover:bg-subtle transition-colors"
        >
          <span>Open 3D Tab</span>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      {feedback && (
        <div
          role={feedback.kind === 'err' ? 'alert' : 'status'}
          className={`mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs font-mono ${
            feedback.kind === 'ok'
              ? 'border-ok/35 bg-ok/10 text-ok'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {feedback.kind === 'ok' ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>{feedback.text}</span>
          {feedback.launchUrl && (
            <a
              href={feedback.launchUrl}
              target="_blank"
              rel="noopener"
              className="underline font-semibold ml-auto"
            >
              Open 3D Tab ↗
            </a>
          )}
        </div>
      )}

      <details className="group mt-4 rounded-lg border border-line bg-subtle/50">
        <summary className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-semibold text-muted hover:text-ink cursor-pointer list-none select-none">
          <span>3D Tab Operator Quick-Guide</span>
          <ChevronDown
            className="h-4 w-4 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <ol className="border-t border-line px-4 py-3 space-y-1.5 text-xs text-muted list-decimal list-inside">
          <li>
            Click <strong className="text-ink">Play</strong> in OIP — Modbus TCP connects on port{' '}
            <code className="font-mono text-ink">5020</code>.
          </li>
          <li>
            Press <strong className="text-ink">START</strong> (
            <code className="font-mono text-ink">%IX0.0</code>) — belt runs and spawner feeds boxes.
          </li>
          <li>
            <strong className="text-ink">Photo-Eye</strong> (
            <code className="font-mono text-ink">%IX0.4</code>) triggers a 2s amber{' '}
            <strong className="text-ink">Inspection Dwell</strong> and increments{' '}
            <code className="font-mono text-ink">Box_Count</code>.
          </li>
          <li>
            <strong className="text-ink">Batch</strong> halts automatically at 5 boxes until{' '}
            <strong className="text-ink">RESET</strong> (
            <code className="font-mono text-ink">%IX0.3</code>) is pressed while stopped.
          </li>
          <li>
            Toggle NC <strong className="text-ink">E-STOP</strong> (
            <code className="font-mono text-ink">%IX0.2</code>) — immediate halt + red{' '}
            <code className="font-mono text-ink">Fault_Light</code>; releasing never auto-restarts.
          </li>
        </ol>
      </details>
    </section>
  )
}
