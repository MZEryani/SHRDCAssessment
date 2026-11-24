---
name: oip-scene
description: Construct and wire any Open Industry Project (OIP) 3D Cell headlessly via OIP CLI from its frozen I/O Contract. Use when creating or editing scenes/<slug>/project.json, scene.json, or parts/.
---

# OIP Headless 3D Cell Authoring

Construct valid, Modbus-ready Open Industry Project (`OIP`) v4 Cell folders headlessly inside isolated git worktrees.

## Steps

1. Read `scenes/<slug>/io-contract.json`, `scenes/<slug>/process-spec.md`, and `GLOSSARY.md`. Use OIP's CLI (`add-part`, `snap-part`, `edit-part`) and the contract directly rather than searching `Open-Industry-Project/` source files.
2. Bootstrap the Cell folder (`scenes/<slug>/`) with `npm --prefix Open-Industry-Project run add-part -- "$PWD/scenes/<slug>" ...` so OIP automatically copies every required `oip.*` package (and cargo dependencies like `oip.box`) into `scenes/<slug>/parts/` and registers them in `scenes/<slug>/project.json`.
3. Seat frame/conveyor-mounted devices (push buttons, diffuse/color sensors, diverters, blade stops) onto their host conveyor using `snap-part` (or explicit parent + coordinates) so they pass `check-layout` with zero errors.
4. Wire every signal in `scenes/<slug>/io-contract.json` onto its exact `sceneRole.partId` and `sceneRole.param` using the exact IEC address (`%IX*`, `%IW*`, `%QX*`, `%QW*`). Every contract address must appear in `scene.json` so OIP's derived Modbus TCP server exposes it without Modbus Exception `02`.
5. Ensure `scenes/<slug>/scene.json` has `"version": 4` and includes the top-level Modbus auto-serve block:
   ```json
   "plcs": [{ "name": "PLC1", "runsOn": "plc", "protocol": "serve", "connect": true }]
   ```
6. Ensure `scenes/<slug>/project.json` lists `"program": ["plc/program.st"]` and `"tests": []` (remove any `tests/starter.test.json` entry added by `add-part --scaffold`).
7. Self-heal (max 2 attempts): run `validate-project --strict` and `check-layout` against `"$PWD/scenes/<slug>"` and fix any errors (`check-st` and `check-wiring --strict` run post-merge once `plc/program.st` is merged).

## Core Part Rules

- **`oip.box-spawner`**: Set `release=enable`, `keepSpacing=true`, `conveyorId=<conveyorPartId>`, and wire `runTag` to the spawner coil so PLC pulses dispense cleanly without piling up.
- **`oip.push-button` E-Stop**: Set `emergencyStop=true,momentary=false` whenever `io-contract.json` marks the signal `contact: "NC"`.
- **Despawners**: Place an `oip.despawner` at the discharge end of every conveyor (and beside any `oip.diverter` reject side) so cargo exits cleanly.

## Disclosed Reference

Read [`oip-cli-reference.md`](oip-cli-reference.md) for exact `add-part`, `snap-part`, `edit-part`, and validator command invocations.

## Completion Criterion

- `scenes/<slug>/project.json`, `scenes/<slug>/scene.json` (version 4 with `"plcs"` auto-serve), and `scenes/<slug>/parts/` exist and match every `sceneRole` in `scenes/<slug>/io-contract.json` 1:1.
- `validate-project --strict` and `check-layout` (zero errors) both exit `0`.
