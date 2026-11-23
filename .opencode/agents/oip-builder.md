---
description: Fast OIP scene worker (Gemini 3.8 Flash) that scaffolds and wires the 3D Conveyor Cell headlessly via OIP CLI from the canonical I/O Contract.
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

- `scenes/conveyor-cell/project.json`
- `scenes/conveyor-cell/scene.json`
