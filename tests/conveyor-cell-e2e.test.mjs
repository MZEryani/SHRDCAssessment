import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createCellHarness } from './lib/cell-harness.mjs'

const REJECTED_PULSE_SEC = 0.35
const REJECTED_SETTLE_SEC = 0.25

function assertModbusTraffic(modbus) {
  assert.ok(modbus.discreteInputReads > 0, 'Expected OpenPLC FC2 Discrete Input polls')
  assert.ok(modbus.coilWrites > 0, 'Expected OpenPLC Coil writes')
  assert.ok(modbus.holdingRegisterWrites > 0, 'Expected OpenPLC Holding Register writes')
}

function startCell(harness) {
  return harness.pulseInput('Start_PB', {
    label: 'OpenPLC to latch Conveyor_Run and Run_Light on Start_PB',
    until: (s) => s.outputs.Conveyor_Run && s.outputs.Run_Light,
    maxSec: 2.0,
  })
}

async function pulseAndSettle(harness, inputName) {
  await harness.pulseInput(inputName, { durationSec: REJECTED_PULSE_SEC })
  return harness.advance(REJECTED_SETTLE_SEC)
}

describe('End-to-End: OpenPLC Runtime v4 (Docker Master) <-> OIP SimWorld Conveyor Cell', () => {
  let harness = null

  afterEach(async () => {
    if (harness) {
      await harness.dispose()
      harness = null
    }
  })

  it('drives Start, box spawn, Photo-Eye Inspection Dwell, 5-box Batch completion, E-Stop, and Reset without touching boxes', async () => {
    harness = await createCellHarness()
    const { batchTarget } = harness.contract.parameters

    // 1. Verify Cell starts stopped
    const idle = await harness.advance(0.5)
    assert.equal(idle.outputs.Conveyor_Run, false, 'Conveyor_Run should start FALSE')
    assert.equal(idle.outputs.Box_Count, 0, 'Box_Count should start at 0')

    // 2. Press Start_PB momentarily -> Conveyor_Run & Run_Light latch ON
    await startCell(harness)

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

    assertModbusTraffic(afterReset.modbus)
  })

  it('halts cleanly on Stop_PB mid-run, ignores Reset_Count_PB while running, and resets Box_Count once stopped', async () => {
    harness = await createCellHarness()

    await startCell(harness)

    // Let first box reach the Photo-Eye, finish Inspection Dwell, and resume running
    const counted = await harness.stepUntil(
      'first box to increment Box_Count',
      (s) => s.outputs.Box_Count >= 1 && s.outputs.Run_Light,
      12.0,
    )
    const countBeforeReset = counted.outputs.Box_Count

    // Reset_Count_PB must be ignored while the Cell is running
    const stillRunning = await pulseAndSettle(harness, 'Reset_Count_PB')
    assert.equal(stillRunning.outputs.Run_Light, true, 'Cell must remain running after Reset_Count_PB')
    assert.ok(
      stillRunning.outputs.Box_Count >= countBeforeReset,
      `Reset_Count_PB while running must not clear Box_Count (was ${countBeforeReset}, now ${stillRunning.outputs.Box_Count})`,
    )

    // Wait for Conveyor_Run to be actively moving before pulsing Stop_PB mid-run
    await harness.stepUntil(
      'Conveyor_Run to resume moving before Stop_PB',
      (s) => s.outputs.Conveyor_Run && !s.outputs.Dwell_Light,
      4.0,
    )

    // Pulse Stop_PB mid-run -> halts conveyor, spawner, and run indicator
    await harness.pulseInput('Stop_PB', {
      label: 'Stop_PB to halt Cell mid-run',
      until: (s) => !s.outputs.Conveyor_Run && !s.outputs.Spawner_Enable && !s.outputs.Run_Light,
      maxSec: 2.0,
    })

    // Reset_Count_PB while stopped resets Box_Count to 0
    const afterReset = await harness.pulseInput('Reset_Count_PB', {
      label: 'Reset_Count_PB while stopped to reset Box_Count to 0',
      until: (s) => s.outputs.Box_Count === 0,
      maxSec: 2.0,
    })

    assertModbusTraffic(afterReset.modbus)
  })

  it('latches Photo-Eye Jam Fault after stall threshold while running, rejects reset/start while blocked, and recovers once cleared', async () => {
    harness = await createCellHarness()
    const { inspectionDwellMs, jamTimeoutMs } = harness.contract.parameters

    await startCell(harness)

    // Hold Photo-Eye continuously blocked: triggers Inspection Dwell, then resumes Conveyor_Run into Jam timer
    harness.setInput('PhotoEye', true)
    await harness.stepUntil(
      'Inspection Dwell to start on Photo-Eye block',
      (s) => s.outputs.Dwell_Light && !s.outputs.Conveyor_Run,
      2.0,
    )
    const jamTimerStart = await harness.stepUntil(
      'Conveyor_Run to resume after Inspection Dwell with Photo-Eye still blocked',
      (s) => s.outputs.Conveyor_Run && !s.outputs.Dwell_Light && !s.outputs.Fault_Light,
      inspectionDwellMs / 1000 + 2.0,
    )

    const faulted = await harness.stepUntil(
      'Photo-Eye Jam Fault to latch after exceeding Jam Fault threshold',
      (s) => s.outputs.Fault_Light && !s.outputs.Conveyor_Run && !s.outputs.Run_Light,
      jamTimeoutMs / 1000 + 3.0,
    )
    const elapsedJamSec = faulted.simTime - jamTimerStart.simTime
    assert.ok(
      elapsedJamSec >= jamTimeoutMs / 1000 - 0.25,
      `Expected Jam Fault after ~${jamTimeoutMs / 1000}s of continuous block, latched too early at ${elapsedJamSec.toFixed(2)}s`,
    )
    assert.equal(faulted.outputs.Spawner_Enable, false, 'Spawner_Enable must be OFF during Jam Fault')

    // While Photo-Eye remains blocked, Reset_Count_PB and Start_PB must not clear fault or restart Cell
    const afterBlockedReset = await pulseAndSettle(harness, 'Reset_Count_PB')
    assert.equal(afterBlockedReset.outputs.Fault_Light, true, 'Jam Fault must remain latched while Photo-Eye is blocked')
    assert.equal(afterBlockedReset.outputs.Conveyor_Run, false, 'Conveyor_Run must stay OFF while Jam Fault is latched')

    const afterBlockedStart = await pulseAndSettle(harness, 'Start_PB')
    assert.equal(afterBlockedStart.outputs.Fault_Light, true, 'Start_PB must not clear Jam Fault while Photo-Eye is blocked')
    assert.equal(afterBlockedStart.outputs.Conveyor_Run, false, 'Start_PB must not restart conveyor during Jam Fault')

    // Clear the stalled box from Photo-Eye, pulse Reset_Count_PB to clear Fault_Light, then restart cleanly
    harness.setInput('PhotoEye', false)
    await harness.pulseInput('Reset_Count_PB', {
      label: 'Reset_Count_PB to clear Jam Fault once Photo-Eye is clear',
      until: (s) => !s.outputs.Fault_Light && s.outputs.Box_Count === 0,
      maxSec: 2.0,
    })

    const restarted = await harness.pulseInput('Start_PB', {
      label: 'Start_PB to restart Cell cleanly after Jam Fault recovery',
      until: (s) => s.outputs.Conveyor_Run && s.outputs.Run_Light && !s.outputs.Fault_Light,
      maxSec: 2.0,
    })

    assertModbusTraffic(restarted.modbus)
  })
})
