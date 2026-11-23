import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createCellHarness } from './lib/cell-harness.mjs'

describe('End-to-End: OpenPLC Runtime v4 (Docker Master) <-> OIP SimWorld Conveyor Cell', () => {
  let harness

  after(async () => {
    if (harness) await harness.dispose()
  })

  it('drives Start, box spawn, Photo-Eye Inspection Dwell, 5-box Batch completion, E-Stop, and Reset without touching boxes', async () => {
    harness = await createCellHarness()
    const { batchTarget } = harness.contract.parameters

    // 1. Verify Cell starts stopped
    const idle = await harness.advance(0.5)
    assert.equal(idle.outputs.Conveyor_Run, false, 'Conveyor_Run should start FALSE')
    assert.equal(idle.outputs.Box_Count, 0, 'Box_Count should start at 0')

    // 2. Press Start_PB momentarily -> Conveyor_Run & Run_Light latch ON
    await harness.pulseInput('Start_PB', {
      label: 'OpenPLC to latch Conveyor_Run and Run_Light on Start_PB',
      until: (s) => s.outputs.Conveyor_Run && s.outputs.Run_Light,
      maxSec: 2.0,
    })

    // 3. First box reaches Photo-Eye -> triggers 2s Inspection Dwell & increments Box_Count to 1
    const dwelled = await harness.stepUntil(
      'first box to trigger Photo-Eye Inspection Dwell and Box_Count >= 1',
      (s) =>
        s.inputs.PhotoEye &&
        s.outputs.Dwell_Light &&
        !s.outputs.Conveyor_Run &&
        s.outputs.Box_Count >= 1,
      12.0,
    )
    assert.equal(
      dwelled.outputs.Spawner_Enable,
      false,
      'Spawner_Enable must be inhibited during Inspection Dwell',
    )

    // 4. Inspection Dwell completes -> Conveyor_Run resumes
    await harness.stepUntil(
      'Conveyor_Run to resume after Inspection Dwell',
      (s) => s.outputs.Conveyor_Run && !s.outputs.Dwell_Light,
      4.0,
    )

    // 5. Run through 5-box Batch completion -> auto-stops Cell
    await harness.stepUntil(
      `Cell to complete ${batchTarget}-box Batch and auto-stop`,
      (s) =>
        s.outputs.Box_Count === batchTarget &&
        !s.outputs.Conveyor_Run &&
        !s.outputs.Spawner_Enable &&
        !s.outputs.Run_Light,
      50.0,
    )

    // 6. Trip E-Stop -> Fault_Light illuminates; release E-Stop + Reset -> Fault_Light clears & Box_Count resets to 0
    harness.setInput('EStop', true)
    await harness.stepUntil(
      'E-Stop to illuminate Fault_Light and halt Conveyor_Run',
      (s) => s.outputs.Fault_Light && !s.outputs.Conveyor_Run,
      2.0,
    )

    harness.setInput('EStop', false)
    const afterReset = await harness.pulseInput('Reset_Count_PB', {
      label: 'Reset_Count_PB while stopped to clear Fault_Light and reset Box_Count to 0',
      until: (s) => !s.outputs.Fault_Light && s.outputs.Box_Count === 0,
      maxSec: 2.0,
    })

    // Verify real Modbus traffic across all 3 function-code areas
    assert.ok(afterReset.modbus.discreteInputReads > 0, 'Expected OpenPLC FC2 Discrete Input polls')
    assert.ok(afterReset.modbus.coilWrites > 0, 'Expected OpenPLC Coil writes')
    assert.ok(afterReset.modbus.holdingRegisterWrites > 0, 'Expected OpenPLC Holding Register writes')
  })
})
