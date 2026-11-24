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
 * Open a shared contract-derived Modbus TCP + OpenPLC session owning tag overlay
 * defaults, OpenPLC bundle deployment via deploy().stop(), compile-failure rollback,
 * and idempotent resource teardown.
 */
export async function openModbusPlcSession({
  contract,
  stPath,
  modbusMasterPath,
  runtimeUrl = DEFAULT_OPENPLC_URL,
  modbusPort,
  startServer = () =>
    startContractModbusServer({
      contract,
      host: '0.0.0.0',
      ...(modbusPort !== undefined ? { port: modbusPort } : {}),
    }),
  deploy = () =>
    deployProgram({
      stPath,
      modbusMasterPath,
      runtimeUrl,
      startAfterDeploy: true,
    }),
  prepareBeforeDeploy,
}) {
  const overlay = createTagOverlay(contract)
  const modbus = await startServer()
  let stopPlc = null
  let serverClosed = false
  const extraCleanups = []

  const registerCleanup = (fn) => {
    if (typeof fn === 'function') extraCleanups.push(fn)
  }

  const dispose = async () => {
    if (stopPlc) {
      const stop = stopPlc
      stopPlc = null
      await Promise.resolve(stop()).catch(() => {})
    }
    if (!serverClosed) {
      serverClosed = true
      await Promise.resolve(modbus.close()).catch(() => {})
    }
    while (extraCleanups.length > 0) {
      const cleanup = extraCleanups.pop()
      await Promise.resolve(cleanup()).catch(() => {})
    }
  }

  try {
    if (prepareBeforeDeploy) {
      await prepareBeforeDeploy({ modbus, overlay, registerCleanup })
    }

    const writeSimTags = () => {
      modbus.io.writeSimTags(overlay.compose())
    }
    writeSimTags()

    const deployed = await deploy()
    stopPlc = typeof deployed?.stop === 'function' ? deployed.stop : null
    assert.equal(
      deployed?.compilationStatus,
      'SUCCESS',
      `OpenPLC deployment compilation status was "${deployed?.compilationStatus}", expected "SUCCESS"`,
    )

    const snapshot = (plcOut = modbus.io.plcTags()) =>
      overlay.snapshot(plcOut, modbus.modbusTraffic())

    const setInput = (name, value) => {
      overlay.setOverride(name, value)
      writeSimTags()
    }

    const clearInputOverride = (name) => {
      overlay.clearOverride(name)
      writeSimTags()
    }

    return {
      contract,
      modbus,
      overlay,
      writeSimTags,
      snapshot,
      setInput,
      clearInputOverride,
      dispose,
    }
  } catch (err) {
    await dispose()
    throw err
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
  startServer,
  deploy,
}) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const session = await openModbusPlcSession({
    contract,
    stPath,
    modbusMasterPath,
    runtimeUrl,
    modbusPort,
    ...(startServer ? { startServer } : {}),
    ...(deploy ? { deploy } : {}),
  })

  const waitUntil = async (label, predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const snap = session.snapshot()
      if (predicate(snap)) return snap
      await sleep(intervalMs)
    }
    const last = session.snapshot()
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${label} (outputs=${JSON.stringify(last.outputs)}, inputs=${JSON.stringify(last.inputs)})`,
    )
  }

  return {
    contract: session.contract,
    setInput: session.setInput,
    clearInputOverride: session.clearInputOverride,
    snapshot: () => session.snapshot(),
    waitUntil,
    dispose: session.dispose,
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
  stPath = join(REPO_ROOT, 'scenes', 'conveyor-cell', 'plc', 'program.st'),
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
  const staticPartIds = new Set(scene.parts.map((p) => p.id))

  let world = null
  const session = await openModbusPlcSession({
    contract,
    stPath,
    modbusMasterPath,
    runtimeUrl,
    modbusPort,
    prepareBeforeDeploy: ({ modbus, overlay, registerCleanup }) => {
      world = new modbus.oip.SimWorld(modbus.oip.Jolt, scene, { hz })
      registerCleanup(() => {
        if (world) {
          const w = world
          world = null
          w.dispose()
        }
      })
      world.setBehaviorDrivenTags(modbus.oip.externalDrivenTags(modbus.externalIo))

      // Step SimWorld once before starting OpenPLC so every part (including NC estop_pb)
      // publishes its real resting contact state into the Modbus image before scan 0.
      world.step()
      overlay.setBase(flattenTags(world.frame().tags))
    },
  })

  let simTime = 0
  let minObservedBoxGapM = Infinity

  const buildSnapshot = (plcOut) => ({
    simTime,
    ...session.snapshot(plcOut),
    minObservedBoxGapM,
  })

  const stepWallClock = async (durationSec, untilPred) => {
    const startWall = performance.now()
    const startSteps = Math.round(simTime * hz)
    const targetSteps = startSteps + Math.round(durationSec * hz)
    let steps = startSteps

    while (steps < targetSteps) {
      const elapsedSec = (performance.now() - startWall) / 1000
      const due = Math.min(targetSteps, startSteps + Math.floor(elapsedSec * hz))
      while (steps < due) {
        session.writeSimTags()
        const plcOut = session.modbus.io.plcTags()
        world.setBehaviorInputTags(plcOut)
        world.step()
        const frame = world.frame()
        const spacing = assertBoxSpacing(frame, { staticPartIds, minSeparationM, simTime })
        if (spacing.minGapM < minObservedBoxGapM) minObservedBoxGapM = spacing.minGapM
        session.overlay.setBase(flattenTags(frame.tags))
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
    session.setInput(name, true)
    try {
      if (until) {
        return await stepUntil(label, until, maxSec)
      }
      return await advance(durationSec)
    } finally {
      session.clearInputOverride(name)
    }
  }

  return {
    contract: session.contract,
    boxLengthM,
    minSeparationM,
    setInput: session.setInput,
    clearInputOverride: session.clearInputOverride,
    pulseInput,
    stepUntil,
    advance,
    snapshot: () => buildSnapshot(),
    dispose: session.dispose,
  }
}
