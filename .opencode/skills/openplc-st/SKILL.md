---
name: openplc-st
description: Author and compile IEC 61131-3 Structured Text for OpenPLC Runtime v4 (STruC++) and Modbus TCP master config. Use when writing or editing .st programs or modbus_master.json.
---

# OpenPLC v4 Structured Text (`STruC++`)

Author IEC 61131-3 Structured Text (`ST`) for OpenPLC Runtime v4.1+ (`STruC++` compiler) and its Modbus TCP master configuration.

## Workflow

1. Read `openplc/io-contract.json` and `GLOSSARY.md` first. Every symbolic signal name and IEC address (`%IX`, `%QX`, `%QW`) must match the `I/O Contract` 1:1 and use Glossary terms.
2. Put reusable control logic inside a `FUNCTION_BLOCK` (for scan-cycle unit testing) and wire located I/O in a top-level `PROGRAM` + `CONFIGURATION`.
3. Place located `AT %IX` / `AT %QX` / `AT %QW` variables in their own dedicated `VAR ... END_VAR` block, separate from ordinary and function-block variables, so both `STruC++` and OIP's `check-st` accept the file identically.
4. Keep `scenes/conveyor-cell/plc/program.st` byte-identical to `openplc/conveyor_cell.st`.
5. Verify with `npm run plc:test` and (when OpenPLC Docker is up) `npm run plc:deploy:cell`.

## Required Control Semantics

- **Start interlock**: Gate `Start_PB` through `R_TRIG` so holding `Start_PB` while releasing `EStop` can never auto-restart the Cell.
- **Anti-touching spawner**: Inhibit `Spawner_Enable` whenever `Conveyor_Run` is `FALSE` (Stop, E-Stop, Inspection Dwell, Jam Fault). Pulse `Spawner_Enable` for `SPAWN_PULSE_TIME` then enforce `SPAWN_COOLDOWN_TIME`. If `Conveyor_Run` drops mid-pulse, transition directly into cooldown so resuming never emits back-to-back pulses.
- **Inspection Dwell & Batch**: Increment `Box_Count` on `R_TRIG` of `PhotoEye`. Halt at `BATCH_TARGET`; otherwise enter `Inspection Dwell` (`Dwell_Light := TRUE`, `Conveyor_Run := FALSE`). Allow `Reset_Count_PB` only when the Cell is stopped.
- **Jam Fault**: Latch `Jam_Fault` if `PhotoEye` remains continuously `TRUE` while `Conveyor_Run` is `TRUE` past `JAM_THRESHOLD_TIME`. Clear only when `PhotoEye` is `FALSE`, `EStop` is `FALSE`, and operator resets or stops.

## Disclosed Reference

Read [`strucpp-modbus-reference.md`](strucpp-modbus-reference.md) when packaging `program.zip` for OpenPLC Runtime v4 REST deployment or editing `openplc/conveyor_cell_modbus_master.json`.

## Completion Criterion

- `npm run plc:test` passes with zero failures.
- `openplc/conveyor_cell.st` and `scenes/conveyor-cell/plc/program.st` are identical and match `openplc/io-contract.json` 1:1.
