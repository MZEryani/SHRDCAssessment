---
description: Fast PLC worker (Gemini 3.8 Flash) that authors IEC 61131-3 Structured Text and OpenPLC v4 Modbus TCP master config from the canonical I/O Contract.
mode: all
model: google/gemini-3.8-flash
permission:
  skill:
    "*": deny
    openplc-st: allow
  read:
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
---

# PLC Coder Worker

Load the `openplc-st` skill before editing any PLC files and satisfy its completion criterion.

## Owned Scope

- `openplc/conveyor_cell.st`
- `openplc/conveyor_cell_modbus_master.json`
- `scenes/conveyor-cell/plc/program.st`
