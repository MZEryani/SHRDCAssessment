export interface OpenPlcStatus {
  activeCell: string | null
  plcStatus: string
  version: string | null
  md5: string | null
  lastDeployedAt: string | null
}

export interface BridgeStatus {
  locked: boolean
  sessionId: string | null
  listening: boolean
  activeMasters: number
  polls: number
  leaseTimeoutMs: number
  leaseRemainingMs: number | null
  tcpPort: number
}

export interface QuotaStatus {
  day: string
  used: number
  cap: number
  remaining: number
}

export interface ActiveJob {
  id: string
  slug: string
  prompt: string
  startedAt: string
  stage: string
  model: string | null
  logs: string[]
}

export interface LastGenResult {
  ok: boolean
  jobId: string
  slug: string
  runId?: string | null
  stage?: string | null
  error?: string
  durationMs?: number | null
  costUsd?: number | null
  finishedAt: string
}

export interface GenerationStatus {
  running: boolean
  activeJob: ActiveJob | null
  lastResult: LastGenResult | null
  quota: QuotaStatus
}

export interface PortalStatusResponse {
  ok: boolean
  openplc: OpenPlcStatus
  bridge: BridgeStatus
  generation: GenerationStatus
  events: string[]
}

export interface CellSummary {
  slug: string
  protected: boolean
  signalCount: number
  capturedAt: string | null
  hasReport: boolean
}

export interface IoSignal {
  name: string
  iecAddress: string
  type: string
  direction: 'oip_to_plc' | 'plc_to_oip'
  modbusArea: string
  modbusAddress: number
  contact?: string
  description?: string
}

export interface CellDetails {
  slug: string
  protected: boolean
  stSource: string
  ioContract: {
    name?: string
    version?: string
    signals?: IoSignal[]
  } | null
  processSpec: string
  generationReport: Record<string, unknown> | null
}

export interface ProofResponse {
  markdown: string
  json: Record<string, unknown>
}

export interface DeployResponse {
  ok: boolean
  slug: string
  version: string
  md5: string
  compilationStatus: string
  plcStatus: string
  launchUrl: string
  error?: string
}
