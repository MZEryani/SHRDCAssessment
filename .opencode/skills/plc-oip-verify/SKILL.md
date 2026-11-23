---
name: plc-oip-verify
description: Verify OpenPLC v4 PLC logic, OIP Cell integrity, and live Modbus TCP E2E behavior. Use when writing or executing ST unit tests, OIP validators, or headless SimWorld Modbus tests.
---

# PLC & OIP Automated Verification

Verify the Conveyor Cell across its three external seams without coupling tests to internal implementation details.

## Workflow

1. Read `openplc/io-contract.json` and `GLOSSARY.md` so test assertions derive addresses from the canonical `I/O Contract` and use Glossary vocabulary.
2. Execute verification from fastest seam to highest seam:
   - **PLC scan-cycle seam**: `npm run plc:test` (`tests/conveyor_cell.test.st` via `STruC++`)
   - **OIP Cell integrity seam**: `npm run oip:validate` (`scripts/validate-oip-cell.mjs`)
   - **Modbus tracer seam**: `npm run test:tracer` (`tests/tracer-modbus.test.mjs`)
   - **End-to-end physics + Modbus seam**: `npm run test:e2e` (`tests/conveyor-cell-e2e.test.mjs`)
3. Assert observable external behavior at every seam:
   - Start latch, Stop clean halt, E-Stop immediate drop + no auto-restart on release
   - Photo-Eye rising-edge count + 2-second Inspection Dwell
   - 5-box Batch auto-halt + Reset allowed only when stopped
   - Anti-touching physical box spacing (`centerGap >= BOX_LENGTH_M + 0.05m`)
   - Photo-Eye continuous-block Jam Fault latch and clear

## Disclosed Reference

Read [`verification-seams.md`](verification-seams.md) when:
- Writing or modifying headless `SimWorld` + `ModbusServerIo` Node tests
- Debugging OpenPLC Docker connectivity or `strucpp --test` failures

## Completion Criterion

- All applicable seams pass (`npm run plc:test`, `npm run oip:validate`, `npm run test:tracer`, `npm run test:e2e`) with zero failures or skipped assertions.
