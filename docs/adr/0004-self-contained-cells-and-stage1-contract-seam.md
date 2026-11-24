# Self-Contained Per-Cell Folders and Stage 1 Contract Seam

Generated Cells live as self-contained directories under `scenes/<slug>/` (holding `project.json`, `scene.json`, `parts/`, `plc/program.st`, `plc/modbus_master.json`, `io-contract.json`, `process-spec.md`, `tests/program.test.st`, and `generation-report.{md,json}`), while Stage 1 freezes `io-contract.json`—including `plc.functionBlockName`, `plc.programName`, `signals[]` with `sceneRole`, and `parameters`—and validates it against the live OIP part catalog before dispatching parallel workers in isolated git worktrees. `plc/modbus_master.json` is derived deterministically from `io-contract.json` rather than authored by an LLM worker.

## Considered Options

- **Self-contained `scenes/<slug>/` + frozen Stage 1 contract (chosen)**: Parallel workers (`plc-coder`, `oip-builder`, `test-engineer`) cannot negotiate symbol names or tag addresses across isolated git worktrees. Freezing the I/O Contract and PLC POU names in Stage 1 (and validating them before Stage 2 fan-out) eliminates cross-worktree compile/wiring mismatches, keeps Task 1 (`scenes/conveyor-cell/`) untouched, and makes every generated Cell independently verifiable (`npm run cell:verify -- <slug>`) and runnable (`npm run cell:run -- <slug>`).
- **Shared root `openplc/` + ephemeral integration worktree (previous harness)**: Limited the repository to a single Cell at a time, deleted generated artifacts on exit, and required leaking Conveyor Cell details into prompts to keep parallel workers aligned.

## Consequences

- `scripts/io-contract.mjs` generalizes parameter validation so `scanIntervalMs` is universally required while Cell-specific constants remain optional.
- `scenes/<slug>/` directories are left untracked by default so users can inspect, run, commit, or discard generated Cells without polluting `main`.
