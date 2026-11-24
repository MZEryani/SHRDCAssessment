import { isDeepStrictEqual } from 'node:util'

const AREA_FC = Object.freeze({
  discreteInput: 2,
  inputRegister: 4,
  coil: 15,
  holdingRegister: 16,
})

const AREA_ORDER = ['discreteInput', 'inputRegister', 'coil', 'holdingRegister']

function parseIecTimeMs(literal) {
  const match = /^T#(\d+(?:\.\d+)?)(ms|s)$/i.exec(literal.trim())
  if (!match) return null
  const val = Number(match[1])
  return match[2].toLowerCase() === 's' ? Math.round(val * 1000) : Math.round(val)
}

function formatIecTime(ms) {
  return ms % 1000 === 0 ? `T#${ms / 1000}s` : `T#${ms}ms`
}

function roleKey(partId, param) {
  return `${partId}.${param}`
}

/**
 * Derive the OpenPLC Modbus master configuration array directly from the
 * canonical I/O Contract by grouping contiguous signals per Modbus area.
 */
export function deriveModbusMaster(contract) {
  const byArea = new Map()
  for (const sig of contract.signals) {
    if (!byArea.has(sig.modbusArea)) byArea.set(sig.modbusArea, [])
    byArea.get(sig.modbusArea).push(sig)
  }

  const ioPoints = []
  for (const area of AREA_ORDER) {
    const sorted = (byArea.get(area) ?? []).slice().sort((a, b) => a.modbusAddress - b.modbusAddress)
    if (sorted.length === 0) continue

    const pushRun = (startSig, len) => {
      ioPoints.push({
        fc: AREA_FC[area],
        offset: String(startSig.modbusAddress),
        iec_location: startSig.iecAddress,
        len,
        cycle_time_ms: contract.modbus.cycleTimeMs,
      })
    }

    let runStart = sorted[0]
    let runLen = 1
    let prevAddr = sorted[0].modbusAddress

    for (let i = 1; i < sorted.length; i += 1) {
      const sig = sorted[i]
      if (sig.modbusAddress === prevAddr + 1) {
        runLen += 1
      } else {
        pushRun(runStart, runLen)
        runStart = sig
        runLen = 1
      }
      prevAddr = sig.modbusAddress
    }
    pushRun(runStart, runLen)
  }

  return [
    {
      name: 'oip_sim',
      protocol: 'MODBUS',
      config: {
        type: 'SLAVE',
        transport: 'tcp',
        host: contract.modbus.oipHostForPlc,
        port: contract.modbus.port,
        timeout_ms: 1000,
        slave_id: contract.modbus.slaveId,
        io_points: ioPoints,
      },
    },
  ]
}

function checkStDeclarations(contract, stSource, problems) {
  const stVars = new Map()
  for (const match of stSource.matchAll(/(\w+)\s+AT\s+(%[IQ][XW]\d+(?:\.\d+)?)\s*:\s*(\w+)\s*;/g)) {
    stVars.set(match[1], { iecAddress: match[2], type: match[3] })
  }

  const contractNames = new Set(contract.signals.map((s) => s.name))
  for (const sig of contract.signals) {
    const found = stVars.get(sig.name)
    if (!found) {
      problems.push({
        artifact: 'program.st',
        message: `Missing located variable ${sig.name} AT ${sig.iecAddress} : ${sig.type}`,
      })
    } else if (found.iecAddress !== sig.iecAddress || found.type !== sig.type) {
      problems.push({
        artifact: 'program.st',
        message: `Signal ${sig.name} declared as AT ${found.iecAddress} : ${found.type}, contract requires ${sig.iecAddress} : ${sig.type}`,
      })
    }
  }

  for (const [name, decl] of stVars) {
    if (!contractNames.has(name)) {
      problems.push({
        artifact: 'program.st',
        message: `Unexpected located variable ${name} AT ${decl.iecAddress} : ${decl.type} not present in I/O Contract`,
      })
    }
  }
}

function checkStPouNames(contract, stSource, problems) {
  const fbName = contract.plc?.functionBlockName
  if (fbName && !new RegExp(`\\bFUNCTION_BLOCK\\s+${fbName}\\b`).test(stSource)) {
    problems.push({
      artifact: 'program.st',
      message: `Missing FUNCTION_BLOCK ${fbName} required by I/O Contract`,
    })
  }
  const progName = contract.plc?.programName
  if (progName && !new RegExp(`\\bPROGRAM\\s+${progName}\\b`).test(stSource)) {
    problems.push({
      artifact: 'program.st',
      message: `Missing PROGRAM ${progName} required by I/O Contract`,
    })
  }
}

function checkStParameters(contract, stSource, problems) {
  const params = contract.parameters ?? {}
  const paramChecks = [
    { name: 'BATCH_TARGET', expected: params.batchTarget, kind: 'int' },
    { name: 'DWELL_TIME', expected: params.inspectionDwellMs, kind: 'time' },
    { name: 'JAM_THRESHOLD_TIME', expected: params.jamTimeoutMs, kind: 'time' },
    { name: 'SPAWN_PULSE_TIME', expected: params.spawnPulseMs, kind: 'time' },
    { name: 'SPAWN_COOLDOWN_TIME', expected: params.spawnCooldownMs, kind: 'time' },
  ]

  for (const { name, expected, kind } of paramChecks) {
    if (expected === undefined) continue
    const rx = new RegExp(`${name}\\s*:\\s*\\w+\\s*:=\\s*([^;]+);`)
    const match = rx.exec(stSource)
    if (!match) {
      problems.push({
        artifact: 'program.st',
        message: `Missing constant ${name}`,
      })
      continue
    }
    const raw = match[1].trim()
    const actual = kind === 'time' ? parseIecTimeMs(raw) : Number(raw)
    if (actual !== expected) {
      problems.push({
        artifact: 'program.st',
        message: `Constant ${name} is ${raw}, contract requires ${kind === 'time' ? formatIecTime(expected) : expected}`,
      })
    }
  }

  const scanIntervalMs = params.scanIntervalMs
  const taskMatch = /TASK\s+\w+\s*\(\s*INTERVAL\s*:=\s*([^,)]+)/.exec(stSource)
  if (!taskMatch) {
    problems.push({
      artifact: 'program.st',
      message: `Missing TASK scan interval declaration (contract requires ${formatIecTime(scanIntervalMs)})`,
    })
  } else if (parseIecTimeMs(taskMatch[1]) !== scanIntervalMs) {
    problems.push({
      artifact: 'program.st',
      message: `Task scan interval is ${taskMatch[1].trim()}, contract requires ${formatIecTime(scanIntervalMs)}`,
    })
  }
}

function checkModbusMaster(contract, modbusMaster, problems) {
  const beforeCount = problems.length
  const expectedMaster = deriveModbusMaster(contract)
  const expectedEntry = expectedMaster[0]
  const actualEntry = Array.isArray(modbusMaster) ? modbusMaster[0] : null

  if (!Array.isArray(modbusMaster) || modbusMaster.length !== expectedMaster.length || !actualEntry?.config) {
    problems.push({
      artifact: 'modbus_master.json',
      message: 'Modbus master config must contain a single oip_sim slave entry matching the I/O Contract',
    })
    return
  }

  for (const key of ['name', 'protocol']) {
    if (actualEntry[key] !== expectedEntry[key]) {
      problems.push({
        artifact: 'modbus_master.json',
        message: `Modbus entry ${key} is ${actualEntry[key]}, contract requires ${expectedEntry[key]}`,
      })
    }
  }

  const actualCfg = actualEntry.config
  const expectedCfg = expectedEntry.config
  for (const key of ['type', 'transport', 'host', 'port', 'timeout_ms', 'slave_id']) {
    if (actualCfg[key] !== expectedCfg[key]) {
      problems.push({
        artifact: 'modbus_master.json',
        message: `Modbus config ${key} is ${actualCfg[key]}, contract requires ${expectedCfg[key]}`,
      })
    }
  }

  if (!isDeepStrictEqual(actualCfg.io_points, expectedCfg.io_points)) {
    problems.push({
      artifact: 'modbus_master.json',
      message: `Modbus io_points drift from contract (expected ${expectedCfg.io_points.map((p) => `FC${p.fc}:${p.iec_location}x${p.len}`).join(', ')})`,
    })
  }

  if (problems.length === beforeCount && !isDeepStrictEqual(modbusMaster, expectedMaster)) {
    problems.push({
      artifact: 'modbus_master.json',
      message: 'Modbus master config contains unexpected properties differing from contract-derived config',
    })
  }
}

function checkScene(contract, scene, problems) {
  const parts = Array.isArray(scene?.parts) ? scene.parts : []
  const partsById = new Map(parts.map((p) => [p.id, p]))
  const expectedAddresses = new Set(contract.signals.map((s) => s.iecAddress))
  const expectedRoles = new Set()

  for (const sig of contract.signals) {
    if (!sig.sceneRole?.partId || !sig.sceneRole?.param) {
      problems.push({
        artifact: 'io-contract.json',
        message: `Signal ${sig.name} is missing sceneRole (partId and param)`,
      })
      continue
    }
    const { partId, param } = sig.sceneRole
    expectedRoles.add(roleKey(partId, param))
    const part = partsById.get(partId)
    if (!part) {
      problems.push({
        artifact: 'scene.json',
        message: `Missing scene part "${partId}" for ${sig.name}`,
      })
      continue
    }
    const actualTag = part.params?.[param]
    if (actualTag !== sig.iecAddress) {
      problems.push({
        artifact: 'scene.json',
        message: `Role mismatch on ${partId}.${param}: wired to ${actualTag || '(empty)'}, contract assigns ${sig.name} (${sig.iecAddress})`,
      })
    }
    if (
      part.packageId === 'oip.push-button' &&
      param === 'tag' &&
      part.params?.emergencyStop === true &&
      sig.contact !== 'NC'
    ) {
      problems.push({
        artifact: 'io-contract.json',
        message: `Signal ${sig.name} is wired to emergencyStop push-button ${partId} (always Normally Closed in OIP) but contract is missing contact: "NC"`,
      })
    }
  }

  for (const part of parts) {
    for (const [key, val] of Object.entries(part.params ?? {})) {
      if (!(key.endsWith('Tag') || key === 'tag')) continue
      if (typeof val !== 'string' || val.length === 0) continue
      if (!expectedAddresses.has(val)) {
        problems.push({
          artifact: 'scene.json',
          message: `Unexpected tag ${val} on ${part.id}.${key} not present in I/O Contract`,
        })
      } else if (!expectedRoles.has(roleKey(part.id, key))) {
        problems.push({
          artifact: 'scene.json',
          message: `Unexpected tag wiring ${val} on ${part.id}.${key} not assigned by I/O Contract`,
        })
      }
    }
  }
  const plcs = Array.isArray(scene?.plcs) ? scene.plcs : []
  const hasAutoServe = plcs.some((plc) => plc?.protocol === 'serve' && plc?.connect === true)
  if (!hasAutoServe) {
    problems.push({
      artifact: 'scene.json',
      message:
        'Missing top-level plcs entry with protocol: "serve" and connect: true so OIP Desktop auto-starts Modbus TCP on Play',
    })
  }
}

const IEC_IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/
const BIT_ADDR_RX = /^%([IQ])X(\d+)\.([0-7])$/
const WORD_ADDR_RX = /^%([IQ])W(\d+)$/
const WORD_TYPES = new Set(['INT', 'WORD', 'DINT', 'UINT'])

function parseIecAddress(addr) {
  if (typeof addr !== 'string') return null
  const bitMatch = BIT_ADDR_RX.exec(addr)
  if (bitMatch) {
    const dir = bitMatch[1] === 'I' ? 'oip_to_plc' : 'plc_to_oip'
    const area = bitMatch[1] === 'I' ? 'discreteInput' : 'coil'
    return {
      direction: dir,
      modbusArea: area,
      modbusAddress: Number(bitMatch[2]) * 8 + Number(bitMatch[3]),
      isBit: true,
    }
  }
  const wordMatch = WORD_ADDR_RX.exec(addr)
  if (wordMatch) {
    const dir = wordMatch[1] === 'I' ? 'oip_to_plc' : 'plc_to_oip'
    const area = wordMatch[1] === 'I' ? 'inputRegister' : 'holdingRegister'
    return {
      direction: dir,
      modbusArea: area,
      modbusAddress: Number(wordMatch[2]),
      isBit: false,
    }
  }
  return null
}

/**
 * Validate a Stage 1 I/O Contract against the canonical schema and (optionally)
 * OIP's live part catalog (`{ parts: [...] }`).
 */
export function validateContractSchema(contract, { catalog = null, requirePlc = true } = {}) {
  const problems = []
  const add = (message) => problems.push({ artifact: 'io-contract.json', message })

  if (!contract || typeof contract !== 'object') {
    add('I/O Contract must be a JSON object')
    return { ok: false, problems }
  }
  if (typeof contract.name !== 'string' || contract.name.trim().length === 0) {
    add('Missing non-empty top-level "name"')
  }
  if (typeof contract.version !== 'string' || contract.version.trim().length === 0) {
    add('Missing non-empty top-level "version"')
  }

  const mb = contract.modbus
  if (!mb || typeof mb !== 'object') {
    add('Missing top-level "modbus" object')
  } else {
    if (typeof mb.oipHostForPlc !== 'string' || mb.oipHostForPlc.trim().length === 0) {
      add('modbus.oipHostForPlc must be a non-empty string')
    }
    for (const key of ['port', 'slaveId', 'cycleTimeMs']) {
      if (!Number.isInteger(mb[key]) || mb[key] <= 0) {
        add(`modbus.${key} must be a positive integer`)
      }
    }
  }

  if (!Number.isInteger(contract.parameters?.scanIntervalMs) || contract.parameters.scanIntervalMs <= 0) {
    add('parameters.scanIntervalMs must be a positive integer')
  }

  if (requirePlc) {
    const fb = contract.plc?.functionBlockName
    const prog = contract.plc?.programName
    if (typeof fb !== 'string' || !IEC_IDENT_RX.test(fb)) {
      add('Missing or invalid plc.functionBlockName (must be a valid IEC 61131-3 identifier)')
    }
    if (typeof prog !== 'string' || !IEC_IDENT_RX.test(prog)) {
      add('Missing or invalid plc.programName (must be a valid IEC 61131-3 identifier)')
    }
    if (fb && prog && fb === prog) {
      add('plc.functionBlockName and plc.programName must be distinct identifiers')
    }
  }

  if (!Array.isArray(contract.signals) || contract.signals.length === 0) {
    add('signals must be a non-empty array')
    return { ok: false, problems }
  }

  const catalogById = catalog?.parts ? new Map(catalog.parts.map((p) => [p.id, p])) : null

  const seenNames = new Set()
  const seenIec = new Set()
  const seenAreaAddr = new Set()
  const seenRoles = new Set()

  for (const sig of contract.signals) {
    const label = sig?.name || '(unnamed signal)'
    if (typeof sig?.name !== 'string' || !IEC_IDENT_RX.test(sig.name)) {
      add(`Invalid signal name "${label}" (must be a valid IEC 61131-3 identifier)`)
    } else if (seenNames.has(sig.name)) {
      add(`Duplicate signal name "${sig.name}"`)
    } else {
      seenNames.add(sig.name)
    }

    const parsed = parseIecAddress(sig?.iecAddress)
    if (!parsed) {
      add(`Signal ${label} has invalid iecAddress "${sig?.iecAddress}" (expected %IXn.b, %QXn.b, %IWn, or %QWn)`)
    } else {
      if (seenIec.has(sig.iecAddress)) {
        add(`Duplicate iecAddress "${sig.iecAddress}" on signal ${label}`)
      } else {
        seenIec.add(sig.iecAddress)
      }
      if (sig.direction !== parsed.direction) {
        add(`Signal ${label} has direction "${sig.direction}", expected "${parsed.direction}" for ${sig.iecAddress}`)
      }
      if (sig.modbusArea !== parsed.modbusArea) {
        add(`Signal ${label} has modbusArea "${sig.modbusArea}", expected "${parsed.modbusArea}" for ${sig.iecAddress}`)
      }
      if (sig.modbusAddress !== parsed.modbusAddress) {
        add(
          `Signal ${label} has modbusAddress ${sig.modbusAddress}, expected ${parsed.modbusAddress} for ${sig.iecAddress}`,
        )
      }
      const areaKey = `${sig.modbusArea}:${sig.modbusAddress}`
      if (seenAreaAddr.has(areaKey)) {
        add(`Duplicate Modbus register ${areaKey} on signal ${label}`)
      } else {
        seenAreaAddr.add(areaKey)
      }
      if (parsed.isBit && sig.type !== 'BOOL') {
        add(`Signal ${label} (${sig.iecAddress}) must have type "BOOL", got "${sig.type}"`)
      } else if (!parsed.isBit && !WORD_TYPES.has(sig.type)) {
        add(`Signal ${label} (${sig.iecAddress}) must have word type (INT/WORD/DINT/UINT), got "${sig.type}"`)
      }
    }

    const partId = sig?.sceneRole?.partId
    const param = sig?.sceneRole?.param
    if (typeof partId !== 'string' || !partId.trim() || typeof param !== 'string' || !param.trim()) {
      add(`Signal ${label} is missing sceneRole.partId or sceneRole.param`)
      continue
    }
    const rKey = roleKey(partId, param)
    if (seenRoles.has(rKey)) {
      add(`Duplicate sceneRole ${rKey} on signal ${label}`)
    } else {
      seenRoles.add(rKey)
    }

    if (catalogById) {
      const packageId = sig.sceneRole.packageId
      if (typeof packageId !== 'string' || !packageId.trim()) {
        add(`Signal ${label} (${rKey}) is missing sceneRole.packageId required for OIP catalog validation`)
        continue
      }
      const partDef = catalogById.get(packageId)
      if (!partDef) {
        add(`Signal ${label} references unsupported OIP packageId "${packageId}" not found in OIP catalog`)
        continue
      }
      const sigDef = (partDef.signals ?? []).find((s) => s.name === param)
      if (!sigDef) {
        const validParams = (partDef.signals ?? []).map((s) => s.name).join(', ') || '(none)'
        add(
          `Signal ${label} references unknown param "${param}" on ${packageId} (available signals: ${validParams})`,
        )
        continue
      }
      const expectedDir = sigDef.dir === 'out' ? 'oip_to_plc' : 'plc_to_oip'
      if (sig.direction !== expectedDir) {
        add(
          `Signal ${label} direction "${sig.direction}" conflicts with OIP ${packageId}.${param} (dir="${sigDef.dir}" requires "${expectedDir}")`,
        )
      }
      if (sigDef.type && sig.type !== sigDef.type) {
        add(
          `Signal ${label} type "${sig.type}" conflicts with OIP ${packageId}.${param} (catalog type is "${sigDef.type}")`,
        )
      }
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * Verify conformance of the PLC ST source, OpenPLC Modbus master config,
 * and OIP scene against the canonical I/O Contract.
 * Returns an array of `{ artifact, message }` findings (empty when conformant).
 */
export function checkConformance({ contract, stSource, modbusMaster, scene }) {
  const problems = []
  checkStDeclarations(contract, stSource, problems)
  checkStPouNames(contract, stSource, problems)
  checkStParameters(contract, stSource, problems)
  checkModbusMaster(contract, modbusMaster, problems)
  checkScene(contract, scene, problems)
  return problems
}
