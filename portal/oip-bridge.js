/* Pre-boot bridge injected before OIP's module graph and SES realm lockdown.
 * Implements OIP's window.oipPlcIo (WSS <-> EC2 Modbus TCP :5020) and read-only
 * window.oipProject (auto-opening ?cell=<slug> without confirm popups or disk writes),
 * plus a compact floating OpenPLC status pill overlaid on the full-viewport OIP tab.
 */
;(function initOipEc2Bridge() {
  'use strict'

  const params = new URLSearchParams(window.location.search)
  const requestedCell = (params.get('cell') || 'conveyor-cell').trim().toLowerCase()
  const CELL_SLUG_RX = /^[a-z0-9][a-z0-9_-]*$/
  const cellSlug = CELL_SLUG_RX.test(requestedCell) ? requestedCell : 'conveyor-cell'
  const cellRoot = `ec2://scenes/${cellSlug}`
  const OPEN_MARKER_KEY = 'oip-ec2-opened-cell'
  const FOLDERS_STORAGE_KEY = 'oip-ec2-remembered-folders'
  const WS_CLOSE_LOCK_HELD = 4009

  // ── 1. Read-only window.oipProject bridge (sessionStorage-backed across OIP reload) ──
  const openPathListeners = new Set()
  const folderCache = new Map()

  function loadRememberedMap() {
    try {
      const raw = window.sessionStorage.getItem(FOLDERS_STORAGE_KEY)
      if (!raw) return new Map()
      const entries = JSON.parse(raw)
      return new Map(Array.isArray(entries) ? entries : [])
    } catch {
      return new Map()
    }
  }

  function saveRememberedMap(map) {
    try {
      window.sessionStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify([...map.entries()]))
    } catch {
      // Ignore storage quota / privacy restrictions
    }
  }

  const rememberedFolders = loadRememberedMap()

  function upsertRemembered(docId, patch) {
    const prev = rememberedFolders.get(docId) || { docId }
    rememberedFolders.set(docId, { ...prev, ...patch })
    saveRememberedMap(rememberedFolders)
  }

  function decodeBase64ToUint8Array(b64) {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function slugFromRoot(root) {
    const match = /^ec2:\/\/scenes\/([a-z0-9][a-z0-9_-]*)$/i.exec(String(root || '').trim())
    return match ? match[1].toLowerCase() : null
  }

  async function fetchFolder(slug) {
    if (folderCache.has(slug)) return folderCache.get(slug)
    const res = await fetch(`/api/cells/${encodeURIComponent(slug)}/oip-folder`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!res.ok) {
      return { root: `ec2://scenes/${slug}`, files: [], docId: null, error: `HTTP ${res.status}` }
    }
    const data = await res.json()
    const files = (data.files || []).map((f) => ({
      path: f.path,
      contents: f.encoding === 'base64' ? decodeBase64ToUint8Array(f.contents) : f.contents,
    }))
    const record = {
      root: data.root || `ec2://scenes/${slug}`,
      docId: data.docId || `ec2-cell-${slug}`,
      signature: data.signature || 'ec2-ro',
      files,
    }
    folderCache.set(slug, record)
    upsertRemembered(record.docId, {
      path: record.root,
      name: slug,
      signature: record.signature,
      baseline: null,
      openedAt: Date.now(),
    })
    return record
  }

  // Omit optional openWindow / focusFolder so opening a second tab never trips openElsewhere()
  window.oipProject = {
    pickOpenFolder: async () => null,
    pickSaveFolder: async () => null,
    readAt: async (root) => {
      const slug = slugFromRoot(root)
      if (!slug) return { root: String(root), files: [], docId: null, error: 'Unsupported EC2 folder path' }
      const loaded = await fetchFolder(slug)
      return {
        root: loaded.root,
        files: loaded.files,
        docId: loaded.docId,
        ...(loaded.error ? { error: loaded.error } : {}),
      }
    },
    signature: async (root) => {
      const slug = slugFromRoot(root)
      if (!slug) return { error: 'Unsupported EC2 folder path' }
      const loaded = await fetchFolder(slug)
      if (loaded.error) return { error: loaded.error }
      return { signature: loaded.signature }
    },
    // Strictly read-only: browser edits stay local and never mutate EC2 disk or dirty git
    write: async () => ({ moved: [], failed: [], error: null }),
    writeSync: () => ({ moved: [], failed: [], error: null }),
    createFolder: async () => ({ error: 'Read-only EC2 demo environment' }),
    attach: () => {},
    reveal: async () => 'Read-only EC2 demo environment',
    recall: async (docId) => rememberedFolders.get(docId) || null,
    folders: async () => [...rememberedFolders.values()],
    remember: async (docId, patch) => {
      upsertRemembered(docId, patch)
    },
    rememberSync: (docId, patch) => {
      upsertRemembered(docId, patch)
      return true
    },
    detach: async () => {},
    forget: async () => {},
    takePendingOpen: async () => {
      try {
        if (window.sessionStorage.getItem(OPEN_MARKER_KEY) === cellSlug) {
          return null
        }
        window.sessionStorage.setItem(OPEN_MARKER_KEY, cellSlug)
      } catch {
        // Ignore storage restrictions
      }
      return cellRoot
    },
    onOpenPath: (cb) => {
      openPathListeners.add(cb)
      return () => openPathListeners.delete(cb)
    },
    showingDocument: () => {},
  }

  // ── 2. Binary WebSocket <-> EC2 Modbus TCP window.oipPlcIo bridge ──────────
  const connectionListeners = new Set()
  const dataListeners = new Set()

  const bridgeUiState = {
    phase: 'idle', // idle | connecting | listening | locked | error
    polls: 0,
    masters: 0,
    plcStatus: 'CHECKING',
    runtimeVersion: '',
    activeCell: cellSlug,
    leaseMinutes: 30,
    remoteLocked: false,
    lockMessage: '',
  }

  let ws = null
  let wsOpenPromise = null
  let pillUpdater = null
  let activeConnId = null
  let watchedRanges = []
  let localPollTimer = null
  let localTxSeq = 0xf000
  const pendingLocalReads = new Map()
  const lastSentInputB64 = new Map()
  const mirroredWriteTxIds = new Set()

  function bytesToBase64(u8) {
    let bin = ''
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
    return btoa(bin)
  }

  function buildLocalReadFrame(txId, unitId, fc, start, qty) {
    const buf = new Uint8Array(12)
    const view = new DataView(buf.buffer)
    view.setUint16(0, txId, false)
    view.setUint16(2, 0, false)
    view.setUint16(4, 6, false)
    view.setUint8(6, unitId & 0xff)
    view.setUint8(7, fc & 0xff)
    view.setUint16(8, start, false)
    view.setUint16(10, qty, false)
    return buf
  }

  function stopLocalPoll() {
    if (localPollTimer !== null) {
      window.clearInterval(localPollTimer)
      localPollTimer = null
    }
    pendingLocalReads.clear()
    lastSentInputB64.clear()
    mirroredWriteTxIds.clear()
  }

  function ensureLocalPoll() {
    if (localPollTimer !== null || activeConnId === null || watchedRanges.length === 0) return
    localPollTimer = window.setInterval(() => {
      if (activeConnId === null || !ws || ws.readyState !== WebSocket.OPEN) return
      for (const r of watchedRanges) {
        localTxSeq = localTxSeq >= 0xfffe ? 0xf000 : localTxSeq + 1
        const txId = localTxSeq
        pendingLocalReads.set(txId, r)
        if (pendingLocalReads.size > 32) {
          const oldest = pendingLocalReads.keys().next().value
          pendingLocalReads.delete(oldest)
        }
        const frame = buildLocalReadFrame(txId, r.unitId ?? 1, r.fc, r.start, r.qty)
        for (const cb of dataListeners) {
          try {
            cb({ link: 0, id: activeConnId, bytes: frame })
          } catch {}
        }
      }
    }, 20)
  }

  function notifyPill() {
    if (typeof pillUpdater === 'function') pillUpdater()
  }

  function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/ws/modbus`
  }

  function decodeBinaryModbusFrame(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null
    const view = new DataView(buffer)
    const id = view.getUint32(0, false)
    const bytes = new Uint8Array(buffer, 4)
    return { id, bytes }
  }

  function encodeBinaryModbusFrame(id, bytes) {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const out = new Uint8Array(4 + payload.byteLength)
    const view = new DataView(out.buffer)
    view.setUint32(0, id >>> 0, false)
    out.set(payload, 4)
    return out
  }

  function openBridgeSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return Promise.resolve({ error: '' })
    }
    if (wsOpenPromise) return wsOpenPromise

    bridgeUiState.phase = 'connecting'
    bridgeUiState.lockMessage = ''
    notifyPill()

    wsOpenPromise = new Promise((resolvePromise) => {
      let settled = false
      const settle = (res) => {
        if (settled) return
        settled = true
        wsOpenPromise = null
        resolvePromise(res)
      }

      const socket = new WebSocket(wsUrl())
      socket.binaryType = 'arraybuffer'
      ws = socket

      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          let msg
          try {
            msg = JSON.parse(event.data)
          } catch {
            return
          }
          if (msg.type === 'bridge_ready') {
            bridgeUiState.phase = 'listening'
            bridgeUiState.remoteLocked = false
            bridgeUiState.lockMessage = ''
            if (typeof msg.leaseTimeoutMs === 'number') {
              bridgeUiState.leaseMinutes = Math.max(1, Math.round(msg.leaseTimeoutMs / 60000))
            }
            notifyPill()
            settle({ error: '' })
          } else if (msg.type === 'lock_rejected') {
            bridgeUiState.phase = 'locked'
            bridgeUiState.remoteLocked = true
            bridgeUiState.lockMessage = msg.reason || 'Live Modbus bridge is held by another session.'
            notifyPill()
            settle({ error: bridgeUiState.lockMessage })
          } else if (msg.type === 'watch_inputs') {
            watchedRanges = Array.isArray(msg.ranges) ? msg.ranges : []
            ensureLocalPoll()
          } else if (msg.type === 'connection') {
            bridgeUiState.masters = Math.max(0, bridgeUiState.masters + (msg.open ? 1 : -1))
            if (msg.open) {
              activeConnId = msg.id
              ensureLocalPoll()
            } else if (activeConnId === msg.id) {
              activeConnId = null
              stopLocalPoll()
            }
            notifyPill()
            for (const cb of connectionListeners) {
              try {
                cb({ link: msg.link ?? 0, id: msg.id, remote: msg.remote, open: Boolean(msg.open) })
              } catch {}
            }
          }
          return
        }

        const frame = decodeBinaryModbusFrame(event.data)
        if (!frame) return
        if (frame.bytes.length >= 8) {
          const fc = frame.bytes[7]
          if (fc === 5 || fc === 6 || fc === 15 || fc === 16) {
            const txId = (frame.bytes[0] << 8) | frame.bytes[1]
            mirroredWriteTxIds.add(txId)
            if (mirroredWriteTxIds.size > 64) {
              const oldest = mirroredWriteTxIds.values().next().value
              mirroredWriteTxIds.delete(oldest)
            }
          }
        }
        bridgeUiState.polls += 1
        notifyPill()
        for (const cb of dataListeners) {
          try {
            cb({ link: 0, id: frame.id, bytes: frame.bytes })
          } catch {}
        }
      })

      socket.addEventListener('error', () => {
        if (bridgeUiState.phase !== 'locked') {
          bridgeUiState.phase = 'error'
          notifyPill()
        }
        settle({ error: 'WebSocket connection to EC2 Modbus bridge failed.' })
      })

      socket.addEventListener('close', (ev) => {
        if (ws === socket) ws = null
        activeConnId = null
        watchedRanges = []
        stopLocalPoll()
        bridgeUiState.masters = 0
        if (ev.code === WS_CLOSE_LOCK_HELD) {
          bridgeUiState.phase = 'locked'
          bridgeUiState.remoteLocked = true
          bridgeUiState.lockMessage = ev.reason || 'Another browser tab currently owns the live Modbus bridge.'
          settle({ error: bridgeUiState.lockMessage })
        } else {
          if (bridgeUiState.phase !== 'locked') bridgeUiState.phase = 'idle'
          settle({ error: 'WebSocket connection closed before bridge became ready.' })
        }
        notifyPill()
      })
    })

    return wsOpenPromise
  }

  window.oipPlcIo = {
    listen: async (opts) => {
      const opened = await openBridgeSocket()
      if (opened.error) return opened
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'listen',
            link: opts?.link ?? 0,
            host: opts?.host ?? '127.0.0.1',
            port: opts?.port ?? 5020,
            mirror: true,
          }),
        )
        bridgeUiState.phase = 'listening'
        notifyPill()
        return { error: '' }
      }
      return { error: 'EC2 Modbus bridge socket is not open.' }
    },
    connect: async () => ({
      error: 'EC2 demo uses OIP Modbus TCP Server mode (ADR-0001).',
      id: 0,
    }),
    close: async (opts) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'close', link: opts?.link ?? 0 }))
          ws.close(1000, 'OIP stopped')
        } catch {}
      }
      ws = null
      activeConnId = null
      watchedRanges = []
      stopLocalPoll()
      bridgeUiState.masters = 0
      bridgeUiState.phase = 'idle'
      notifyPill()
    },
    onConnection: (cb) => {
      connectionListeners.add(cb)
      return () => connectionListeners.delete(cb)
    },
    onData: (cb) => {
      dataListeners.add(cb)
      return () => dataListeners.delete(cb)
    },
    write: (id, bytes) => {
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      if (payload.length >= 8) {
        const txId = (payload[0] << 8) | payload[1]
        // 1. Intercept browser-local 20ms sensor poll replies and push only on change
        const localReq = pendingLocalReads.get(txId)
        if (localReq) {
          pendingLocalReads.delete(txId)
          if (payload.length >= 9 && payload[7] === localReq.fc) {
            const byteCount = payload[8]
            if (payload.length >= 9 + byteCount) {
              const dataSlice = payload.subarray(9, 9 + byteCount)
              const b64 = bytesToBase64(dataSlice)
              const key = `${localReq.fc}:${localReq.start}:${localReq.qty}`
              if (lastSentInputB64.get(key) !== b64) {
                lastSentInputB64.set(key, b64)
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'input_update',
                      fc: localReq.fc,
                      start: localReq.start,
                      qty: localReq.qty,
                      b64,
                    }),
                  )
                }
              }
            }
          }
          return
        }
        // 2. Absorb local write-acks for server-pushed mirrored output writes (EC2 already acked PLC)
        if (mirroredWriteTxIds.delete(txId)) {
          return
        }
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeBinaryModbusFrame(id, payload))
      }
    },
    drop: (id) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'drop', id }))
      }
    },
  }

  // ── 3. Floating OpenPLC Status Pill (Shadow DOM isolated from OIP CSS) ─────
  async function refreshRuntimeStatus() {
    try {
      const res = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      bridgeUiState.plcStatus = data.openplc?.plcStatus || 'UNKNOWN'
      bridgeUiState.runtimeVersion = data.openplc?.version || ''
      if (data.openplc?.activeCell) bridgeUiState.activeCell = data.openplc.activeCell
      if (typeof data.bridge?.polls === 'number' && data.bridge.polls > bridgeUiState.polls) {
        bridgeUiState.polls = data.bridge.polls
      }
      if (typeof data.bridge?.leaseTimeoutMs === 'number') {
        bridgeUiState.leaseMinutes = Math.max(1, Math.round(data.bridge.leaseTimeoutMs / 60000))
      }
      // Surface strict lock held by another tab even before Play is pressed
      bridgeUiState.remoteLocked = Boolean(data.bridge?.locked) && !(ws && ws.readyState === WebSocket.OPEN)
      notifyPill()
    } catch {
      // Non-fatal telemetry poll failure
    }
  }

  function mountStatusPill() {
    if (!document.body || document.getElementById('oip-ec2-status-host')) return
    const host = document.createElement('div')
    host.id = 'oip-ec2-status-host'
    host.style.cssText =
      'position:fixed;bottom:14px;left:14px;z-index:2147483647;pointer-events:auto;'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: "Fira Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .pill {
          display: inline-flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          padding: 7px 12px;
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.92);
          color: #f8fafc;
          border: 1px solid rgba(51, 65, 85, 0.85);
          box-shadow: 0 10px 28px rgba(2, 6, 23, 0.45);
          font-size: 12px;
          line-height: 1.3;
          backdrop-filter: blur(10px);
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #94a3b8;
          display: inline-block;
          flex: none;
        }
        .dot.ok { background: #22c55e; box-shadow: 0 0 8px rgba(34, 197, 94, 0.6); }
        .dot.warn { background: #f59e0b; }
        .dot.err { background: #f87171; }
        .sep { color: #475569; }
        .muted { color: #94a3b8; }
        .mono {
          font-family: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
        }
        a.back {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: #f8fafc;
          background: rgba(37, 99, 235, 0.22);
          text-decoration: none;
          font-weight: 600;
          padding: 3px 9px;
          border-radius: 7px;
          border: 1px solid rgba(59, 130, 246, 0.5);
          transition: background 150ms ease, border-color 150ms ease;
        }
        a.back:hover {
          background: rgba(37, 99, 235, 0.38);
          border-color: rgba(96, 165, 250, 0.8);
        }
        a.back:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
        svg { width: 12px; height: 12px; flex: none; }
      </style>
      <div class="pill" role="status" aria-live="polite">
        <span class="dot" id="dot" aria-hidden="true"></span>
        <strong id="status-text">OpenPLC · Press Play</strong>
        <span class="sep" aria-hidden="true">·</span>
        <span class="muted mono" id="polls-text">0 polls</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="muted mono" id="lock-text">${cellSlug}</span>
        <a class="back" href="/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
          <span>Console</span>
        </a>
      </div>
    `
    document.body.appendChild(host)

    const dotEl = shadow.getElementById('dot')
    const statusEl = shadow.getElementById('status-text')
    const pollsEl = shadow.getElementById('polls-text')
    const lockEl = shadow.getElementById('lock-text')

    pillUpdater = () => {
      const ver = bridgeUiState.runtimeVersion ? ` ${bridgeUiState.runtimeVersion}` : ''
      if (bridgeUiState.phase === 'locked' || bridgeUiState.remoteLocked) {
        dotEl.className = 'dot warn'
        statusEl.textContent = 'Strict Lock: Active in Another Tab'
        lockEl.textContent = bridgeUiState.lockMessage || 'Read-only until active tab disconnects'
      } else if (bridgeUiState.phase === 'error') {
        dotEl.className = 'dot err'
        statusEl.textContent = 'Modbus Bridge Error'
        lockEl.textContent = 'Check OpenPLC Runtime'
      } else if (bridgeUiState.phase === 'listening') {
        dotEl.className = bridgeUiState.masters > 0 ? 'dot ok' : 'dot warn'
        statusEl.textContent =
          bridgeUiState.masters > 0
            ? `OpenPLC${ver} · ${bridgeUiState.plcStatus} · Live Modbus`
            : `OpenPLC${ver} · Waiting for Master Poll`
        lockEl.textContent = `Strict Lock (${bridgeUiState.leaseMinutes}m) · ${cellSlug}`
      } else {
        dotEl.className = 'dot'
        statusEl.textContent = `OpenPLC${ver} (${bridgeUiState.plcStatus}) · Press Play`
        lockEl.textContent = `Read-Only · ${cellSlug}`
      }
      pollsEl.textContent = `${bridgeUiState.polls.toLocaleString()} polls`
    }

    pillUpdater()
    void refreshRuntimeStatus()
    window.setInterval(() => void refreshRuntimeStatus(), 4000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountStatusPill, { once: true })
  } else {
    mountStatusPill()
  }
})()
