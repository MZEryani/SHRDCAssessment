import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { describe, it, after } from 'node:test'
import { resolve } from 'node:path'
import { deployProgram } from '../scripts/openplc-deploy.mjs'

const MODBUS_PORT = Number(process.env.OIP_MODBUS_PORT ?? 5020)
const OPENPLC_URL = process.env.OPENPLC_URL ?? 'https://127.0.0.1:8443'

/**
 * Minimal Modbus TCP server implementing the exact subset OIP's ModbusServerIo serves:
 * - FC 2 (Read Discrete Inputs) -> reads discreteInputs[]
 * - FC 5 (Write Single Coil)    -> writes coils[addr]
 * - FC 15 (Write Multiple Coils)-> writes coils[addr..addr+qty-1]
 */
function startModbusServer({ host = '0.0.0.0', port = MODBUS_PORT } = {}) {
  const discreteInputs = new Array(16).fill(false)
  const coils = new Array(16).fill(false)
  const stats = { fc2Reads: 0, coilWrites: 0 }
  const sockets = new Set()

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    let buf = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 6) {
        const len = buf.readUInt16BE(4)
        const frameLen = 6 + len
        if (buf.length < frameLen) break

        const frame = buf.subarray(0, frameLen)
        buf = buf.subarray(frameLen)

        const txId = frame.readUInt16BE(0)
        const protoId = frame.readUInt16BE(2)
        const unitId = frame.readUInt8(6)
        const fc = frame.readUInt8(7)

        let pdu
        if (fc === 2) {
          // Read Discrete Inputs
          const start = frame.readUInt16BE(8)
          const qty = frame.readUInt16BE(10)
          const byteCount = Math.ceil(qty / 8)
          const bytes = Buffer.alloc(byteCount)
          for (let i = 0; i < qty; i++) {
            if (discreteInputs[start + i]) {
              bytes[Math.floor(i / 8)] |= 1 << (i % 8)
            }
          }
          stats.fc2Reads++
          pdu = Buffer.concat([Buffer.from([fc, byteCount]), bytes])
        } else if (fc === 5) {
          // Write Single Coil
          const addr = frame.readUInt16BE(8)
          const val = frame.readUInt16BE(10)
          coils[addr] = val === 0xff00
          stats.coilWrites++
          pdu = frame.subarray(7, 12)
        } else if (fc === 15) {
          // Write Multiple Coils
          const start = frame.readUInt16BE(8)
          const qty = frame.readUInt16BE(10)
          const dataOffset = 13
          for (let i = 0; i < qty; i++) {
            const byte = frame.readUInt8(dataOffset + Math.floor(i / 8))
            coils[start + i] = Boolean((byte >> (i % 8)) & 1)
          }
          stats.coilWrites++
          pdu = frame.subarray(7, 12)
        } else {
          // Illegal function exception
          pdu = Buffer.from([fc | 0x80, 0x01])
        }

        const mbap = Buffer.alloc(7)
        mbap.writeUInt16BE(txId, 0)
        mbap.writeUInt16BE(protoId, 2)
        mbap.writeUInt16BE(pdu.length + 1, 4)
        mbap.writeUInt8(unitId, 6)
        socket.write(Buffer.concat([mbap, pdu]))
      }
    })

    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolvePromise({
        discreteInputs,
        coils,
        stats,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)
}

describe('Tracer Bullet: OpenPLC v4 (Docker Master) <-> OIP Modbus TCP Server', () => {
  let modbus
  let client

  after(async () => {
    if (client) await client.stop().catch(() => {})
    if (modbus) await modbus.close()
  })

  it('reads %IX0.4 (PhotoEye) from Modbus server and drives %QX0.0 (Conveyor_Run) end-to-end', async () => {
    modbus = await startModbusServer({ host: '0.0.0.0', port: MODBUS_PORT })

    const deployed = await deployProgram({
      stPath: resolve('openplc/tracer_bullet.st'),
      modbusMasterPath: resolve('openplc/tracer_modbus_master.json'),
      runtimeUrl: OPENPLC_URL,
      startAfterDeploy: true,
    })
    client = deployed.client
    assert.equal(deployed.compilationStatus, 'SUCCESS')

    // PhotoEye clear (%IX0.4 = 0) => Conveyor_Run ON (%QX0.0 = 1)
    modbus.discreteInputs[4] = false
    await waitFor(() => modbus.stats.fc2Reads > 0 && modbus.stats.coilWrites > 0 && modbus.coils[0] === true, {
      timeoutMs: 8000,
      label: 'Conveyor_Run (%QX0.0) to turn ON when PhotoEye (%IX0.4) is clear',
    })

    // Box blocks PhotoEye (%IX0.4 = 1) => Conveyor_Run OFF (%QX0.0 = 0)
    modbus.discreteInputs[4] = true
    await waitFor(() => modbus.coils[0] === false, {
      timeoutMs: 3000,
      label: 'Conveyor_Run (%QX0.0) to turn OFF when PhotoEye (%IX0.4) is blocked',
    })

    // Box clears PhotoEye (%IX0.4 = 0) => Conveyor_Run ON (%QX0.0 = 1)
    modbus.discreteInputs[4] = false
    await waitFor(() => modbus.coils[0] === true, {
      timeoutMs: 3000,
      label: 'Conveyor_Run (%QX0.0) to turn back ON when PhotoEye (%IX0.4) clears',
    })
  })
})
