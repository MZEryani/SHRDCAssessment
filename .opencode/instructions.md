# OpenCode Cell-Generator Runtime Instructions

Shared invariants for all runtime agents (`orchestrator`, `plc-coder`, `oip-builder`, `test-engineer`) generating OpenPLC Runtime v4 + OIP Cells.

## Domain & Scope

- **Vocabulary**: Follow `GLOSSARY.md` (`OIP`, `Cell`, `I/O Contract`).
- **Protected boundaries**: Edit only your assigned files under `scenes/<slug>/`. Leave the Task 1 reference Cell untouched and keep `.env*` secrets unread.

## Canonical Contract Seam

- `scenes/<slug>/io-contract.json` is the single source of truth freezing `plc.functionBlockName`, `plc.programName`, `parameters.scanIntervalMs`, and every signal's IEC address, type, direction, Modbus area/address, and `sceneRole`.
- `scenes/<slug>/plc/modbus_master.json` is derived deterministically by script from `io-contract.json`; leave it untouched.

## Worktree & Toolchain Rules

- `.tools` (`STruC++`) and `Open-Industry-Project` are gitignored and live at repo root; symlink them (`ln -sfn`) inside your worktree before running local compilers or OIP validators.
- Use the provided OIP part catalog summary and OIP CLIs (`add-part`, `validate-project`, `check-layout`) directly instead of searching `Open-Industry-Project/` source files.
