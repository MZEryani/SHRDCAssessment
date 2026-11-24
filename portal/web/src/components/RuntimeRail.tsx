import { Activity, Lock, Unlock, Server } from 'lucide-react'
import type { PortalStatusResponse } from '../types'

interface RuntimeRailProps {
  status: PortalStatusResponse | null
}

export function RuntimeRail({ status }: RuntimeRailProps) {
  const plc = status?.openplc
  const bridge = status?.bridge
  const quota = status?.generation?.quota
  const events = status?.events ?? []

  const plcState = (plc?.plcStatus || 'CHECKING').replace(/^STATUS:/, '')
  const isRunning = plcState.includes('RUNNING')
  const leaseTotalMins =
    typeof bridge?.leaseTimeoutMs === 'number'
      ? Math.max(1, Math.round(bridge.leaseTimeoutMs / 60000))
      : 30
  const leaseLeftMins =
    bridge?.leaseRemainingMs != null
      ? Math.ceil(bridge.leaseRemainingMs / 60000)
      : leaseTotalMins

  return (
    <aside
      aria-labelledby="runtime-heading"
      className="lg:sticky lg:top-20 rounded-xl border border-line bg-surface p-4 shadow-xs text-xs"
    >
      <div className="flex items-center justify-between gap-2 pb-3 mb-3 border-b border-line">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-brand" aria-hidden="true" />
          <h2 id="runtime-heading" className="text-sm font-semibold tracking-tight">
            Runtime Telemetry
          </h2>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 font-mono font-semibold ${
            isRunning ? 'text-ok' : 'text-warn'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${isRunning ? 'bg-ok' : 'bg-warn'}`}
            aria-hidden="true"
          />
          {plcState}
        </span>
      </div>

      <dl className="divide-y divide-line/60">
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Active Cell</dt>
          <dd className="font-mono font-semibold text-ink">
            {plc?.activeCell || 'none'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">OpenPLC</dt>
          <dd className="font-mono font-semibold text-ink">
            {plc?.version || 'Docker :8443'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Modbus Polls</dt>
          <dd className="font-mono font-semibold text-ink">
            {(bridge?.polls ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Bridge Lock</dt>
          <dd className="inline-flex items-center gap-1 font-mono font-semibold text-ink">
            {bridge?.locked ? (
              <>
                <Lock className="h-3 w-3 text-warn" aria-hidden="true" />
                <span>{leaseLeftMins}m left</span>
              </>
            ) : (
              <>
                <Unlock className="h-3 w-3 text-ok" aria-hidden="true" />
                <span>Open ({leaseTotalMins}m)</span>
              </>
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Masters</dt>
          <dd className="font-mono font-semibold text-ink">
            {bridge?.activeMasters ?? 0}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">AI Quota</dt>
          <dd className="font-mono font-semibold text-ink">
            {quota ? `${quota.used} / ${quota.cap}` : '—'}
          </dd>
        </div>
      </dl>

      <div className="mt-3 pt-3 border-t border-line">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted mb-2">
          <Activity className="h-3 w-3" aria-hidden="true" />
          <span>Events</span>
        </div>
        <ul className="space-y-1.5 max-h-48 overflow-y-auto font-mono text-[11px] text-muted">
          {events.length > 0 ? (
            events.slice(0, 8).map((ev, idx) => (
              <li
                key={`${idx}-${ev}`}
                className="pb-1.5 border-b border-dashed border-line/60 last:border-b-0 break-words"
              >
                {ev}
              </li>
            ))
          ) : (
            <li>Waiting for telemetry…</li>
          )}
        </ul>
      </div>
    </aside>
  )
}
