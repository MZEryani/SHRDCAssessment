import { randomBytes } from 'node:crypto'
import { createServer as createTcpServer } from 'node:net'

export const DEFAULT_LEASE_TIMEOUT_MS = 30 * 60 * 1000
export const WS_CLOSE_LEASE_EXPIRED = 4008
export const WS_CLOSE_LOCK_HELD = 4009

function packBinaryFrame(connId, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const out = Buffer.allocUnsafe(4 + buf.length)
  out.writeUInt32BE(connId >>> 0, 0)
  buf.copy(out, 4)
  return out
}

function formatLeaseMinutes(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000))
  return `${mins}m`
}

/**
 * WebSocket-to-Modbus TCP bridge enforcing strict single-session ownership with a configurable timeout.
 */
export async function createModbusBridge({
  listenHost = '127.0.0.1',
  listenPort = 5020,
  leaseTimeoutMs = DEFAULT_LEASE_TIMEOUT_MS,
  now = () => Date.now(),
  onEvent = () => {},
} = {}) {
  let nextConnId = 1
  let totalPolls = 0
  let activeSession = null
  const tcpSockets = new Map() // connId -> { socket, remote, announced }
  const leaseLabel = formatLeaseMinutes(leaseTimeoutMs)

  function clearTcpSockets() {
    for (const entry of tcpSockets.values()) {
      entry.socket.destroy()
    }
    tcpSockets.clear()
  }

  function releaseSession(session, closeCode = 1000, closeReason = 'Session ended') {
    if (!session || activeSession !== session) return
    activeSession = null
    clearTcpSockets()
    try {
      session.ws.close(closeCode, closeReason)
    } catch {
      // Already closed
    }
    onEvent(`Modbus bridge session ${session.id} released (${closeReason})`)
  }

  function checkExpiry() {
    if (!activeSession) return false
    const elapsed = now() - activeSession.lastActivityAt
    if (elapsed >= leaseTimeoutMs) {
      releaseSession(activeSession, WS_CLOSE_LEASE_EXPIRED, `Session lease timeout (${leaseLabel}) exceeded`)
      return true
    }
    return false
  }

  function announceSocketToSession(session, id, entry) {
    if (!session || !session.listening || entry.announced) return
    entry.announced = true
    session.ws.sendText(
      JSON.stringify({
        type: 'connection',
        link: 0,
        id,
        remote: entry.remote,
        open: true,
      }),
    )
  }

  const tcpServer = createTcpServer((socket) => {
    checkExpiry()
    if (!activeSession) {
      socket.destroy()
      return
    }

    socket.setNoDelay(true)
    const id = nextConnId++
    const remote = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`
    const entry = { socket, remote, announced: false }
    tcpSockets.set(id, entry)

    if (activeSession.listening) {
      announceSocketToSession(activeSession, id, entry)
    }

    socket.on('data', (chunk) => {
      if (checkExpiry()) return
      if (!activeSession || !activeSession.listening) return
      totalPolls += 1
      activeSession.ws.sendBinary(packBinaryFrame(id, chunk))
    })

    socket.on('error', () => {
      // Peer disconnect handled in close
    })

    socket.on('close', () => {
      const existed = tcpSockets.delete(id)
      if (existed && entry.announced && activeSession) {
        activeSession.ws.sendText(
          JSON.stringify({
            type: 'connection',
            link: 0,
            id,
            remote,
            open: false,
          }),
        )
      }
    })
  })

  await new Promise((resolvePromise, reject) => {
    tcpServer.once('error', reject)
    tcpServer.listen(listenPort, listenHost, () => resolvePromise())
  })

  const addr = tcpServer.address()
  const actualTcpPort = typeof addr === 'object' && addr ? addr.port : listenPort

  const expiryTimer = setInterval(() => {
    checkExpiry()
  }, 15_000)
  expiryTimer.unref?.()

  function handleWebSocket(ws) {
    checkExpiry()
    if (activeSession) {
      const leaseRemainingMs = Math.max(0, leaseTimeoutMs - (now() - activeSession.lastActivityAt))
      ws.sendText(
        JSON.stringify({
          type: 'lock_rejected',
          reason: 'Another browser session currently holds the live Modbus TCP bridge.',
          leaseRemainingMs,
        }),
      )
      ws.close(WS_CLOSE_LOCK_HELD, 'Another browser session currently holds the live Modbus TCP bridge')
      onEvent('Rejected second concurrent Modbus bridge session (strict lock active)')
      return
    }

    const timestamp = now()
    const session = {
      id: randomBytes(6).toString('hex'),
      ws,
      listening: false,
      connectedAt: timestamp,
      lastActivityAt: timestamp,
    }
    activeSession = session
    onEvent(`Modbus bridge session ${session.id} acquired strict lock (${leaseLabel} lease)`)

    ws.sendText(
      JSON.stringify({
        type: 'bridge_ready',
        sessionId: session.id,
        leaseTimeoutMs,
        tcpPort: actualTcpPort,
      }),
    )

    ws.on('text', (raw) => {
      if (activeSession !== session) return
      if (checkExpiry()) return
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      session.lastActivityAt = now()

      if (msg.type === 'listen') {
        session.listening = true
        for (const [id, entry] of tcpSockets.entries()) {
          announceSocketToSession(session, id, entry)
        }
        onEvent(`Modbus bridge session ${session.id} listening for OpenPLC master polls`)
      } else if (msg.type === 'close') {
        session.listening = false
        clearTcpSockets()
      } else if (msg.type === 'drop' && typeof msg.id === 'number') {
        tcpSockets.get(msg.id)?.socket.destroy()
      }
    })

    ws.on('binary', (frame) => {
      if (activeSession !== session) return
      if (checkExpiry()) return
      if (!Buffer.isBuffer(frame) || frame.length < 4) return
      session.lastActivityAt = now()
      const connId = frame.readUInt32BE(0)
      const payload = frame.subarray(4)
      const entry = tcpSockets.get(connId)
      if (entry && !entry.socket.destroyed && payload.length > 0) {
        entry.socket.write(payload)
      }
    })

    ws.on('close', () => {
      releaseSession(session, 1000, 'Client disconnected')
    })

    ws.on('error', () => {
      releaseSession(session, 1006, 'Client socket error')
    })
  }

  function status() {
    checkExpiry()
    return {
      locked: activeSession !== null,
      sessionId: activeSession?.id ?? null,
      listening: activeSession?.listening ?? false,
      activeMasters: tcpSockets.size,
      polls: totalPolls,
      leaseTimeoutMs,
      leaseRemainingMs: activeSession
        ? Math.max(0, leaseTimeoutMs - (now() - activeSession.lastActivityAt))
        : null,
      tcpPort: actualTcpPort,
    }
  }

  async function close() {
    clearInterval(expiryTimer)
    if (activeSession) {
      releaseSession(activeSession, 1001, 'Server shutting down')
    }
    clearTcpSockets()
    await new Promise((resolvePromise) => {
      tcpServer.close(() => resolvePromise())
    })
  }

  return {
    tcpPort: actualTcpPort,
    handleWebSocket,
    checkExpiry,
    status,
    close,
  }
}
