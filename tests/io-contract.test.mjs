import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkConformance,
  deriveModbusMaster,
  validateContractSchema,
} from '../scripts/io-contract.mjs'
import { formatCatalogSummary } from '../scripts/oip-catalog.mjs'
import { validateOipCell } from '../scripts/validate-oip-cell.mjs'
import { extractLayoutWarnings, verifyCell } from '../scripts/verify-cell.mjs'
import { deriveBoxLengthFromScene } from './lib/cell-harness.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadBaseline() {
  return {
    contract: JSON.parse(readFileSync(join(REPO_ROOT, 'openplc', 'io-contract.json'), 'utf8')),
    stSource: readFileSync(join(REPO_ROOT, 'scenes', 'conveyor-cell', 'plc', 'program.st'), 'utf8'),
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
    assert.equal(addrProblems[0].artifact, 'program.st')
    assert.match(addrProblems[0].message, /PhotoEye.*%IX0\.5.*%IX0\.4/)

    const typeDrift = structuredClone(baseline)
    typeDrift.stSource = typeDrift.stSource.replace(
      'Box_Count      AT %QW0   : INT;',
      'Box_Count      AT %QW0   : WORD;',
    )
    const typeProblems = checkConformance(typeDrift)
    assert.equal(typeProblems.length, 1)
    assert.equal(typeProblems[0].artifact, 'program.st')
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
        (p) => p.artifact === 'program.st' && /PhotoEye.*%IX0\.0.*%IX0\.4/.test(p.message),
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
    assert.equal(batchProblems[0].artifact, 'program.st')
    assert.match(batchProblems[0].message, /BATCH_TARGET.*8.*5/)

    const dwellDrift = structuredClone(baseline)
    dwellDrift.stSource = dwellDrift.stSource.replace(
      'DWELL_TIME          : TIME := T#2s;',
      'DWELL_TIME          : TIME := T#3s;',
    )
    const dwellProblems = checkConformance(dwellDrift)
    assert.equal(dwellProblems.length, 1)
    assert.equal(dwellProblems[0].artifact, 'program.st')
    assert.match(dwellProblems[0].message, /DWELL_TIME.*T#3s.*T#2s/)

    const jamDrift = structuredClone(baseline)
    jamDrift.stSource = jamDrift.stSource.replace(
      'JAM_THRESHOLD_TIME  : TIME := T#4s;',
      'JAM_THRESHOLD_TIME  : TIME := T#6s;',
    )
    const jamProblems = checkConformance(jamDrift)
    assert.equal(jamProblems.length, 1)
    assert.equal(jamProblems[0].artifact, 'program.st')
    assert.match(jamProblems[0].message, /JAM_THRESHOLD_TIME.*T#6s.*T#4s/)

    const scanDrift = structuredClone(baseline)
    scanDrift.stSource = scanDrift.stSource.replace(
      'TASK task0(INTERVAL := T#20ms, PRIORITY := 0);',
      'TASK task0(INTERVAL := T#50ms, PRIORITY := 0);',
    )
    const scanProblems = checkConformance(scanDrift)
    assert.equal(scanProblems.length, 1)
    assert.equal(scanProblems[0].artifact, 'program.st')
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

  it('supports %IW inputRegister (FC 4), optional Cell parameters, frozen plc POU names, and scene.plcs auto-serve on arbitrary Cells', () => {
    const colorContract = {
      name: 'color-sorter',
      version: '1.0.0',
      plc: {
        functionBlockName: 'ColorSorterController',
        programName: 'ColorSorterMain',
      },
      modbus: {
        topology: 'oip-server-openplc-master',
        oipHostForPlc: 'host.docker.internal',
        port: 5020,
        slaveId: 1,
        cycleTimeMs: 50,
      },
      parameters: {
        scanIntervalMs: 20,
      },
      signals: [
        {
          name: 'Start_PB',
          iecAddress: '%IX0.0',
          type: 'BOOL',
          direction: 'oip_to_plc',
          modbusArea: 'discreteInput',
          modbusAddress: 0,
          sceneRole: { partId: 'start_pb', param: 'tag', packageId: 'oip.push-button' },
        },
        {
          name: 'Color_Code',
          iecAddress: '%IW0',
          type: 'INT',
          direction: 'oip_to_plc',
          modbusArea: 'inputRegister',
          modbusAddress: 0,
          sceneRole: { partId: 'color_1', param: 'colorTag', packageId: 'oip.color-sensor' },
        },
        {
          name: 'Diverter_Cmd',
          iecAddress: '%QX0.0',
          type: 'BOOL',
          direction: 'plc_to_oip',
          modbusArea: 'coil',
          modbusAddress: 0,
          sceneRole: { partId: 'diverter_1', param: 'tag', packageId: 'oip.diverter' },
        },
      ],
    }

    const derived = deriveModbusMaster(colorContract)
    assert.deepEqual(derived[0].config.io_points, [
      { fc: 2, offset: '0', iec_location: '%IX0.0', len: 1, cycle_time_ms: 50 },
      { fc: 4, offset: '0', iec_location: '%IW0', len: 1, cycle_time_ms: 50 },
      { fc: 15, offset: '0', iec_location: '%QX0.0', len: 1, cycle_time_ms: 50 },
    ])

    const validSt = [
      'FUNCTION_BLOCK ColorSorterController',
      'VAR_INPUT Start_PB : BOOL; Color_Code : INT; END_VAR',
      'VAR_OUTPUT Diverter_Cmd : BOOL; END_VAR',
      'END_FUNCTION_BLOCK',
      'PROGRAM ColorSorterMain',
      'VAR',
      '  Start_PB AT %IX0.0 : BOOL;',
      '  Color_Code AT %IW0 : INT;',
      '  Diverter_Cmd AT %QX0.0 : BOOL;',
      'END_VAR',
      'END_PROGRAM',
      'CONFIGURATION Config0',
      '  RESOURCE Res0 ON PLC',
      '    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);',
      '    PROGRAM inst0 WITH task0 : ColorSorterMain;',
      '  END_RESOURCE',
      'END_CONFIGURATION',
    ].join('\n')

    const validScene = {
      version: 4,
      parts: [
        { id: 'start_pb', packageId: 'oip.push-button', params: { tag: '%IX0.0' } },
        { id: 'color_1', packageId: 'oip.color-sensor', params: { colorTag: '%IW0' } },
        { id: 'diverter_1', packageId: 'oip.diverter', params: { tag: '%QX0.0' } },
      ],
      plcs: [{ name: 'PLC1', runsOn: 'plc', protocol: 'serve', connect: true }],
    }

    assert.deepEqual(
      checkConformance({
        contract: colorContract,
        stSource: validSt,
        modbusMaster: derived,
        scene: validScene,
      }),
      [],
    )

    // Missing frozen FUNCTION_BLOCK name and missing scene.plcs auto-serve must be flagged
    const brokenSt = validSt.replaceAll('ColorSorterController', 'WrongNameFB')
    const brokenScene = { ...validScene, plcs: [] }
    const problems = checkConformance({
      contract: colorContract,
      stSource: brokenSt,
      modbusMaster: derived,
      scene: brokenScene,
    })
    assert.ok(
      problems.some((p) => p.artifact === 'program.st' && /ColorSorterController/.test(p.message)),
      `Expected missing FUNCTION_BLOCK finding, got: ${JSON.stringify(problems)}`,
    )
    assert.ok(
      problems.some((p) => p.artifact === 'scene.json' && /plcs.*serve/i.test(p.message)),
      `Expected missing scene.plcs auto-serve finding, got: ${JSON.stringify(problems)}`,
    )
  })
})

function makeTempCellFixture() {
  const root = mkdtempSync(join(tmpdir(), 'oip-validate-fixture-'))
  mkdirSync(join(root, 'openplc'), { recursive: true })
  mkdirSync(join(root, 'scenes', 'conveyor-cell', 'plc'), { recursive: true })
  for (const rel of [
    join('openplc', 'io-contract.json'),
    join('openplc', 'conveyor_cell_modbus_master.json'),
    join('scenes', 'conveyor-cell', 'scene.json'),
    join('scenes', 'conveyor-cell', 'plc', 'program.st'),
  ]) {
    cpSync(join(REPO_ROOT, rel), join(root, rel))
  }
  return root
}

function runWithFixture(mutate) {
  const fixtureRoot = makeTempCellFixture()
  try {
    mutate(fixtureRoot)
    let oipCalled = false
    const errors = []
    const result = validateOipCell({
      repoRoot: fixtureRoot,
      runOipValidators: () => {
        oipCalled = true
      },
      log: () => {},
      error: (msg) => errors.push(msg),
    })
    return { result, oipCalled, errors }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

describe('OIP validation CLI conformance gate', () => {
  it('fails with a role-mismatch message before invoking OIP validators when belt and spawner tags are swapped', () => {
    const { result, oipCalled, errors } = runWithFixture((fixtureRoot) => {
      const scenePath = join(fixtureRoot, 'scenes', 'conveyor-cell', 'scene.json')
      const scene = JSON.parse(readFileSync(scenePath, 'utf8'))
      const belt = scene.parts.find((p) => p.id === 'belt_1')
      const spawner = scene.parts.find((p) => p.id === 'spawner_1')
      ;[belt.params.runTag, spawner.params.runTag] = [spawner.params.runTag, belt.params.runTag]
      writeFileSync(scenePath, JSON.stringify(scene, null, 2), 'utf8')
    })

    assert.equal(result.ok, false)
    assert.equal(oipCalled, false, 'OIP CLI validators must not run when conformance fails')
    assert.match(errors.join('\n'), /\[scene\.json\].*Role mismatch on belt_1\.runTag/)
    assert.match(errors.join('\n'), /\[scene\.json\].*Role mismatch on spawner_1\.runTag/)
  })

  it('fails before invoking OIP validators on ST AT drift, ST constant drift, or Modbus io_points drift', () => {
    const mutations = [
      {
        label: 'ST AT address drift',
        mutate: (root) => {
          const stPath = join(root, 'scenes', 'conveyor-cell', 'plc', 'program.st')
          const src = readFileSync(stPath, 'utf8').replace('PhotoEye       AT %IX0.4', 'PhotoEye       AT %IX0.5')
          writeFileSync(stPath, src, 'utf8')
        },
        expectedPattern: /\[program\.st\].*PhotoEye.*%IX0\.5/,
      },
      {
        label: 'ST Batch constant drift',
        mutate: (root) => {
          const stPath = join(root, 'scenes', 'conveyor-cell', 'plc', 'program.st')
          const src = readFileSync(stPath, 'utf8').replace('BATCH_TARGET        : INT  := 5;', 'BATCH_TARGET        : INT  := 7;')
          writeFileSync(stPath, src, 'utf8')
        },
        expectedPattern: /\[program\.st\].*BATCH_TARGET.*7.*5/,
      },
      {
        label: 'Modbus io_points drift',
        mutate: (root) => {
          const mbPath = join(root, 'openplc', 'conveyor_cell_modbus_master.json')
          const cfg = JSON.parse(readFileSync(mbPath, 'utf8'))
          cfg[0].config.io_points[0].len = 4
          writeFileSync(mbPath, JSON.stringify(cfg, null, 2), 'utf8')
        },
        expectedPattern: /\[modbus_master\.json\].*io_points/,
      },
    ]

    for (const { label, mutate, expectedPattern } of mutations) {
      const { result, oipCalled, errors } = runWithFixture(mutate)
      assert.equal(result.ok, false, `Expected failure for ${label}`)
      assert.equal(oipCalled, false, `OIP CLI validators must not run for ${label}`)
      assert.match(errors.join('\n'), expectedPattern, `Unexpected output for ${label}: ${errors.join('\n')}`)
    }
  })

  it('invokes OIP validators and succeeds on the clean repository baseline', () => {
    let oipCalled = false
    const result = validateOipCell({
      repoRoot: REPO_ROOT,
      runOipValidators: () => {
        oipCalled = true
      },
      log: () => {},
      error: () => {},
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.problems, [])
    assert.equal(oipCalled, true)
  })
})

describe('Tracer artifacts I/O Contract alignment', () => {
  it('aligns tracer_bullet.st and tracer_modbus_master.json with canonical PhotoEye (%IX0.4) and Conveyor_Run (%QX0.0)', () => {
    const { contract } = loadBaseline()
    const tracerSt = readFileSync(join(REPO_ROOT, 'openplc', 'tracer_bullet.st'), 'utf8')
    const tracerModbus = JSON.parse(
      readFileSync(join(REPO_ROOT, 'openplc', 'tracer_modbus_master.json'), 'utf8'),
    )

    const tracerContract = {
      ...contract,
      signals: contract.signals.filter((s) => s.name === 'PhotoEye' || s.name === 'Conveyor_Run'),
    }

    assert.match(tracerSt, /PhotoEye\s+AT\s+%IX0\.4\s*:\s*BOOL\s*;/)
    assert.doesNotMatch(tracerSt, /PhotoEye\s+AT\s+%IX0\.0\b/)
    assert.match(tracerSt, /Conveyor_Run\s+AT\s+%QX0\.0\s*:\s*BOOL\s*;/)
    assert.deepEqual(tracerModbus, deriveModbusMaster(tracerContract))
  })
})

describe('Stage 1 I/O Contract schema and OIP catalog validation', () => {
  const sampleCatalog = {
    parts: [
      {
        id: 'oip.push-button',
        name: 'Push Button',
        signals: [
          { name: 'tag', dir: 'out', type: 'BOOL' },
          { name: 'lampTag', dir: 'in', type: 'BOOL' },
        ],
      },
      {
        id: 'oip.color-sensor',
        name: 'Color Sensor',
        signals: [{ name: 'colorTag', dir: 'out', type: 'INT' }],
      },
      {
        id: 'oip.diverter',
        name: 'Diverter',
        signals: [{ name: 'tag', dir: 'in', type: 'BOOL' }],
      },
    ],
  }

  const validColorContract = {
    name: 'color-sorter',
    version: '1.0.0',
    plc: { functionBlockName: 'ColorSorterController', programName: 'ColorSorterMain' },
    modbus: {
      topology: 'oip-server-openplc-master',
      oipHostForPlc: 'host.docker.internal',
      port: 5020,
      slaveId: 1,
      cycleTimeMs: 50,
    },
    parameters: { scanIntervalMs: 20 },
    signals: [
      {
        name: 'Start_PB',
        iecAddress: '%IX0.0',
        type: 'BOOL',
        direction: 'oip_to_plc',
        modbusArea: 'discreteInput',
        modbusAddress: 0,
        sceneRole: { partId: 'start_pb', param: 'tag', packageId: 'oip.push-button' },
      },
      {
        name: 'Color_Code',
        iecAddress: '%IW0',
        type: 'INT',
        direction: 'oip_to_plc',
        modbusArea: 'inputRegister',
        modbusAddress: 0,
        sceneRole: { partId: 'color_1', param: 'colorTag', packageId: 'oip.color-sensor' },
      },
      {
        name: 'Diverter_Cmd',
        iecAddress: '%QX0.0',
        type: 'BOOL',
        direction: 'plc_to_oip',
        modbusArea: 'coil',
        modbusAddress: 0,
        sceneRole: { partId: 'diverter_1', param: 'tag', packageId: 'oip.diverter' },
      },
    ],
  }

  it('accepts a valid contract against the OIP catalog', () => {
    const res = validateContractSchema(validColorContract, { catalog: sampleCatalog })
    assert.equal(res.ok, true, JSON.stringify(res.problems))
    assert.deepEqual(res.problems, [])
  })

  it('rejects missing plc POU names, mismatched modbusAddress, unknown OIP packageId, invalid signal param, and inverted signal direction', () => {
    const broken = structuredClone(validColorContract)
    delete broken.plc
    broken.signals[0].modbusAddress = 3 // %IX0.0 must be 0
    broken.signals[1].sceneRole.param = 'tag' // oip.color-sensor uses colorTag, not tag
    broken.signals[2].sceneRole.packageId = 'oip.welding-laser' // unsupported hardware
    broken.signals.push({
      name: 'Bad_Dir',
      iecAddress: '%QX0.1',
      type: 'BOOL',
      direction: 'plc_to_oip',
      modbusArea: 'coil',
      modbusAddress: 1,
      sceneRole: { partId: 'start_pb_2', param: 'tag', packageId: 'oip.push-button' }, // tag is dir:'out' -> oip_to_plc
    })
    broken.signals.push({
      name: 'Bad_Type',
      iecAddress: '%IX0.1',
      type: 'BOOL',
      direction: 'oip_to_plc',
      modbusArea: 'discreteInput',
      modbusAddress: 1,
      sceneRole: { partId: 'color_2', param: 'colorTag', packageId: 'oip.color-sensor' }, // colorTag is INT, not BOOL
    })

    const res = validateContractSchema(broken, { catalog: sampleCatalog })
    assert.equal(res.ok, false)
    const messages = res.problems.map((p) => p.message).join('\n')
    assert.match(messages, /plc\.functionBlockName/i)
    assert.match(messages, /Start_PB.*modbusAddress/i)
    assert.match(messages, /oip\.color-sensor.*tag/i)
    assert.match(messages, /oip\.welding-laser/i)
    assert.match(messages, /Bad_Dir.*direction/i)
    assert.match(messages, /Bad_Type.*type.*BOOL.*INT/i)
  })

  it('formats a concise OIP catalog summary with part IDs and signal signatures', () => {
    const summary = formatCatalogSummary(sampleCatalog)
    assert.match(summary, /oip\.color-sensor.*colorTag\(out:INT\)/)
    assert.match(summary, /oip\.diverter.*tag\(in:BOOL\)/)
  })
})

describe('Generic per-Cell verifier (cell:verify)', () => {
  function makeSelfContainedCellFixture(slug = 'color-sorter') {
    const root = mkdtempSync(join(tmpdir(), 'cell-verify-fixture-'))
    const cellDir = join(root, 'scenes', slug)
    mkdirSync(join(cellDir, 'plc'), { recursive: true })
    mkdirSync(join(cellDir, 'tests'), { recursive: true })

    const contract = {
      name: slug,
      version: '1.0.0',
      plc: { functionBlockName: 'ColorSorterController', programName: 'ColorSorterMain' },
      modbus: {
        topology: 'oip-server-openplc-master',
        oipHostForPlc: 'host.docker.internal',
        port: 5020,
        slaveId: 1,
        cycleTimeMs: 50,
      },
      parameters: { scanIntervalMs: 20 },
      signals: [
        {
          name: 'Color_Code',
          iecAddress: '%IW0',
          type: 'INT',
          direction: 'oip_to_plc',
          modbusArea: 'inputRegister',
          modbusAddress: 0,
          sceneRole: { partId: 'color_1', param: 'colorTag', packageId: 'oip.color-sensor' },
        },
        {
          name: 'Diverter_Cmd',
          iecAddress: '%QX0.0',
          type: 'BOOL',
          direction: 'plc_to_oip',
          modbusArea: 'coil',
          modbusAddress: 0,
          sceneRole: { partId: 'diverter_1', param: 'tag', packageId: 'oip.diverter' },
        },
      ],
    }

    const stSource = [
      'FUNCTION_BLOCK ColorSorterController',
      'VAR_INPUT Color_Code : INT; END_VAR',
      'VAR_OUTPUT Diverter_Cmd : BOOL; END_VAR',
      '  Diverter_Cmd := (Color_Code = 1);',
      'END_FUNCTION_BLOCK',
      'PROGRAM ColorSorterMain',
      'VAR',
      '  Color_Code AT %IW0 : INT;',
      '  Diverter_Cmd AT %QX0.0 : BOOL;',
      'END_VAR',
      'END_PROGRAM',
      'CONFIGURATION Config0',
      '  RESOURCE Res0 ON PLC',
      '    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);',
      '    PROGRAM inst0 WITH task0 : ColorSorterMain;',
      '  END_RESOURCE',
      'END_CONFIGURATION',
    ].join('\n')

    const scene = {
      version: 4,
      parts: [
        { id: 'color_1', packageId: 'oip.color-sensor', params: { colorTag: '%IW0' } },
        { id: 'diverter_1', packageId: 'oip.diverter', params: { tag: '%QX0.0' } },
      ],
      plcs: [{ name: 'PLC1', runsOn: 'plc', protocol: 'serve', connect: true }],
    }

    writeFileSync(join(cellDir, 'io-contract.json'), JSON.stringify(contract, null, 2), 'utf8')
    writeFileSync(join(cellDir, 'plc', 'program.st'), stSource, 'utf8')
    writeFileSync(
      join(cellDir, 'plc', 'modbus_master.json'),
      JSON.stringify(deriveModbusMaster(contract), null, 2),
      'utf8',
    )
    writeFileSync(join(cellDir, 'scene.json'), JSON.stringify(scene, null, 2), 'utf8')
    writeFileSync(join(cellDir, 'tests', 'program.test.st'), "TEST 'smoke' END_TEST\n", 'utf8')
    return root
  }

  it('verifies a self-contained generated Cell and surfaces non-fatal layout warnings without failing', () => {
    const root = makeSelfContainedCellFixture('color-sorter')
    try {
      let plcCalledWith = null
      const result = verifyCell({
        slug: 'color-sorter',
        repoRoot: root,
        runPlcTest: (args) => {
          plcCalledWith = args
          return { passed: true, summary: '1 test passed' }
        },
        runOipValidators: () => ({
          passed: true,
          warnings: ['spawner_1: feed warning on stopped belt'],
          summary: 'ok with 1 warning',
        }),
        log: () => {},
        error: () => {},
      })

      assert.equal(result.ok, true)
      assert.equal(result.gates.contract.passed, true)
      assert.equal(result.gates.plcTest.passed, true)
      assert.equal(result.gates.oipValidate.passed, true)
      assert.deepEqual(result.warnings, ['spawner_1: feed warning on stopped belt'])
      assert.match(plcCalledWith.stPath, /scenes[/\\]color-sorter[/\\]plc[/\\]program\.st$/)
      assert.match(plcCalledWith.testPath, /scenes[/\\]color-sorter[/\\]tests[/\\]program\.test\.st$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails when OIP layout or wiring validation reports an error', () => {
    const root = makeSelfContainedCellFixture('color-sorter')
    try {
      const result = verifyCell({
        slug: 'color-sorter',
        repoRoot: root,
        runPlcTest: () => ({ passed: true, summary: 'ok' }),
        runOipValidators: () => ({
          passed: false,
          warnings: [],
          summary: 'check-layout failed: diverter_1 is floating',
        }),
        log: () => {},
        error: () => {},
      })

      assert.equal(result.ok, false)
      assert.equal(result.gates.oipValidate.passed, false)
      assert.match(result.gates.oipValidate.summary, /floating/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts non-fatal warnings from OIP check-layout --json output while ignoring errors', () => {
    const npmStdout = [
      '> oip-web@0.1.0 check-layout',
      '> node scripts/check-layout.mjs scenes/color-sorter --json',
      JSON.stringify({
        ok: true,
        errors: 0,
        warnings: 1,
        projects: [
          {
            project: 'color-sorter',
            parts: 8,
            findings: [
              {
                partId: 'spawner_1',
                packageId: 'oip.box-spawner',
                kind: 'feed-ungated',
                severity: 'warning',
                detail: 'drops onto a belt that starts and stops',
              },
            ],
          },
        ],
      }),
    ].join('\n')

    assert.deepEqual(extractLayoutWarnings(npmStdout), [
      'spawner_1: drops onto a belt that starts and stops',
    ])
  })

  it('resolves Task 1 conveyor-cell legacy layout and passes all 3 gates', () => {
    let plcCalledWith = null
    const result = verifyCell({
      slug: 'conveyor-cell',
      repoRoot: REPO_ROOT,
      runPlcTest: (args) => {
        plcCalledWith = args
        return { passed: true, summary: 'passed' }
      },
      runOipValidators: () => ({ passed: true, warnings: [], summary: 'ok' }),
      log: () => {},
      error: () => {},
    })

    assert.equal(result.ok, true)
    assert.match(plcCalledWith.testPath, /tests[/\\]conveyor_cell\.test\.st$/)
  })
})

describe('Cell Harness geometry derivation', () => {
  it('derives box length from the scene spawner parameters instead of a hard-coded constant', () => {
    const { contract, scene } = loadBaseline()
    assert.equal(deriveBoxLengthFromScene(scene, contract), 0.4)

    const resizedScene = structuredClone(scene)
    resizedScene.parts.find((p) => p.id === 'spawner_1').params.length = 0.65
    assert.equal(deriveBoxLengthFromScene(resizedScene, contract), 0.65)
  })
})
