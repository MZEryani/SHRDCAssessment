---
name: openplc-st
description: Author and compile IEC 61131-3 Structured Text for OpenPLC Runtime v4 (STruC++) from a Cell's frozen I/O Contract. Use when creating or fixing scenes/<slug>/plc/program.st.
---

# OpenPLC v4 Structured Text (`STruC++`)

Author clean, scan-cycle-testable IEC 61131-3 Structured Text (`ST`) for OpenPLC Runtime v4.1+ (`STruC++`) matching a Cell's frozen `I/O Contract`.

## Steps

1. Read `scenes/<slug>/io-contract.json`, `scenes/<slug>/process-spec.md`, and `GLOSSARY.md`.
2. Author `scenes/<slug>/plc/program.st` with three POUs matching the frozen contract:
   - `FUNCTION_BLOCK <plc.functionBlockName>`: declare `VAR_INPUT` for every `oip_to_plc` signal and `VAR_OUTPUT` for every `plc_to_oip` signal using exact signal names and types from `io-contract.json`. Keep all internal logic active-high and start in a safe stopped state.
   - `PROGRAM <plc.programName>`: place all located `AT %IX` / `AT %IW` / `AT %QX` / `AT %QW` variables in their own dedicated `VAR ... END_VAR` block, separate from the function-block instance and internal variables, so both `STruC++` and OIP `check-st` accept the file identically.
   - `CONFIGURATION Config0`: bind `<plc.programName>` to a cyclic `TASK` whose `INTERVAL` matches `parameters.scanIntervalMs`.
3. Compile `scenes/<slug>/plc/program.st` with `.tools/strucpp/strucpp/strucpp scenes/<slug>/plc/program.st --debug -o /tmp/check_cell.cpp` and fix any compiler errors before finishing (max 2 attempts).

## Core Authoring Rules

- **Fail-safe NC boundary inversion**: For any signal with `"contact": "NC"` (such as an `emergencyStop` push button where `TRUE` = released/healthy and `FALSE` = struck/tripped), invert the input at the `PROGRAM` call site (`<SigName> := NOT <SigName>`) while keeping the `FUNCTION_BLOCK` internal input active-high (`TRUE` = tripped).
- **Edge-gated Start**: Gate any Start push button through `R_TRIG` so holding Start while releasing Stop or E-Stop cannot auto-restart the Cell.
- **Spawner pacing**: When the Cell includes a box spawner (`oip.box-spawner`), inhibit its enable coil whenever its downstream conveyor is stopped, and pulse/cooldown spawning so boxes maintain clear physical separation.
- **Modbus config ownership**: Leave `scenes/<slug>/plc/modbus_master.json` untouched — the generator derives it deterministically from `io-contract.json`.

## Disclosed Reference

Read [`strucpp-modbus-reference.md`](strucpp-modbus-reference.md) when debugging `STruC++` compilation errors, OpenPLC Runtime v4 `program.zip` packaging, or Modbus function-code mappings (`%IX`/`%IW`/`%QX`/`%QW`).

## Completion Criterion

- `scenes/<slug>/plc/program.st` compiles with exit `0` under `STruC++ --debug`.
- Every located `AT` variable, `FUNCTION_BLOCK` name, `PROGRAM` name, and `TASK` scan interval matches `scenes/<slug>/io-contract.json` 1:1.
