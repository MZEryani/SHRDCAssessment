import { isDeepStrictEqual } from 'node:util'

const AREA_FC = Object.freeze({
  discreteInput: 2,
  coil: 15,
  holdingRegister: 16,
})

const AREA_ORDER = ['discreteInput', 'coil', 'holdingRegister']

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
        artifact: 'conveyor_cell.st',
        message: `Missing located variable ${sig.name} AT ${sig.iecAddress} : ${sig.type}`,
      })
    } else if (found.iecAddress !== sig.iecAddress || found.type !== sig.type) {
      problems.push({
        artifact: 'conveyor_cell.st',
        message: `Signal ${sig.name} declared as AT ${found.iecAddress} : ${found.type}, contract requires ${sig.iecAddress} : ${sig.type}`,
      })
    }
  }

  for (const [name, decl] of stVars) {
    if (!contractNames.has(name)) {
      problems.push({
        artifact: 'conveyor_cell.st',
        message: `Unexpected located variable ${name} AT ${decl.iecAddress} : ${decl.type} not present in I/O Contract`,
      })
    }
  }
}

function checkStParameters(contract, stSource, problems) {
  const paramChecks = [
    { name: 'BATCH_TARGET', expected: contract.parameters.batchTarget, kind: 'int' },
    { name: 'DWELL_TIME', expected: contract.parameters.inspectionDwellMs, kind: 'time' },
    { name: 'JAM_THRESHOLD_TIME', expected: contract.parameters.jamTimeoutMs, kind: 'time' },
    { name: 'SPAWN_PULSE_TIME', expected: contract.parameters.spawnPulseMs, kind: 'time' },
    { name: 'SPAWN_COOLDOWN_TIME', expected: contract.parameters.spawnCooldownMs, kind: 'time' },
  ]

  for (const { name, expected, kind } of paramChecks) {
    const rx = new RegExp(`${name}\\s*:\\s*\\w+\\s*:=\\s*([^;]+);`)
    const match = rx.exec(stSource)
    if (!match) {
      problems.push({
        artifact: 'conveyor_cell.st',
        message: `Missing constant ${name}`,
      })
      continue
    }
    const raw = match[1].trim()
    const actual = kind === 'time' ? parseIecTimeMs(raw) : Number(raw)
    if (actual !== expected) {
      problems.push({
        artifact: 'conveyor_cell.st',
        message: `Constant ${name} is ${raw}, contract requires ${kind === 'time' ? formatIecTime(expected) : expected}`,
      })
    }
  }

  const taskMatch = /TASK\s+\w+\s*\(\s*INTERVAL\s*:=\s*([^,)]+)/.exec(stSource)
  if (!taskMatch) {
    problems.push({
      artifact: 'conveyor_cell.st',
      message: `Missing TASK scan interval declaration (contract requires ${formatIecTime(contract.parameters.scanIntervalMs)})`,
    })
  } else if (parseIecTimeMs(taskMatch[1]) !== contract.parameters.scanIntervalMs) {
    problems.push({
      artifact: 'conveyor_cell.st',
      message: `Task scan interval is ${taskMatch[1].trim()}, contract requires ${formatIecTime(contract.parameters.scanIntervalMs)}`,
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
}

/**
 * Verify conformance of the PLC ST source, OpenPLC Modbus master config,
 * and OIP scene against the canonical I/O Contract.
 * Returns an array of `{ artifact, message }` findings (empty when conformant).
 */
export function checkConformance({ contract, stSource, modbusMaster, scene }) {
  const problems = []
  checkStDeclarations(contract, stSource, problems)
  checkStParameters(contract, stSource, problems)
  checkModbusMaster(contract, modbusMaster, problems)
  checkScene(contract, scene, problems)
  return problems
}
