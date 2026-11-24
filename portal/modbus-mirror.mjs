export const DEFAULT_HEARTBEAT_MS = 400

function rangeKey(fc, start, qty) {
  return `${fc}:${start}:${qty}`
}

/**
 * Reassemble arbitrary TCP stream chunks into complete Modbus TCP MBAP frames.
 */
export function createModbusTcpParser() {
  let buf = Buffer.alloc(0)

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return []
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk])
      const frames = []
      while (buf.length >= 6) {
        const mbapLen = buf.readUInt16BE(4)
        const totalLen = 6 + mbapLen
        if (mbapLen < 2 || totalLen > 260) {
          // Malformed MBAP length; reset buffer to avoid wedging the stream
          buf = Buffer.alloc(0)
          break
        }
        if (buf.length < totalLen) break
        frames.push(buf.subarray(0, totalLen))
        buf = buf.subarray(totalLen)
      }
      return frames
    },
    reset() {
      buf = Buffer.alloc(0)
    },
  }
}

function buildReadReply(txId, protoId, unitId, fc, dataBuf) {
  const out = Buffer.allocUnsafe(9 + dataBuf.length)
  out.writeUInt16BE(txId, 0)
  out.writeUInt16BE(protoId, 2)
  out.writeUInt16BE(3 + dataBuf.length, 4)
  out.writeUInt8(unitId, 6)
  out.writeUInt8(fc, 7)
  out.writeUInt8(dataBuf.length, 8)
  dataBuf.copy(out, 9)
  return out
}

function buildWriteMultiReply(frame) {
  const out = Buffer.allocUnsafe(12)
  frame.copy(out, 0, 0, 12)
  out.writeUInt16BE(6, 4)
  return out
}

/**
 * Decoupled Modbus TCP Edge Mirror with Report-by-Exception (change-of-value) push.
 * Answers OpenPLC locally in <1ms while syncing sensor/actuator deltas asynchronously over WSS.
 */
export function createModbusEdgeMirror({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  now = () => Date.now(),
} = {}) {
  const watchedInputs = new Map() // key -> { unitId, fc, start, qty }
  const inputCache = new Map() // key -> Buffer
  const outputCache = new Map() // key -> Buffer (last written bytes)
  const pendingForwardReads = new Map() // txId -> { fc, start, qty, expectedBytes }
  let lastBrowserPushAt = 0

  function expectedReadBytes(fc, qty) {
    return fc === 1 || fc === 2 ? Math.ceil(qty / 8) : qty * 2
  }

  function applyBrowserInputUpdate({ fc, start, qty, data }) {
    const key = rangeKey(fc, start, qty)
    const buf = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data)
    if (buf.length !== expectedReadBytes(fc, qty)) return false
    inputCache.set(key, buf)
    return true
  }

  function observeBrowserReply(replyFrame) {
    if (!Buffer.isBuffer(replyFrame) || replyFrame.length < 9) return
    const txId = replyFrame.readUInt16BE(0)
    const pending = pendingForwardReads.get(txId)
    if (!pending) return
    pendingForwardReads.delete(txId)
    const fc = replyFrame.readUInt8(7)
    if (fc !== pending.fc) return
    const byteCount = replyFrame.readUInt8(8)
    if (byteCount !== pending.expectedBytes || replyFrame.length < 9 + byteCount) return
    inputCache.set(
      rangeKey(pending.fc, pending.start, pending.qty),
      Buffer.from(replyFrame.subarray(9, 9 + byteCount)),
    )
  }

  function handlePlcFrame(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 8) {
      return { mode: 'forward', watchChanged: false }
    }
    const txId = frame.readUInt16BE(0)
    const protoId = frame.readUInt16BE(2)
    const unitId = frame.readUInt8(6)
    const fc = frame.readUInt8(7)

    // FC 2 (Read Discrete Inputs) & FC 4 (Read Input Registers)
    if ((fc === 2 || fc === 4) && frame.length >= 12) {
      const start = frame.readUInt16BE(8)
      const qty = frame.readUInt16BE(10)
      const key = rangeKey(fc, start, qty)
      let watchChanged = false
      if (!watchedInputs.has(key)) {
        watchedInputs.set(key, { unitId, fc, start, qty })
        watchChanged = true
      }

      const cached = inputCache.get(key)
      if (!cached) {
        // Fail-safe: forward the initial unseeded read synchronously so OpenPLC sees real NC E-Stop
        pendingForwardReads.set(txId, {
          fc,
          start,
          qty,
          expectedBytes: expectedReadBytes(fc, qty),
        })
        if (pendingForwardReads.size > 64) {
          const oldest = pendingForwardReads.keys().next().value
          pendingForwardReads.delete(oldest)
        }
        return { mode: 'forward', watchChanged }
      }

      return {
        mode: 'reply',
        replyFrame: buildReadReply(txId, protoId, unitId, fc, cached),
        watchChanged,
        pushToBrowser: null,
      }
    }

    // FC 15 (Write Multiple Coils) & FC 16 (Write Multiple Registers)
    if ((fc === 15 || fc === 16) && frame.length >= 13) {
      const start = frame.readUInt16BE(8)
      const qty = frame.readUInt16BE(10)
      const byteCount = frame.readUInt8(12)
      if (frame.length < 13 + byteCount) {
        return { mode: 'forward', watchChanged: false }
      }
      const payload = frame.subarray(13, 13 + byteCount)
      const key = rangeKey(fc, start, qty)
      const prev = outputCache.get(key)
      const changed = !prev || !prev.equals(payload)
      if (changed) {
        outputCache.set(key, Buffer.from(payload))
      }

      const t = now()
      const shouldPush = changed || t - lastBrowserPushAt >= heartbeatMs
      if (shouldPush) lastBrowserPushAt = t

      return {
        mode: 'reply',
        replyFrame: buildWriteMultiReply(frame),
        watchChanged: false,
        pushToBrowser: shouldPush ? frame : null,
      }
    }

    // FC 5 (Write Single Coil) & FC 6 (Write Single Register)
    if ((fc === 5 || fc === 6) && frame.length >= 12) {
      const addr = frame.readUInt16BE(8)
      const valBuf = frame.subarray(10, 12)
      const key = rangeKey(fc, addr, 1)
      const prev = outputCache.get(key)
      const changed = !prev || !prev.equals(valBuf)
      if (changed) {
        outputCache.set(key, Buffer.from(valBuf))
      }

      const t = now()
      const shouldPush = changed || t - lastBrowserPushAt >= heartbeatMs
      if (shouldPush) lastBrowserPushAt = t

      return {
        mode: 'reply',
        replyFrame: Buffer.from(frame),
        watchChanged: false,
        pushToBrowser: shouldPush ? frame : null,
      }
    }

    // FC 1 (Read Coils) & FC 3 (Read Holding Registers)
    if ((fc === 1 || fc === 3) && frame.length >= 12) {
      const start = frame.readUInt16BE(8)
      const qty = frame.readUInt16BE(10)
      const writeFc = fc === 1 ? 15 : 16
      const cached = outputCache.get(rangeKey(writeFc, start, qty))
      if (cached && cached.length === expectedReadBytes(fc, qty)) {
        return {
          mode: 'reply',
          replyFrame: buildReadReply(txId, protoId, unitId, fc, cached),
          watchChanged: false,
          pushToBrowser: null,
        }
      }
    }

    return { mode: 'forward', watchChanged: false }
  }

  function getWatchedRanges() {
    return [...watchedInputs.values()]
  }

  return {
    handlePlcFrame,
    applyBrowserInputUpdate,
    observeBrowserReply,
    getWatchedRanges,
  }
}
