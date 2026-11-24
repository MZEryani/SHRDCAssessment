---
name: plc-oip-verify
description: Author STruC++ scan-cycle unit tests for any generated Cell from its frozen I/O Contract and process spec. Use when creating or fixing scenes/<slug>/tests/program.test.st.
---

# PLC & OIP Automated Verification

Author deterministic, behavior-focused `STruC++` scan-cycle unit tests for any generated Cell's `FUNCTION_BLOCK`.

## Steps

1. Read `scenes/<slug>/io-contract.json`, `scenes/<slug>/process-spec.md`, and `GLOSSARY.md`.
2. Author `scenes/<slug>/tests/program.test.st` targeting `FUNCTION_BLOCK <plc.functionBlockName>` using only signal names declared in `scenes/<slug>/io-contract.json`:
   - Instantiate `cell : <plc.functionBlockName>;` in `SETUP ... END_SETUP` with all inputs in their safe resting state (`FUNCTION_BLOCK` internal inputs are active-high even when an external signal is `contact: "NC"`).
   - Write one focused `TEST '...'` block per core process behavior in `process-spec.md` (safe stopped startup, Start/Stop latch, E-Stop drop + no auto-restart when present, sensor/actuator reactions, counters/timers/faults).
   - Place `ADVANCE_TIME(<nanoseconds>);` strictly as a top-level statement inside `TEST ... END_TEST` to step timers.

## Disclosed Reference

Read [`verification-seams.md`](verification-seams.md) when you need `strucpp --test` assertion macros, nanosecond `ADVANCE_TIME` examples, or post-merge `cell:verify` gate details.

## Completion Criterion

- `scenes/<slug>/tests/program.test.st` instantiates `<plc.functionBlockName>`, uses single-quoted `TEST '...'` titles and top-level `ADVANCE_TIME`, references only contracted signals, and covers every core behavior in `scenes/<slug>/process-spec.md`.
