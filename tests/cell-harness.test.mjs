import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertBoxSpacing,
  createTagOverlay,
  deriveBoxLengthFromScene,
  measureMinBoxGap,
  restingSignalValue,
} from './lib/cell-invariants.mjs'
import { createModbusTestSession, openModbusPlcSession } from './lib/cell-harness.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CELL_CONTRACT = {
  signals: [
    { name: 'Start_PB', iecAddress: '%IX0.0', type: 'BOOL', direction: 'oip_to_plc' },
    { name: 'Stop_PB', iecAddress: '%IX0.1', type: 'BOOL', direction: 'oip_to_plc' },
    { name: 'EStop', iecAddress: '%IX0.2', type: 'BOOL', contact: 'NC', direction: 'oip_to_plc' },
    { name: 'Reset_Count_PB', iecAddress: '%IX0.3', type: 'BOOL', direction: 'oip_to_plc' },
    { name: 'PhotoEye', iecAddress: '%IX0.4', type: 'BOOL', direction: 'oip_to_plc' },
    { name: 'Conveyor_Run', iecAddress: '%QX0.0', type: 'BOOL', direction: 'plc_to_oip' },
    { name: 'Spawner_Enable', iecAddress: '%QX0.1', type: 'BOOL', direction: 'plc_to_oip' },
    { name: 'Box_Count', iecAddress: '%QW0', type: 'INT', direction: 'plc_to_oip' },
  ],
}

describe('restingSignalValue', () => {
  it('returns true for NC BOOL, false for NO BOOL, and 0 for INT', () => {
    assert.equal(restingSignalValue({ name: 'EStop', type: 'BOOL', contact: 'NC' }), true)
    assert.equal(restingSignalValue({ name: 'Start_PB', type: 'BOOL' }), false)
    assert.equal(restingSignalValue({ name: 'PhotoEye', type: 'BOOL', contact: 'NO' }), false)
    assert.equal(restingSignalValue({ name: 'Box_Count', type: 'INT' }), 0)
  })
})

describe('createTagOverlay', () => {
  it('seeds NC EStop to true and other oip_to_plc inputs to false on compose', () => {
    const overlay = createTagOverlay(CELL_CONTRACT)
    assert.deepEqual(overlay.compose(), {
      '%IX0.0': false,
      '%IX0.1': false,
      '%IX0.2': true,
      '%IX0.3': false,
      '%IX0.4': false,
    })
  })

  it('layers setBase, setOverride, and clearOverride without clobbering untouched base tags', () => {
    const overlay = createTagOverlay(CELL_CONTRACT)
    overlay.setBase({ '%IX0.4': true })
    overlay.setOverride('Start_PB', true)
    overlay.setOverride('EStop', false)

    assert.deepEqual(overlay.compose(), {
      '%IX0.0': true,
      '%IX0.1': false,
      '%IX0.2': false,
      '%IX0.3': false,
      '%IX0.4': true,
    })

    // Updating base preserves active overrides and clears stale unmentioned base tags
    overlay.setBase({ '%IX0.1': true })
    assert.deepEqual(overlay.compose(), {
      '%IX0.0': true,
      '%IX0.1': true,
      '%IX0.2': false,
      '%IX0.3': false,
      '%IX0.4': false,
    })

    // Clearing overrides restores resting/base values
    overlay.clearOverride('Start_PB')
    overlay.clearOverride('EStop')
    assert.deepEqual(overlay.compose(), {
      '%IX0.0': false,
      '%IX0.1': true,
      '%IX0.2': true,
      '%IX0.3': false,
      '%IX0.4': false,
    })

    // Clearing an override when base explicitly drove EStop false restores base value (false)
    overlay.setBase({ '%IX0.2': false })
    overlay.setOverride('EStop', true)
    assert.equal(overlay.compose()['%IX0.2'], true)
    overlay.clearOverride('EStop')
    assert.equal(overlay.compose()['%IX0.2'], false)
  })

  it('throws on unknown symbolic input in setOverride and clearOverride', () => {
    const overlay = createTagOverlay(CELL_CONTRACT)
    assert.throws(() => overlay.setOverride('Bogus_Input', true), /Unknown symbolic Cell input "Bogus_Input"/)
    assert.throws(() => overlay.clearOverride('Bogus_Input'), /Unknown symbolic Cell input "Bogus_Input"/)
    assert.throws(() => overlay.setOverride('Conveyor_Run', true), /Unknown symbolic Cell input "Conveyor_Run"/)
    assert.throws(() => overlay.clearOverride('Conveyor_Run'), /Unknown symbolic Cell input "Conveyor_Run"/)
  })

  it('projects symbolic inputs, outputs with resting fallbacks, and modbus traffic in snapshot()', () => {
    const overlay = createTagOverlay(CELL_CONTRACT)

    assert.deepEqual(overlay.snapshot(), {
      inputs: {
        Start_PB: false,
        Stop_PB: false,
        EStop: true,
        Reset_Count_PB: false,
        PhotoEye: false,
      },
      outputs: {
        Conveyor_Run: false,
        Spawner_Enable: false,
        Box_Count: 0,
      },
      modbus: {
        discreteInputReads: 0,
        coilWrites: 0,
        holdingRegisterWrites: 0,
      },
    })

    overlay.setBase({ '%IX0.4': true })
    overlay.setOverride('Start_PB', true)
    const snap = overlay.snapshot(
      { '%QX0.0': true, '%QW0': 3 },
      { discreteInputReads: 12, coilWrites: 4, holdingRegisterWrites: 2 },
    )
    assert.deepEqual(snap, {
      inputs: {
        Start_PB: true,
        Stop_PB: false,
        EStop: true,
        Reset_Count_PB: false,
        PhotoEye: true,
      },
      outputs: {
        Conveyor_Run: true,
        Spawner_Enable: false,
        Box_Count: 3,
      },
      modbus: {
        discreteInputReads: 12,
        coilWrites: 4,
        holdingRegisterWrites: 2,
      },
    })
  })
})

function makeFrame(bodies) {
  return {
    partIds: bodies.map((b) => b.id ?? null),
    positions: bodies.flatMap((b) => [b.x, b.y, b.z ?? 0]),
  }
}

describe('measureMinBoxGap', () => {
  const staticPartIds = new Set(['belt_1', 'spawner_1', 'photoeye_1'])

  it('excludes static scene parts at identical x and falling bodies at y <= 0.5', () => {
    const frame = makeFrame([
      { id: 'belt_1', x: 1.5, y: 0.8 },
      { id: 'photoeye_1', x: 1.5, y: 0.8 },
      { id: null, x: 1.5, y: 0.5 },
      { id: null, x: 1.55, y: 0.25 },
      { id: 'box_nan', x: Number.NaN, y: 0.8 },
      { id: 'box_inf', x: 1.6, y: Number.POSITIVE_INFINITY },
      { id: null, x: 2.1, y: 0.8 },
      { id: 'box_2', x: 1.5, y: 0.8 },
    ])

    const result = measureMinBoxGap(frame, staticPartIds)
    assert.equal(result.cargo.length, 2)
    assert.deepEqual(
      result.cargo.map((c) => c.x),
      [1.5, 2.1],
    )
    assert.ok(Math.abs(result.minGapM - 0.6) < 1e-12)
    assert.deepEqual(
      result.closestPair.map((c) => c.x),
      [1.5, 2.1],
    )
  })

  it('returns Infinity and null closestPair for 0 or 1 active box', () => {
    const empty = measureMinBoxGap(makeFrame([]), staticPartIds)
    assert.deepEqual(empty, { cargo: [], minGapM: Infinity, closestPair: null })

    const one = measureMinBoxGap(
      makeFrame([
        { id: 'belt_1', x: 0.5, y: 0.8 },
        { id: null, x: 1.2, y: 0.9 },
        { id: null, x: 1.25, y: 0.5 },
      ]),
      staticPartIds,
    )
    assert.equal(one.cargo.length, 1)
    assert.equal(one.minGapM, Infinity)
    assert.equal(one.closestPair, null)
  })

  it('sorts unsorted active cargo positions before computing minimum gap', () => {
    const frame = makeFrame([
      { id: 'box_c', x: 3.0, y: 0.8 },
      { id: 'box_a', x: 0.4, y: 0.8 },
      { id: 'box_b', x: 2.5, y: 0.8 },
    ])

    const result = measureMinBoxGap(frame, staticPartIds)
    assert.deepEqual(
      result.cargo.map((c) => c.id),
      ['box_a', 'box_b', 'box_c'],
    )
    assert.ok(Math.abs(result.minGapM - 0.5) < 1e-12)
    assert.deepEqual(
      result.closestPair.map((c) => c.id),
      ['box_b', 'box_c'],
    )
  })
})

describe('assertBoxSpacing', () => {
  const staticPartIds = new Set(['belt_1'])
  const minSeparationM = 0.45

  it('passes at exact 0.450 m boundary (including IEEE-754 1.95 - 1.5) and returns measurement', () => {
    const frameA = makeFrame([
      { id: null, x: 1.5, y: 0.8 },
      { id: null, x: 1.95, y: 0.8 },
    ])
    const resA = assertBoxSpacing(frameA, { staticPartIds, minSeparationM, simTime: 2.5 })
    assert.equal(resA.cargo.length, 2)
    assert.equal(resA.minGapM, 1.95 - 1.5)

    const frameB = makeFrame([
      { id: null, x: 0.0, y: 0.8 },
      { id: null, x: 0.45, y: 0.8 },
    ])
    const resB = assertBoxSpacing(frameB, { staticPartIds, minSeparationM })
    assert.equal(resB.minGapM, 0.45)

    const single = assertBoxSpacing(makeFrame([{ id: null, x: 1.0, y: 0.8 }]), {
      staticPartIds,
      minSeparationM,
    })
    assert.equal(single.minGapM, Infinity)
  })

  it('throws descriptive Touching boxes detected error at 0.449 m including simTime and threshold', () => {
    const frame = makeFrame([
      { id: null, x: 1.5, y: 0.8 },
      { id: null, x: 1.949, y: 0.8 },
    ])

    assert.throws(
      () => assertBoxSpacing(frame, { staticPartIds, minSeparationM, simTime: 4.25 }),
      /Touching boxes detected at t=4\.25s: center spacing 0\.449m < 0\.450m/,
    )

    assert.throws(
      () => assertBoxSpacing(frame, { staticPartIds, minSeparationM }),
      /Touching boxes detected at t=0\.00s: center spacing 0\.449m < 0\.450m/,
    )
  })
})

describe('deriveBoxLengthFromScene', () => {
  it('derives box length from spawner params or contract sceneRole fallback and rejects invalid lengths', () => {
    assert.equal(
      deriveBoxLengthFromScene(
        { parts: [{ id: 'spawner_1', packageId: 'oip.box-spawner', params: { length: 0.4 } }] },
        CELL_CONTRACT,
      ),
      0.4,
    )

    assert.equal(
      deriveBoxLengthFromScene(
        { parts: [{ id: 'spawner_1', packageId: 'custom.spawner', params: { length: 0.55 } }] },
        { signals: [{ name: 'Spawner_Enable', sceneRole: { partId: 'spawner_1', param: 'runTag' } }] },
      ),
      0.55,
    )

    assert.throws(
      () => deriveBoxLengthFromScene({ parts: [{ id: 'spawner_1', params: { length: 0 } }] }, CELL_CONTRACT),
      /Could not derive positive box length/,
    )
  })
})

function makeFakeModbus() {
  let simTags = {}
  const simTagWrites = []
  let plcOut = {}
  let closeCount = 0

  return {
    simTagWrites,
    setPlcOut: (next) => {
      plcOut = next
    },
    getLatestSimTags: () => ({ ...simTags }),
    getCloseCount: () => closeCount,
    modbus: {
      io: {
        writeSimTags: (tags) => {
          simTags = { ...tags }
          simTagWrites.push({ ...tags })
        },
        plcTags: () => plcOut,
      },
      modbusTraffic: () => ({ discreteInputReads: 3, coilWrites: 2, holdingRegisterWrites: 1 }),
      close: async () => {
        closeCount += 1
      },
    },
  }
}

describe('openModbusPlcSession & createModbusTestSession offline lifecycle', () => {
  it('seeds NC EStop=true before deploy, tears down via stop(), and makes dispose() idempotent', async () => {
    const fake = makeFakeModbus()
    const events = []
    let stopCount = 0
    let extraCleanupCount = 0

    const session = await openModbusPlcSession({
      contract: CELL_CONTRACT,
      startServer: async () => {
        events.push('startServer')
        return fake.modbus
      },
      prepareBeforeDeploy: async ({ registerCleanup }) => {
        events.push('prepareBeforeDeploy')
        registerCleanup(async () => {
          extraCleanupCount += 1
          events.push('extraCleanup')
        })
      },
      deploy: async () => {
        events.push(`deploy:EStop=${fake.getLatestSimTags()['%IX0.2']}`)
        return {
          compilationStatus: 'SUCCESS',
          stop: async () => {
            stopCount += 1
            events.push('stop')
          },
        }
      },
    })

    assert.deepEqual(events, ['startServer', 'prepareBeforeDeploy', 'deploy:EStop=true'])
    assert.equal(fake.simTagWrites[0]['%IX0.2'], true)
    assert.equal(session.snapshot().inputs.EStop, true)

    await session.dispose()
    await session.dispose()

    assert.equal(stopCount, 1)
    assert.equal(fake.getCloseCount(), 1)
    assert.equal(extraCleanupCount, 1)
  })

  it('rolls back Modbus server and extraCleanup when deploy rejects or reports FAILED compilation', async () => {
    const fakeReject = makeFakeModbus()
    let rejectCleanupCount = 0

    await assert.rejects(
      openModbusPlcSession({
        contract: CELL_CONTRACT,
        startServer: async () => fakeReject.modbus,
        prepareBeforeDeploy: async ({ registerCleanup }) => {
          registerCleanup(() => {
            rejectCleanupCount += 1
          })
        },
        deploy: async () => {
          throw new Error('OpenPLC compilation failed (exit 2)')
        },
      }),
      /OpenPLC compilation failed/,
    )
    assert.equal(fakeReject.getCloseCount(), 1)
    assert.equal(rejectCleanupCount, 1)

    const fakeFailedStatus = makeFakeModbus()
    let failedStopCount = 0
    let failedCleanupCount = 0

    await assert.rejects(
      openModbusPlcSession({
        contract: CELL_CONTRACT,
        startServer: async () => fakeFailedStatus.modbus,
        prepareBeforeDeploy: async ({ registerCleanup }) => {
          registerCleanup(() => {
            failedCleanupCount += 1
          })
        },
        deploy: async () => ({
          compilationStatus: 'FAILED',
          stop: async () => {
            failedStopCount += 1
          },
        }),
      }),
      /OpenPLC deployment compilation status was "FAILED"/,
    )
    assert.equal(failedStopCount, 1)
    assert.equal(fakeFailedStatus.getCloseCount(), 1)
    assert.equal(failedCleanupCount, 1)
  })

  it('standalone createModbusTestSession seeds NC EStop as true via createTagOverlay and drops raw client/partsById', async () => {
    const fake = makeFakeModbus()
    let stopCount = 0

    const session = await createModbusTestSession({
      startServer: async () => fake.modbus,
      deploy: async () => ({
        compilationStatus: 'SUCCESS',
        stop: async () => {
          stopCount += 1
        },
      }),
    })

    try {
      assert.equal(session.snapshot().inputs.EStop, true)
      assert.equal(fake.getLatestSimTags()['%IX0.2'], true)

      session.setInput('EStop', false)
      assert.equal(fake.getLatestSimTags()['%IX0.2'], false)
      session.clearInputOverride('EStop')
      assert.equal(fake.getLatestSimTags()['%IX0.2'], true)
    } finally {
      await session.dispose()
      await session.dispose()
    }
    assert.equal(stopCount, 1)
    assert.equal(fake.getCloseCount(), 1)

    const harnessSrc = readFileSync(join(REPO_ROOT, 'tests', 'lib', 'cell-harness.mjs'), 'utf8')
    assert.equal(harnessSrc.includes('partsById'), false)
    assert.equal(harnessSrc.includes('.client'), false)
    assert.equal(harnessSrc.includes('defaultSignalValue'), false)
  })
})
