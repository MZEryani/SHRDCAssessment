import { Cpu, Moon, Sun, Monitor, Radio } from 'lucide-react'
import type { ThemePreference } from '../hooks/useTheme'
import type { PortalStatusResponse } from '../types'

interface TopBarProps {
  status: PortalStatusResponse | null
  theme: ThemePreference
  onSetTheme: (pref: ThemePreference) => void
}

export function TopBar({ status, theme, onSetTheme }: TopBarProps) {
  const plcStatus = status?.openplc?.plcStatus || 'CHECKING'
  const isRunning = plcStatus.includes('RUNNING')
  const isLocked = Boolean(status?.bridge?.locked)
  const polls = status?.bridge?.polls ?? 0

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand border border-brand/25">
            <Cpu className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight truncate">
              OpenPLC v4 + OIP Demo Console
            </h1>
            <p className="text-xs text-muted font-mono truncate">
              WebSocket ↔ Modbus TCP :5020
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <div
            className="hidden sm:inline-flex items-center gap-2 rounded-full border border-line bg-subtle px-3 py-1 text-xs font-mono"
            aria-label="Live runtime summary"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                isRunning ? 'bg-ok' : 'bg-warn'
              }`}
              aria-hidden="true"
            />
            <span className="font-medium text-ink">
              {status?.openplc?.activeCell || 'conveyor-cell'}
            </span>
            <span className="text-muted">·</span>
            <span className={isRunning ? 'text-ok font-semibold' : 'text-warn font-semibold'}>
              {plcStatus.replace(/^STATUS:/, '')}
            </span>
            {isLocked && (
              <>
                <span className="text-muted">·</span>
                <span className="inline-flex items-center gap-1 text-brand">
                  <Radio className="h-3 w-3" aria-hidden="true" />
                  {polls.toLocaleString()}
                </span>
              </>
            )}
          </div>

          <div
            role="group"
            aria-label="Color theme"
            className="inline-flex items-center rounded-lg border border-line bg-subtle p-0.5"
          >
            {(
              [
                { id: 'light', icon: Sun, label: 'Light' },
                { id: 'dark', icon: Moon, label: 'Dark' },
                { id: 'system', icon: Monitor, label: 'Auto' },
              ] as const
            ).map(({ id, icon: Icon, label }) => {
              const active = theme === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSetTheme(id)}
                  aria-pressed={active}
                  title={`${label} theme`}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-surface text-ink shadow-xs'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">{label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </header>
  )
}
