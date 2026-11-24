import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 2 * 1024 * 1024

function encodeFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf ?? '')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Minimal RFC 6455 WebSocket server connection over an upgraded Node net.Socket (zero external dependencies).
 */
export function acceptWebSocket(req, socket, head = Buffer.alloc(0)) {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }

  const accept = createHash('sha1').update(`${key}${WS_MAGIC_GUID}`).digest('base64')
  socket.setNoDelay(true)
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  )

  const conn = new EventEmitter()
  let closed = false
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
  let fragmentedOpcode = null
  let fragmentedChunks = []

  function finishClose(code = 1000, reason = '') {
    if (closed) return
    closed = true
    conn.readyState = 3
    conn.emit('close', { code, reason })
  }

  conn.readyState = 1 // OPEN

  conn.sendText = (text) => {
    if (closed || socket.destroyed) return
    socket.write(encodeFrame(0x01, Buffer.from(String(text), 'utf8')))
  }

  conn.sendBinary = (buf) => {
    if (closed || socket.destroyed) return
    socket.write(encodeFrame(0x02, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)))
  }

  conn.ping = () => {
    if (closed || socket.destroyed) return
    socket.write(encodeFrame(0x09, Buffer.alloc(0)))
  }

  conn.close = (code = 1000, reason = '') => {
    if (closed) return
    const reasonBuf = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, 123)
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    if (!socket.destroyed) {
      try {
        socket.write(encodeFrame(0x08, payload))
        socket.end()
      } catch {
        socket.destroy()
      }
    }
    finishClose(code, reasonBuf.toString('utf8'))
  }

  function processBuffer() {
    while (!closed && buffer.length >= 2) {
      const b0 = buffer[0]
      const b1 = buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (buffer.length < 4) return
        payloadLen = buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_FRAME_BYTES)) {
          conn.close(1009, 'Frame too large')
          return
        }
        payloadLen = Number(big)
        offset = 10
      }

      if (payloadLen > MAX_FRAME_BYTES) {
        conn.close(1009, 'Frame too large')
        return
      }

      const maskLen = masked ? 4 : 0
      if (buffer.length < offset + maskLen + payloadLen) return

      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null
      offset += maskLen
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen))
      buffer = buffer.subarray(offset + payloadLen)

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3]
        }
      }

      if (opcode === 0x08) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        conn.close(code, reason)
        return
      }
      if (opcode === 0x09) {
        if (!socket.destroyed) socket.write(encodeFrame(0x0a, payload))
        continue
      }
      if (opcode === 0x0a) {
        conn.emit('pong', payload)
        continue
      }

      let effectiveOpcode = opcode
      let completePayload = payload

      if (opcode === 0x00) {
        if (fragmentedOpcode === null) {
          conn.close(1002, 'Unexpected continuation frame')
          return
        }
        fragmentedChunks.push(payload)
        if (!fin) continue
        effectiveOpcode = fragmentedOpcode
        completePayload = Buffer.concat(fragmentedChunks)
        fragmentedOpcode = null
        fragmentedChunks = []
      } else if (!fin) {
        fragmentedOpcode = opcode
        fragmentedChunks = [payload]
        continue
      }

      if (effectiveOpcode === 0x01) {
        conn.emit('text', completePayload.toString('utf8'))
      } else if (effectiveOpcode === 0x02) {
        conn.emit('binary', completePayload)
      }
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
    processBuffer()
  })

  socket.on('error', (err) => {
    conn.emit('error', err)
    finishClose(1006, 'Socket error')
  })

  socket.on('close', () => {
    finishClose(1006, 'Socket closed')
  })

  if (buffer.length > 0) processBuffer()
  return conn
}
