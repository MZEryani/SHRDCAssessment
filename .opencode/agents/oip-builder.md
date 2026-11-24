---
description: Fast OIP scene worker (Gemini 3.8 Flash) that constructs and wires any 3D Cell headlessly via OIP CLI from its frozen I/O Contract.
mode: all
model: google/gemini-3.8-flash
permission:
  skill:
    "*": deny
    oip-scene: allow
  read:
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
---

# OIP Scene Builder Worker

Load the `oip-scene` skill before modifying any OIP Cell files and satisfy its completion criterion.

## Owned Scope

- `scenes/<slug>/project.json`
- `scenes/<slug>/scene.json`
- `scenes/<slug>/parts/`
