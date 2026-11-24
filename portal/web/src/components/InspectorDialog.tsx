import { useEffect, useRef, useState } from 'react'
import { X, Copy, Check } from 'lucide-react'
import type { CellDetails, ProofResponse } from '../types'

export type ModalContent =
  | { kind: 'cell'; data: CellDetails }
  | { kind: 'proof'; data: ProofResponse }
  | null

interface InspectorDialogProps {
  content: ModalContent
  onClose: () => void
}

export function InspectorDialog({ content, onClose }: InspectorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (content && !dialog.open) {
      dialog.showModal()
    } else if (!content && dialog.open) {
      dialog.close()
    }
  }, [content])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleClose = () => onClose()
    dialog.addEventListener('close', handleClose)

    // Light-dismiss fallback for browsers without closedby="any"
    let pressedOutside = false
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e)
    }
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) dialog.close()
    }
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('pointerdown', onDown)
      dialog.addEventListener('pointerup', onUp)
    }

    return () => {
      dialog.removeEventListener('close', handleClose)
      dialog.removeEventListener('pointerdown', onDown)
      dialog.removeEventListener('pointerup', onUp)
    }
  }, [onClose])

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Ignore clipboard failures
    }
  }

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="inspector-modal-title"
      className="m-auto w-[min(920px,94vw)] max-h-[86vh] rounded-xl p-0 shadow-2xl overflow-hidden"
    >
      {content && (
        <div className="flex flex-col max-h-[86vh]">
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-line bg-surface">
            <h2
              id="inspector-modal-title"
              className="text-sm font-semibold font-mono truncate"
            >
              {content.kind === 'cell'
                ? `scenes/${content.data.slug}/`
                : 'Committed Orchestration Proof'}
            </h2>
            <div className="flex items-center gap-2">
              {content.kind === 'cell' && content.data.stSource && (
                <button
                  type="button"
                  onClick={() => void handleCopy(content.data.stSource)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-subtle px-2.5 py-1 text-xs font-medium text-ink hover:bg-line/40 transition-colors cursor-pointer"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-ok" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                  )}
                  <span>{copied ? 'Copied' : 'Copy ST'}</span>
                </button>
              )}
              <form method="dialog">
                <button
                  type="submit"
                  aria-label="Close dialog"
                  className="inline-flex items-center justify-center rounded-lg border border-line bg-surface p-1.5 text-muted hover:text-ink hover:bg-subtle transition-colors cursor-pointer"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>
            </div>
          </div>

          <div className="overflow-y-auto p-5 space-y-5 bg-surface">
            {content.kind === 'proof' ? (
              <pre className="m-0 rounded-lg border border-line bg-canvas p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
                {content.data.markdown || JSON.stringify(content.data.json, null, 2)}
              </pre>
            ) : (
              <>
                {content.data.generationReport && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
                      Generation &amp; Verification Report
                    </h3>
                    <pre className="m-0 rounded-lg border border-line bg-canvas p-3.5 text-xs font-mono leading-relaxed overflow-x-auto">
                      {JSON.stringify(content.data.generationReport, null, 2)}
                    </pre>
                  </div>
                )}

                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
                    Structured Text (plc/program.st)
                  </h3>
                  <pre className="m-0 rounded-lg border border-line bg-canvas p-3.5 text-xs font-mono leading-relaxed overflow-x-auto">
                    {content.data.stSource || '(no ST program)'}
                  </pre>
                </div>

                {content.data.ioContract?.signals && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
                      I/O Contract ({content.data.ioContract.signals.length} signals)
                    </h3>
                    <div className="overflow-x-auto rounded-lg border border-line">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-line bg-subtle text-muted">
                            <th scope="col" className="px-3 py-2 font-semibold">
                              Signal
                            </th>
                            <th scope="col" className="px-3 py-2 font-semibold">
                              IEC
                            </th>
                            <th scope="col" className="px-3 py-2 font-semibold">
                              Type
                            </th>
                            <th scope="col" className="px-3 py-2 font-semibold">
                              Direction
                            </th>
                            <th scope="col" className="px-3 py-2 font-semibold">
                              Modbus
                            </th>
                            <th scope="col" className="px-3 py-2 font-semibold">
                              Description
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line/60">
                          {content.data.ioContract.signals.map((sig) => (
                            <tr key={sig.name} className="hover:bg-subtle/40">
                              <th scope="row" className="px-3 py-2 font-mono font-semibold text-ink">
                                {sig.name}
                                {sig.contact ? ` (${sig.contact})` : ''}
                              </th>
                              <td className="px-3 py-2 font-mono text-ink">{sig.iecAddress}</td>
                              <td className="px-3 py-2 font-mono text-muted">{sig.type}</td>
                              <td className="px-3 py-2 font-mono text-muted">
                                {sig.direction === 'oip_to_plc' ? 'OIP → PLC' : 'PLC → OIP'}
                              </td>
                              <td className="px-3 py-2 font-mono text-muted">
                                {sig.modbusArea} {sig.modbusAddress}
                              </td>
                              <td className="px-3 py-2 text-muted">{sig.description || ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  )
}
