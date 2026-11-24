---
description: Fast PLC worker (Gemini 3.8 Flash) that authors IEC 61131-3 Structured Text for OpenPLC Runtime v4 (STruC++) from a Cell's frozen I/O Contract.
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

- `scenes/<slug>/plc/program.st`
