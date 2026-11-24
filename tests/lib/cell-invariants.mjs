// Pure Cell Harness invariant helpers (zero OIP/Docker/Jolt dependencies).

const FLOAT_EPSILON_M = 1e-9

/**
 * Derive box length (meters) from the scene spawner part parameters or contract role.
 */
export function deriveBoxLengthFromScene(scene, contract) {
  const spawnerPart =
    scene.parts.find((p) => p.packageId === 'oip.box-spawner') ??
    scene.parts.find((p) =>
      contract?.signals?.some((s) => s.sceneRole?.partId === p.id && typeof p.params?.length === 'number'),
    )
  const length = spawnerPart?.params?.length
  if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) {
    throw new Error('Could not derive positive box length from scene spawner part parameters')
  }
  return length
}

/**
 * Return the resting (unactuated) process value for an I/O Contract signal.
 * Fail-safe Normally Closed (NC) inputs rest at true.
 */
export function restingSignalValue(signal) {
  if (signal.contact === 'NC') return true
  return signal.type === 'BOOL' ? false : 0
}

/**
 * Layer explicit symbolic Cell input overrides over base OIP world tags,
 * seeding resting defaults for every oip_to_plc signal in the I/O Contract.
 */
export function createTagOverlay(contract) {
  const inputSignals = contract.signals.filter((s) => s.direction === 'oip_to_plc')
  const outputSignals = contract.signals.filter((s) => s.direction === 'plc_to_oip')
  const inputByName = new Map(inputSignals.map((s) => [s.name, s]))
  const restingDefaults = Object.fromEntries(
    inputSignals.map((s) => [s.iecAddress, restingSignalValue(s)]),
  )

  let baseTags = { ...restingDefaults }
  const overrides = new Map()

  const assertKnownInput = (name) => {
    if (!inputByName.has(name)) {
      throw new Error(`Unknown symbolic Cell input "${name}"`)
    }
  }

  const setBase = (worldTags = {}) => {
    baseTags = { ...restingDefaults, ...worldTags }
  }

  const setOverride = (name, value) => {
    assertKnownInput(name)
    overrides.set(name, value)
  }

  const clearOverride = (name) => {
    assertKnownInput(name)
    overrides.delete(name)
  }

  const compose = () => {
    const merged = { ...baseTags }
    for (const [name, val] of overrides) {
      merged[inputByName.get(name).iecAddress] = val
    }
    return merged
  }

  const projectSignals = (signals, tags) =>
    Object.fromEntries(
      signals.map((sig) => [sig.name, tags[sig.iecAddress] ?? restingSignalValue(sig)]),
    )

  const snapshot = (
    plcOut = {},
    modbusTraffic = { discreteInputReads: 0, coilWrites: 0, holdingRegisterWrites: 0 },
  ) => ({
    inputs: projectSignals(inputSignals, compose()),
    outputs: projectSignals(outputSignals, plcOut),
    modbus: modbusTraffic,
  })

  return { setBase, setOverride, clearOverride, compose, snapshot }
}

/**
 * Extract active conveyor cargo bodies from a SimWorld frame and measure the
 * minimum center-to-center X spacing between adjacent boxes.
 */
export function measureMinBoxGap(frame, staticPartIds) {
  const cargo = []
  for (let i = 0; i < frame.partIds.length; i += 1) {
    const id = frame.partIds[i]
    if (!id || !staticPartIds.has(id)) {
      const x = frame.positions[i * 3]
      const y = frame.positions[i * 3 + 1]
      if (Number.isFinite(x) && Number.isFinite(y) && y > 0.5) {
        cargo.push({ index: i, id: id ?? `cargo_${i}`, x, y })
      }
    }
  }
  cargo.sort((a, b) => a.x - b.x)
  let minGapM = Infinity
  let closestPair = null
  for (let i = 1; i < cargo.length; i += 1) {
    const gap = cargo[i].x - cargo[i - 1].x
    if (gap < minGapM) {
      minGapM = gap
      closestPair = [cargo[i - 1], cargo[i]]
    }
  }
  return { cargo, minGapM, closestPair }
}

/**
 * Assert that active cargo boxes on the conveyor meet the minimum center-to-center
 * separation threshold, allowing IEEE-754 floating-point subtraction tolerance.
 */
export function assertBoxSpacing(frame, { staticPartIds, minSeparationM, simTime = 0 }) {
  const result = measureMinBoxGap(frame, staticPartIds)
  if (result.minGapM + FLOAT_EPSILON_M < minSeparationM) {
    throw new Error(
      `Touching boxes detected at t=${simTime.toFixed(2)}s: center spacing ${result.minGapM.toFixed(3)}m < ${minSeparationM.toFixed(3)}m`,
    )
  }
  return result
}
