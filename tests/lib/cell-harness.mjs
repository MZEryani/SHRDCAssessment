import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deployProgram } from '../../scripts/openplc-deploy.mjs'
import {
  flattenTags,
  loadOurs as loadOip,
  sleep,
} from '../../Open-Industry-Project/scripts/lib/conveyor-loop.mjs'
import { listenModbus } from '../../Open-Industry-Project/scripts/lib/modbus-tcp-listen.mjs'
import {
  assertBoxSpacing,
  createTagOverlay,
  deriveBoxLengthFromScene,
  measureMinBoxGap,
  restingSignalValue,
} from './cell-invariants.mjs'

export {
  assertBoxSpacing,
  createTagOverlay,
  deriveBoxLengthFromScene,
  measureMinBoxGap,
  restingSignalValue,
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_OPENPLC_URL = process.env.OPENPLC_URL ?? 'https://127.0.0.1:8443'
const DEFAULT_HZ = 60
const DEFAULT_SPACING_MARGIN_M = 0.05

const FC_READ_DISCRETE_INPUTS = 2
const FC_WRITE_SINGLE_COIL = 5
const FC_WRITE_SINGLE_REGISTER = 6
const FC_WRITE_MULTIPLE_COILS = 15
const FC_WRITE_MULTIPLE_REGISTERS = 16

function defaultSignalValue(signal) {
  return signal.type === 'BOOL' ? false : 0
}

/**
 * Start a contract-derived OIP ModbusServerIo + TCP listener without spinning
 * up SimWorld. Reusable by both the full Cell Harness and standalone Modbus
 * smoke tests.
 */
export async function startContractModbusServer({
  contract,
  host = '0.0.0.0',
  port = Number(process.env.OIP_MODBUS_PORT ?? contract.modbus.port),
}) {
  const oip = await loadOip()
  const tagDefs = contract.signals.map((s) => ({ name: s.iecAddress, type: s.type }))
  const derived = oip.modbusServerFromTags({ host, port }, tagDefs)
  assert.equal(
    derived.problems.length,
    0,
    `Unexpected Modbus derivation problems: ${JSON.stringify(derived.problems)}`,
  )
  const checked = oip.validateExternalIo(derived.io)
  assert.equal(checked.ok, true, `Invalid external IO table: ${JSON.stringify(checked.errors)}`)

  const io = new oip.ModbusServerIo(checked.io)
  const server = await listenModbus(io, checked.io)
  const addrByName = Object.fromEntries(contract.signals.map((s) => [s.name, s.iecAddress]))

  const modbusTraffic = () => ({
    discreteInputReads: io.stats.requests[FC_READ_DISCRETE_INPUTS] ?? 0,
    coilWrites:
      (io.stats.requests[FC_WRITE_MULTIPLE_COILS] ?? 0) +
      (io.stats.requests[FC_WRITE_SINGLE_COIL] ?? 0),
    holdingRegisterWrites:
      (io.stats.requests[FC_WRITE_MULTIPLE_REGISTERS] ?? 0) +
      (io.stats.requests[FC_WRITE_SINGLE_REGISTER] ?? 0),
  })

  return {
    oip,
    io,
    externalIo: checked.io,
    server,
    addrByName,
    modbusTraffic,
    close: () => server.close().catch(() => {}),
  }
}

/**
 * Start a standalone contract-derived Modbus TCP + OpenPLC session without
 * spinning up SimWorld. Owns Modbus server lifecycle, symbolic I/O reads/writes,
 * polling waitUntil, and OpenPLC deploy/stop teardown.
 */
export async function createModbusTestSession({
  contractPath = join(REPO_ROOT, 'openplc', 'io-contract.json'),
  stPath,
  modbusMasterPath,
  runtimeUrl = DEFAULT_OPENPLC_URL,
  modbusPort,
}) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const inputSignals = contract.signals.filter((s) => s.direction === 'oip_to_plc')
  const outputSignals = contract.signals.filter((s) => s.direction === 'plc_to_oip')
  const inputByName = new Map(inputSignals.map((s) => [s.name, s]))

  const modbus = await startContractModbusServer({
    contract,
    host: '0.0.0.0',
    ...(modbusPort !== undefined ? { port: modbusPort } : {}),
  })
  let client = null

  const dispose = async () => {
    if (client) {
      const c = client
      client = null
      await c.stop().catch(() => {})
    }
    await modbus.close()
  }

  try {
    const simTags = {}
    for (const sig of inputSignals) {
      simTags[sig.iecAddress] = defaultSignalValue(sig)
    }
    modbus.io.writeSimTags(simTags)

    const deployed = await deployProgram({
      stPath,
      modbusMasterPath,
      runtimeUrl,
      startAfterDeploy: true,
    })
    client = deployed.client
    assert.equal(deployed.compilationStatus, 'SUCCESS')

    const snapshot = () => {
      const plcOut = modbus.io.plcTags()
      const inputs = {}
      for (const sig of inputSignals) {
        inputs[sig.name] = simTags[sig.iecAddress] ?? defaultSignalValue(sig)
      }
      const outputs = {}
      for (const sig of outputSignals) {
        outputs[sig.name] = plcOut[sig.iecAddress] ?? defaultSignalValue(sig)
      }
      return { inputs, outputs, modbus: modbus.modbusTraffic() }
    }

    const setInput = (name, value) => {
      if (!inputByName.has(name)) {
        throw new Error(`Unknown symbolic Cell input "${name}"`)
      }
      simTags[modbus.addrByName[name]] = value
      modbus.io.writeSimTags(simTags)
    }

    const waitUntil = async (label, predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const snap = snapshot()
        if (predicate(snap)) return snap
        await sleep(intervalMs)
      }
      const last = snapshot()
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label} (outputs=${JSON.stringify(last.outputs)}, inputs=${JSON.stringify(last.inputs)})`,
      )
    }

    return {
      contract,
      setInput,
      snapshot,
      waitUntil,
      dispose,
    }
  } catch (err) {
    await dispose()
    throw err
  }
}

/**
 * Create a live, contract-driven Conveyor Cell verification harness owning:
 * - contract-derived OIP Modbus TCP server
 * - OIP SimWorld real-time stepping
 * - scene-derived anti-touching box-spacing invariant checks
 * - OpenPLC v4 program deploy and clean teardown
 */
export async function createCellHarness({
  contractPath = join(REPO_ROOT, 'openplc', 'io-contract.json'),
  scenePath = join(REPO_ROOT, 'scenes', 'conveyor-cell', 'scene.json'),
  stPath = join(REPO_ROOT, 'openplc', 'conveyor_cell.st'),
  modbusMasterPath = join(REPO_ROOT, 'openplc', 'conveyor_cell_modbus_master.json'),
  runtimeUrl = DEFAULT_OPENPLC_URL,
  modbusPort,
  hz = DEFAULT_HZ,
  spacingMarginM = DEFAULT_SPACING_MARGIN_M,
} = {}) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const scene = JSON.parse(readFileSync(scenePath, 'utf8'))
  const boxLengthM = deriveBoxLengthFromScene(scene, contract)
  const minSeparationM = boxLengthM + spacingMarginM

  const inputSignals = contract.signals.filter((s) => s.direction === 'oip_to_plc')
  const outputSignals = contract.signals.filter((s) => s.direction === 'plc_to_oip')
  const inputByName = new Map(inputSignals.map((s) => [s.name, s]))
  const partsById = new Map(scene.parts.map((p) => [p.id, p]))

  const modbus = await startContractModbusServer({
    contract,
    host: '0.0.0.0',
    ...(modbusPort !== undefined ? { port: modbusPort } : {}),
  })
  let world = null
  let client = null

  const dispose = async () => {
    if (client) {
      const c = client
      client = null
      await c.stop().catch(() => {})
    }
    await modbus.close()
    if (world) {
      const w = world
      world = null
      w.dispose()
    }
  }

  try {
    world = new modbus.oip.SimWorld(modbus.oip.Jolt, scene, { hz })
    world.setBehaviorDrivenTags(modbus.oip.externalDrivenTags(modbus.externalIo))

    // Let SimWorld drive resting states for all parts (including NC E-Stop = TRUE);
    // overrides are applied only when a test explicitly sets or pulses an input.
    const inputOverrides = new Map()

    // Step SimWorld once before starting OpenPLC so every part (including NC estop_pb)
    // publishes its real resting contact state into the Modbus image before scan 0.
    world.step()
    let worldTags = flattenTags(world.frame().tags)
    const composedSimTags = () => {
      const merged = { ...worldTags }
      for (const [name, val] of inputOverrides) {
        merged[modbus.addrByName[name]] = val
      }
      return merged
    }

    modbus.io.writeSimTags(composedSimTags())

    const deployed = await deployProgram({
      stPath,
      modbusMasterPath,
      runtimeUrl,
      startAfterDeploy: true,
    })
    client = deployed.client
    assert.equal(deployed.compilationStatus, 'SUCCESS')

    const staticPartIds = new Set(scene.parts.map((p) => p.id))
    let simTime = 0
    let minObservedBoxGapM = Infinity

    const checkBoxSpacing = (frame) => {
      const boxXs = []
      for (let i = 0; i < frame.partIds.length; i += 1) {
        const id = frame.partIds[i]
        // Spawned boxes are dynamic cargo bodies (null or not in static scene parts)
        if (!id || !staticPartIds.has(id)) {
          const x = frame.positions[i * 3]
          const y = frame.positions[i * 3 + 1]
          if (Number.isFinite(x) && y > 0.5) boxXs.push(x)
        }
      }
      boxXs.sort((a, b) => a - b)
      for (let i = 1; i < boxXs.length; i += 1) {
        const gap = boxXs[i] - boxXs[i - 1]
        if (gap < minObservedBoxGapM) minObservedBoxGapM = gap
        assert.ok(
          gap >= minSeparationM,
          `Touching boxes detected at t=${simTime.toFixed(2)}s: center spacing ${gap.toFixed(3)}m < ${minSeparationM.toFixed(3)}m`,
        )
      }
    }

    const buildSnapshot = (plcOut = modbus.io.plcTags()) => {
      const simTags = composedSimTags()
      const inputs = {}
      for (const sig of inputSignals) {
        inputs[sig.name] = simTags[sig.iecAddress] ?? defaultSignalValue(sig)
      }
      const outputs = {}
      for (const sig of outputSignals) {
        outputs[sig.name] = plcOut[sig.iecAddress] ?? defaultSignalValue(sig)
      }
      return {
        simTime,
        inputs,
        outputs,
        minObservedBoxGapM,
        modbus: modbus.modbusTraffic(),
      }
    }

    const stepWallClock = async (durationSec, untilPred) => {
      const startWall = performance.now()
      const startSteps = Math.round(simTime * hz)
      const targetSteps = startSteps + Math.round(durationSec * hz)
      let steps = startSteps

      while (steps < targetSteps) {
        const elapsedSec = (performance.now() - startWall) / 1000
        const due = Math.min(targetSteps, startSteps + Math.floor(elapsedSec * hz))
        while (steps < due) {
          modbus.io.writeSimTags(composedSimTags())
          const plcOut = modbus.io.plcTags()
          world.setBehaviorInputTags(plcOut)
          world.step()
          const frame = world.frame()
          checkBoxSpacing(frame)
          worldTags = flattenTags(frame.tags)
          steps += 1
          simTime = steps / hz
          if (untilPred) {
            const snap = buildSnapshot(plcOut)
            if (untilPred(snap)) return { matched: true, snapshot: snap }
          }
        }
        await sleep(5)
      }
      return { matched: false, snapshot: buildSnapshot() }
    }

    const assertKnownInput = (name) => {
      if (!inputByName.has(name)) {
        throw new Error(`Unknown symbolic Cell input "${name}"`)
      }
    }

    const setInput = (name, value) => {
      assertKnownInput(name)
      inputOverrides.set(name, value)
    }

    const clearInputOverride = (name) => {
      assertKnownInput(name)
      inputOverrides.delete(name)
    }

    const stepUntil = async (label, predicate, maxSec) => {
      const { matched, snapshot } = await stepWallClock(maxSec, predicate)
      assert.equal(
        matched,
        true,
        `Timed out after ${maxSec}s waiting for ${label} (t=${snapshot.simTime.toFixed(2)}s, outputs=${JSON.stringify(snapshot.outputs)}, inputs=${JSON.stringify(snapshot.inputs)})`,
      )
      return snapshot
    }

    const advance = async (durationSec) => {
      const { snapshot } = await stepWallClock(durationSec)
      return snapshot
    }

    const pulseInput = async (name, { until, label = `${name} pulse`, maxSec = 2.0, durationSec = 0.25 } = {}) => {
      setInput(name, true)
      try {
        if (until) {
          return await stepUntil(label, until, maxSec)
        }
        return await advance(durationSec)
      } finally {
        clearInputOverride(name)
      }
    }

    return {
      contract,
      boxLengthM,
      minSeparationM,
      setInput,
      clearInputOverride,
      pulseInput,
      stepUntil,
      advance,
      snapshot: () => buildSnapshot(),
      dispose,
    }
  } catch (err) {
    await dispose()
    throw err
  }
}
