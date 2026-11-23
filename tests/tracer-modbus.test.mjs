import { after, describe, it } from 'node:test'
import { resolve } from 'node:path'
import { createModbusTestSession } from './lib/cell-harness.mjs'

describe('Tracer Bullet: OpenPLC v4 (Docker Master) <-> OIP Modbus TCP Server', () => {
  let session = null

  after(async () => {
    if (session) await session.dispose()
  })

  it('reads %IX0.4 (PhotoEye) from Modbus server and drives %QX0.0 (Conveyor_Run) end-to-end', async () => {
    session = await createModbusTestSession({
      stPath: resolve('openplc/tracer_bullet.st'),
      modbusMasterPath: resolve('openplc/tracer_modbus_master.json'),
    })

    // PhotoEye clear (%IX0.4 = 0) => Conveyor_Run ON (%QX0.0 = 1)
    session.setInput('PhotoEye', false)
    await session.waitUntil(
      'Conveyor_Run (%QX0.0) to turn ON when PhotoEye (%IX0.4) is clear',
      (s) =>
        s.modbus.discreteInputReads > 0 &&
        s.modbus.coilWrites > 0 &&
        s.outputs.Conveyor_Run === true,
      { timeoutMs: 8000 },
    )

    // Box blocks PhotoEye (%IX0.4 = 1) => Conveyor_Run OFF (%QX0.0 = 0)
    session.setInput('PhotoEye', true)
    await session.waitUntil(
      'Conveyor_Run (%QX0.0) to turn OFF when PhotoEye (%IX0.4) is blocked',
      (s) => s.outputs.Conveyor_Run === false,
      { timeoutMs: 3000 },
    )

    // Box clears PhotoEye (%IX0.4 = 0) => Conveyor_Run ON (%QX0.0 = 1)
    session.setInput('PhotoEye', false)
    await session.waitUntil(
      'Conveyor_Run (%QX0.0) to turn back ON when PhotoEye (%IX0.4) clears',
      (s) => s.outputs.Conveyor_Run === true,
      { timeoutMs: 3000 },
    )
  })
})
