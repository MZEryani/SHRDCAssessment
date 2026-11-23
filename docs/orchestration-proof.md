# OpenCode Parallel `git worktree` Orchestration Proof

- **Run ID:** `20261123133719`
- **Captured At:** `2026-11-23T13:41:18.143Z`
- **Process Spec:** `docs/cell-process-spec.md`
- **Canonical I/O Contract:** `openplc/io-contract.json`
- **Tiered Models:** Orchestrator `google/gemini-3-flash-preview` vs. 3 parallel workers `google/gemini-flash-lite-latest`
- **Parallel Window Overlap:** `4231 ms` (all 3 workers active concurrently)
- **Integration Branch:** `orchestrate/20261123133719/integration` (`0` merge conflicts)

## Tiered Model, Skill Scoping & Cost Breakdown

| Agent | Model | Skills Loaded | Worktree | Wall Time | Tokens | Cost (USD) |
| :--- | :--- | :--- | :--- | ---: | :--- | ---: |
| `orchestrator` | `google/gemini-3-flash-preview` | (coordinator) | repo root | 165.1s | 20020 in / 744 think / 346 out | $0.01409 |
| `plc-coder` | `google/gemini-flash-lite-latest` | openplc-st | `/Users/majd/.local/share/opencode/worktree/70d59e/quick-cabin` | 4.6s | 11803 in / 0 think / 174 out | $0.00434 |
| `oip-builder` | `google/gemini-flash-lite-latest` | oip-scene | `/Users/majd/.local/share/opencode/worktree/70d59e/crisp-eagle` | 20.1s | 11174 in / 0 think / 160 out | $0.00412 |
| `test-engineer` | `google/gemini-flash-lite-latest` | plc-oip-verify | `/Users/majd/.local/share/opencode/worktree/70d59e/brave-tiger` | 4.2s | 13356 in / 0 think / 183 out | $0.00477 |

## Isolated Worktree Branches Merged Cleanly

| Worker | Worktree Branch | Worker Commit | Merge Commit |
| :--- | :--- | :--- | :--- |
| `plc-coder` | `orchestrate/20261123133719/plc-coder` | `a035ffd` | `69339e8` |
| `oip-builder` | `orchestrate/20261123133719/oip-builder` | `79faec8` | `b8fc414` |
| `test-engineer` | `orchestrate/20261123133719/test-engineer` | `9c11219` | `92e912e` |

## Post-Merge Verification Gates (Executed on Merged Integration Worktree)

- **STruC++ PLC Unit Tests (`npm run plc:test`):** PASS (1.7s)
- **OIP Strict Validators (`npm run oip:validate`):** PASS (3.5s)
- **Live OpenPLC v4 <-> OIP Modbus TCP E2E (`npm run test:e2e`):** PASS (47.3s)
