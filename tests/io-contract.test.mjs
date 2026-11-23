import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkConformance, deriveModbusMaster } from '../scripts/io-contract.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadBaseline() {
  return {
    contract: JSON.parse(readFileSync(join(REPO_ROOT, 'openplc', 'io-contract.json'), 'utf8')),
    stSource: readFileSync(join(REPO_ROOT, 'openplc', 'conveyor_cell.st'), 'utf8'),
    modbusMaster: JSON.parse(
      readFileSync(join(REPO_ROOT, 'openplc', 'conveyor_cell_modbus_master.json'), 'utf8'),
    ),
    scene: JSON.parse(
      readFileSync(join(REPO_ROOT, 'scenes', 'conveyor-cell', 'scene.json'), 'utf8'),
    ),
  }
}

describe('I/O Contract canonical schema and Modbus master derivation', () => {
  it('declares sceneRole (partId and param) on every signal in openplc/io-contract.json', () => {
    const { contract } = loadBaseline()
    assert.ok(contract.signals.length > 0, 'Expected signals in io-contract.json')
    for (const sig of contract.signals) {
      assert.equal(
        typeof sig.sceneRole?.partId,
        'string',
        `Signal ${sig.name} must declare string sceneRole.partId`,
      )
      assert.ok(sig.sceneRole.partId.length > 0, `Signal ${sig.name} sceneRole.partId must be non-empty`)
      assert.equal(
        typeof sig.sceneRole?.param,
        'string',
        `Signal ${sig.name} must declare string sceneRole.param`,
      )
      assert.ok(sig.sceneRole.param.length > 0, `Signal ${sig.name} sceneRole.param must be non-empty`)
    }
  })

  it('derives the exact Conveyor Cell OpenPLC Modbus master configuration from the I/O Contract', () => {
    const { contract, modbusMaster } = loadBaseline()
    assert.deepEqual(deriveModbusMaster(contract), modbusMaster)
  })

  it('groups contiguous addresses per Modbus area and splits non-contiguous ranges into separate io_points', () => {
    const { contract } = loadBaseline()
    const gapped = structuredClone(contract)
    gapped.signals.push({
      name: 'Aux_Sensor',
      iecAddress: '%IX1.0',
      type: 'BOOL',
      direction: 'oip_to_plc',
      modbusArea: 'discreteInput',
      modbusAddress: 8,
      sceneRole: { partId: 'aux_sensor', param: 'tag' },
    })

    const derived = deriveModbusMaster(gapped)
    const fc2Points = derived[0].config.io_points.filter((p) => p.fc === 2)
    assert.deepEqual(fc2Points, [
      { fc: 2, offset: '0', iec_location: '%IX0.0', len: 5, cycle_time_ms: 50 },
      { fc: 2, offset: '8', iec_location: '%IX1.0', len: 1, cycle_time_ms: 50 },
    ])
  })
})

describe('I/O Contract conformance checks', () => {
  it('returns zero problems on the clean repository baseline', () => {
    const problems = checkConformance(loadBaseline())
    assert.deepEqual(problems, [])
  })

  it('flags ST AT address drift, type drift, and a %IX0.0 Photo-Eye collision', () => {
    const baseline = loadBaseline()

    const addrDrift = structuredClone(baseline)
    addrDrift.stSource = addrDrift.stSource.replace(
      'PhotoEye       AT %IX0.4 : BOOL;',
      'PhotoEye       AT %IX0.5 : BOOL;',
    )
    const addrProblems = checkConformance(addrDrift)
    assert.equal(addrProblems.length, 1)
    assert.equal(addrProblems[0].artifact, 'conveyor_cell.st')
    assert.match(addrProblems[0].message, /PhotoEye.*%IX0\.5.*%IX0\.4/)

    const typeDrift = structuredClone(baseline)
    typeDrift.stSource = typeDrift.stSource.replace(
      'Box_Count      AT %QW0   : INT;',
      'Box_Count      AT %QW0   : WORD;',
    )
    const typeProblems = checkConformance(typeDrift)
    assert.equal(typeProblems.length, 1)
    assert.equal(typeProblems[0].artifact, 'conveyor_cell.st')
    assert.match(typeProblems[0].message, /Box_Count.*WORD.*INT/)

    const collision = structuredClone(baseline)
    collision.stSource = collision.stSource.replace(
      'PhotoEye       AT %IX0.4 : BOOL;',
      'PhotoEye       AT %IX0.0 : BOOL;',
    )
    const collisionProblems = checkConformance(collision)
    assert.ok(collisionProblems.length >= 1)
    assert.ok(
      collisionProblems.some(
        (p) => p.artifact === 'conveyor_cell.st' && /PhotoEye.*%IX0\.0.*%IX0\.4/.test(p.message),
      ),
      `Expected PhotoEye %IX0.0 collision finding, got: ${JSON.stringify(collisionProblems)}`,
    )
  })

  it('flags ST Batch, Inspection Dwell, Jam Fault constant, and task scan interval drift', () => {
    const baseline = loadBaseline()

    const batchDrift = structuredClone(baseline)
    batchDrift.stSource = batchDrift.stSource.replace(
      'BATCH_TARGET        : INT  := 5;',
      'BATCH_TARGET        : INT  := 8;',
    )
    const batchProblems = checkConformance(batchDrift)
    assert.equal(batchProblems.length, 1)
    assert.equal(batchProblems[0].artifact, 'conveyor_cell.st')
    assert.match(batchProblems[0].message, /BATCH_TARGET.*8.*5/)

    const dwellDrift = structuredClone(baseline)
    dwellDrift.stSource = dwellDrift.stSource.replace(
      'DWELL_TIME          : TIME := T#2s;',
      'DWELL_TIME          : TIME := T#3s;',
    )
    const dwellProblems = checkConformance(dwellDrift)
    assert.equal(dwellProblems.length, 1)
    assert.equal(dwellProblems[0].artifact, 'conveyor_cell.st')
    assert.match(dwellProblems[0].message, /DWELL_TIME.*T#3s.*T#2s/)

    const jamDrift = structuredClone(baseline)
    jamDrift.stSource = jamDrift.stSource.replace(
      'JAM_THRESHOLD_TIME  : TIME := T#4s;',
      'JAM_THRESHOLD_TIME  : TIME := T#6s;',
    )
    const jamProblems = checkConformance(jamDrift)
    assert.equal(jamProblems.length, 1)
    assert.equal(jamProblems[0].artifact, 'conveyor_cell.st')
    assert.match(jamProblems[0].message, /JAM_THRESHOLD_TIME.*T#6s.*T#4s/)

    const scanDrift = structuredClone(baseline)
    scanDrift.stSource = scanDrift.stSource.replace(
      'TASK task0(INTERVAL := T#20ms, PRIORITY := 0);',
      'TASK task0(INTERVAL := T#50ms, PRIORITY := 0);',
    )
    const scanProblems = checkConformance(scanDrift)
    assert.equal(scanProblems.length, 1)
    assert.equal(scanProblems[0].artifact, 'conveyor_cell.st')
    assert.match(scanProblems[0].message, /scan interval.*T#50ms.*T#20ms/i)
  })

  it('flags Modbus master poll-length and connection parameter drift against derived config', () => {
    const baseline = loadBaseline()

    const lenDrift = structuredClone(baseline)
    lenDrift.modbusMaster[0].config.io_points[0].len = 4
    const lenProblems = checkConformance(lenDrift)
    assert.equal(lenProblems.length, 1)
    assert.equal(lenProblems[0].artifact, 'modbus_master.json')
    assert.match(lenProblems[0].message, /io_points/i)

    const portDrift = structuredClone(baseline)
    portDrift.modbusMaster[0].config.port = 502
    const portProblems = checkConformance(portDrift)
    assert.equal(portProblems.length, 1)
    assert.equal(portProblems[0].artifact, 'modbus_master.json')
    assert.match(portProblems[0].message, /port.*502.*5020/)
  })

  it('flags swapped conveyor belt and box spawner tags and unexpected non-contract tags in scene.json', () => {
    const baseline = loadBaseline()

    const swapped = structuredClone(baseline)
    const belt = swapped.scene.parts.find((p) => p.id === 'belt_1')
    const spawner = swapped.scene.parts.find((p) => p.id === 'spawner_1')
    ;[belt.params.runTag, spawner.params.runTag] = [spawner.params.runTag, belt.params.runTag]

    const swapProblems = checkConformance(swapped)
    assert.equal(swapProblems.length, 2)
    assert.ok(
      swapProblems.every((p) => p.artifact === 'scene.json'),
      `Expected all swap findings on scene.json, got: ${JSON.stringify(swapProblems)}`,
    )
    assert.ok(
      swapProblems.some((p) => /belt_1\.runTag.*%QX0\.1.*%QX0\.0/.test(p.message)),
      `Expected belt_1.runTag mismatch, got: ${JSON.stringify(swapProblems)}`,
    )
    assert.ok(
      swapProblems.some((p) => /spawner_1\.runTag.*%QX0\.0.*%QX0\.1/.test(p.message)),
      `Expected spawner_1.runTag mismatch, got: ${JSON.stringify(swapProblems)}`,
    )

    const unexpectedTag = structuredClone(baseline)
    const despawner = unexpectedTag.scene.parts.find((p) => p.id === 'despawner_1')
    despawner.params.countTag = '%QW99'

    const unexpectedProblems = checkConformance(unexpectedTag)
    assert.equal(unexpectedProblems.length, 1)
    assert.equal(unexpectedProblems[0].artifact, 'scene.json')
    assert.match(unexpectedProblems[0].message, /%QW99.*despawner_1\.countTag/)
  })
})
