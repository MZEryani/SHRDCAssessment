import { useState } from 'react'
import { Boxes, Play, FileCode2, Trash2, Loader2 } from 'lucide-react'
import type { CellSummary, DeployResponse } from '../types'

interface CellLibraryCardProps {
  cells: CellSummary[]
  activeCell: string | null
  onDeploy: (slug: string) => Promise<DeployResponse>
  onInspect: (slug: string) => void
  onDelete: (slug: string) => Promise<void>
}

export function CellLibraryCard({
  cells,
  activeCell,
  onDeploy,
  onInspect,
  onDelete,
}: CellLibraryCardProps) {
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const generated = cells.filter((c) => !c.protected)

  const handleDeploy = async (slug: string) => {
    setBusySlug(slug)
    setFeedback(null)
    try {
      const res = await onDeploy(slug)
      setFeedback(`Deployed "${slug}" (${res.plcStatus.replace(/^STATUS:/, '')})`)
      window.open(res.launchUrl, '_blank', 'noopener')
    } catch (err) {
      setFeedback(`Deploy error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusySlug(null)
    }
  }

  const handleDelete = async (slug: string) => {
    if (!window.confirm(`Delete generated Cell "${slug}"?`)) return
    setBusySlug(slug)
    setFeedback(null)
    try {
      await onDelete(slug)
      setFeedback(`Deleted "${slug}"`)
    } catch (err) {
      setFeedback(`Delete error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <section
      aria-labelledby="cells-heading"
      className="rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-subtle border border-line text-xs font-bold text-ink font-mono">
            3
          </span>
          <h2 id="cells-heading" className="text-base font-semibold tracking-tight">
            Generated Cells
          </h2>
        </div>
        <span className="text-xs font-mono text-muted">
          {generated.length} stored
        </span>
      </div>

      {feedback && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-line bg-subtle px-3 py-2 text-xs font-mono text-ink"
        >
          {feedback}
        </div>
      )}

      {generated.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-line bg-subtle/40 px-4 py-4 text-xs text-muted">
          <Boxes className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <span>
            No AI-generated Cells yet. Cells created in Step 2 persist across restarts here.
          </span>
        </div>
      ) : (
        <div className="space-y-2.5">
          {generated.map((cell) => {
            const isBusy = busySlug === cell.slug
            const isActive = activeCell === cell.slug
            return (
              <article
                key={cell.slug}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3.5 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold font-mono truncate">{cell.slug}</h3>
                    {isActive && (
                      <span className="rounded-full bg-ok/10 border border-ok/35 px-2 py-0.5 text-[10px] font-mono font-semibold text-ok">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted font-mono">
                    {cell.signalCount} signals
                    {cell.capturedAt
                      ? ` · ${cell.capturedAt.slice(0, 19).replace('T', ' ')} UTC`
                      : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleDeploy(cell.slug)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60 transition cursor-pointer"
                  >
                    {isBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>Deploy &amp; 3D</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onInspect(cell.slug)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-subtle transition-colors cursor-pointer"
                  >
                    <FileCode2 className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                    <span>Inspect</span>
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleDelete(cell.slug)}
                    aria-label={`Delete ${cell.slug}`}
                    className="inline-flex items-center justify-center rounded-lg border border-danger/40 bg-surface p-1.5 text-danger hover:bg-danger/10 disabled:opacity-60 transition-colors cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
