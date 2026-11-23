---
name: oip-scene
description: Author and wire Open Industry Project (OIP) 3D Cell scenes headlessly via CLI. Use when creating or editing scene.json parts, spawner/conveyor pacing, or I/O Contract wiring.
---

# OIP Headless 3D Cell Authoring

Author and validate Open Industry Project (`OIP`) 3D Cell projects headlessly so agents operate cleanly inside isolated git worktrees without Electron open.

## Workflow

1. Read `openplc/io-contract.json` and `GLOSSARY.md` first.
2. Author and modify `scenes/conveyor-cell/scene.json` through OIP's CLI tools (`add-part --scaffold`, `edit-part`) rather than hand-writing raw JSON from scratch.
3. Wire every signal in `openplc/io-contract.json` onto a part in `scene.json` — including `%QW0` (`Box_Count`) on a numeric display/counter part — so OIP's derived Modbus TCP server exposes every address without Modbus Exception `02`.
4. Configure `oip.box-spawner` for PLC-gated single-box dispensing:
   - `release=enable` (the default `interval` mode can miss short PLC pulses)
   - `keepSpacing=true`
   - `conveyorId=<beltPartId>`
   - `runTag=%QX0.1`
5. Align conveyor speed and length with the PLC spawn cooldown so physical box spacing exceeds `BOX_LENGTH_M + 0.05m` at all times.
6. Verify with `npm run oip:validate`.

## Disclosed Reference

Read [`oip-cli-reference.md`](oip-cli-reference.md) when:
- Invoking OIP `add-part`, `edit-part`, or strict validation CLI commands
- Launching OIP Desktop natively on macOS for visual inspection

## Completion Criterion

- `npm run oip:validate` exits `0` (1:1 `I/O Contract` match, ST parity, `validate-project --strict`, `check-st`, `check-wiring --strict`, and `check-layout --strict` all pass).
