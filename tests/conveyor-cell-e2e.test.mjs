import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deployProgram } from '../scripts/openplc-deploy.mjs'
import { flattenTags, loadOurs as loadOip, sleep } from '../Open-Industry-Project/scripts/lib/conveyor-loop.mjs'
import { listenModbus } from '../Open-Industry-Project/scripts/lib/modbus-tcp-listen.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODBUS_PORT = Number(process.env.OIP_MODBUS_PORT ?? 5020)
const OPENPLC_URL = process.env.OPENPLC_URL ?? 'https://127.0.0.1:8443'
const HZ = 60
const BOX_LENGTH_M = 0.4
const MIN_SEPARATION_M = BOX_LENGTH_M + 0.05

const FC_READ_DISCRETE_INPUTS = 2
const FC_WRITE_SINGLE_COIL = 5
const FC_WRITE_SINGLE_REGISTER = 6
const FC_WRITE_MULTIPLE_COILS = 15
const FC_WRITE_MULTIPLE_REGISTERS = 16

describe('End-to-End: OpenPLC Runtime v4 (Docker Master) <-> OIP SimWorld Conveyor Cell', () => {
  let client
  let server
  let world

  after(async () => {
    if (client) await client.stop().catch(() => {})
    if (server) await server.close().catch(() => {})
    if (world) world.dispose()
  })

  it('drives Start, box spawn, Photo-Eye Inspection Dwell, 5-box Batch completion, E-Stop, and Reset without touching boxes', async () => {
    const oip = await loadOip()
    const contract = JSON.parse(readFileSync(join(REPO_ROOT, 'openplc', 'io-contract.json'), 'utf8'))
    const scene = JSON.parse(readFileSync(join(REPO_ROOT, 'scenes', 'conveyor-cell', 'scene.json'), 'utf8'))
    const addr = Object.fromEntries(contract.signals.map((s) => [s.name, s.iecAddress]))

    const tagDefs = contract.signals.map((s) => ({ name: s.iecAddress, type: s.type }))
    const derived = oip.modbusServerFromTags({ host: '0.0.0.0', port: MODBUS_PORT }, tagDefs)
    assert.equal(derived.problems.length, 0, `Unexpected Modbus derivation problems: ${JSON.stringify(derived.problems)}`)
    const checked = oip.validateExternalIo(derived.io)
    assert.equal(checked.ok, true, `Invalid external IO table: ${JSON.stringify(checked.errors)}`)

    const io = new oip.ModbusServerIo(checked.io)
    server = await listenModbus(io, checked.io)

    world = new oip.SimWorld(oip.Jolt, scene, { hz: HZ })
    world.setBehaviorDrivenTags(oip.externalDrivenTags(checked.io))

    // Seed initial field inputs before PLC starts
    const operatorInputs = {
      [addr.Start_PB]: false,
      [addr.Stop_PB]: false,
      [addr.EStop]: false,
      [addr.Reset_Count_PB]: false,
    }
    let worldTags = flattenTags(world.frame().tags)
    io.writeSimTags({ ...worldTags, ...operatorInputs })

    const deployed = await deployProgram({
      stPath: join(REPO_ROOT, 'openplc', 'conveyor_cell.st'),
      modbusMasterPath: join(REPO_ROOT, 'openplc', 'conveyor_cell_modbus_master.json'),
      runtimeUrl: OPENPLC_URL,
      startAfterDeploy: true,
    })
    client = deployed.client
    assert.equal(deployed.compilationStatus, 'SUCCESS')

    const staticPartIds = new Set(scene.parts.map((p) => p.id))
    let simTime = 0
    let minObservedBoxGapM = Infinity

    const checkBoxSpacing = (frame) => {
      const boxXs = []
      for (let i = 0; i < frame.partIds.length; i++) {
        const id = frame.partIds[i]
        // Spawned boxes are dynamic cargo bodies (null or not in static scene parts)
        if (!id || !staticPartIds.has(id)) {
          const x = frame.positions[i * 3]
          const y = frame.positions[i * 3 + 1]
          if (Number.isFinite(x) && y > 0.5) boxXs.push(x)
        }
      }
      boxXs.sort((a, b) => a - b)
      for (let i = 1; i < boxXs.length; i++) {
        const gap = boxXs[i] - boxXs[i - 1]
        if (gap < minObservedBoxGapM) minObservedBoxGapM = gap
        assert.ok(
          gap >= MIN_SEPARATION_M,
          `Touching boxes detected at t=${simTime.toFixed(2)}s: center spacing ${gap.toFixed(3)}m < ${MIN_SEPARATION_M}m`,
        )
      }
    }

    const stepWallClock = async (durationSec, untilPred) => {
      const startWall = performance.now()
      const startSteps = Math.round(simTime * HZ)
      const targetSteps = startSteps + Math.round(durationSec * HZ)
      let steps = startSteps

      while (steps < targetSteps) {
        const elapsedSec = (performance.now() - startWall) / 1000
        const due = Math.min(targetSteps, startSteps + Math.floor(elapsedSec * HZ))
        while (steps < due) {
          io.writeSimTags({ ...worldTags, ...operatorInputs })
          const plcOut = io.plcTags()
          world.setBehaviorInputTags(plcOut)
          world.step()
          const frame = world.frame()
          checkBoxSpacing(frame)
          worldTags = flattenTags(frame.tags)
          steps++
          simTime = steps / HZ
          if (untilPred && untilPred({ worldTags, plcOut, simTime })) {
            return { matched: true, worldTags, plcOut, simTime }
          }
        }
        await sleep(5)
      }
      return { matched: false, worldTags, plcOut: io.plcTags(), simTime }
    }

    // 1. Verify Cell starts stopped
    const idle = await stepWallClock(0.5)
    assert.equal(idle.plcOut[addr.Conveyor_Run] ?? false, false, 'Conveyor_Run should start FALSE')
    assert.equal(idle.plcOut[addr.Box_Count] ?? 0, 0, 'Box_Count should start at 0')

    // 2. Press Start_PB momentarily -> Conveyor_Run & Run_Light latch ON
    operatorInputs[addr.Start_PB] = true
    const started = await stepWallClock(2.0, ({ plcOut }) => plcOut[addr.Conveyor_Run] === true && plcOut[addr.Run_Light] === true)
    operatorInputs[addr.Start_PB] = false
    assert.equal(started.matched, true, 'OpenPLC did not latch Conveyor_Run and Run_Light on Start_PB')

    // 3. First box reaches Photo-Eye -> triggers 2s Inspection Dwell & increments Box_Count to 1
    const dwelled = await stepWallClock(12.0, ({ worldTags: wt, plcOut }) =>
      wt[addr.PhotoEye] === true &&
      plcOut[addr.Dwell_Light] === true &&
      plcOut[addr.Conveyor_Run] === false &&
      (plcOut[addr.Box_Count] ?? 0) >= 1,
    )
    assert.equal(dwelled.matched, true, 'First box did not trigger Photo-Eye -> Inspection Dwell + Box_Count >= 1')
    assert.equal(dwelled.plcOut[addr.Spawner_Enable], false, 'Spawner_Enable must be inhibited during Inspection Dwell')

    // 4. Dwell completes -> Conveyor_Run resumes
    const resumed = await stepWallClock(4.0, ({ plcOut }) => plcOut[addr.Conveyor_Run] === true && plcOut[addr.Dwell_Light] === false)
    assert.equal(resumed.matched, true, 'Conveyor_Run did not resume after 2s Inspection Dwell')

    // 5. Run through 5-box Batch completion -> auto-stops Cell
    const batchDone = await stepWallClock(50.0, ({ plcOut }) =>
      plcOut[addr.Box_Count] === contract.parameters.batchTarget &&
      plcOut[addr.Conveyor_Run] === false &&
      plcOut[addr.Spawner_Enable] === false &&
      plcOut[addr.Run_Light] === false,
    )
    assert.equal(batchDone.matched, true, `Cell did not complete ${contract.parameters.batchTarget}-box Batch and auto-stop`)

    // 6. Trip E-Stop -> Fault_Light illuminates; release E-Stop + Reset -> Fault_Light clears & Box_Count resets to 0
    operatorInputs[addr.EStop] = true
    const estopped = await stepWallClock(2.0, ({ plcOut }) => plcOut[addr.Fault_Light] === true && plcOut[addr.Conveyor_Run] === false)
    assert.equal(estopped.matched, true, 'E-Stop did not illuminate Fault_Light')

    operatorInputs[addr.EStop] = false
    operatorInputs[addr.Reset_Count_PB] = true
    const reset = await stepWallClock(2.0, ({ plcOut }) => plcOut[addr.Fault_Light] === false && plcOut[addr.Box_Count] === 0)
    operatorInputs[addr.Reset_Count_PB] = false
    assert.equal(reset.matched, true, 'Reset_Count_PB while stopped did not clear Fault_Light and reset Box_Count to 0')

    // Verify real Modbus traffic across all 3 function-code areas
    assert.ok((io.stats.requests[FC_READ_DISCRETE_INPUTS] ?? 0) > 0, 'Expected OpenPLC FC2 Discrete Input polls')
    assert.ok((io.stats.requests[FC_WRITE_MULTIPLE_COILS] ?? 0) + (io.stats.requests[FC_WRITE_SINGLE_COIL] ?? 0) > 0, 'Expected OpenPLC Coil writes')
    assert.ok((io.stats.requests[FC_WRITE_MULTIPLE_REGISTERS] ?? 0) + (io.stats.requests[FC_WRITE_SINGLE_REGISTER] ?? 0) > 0, 'Expected OpenPLC Holding Register writes')
  })
})
