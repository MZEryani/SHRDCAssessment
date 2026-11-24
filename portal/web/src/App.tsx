import { useCallback, useEffect, useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { LoginView } from './components/LoginView'
import { TopBar } from './components/TopBar'
import { Task1Card } from './components/Task1Card'
import { Task2Card, type PipelineState } from './components/Task2Card'
import { CellLibraryCard } from './components/CellLibraryCard'
import { RuntimeRail } from './components/RuntimeRail'
import { InspectorDialog, type ModalContent } from './components/InspectorDialog'
import type {
  CellDetails,
  CellSummary,
  DeployResponse,
  PortalStatusResponse,
  ProofResponse,
} from './types'

function readMeta(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || ''
}

export function App() {
  const { preference, setPreference, cycleTheme } = useTheme()
  const [authenticated, setAuthenticated] = useState(
    () => readMeta('portal-auth') !== 'unauthenticated',
  )
  const [authError] = useState(() => readMeta('portal-auth-error'))

  const [status, setStatus] = useState<PortalStatusResponse | null>(null)
  const [cells, setCells] = useState<CellSummary[]>([])
  const [modal, setModal] = useState<ModalContent>(null)
  const [pipeline, setPipeline] = useState<PipelineState>({
    running: false,
    stage: null,
    model: null,
    outcome: 'idle',
    logs: [],
    message: null,
  })

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' })
      if (res.status === 401) {
        setAuthenticated(false)
        return
      }
      if (!res.ok) return
      const data: PortalStatusResponse = await res.json()
      setStatus(data)
    } catch {
      // Ignore transient network errors
    }
  }, [])

  const refreshCells = useCallback(async () => {
    try {
      const res = await fetch('/api/cells', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setCells(Array.isArray(data.cells) ? data.cells : [])
    } catch {
      // Ignore transient fetch errors
    }
  }, [])

  useEffect(() => {
    if (!authenticated) return
    void refreshStatus()
    void refreshCells()

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshStatus()
      }
    }, 3000)

    const es = new EventSource('/api/generate/events')
    es.addEventListener('snapshot', (ev) => {
      try {
        const snap = JSON.parse((ev as MessageEvent).data)
        if (snap.activeJob) {
          setPipeline({
            running: true,
            stage: snap.activeJob.stage || 'queued',
            model: snap.activeJob.model || null,
            outcome: 'running',
            logs: Array.isArray(snap.activeJob.logs) ? snap.activeJob.logs : [],
            message: null,
          })
        } else {
          setPipeline((prev) => ({ ...prev, running: Boolean(snap.running) }))
        }
      } catch {
        // Ignore malformed snapshot
      }
    })

    es.addEventListener('stage', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        const line = `[${String(data.ts || '').slice(11, 19)}] Stage: ${data.stage}${
          data.model ? ` (${data.model})` : ''
        }`
        setPipeline((prev) => ({
          ...prev,
          running: true,
          stage: data.stage,
          model: data.model ?? prev.model,
          outcome: 'running',
          logs: [...prev.logs.slice(-100), line],
        }))
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('log', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        if (!data.line) return
        setPipeline((prev) => ({
          ...prev,
          logs: [...prev.logs.slice(-100), String(data.line)],
        }))
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('done', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        setPipeline((prev) => ({
          ...prev,
          running: false,
          stage: 'stage4',
          outcome: 'done',
          message: `Generated "${data.slug}" — passed verification.`,
        }))
        void refreshCells()
        void refreshStatus()
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('error', (ev) => {
      const raw = (ev as MessageEvent).data
      if (!raw) return
      try {
        const data = JSON.parse(raw)
        setPipeline((prev) => ({
          ...prev,
          running: false,
          stage: data.stage || prev.stage,
          outcome: 'error',
          message: `Generation failed: ${data.error || 'Unknown error'}`,
        }))
        void refreshStatus()
      } catch {
        // Ignore reconnect error
      }
    })

    return () => {
      window.clearInterval(timer)
      es.close()
    }
  }, [authenticated, refreshCells, refreshStatus])

  const handleDeploy = async (slug: string): Promise<DeployResponse> => {
    const res = await fetch(`/api/cells/${encodeURIComponent(slug)}/deploy`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    const data: DeployResponse = await res.json()
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Deployment failed (HTTP ${res.status})`)
    }
    void refreshStatus()
    return data
  }

  const handleInspect = async (slug: string) => {
    const res = await fetch(`/api/cells/${encodeURIComponent(slug)}`, {
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const data: CellDetails = await res.json()
    setModal({ kind: 'cell', data })
  }

  const handleViewProof = async () => {
    const res = await fetch('/api/proof', { credentials: 'same-origin' })
    if (!res.ok) return
    const data: ProofResponse = await res.json()
    setModal({ kind: 'proof', data })
  }

  const handleStartGenerate = async (prompt: string, name?: string) => {
    setPipeline({
      running: true,
      stage: 'queued',
      model: null,
      outcome: 'running',
      logs: [`[${new Date().toISOString().slice(11, 19)}] Submitting specification…`],
      message: null,
    })
    const res = await fetch('/api/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, name }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      setPipeline((prev) => ({ ...prev, running: false, outcome: 'idle' }))
      throw new Error(data.error || `Generation rejected (HTTP ${res.status})`)
    }
    void refreshStatus()
  }

  const handleDeleteCell = async (slug: string) => {
    const res = await fetch(`/api/cells/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Delete failed (HTTP ${res.status})`)
    }
    await Promise.all([refreshCells(), refreshStatus()])
  }

  if (!authenticated) {
    return (
      <LoginView
        initialError={authError}
        theme={preference}
        onCycleTheme={cycleTheme}
        onAuthenticated={() => setAuthenticated(true)}
      />
    )
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-3.5 focus:py-2 focus:text-xs focus:font-semibold focus:text-white"
      >
        Skip to main content
      </a>

      <TopBar status={status} theme={preference} onSetTheme={setPreference} />

      <div className="mx-auto max-w-[1240px] px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
        <main id="main-content" tabIndex={-1} className="space-y-5">
          <Task1Card
            activeCell={status?.openplc?.activeCell ?? null}
            onDeploy={handleDeploy}
            onInspect={(slug) => void handleInspect(slug)}
          />
          <Task2Card
            pipeline={pipeline}
            quota={status?.generation?.quota ?? null}
            onStartGenerate={handleStartGenerate}
            onViewProof={() => void handleViewProof()}
          />
          <CellLibraryCard
            cells={cells}
            activeCell={status?.openplc?.activeCell ?? null}
            onDeploy={handleDeploy}
            onInspect={(slug) => void handleInspect(slug)}
            onDelete={handleDeleteCell}
          />
        </main>

        <RuntimeRail status={status} />
      </div>

      <InspectorDialog content={modal} onClose={() => setModal(null)} />
    </div>
  )
}
