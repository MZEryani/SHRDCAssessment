# SHRDC Assessment — OpenPLC v4, Open Industry Project (OIP), and AI Cell Generator

**OpenPLC Runtime v4** drives a 3D **Open Industry Project (OIP)** conveyor simulation over Modbus TCP. An **OpenCode** multi-agent pipeline turns plain-English process descriptions into verified OpenPLC Structured Text and runnable 3D OIP simulations.

- **Demo Video:** https://youtu.be/-q-_DTVJEZ4
- **Live Demo:** Deployed on AWS EC2 on request (IaC in [infra/cloudformation.yaml](infra/cloudformation.yaml))

---

## Pre-Assessment Deliverables

| Pre-Assessment Task | Implementation | Key Files |
| :--- | :--- | :--- |
| **1. Integrate OpenPLC with Open Industry Project for a simple application** | Dockerized OpenPLC Runtime v4 controls a **Basic Conveyor Cell** (`scenes/conveyor-cell/`) over Modbus TCP (`FC 2` inputs, `FC 15` coils, `FC 16` holding registers). The cell includes Start, Stop, NC E-Stop, and Reset push buttons (with indicator lamps), a box spawner with a 5 s cooldown, a Photo-Eye with a 2 s Inspection Dwell, a 5-box Batch auto-halt, a >4 s Jam Fault latch, and a stack light driven by `Box_Count`. | [program.st](scenes/conveyor-cell/plc/program.st), [io-contract.json](openplc/io-contract.json), [scene.json](scenes/conveyor-cell/scene.json) |
| **2. Use AI to generate OpenPLC code and translate it into an OIP simulation** | A 4-stage **OpenCode** multi-agent workflow (`npm run generate`) converts a plain-English description into an OpenPLC program, an OIP 3D scene, and a PLC test suite under `scenes/<slug>/`, then verifies all three before saving. | [orchestrate-cell.mjs](scripts/orchestrate-cell.mjs), [.opencode/agents/](.opencode/agents/), [.opencode/skills/](.opencode/skills/) |

---

## System Architecture

![SHRDC Assessment System Architecture](docs/architecture.svg)

### Task 1 — OpenPLC v4 ↔ OIP 3D Integration

- **Shared I/O Contract ([`openplc/io-contract.json`](openplc/io-contract.json)):** One contract defines every sensor and actuator—its address, Modbus function code, data type, and OIP 3D part binding. The tooling derives the Modbus master config from it and checks `program.st` and `scene.json` against it so addresses stay aligned.
- **PLC Control Logic ([`scenes/conveyor-cell/plc/program.st`](scenes/conveyor-cell/plc/program.st)):** `STruC++` transpiles the Structured Text to C++, and `scripts/openplc-deploy.mjs` packages it with `modbus_master.json` into a ZIP and deploys it headlessly to OpenPLC Runtime v4 over REST (`:8443`). Each scan cycle reads discrete inputs (`FC 2`: Start, Stop, NC E-Stop, Reset, Photo-Eye), evaluates the state machine, and writes coils (`FC 15`: conveyor belt, box spawner, button indicator lamps) plus the `Box_Count` holding register (`FC 16`).
- **3D Physics & I/O Loop ([`scenes/conveyor-cell/scene.json`](scenes/conveyor-cell/scene.json)):** OIP simulates the 3D conveyor cell and runs a Modbus TCP server on `:5020` bound to the scene's push buttons (and lamps), Photo-Eye sensor, conveyor motor, spawner, and `Box_Count` stack light. OpenPLC polls that server as the Modbus TCP master.
- **Hosted Browser Demo & Modbus Edge Mirror:** A 3-container Docker stack (`caddy`, `demo-portal`, `openplc-runtime`) also runs the full system behind HTTPS. Unmodified OIP web assets render on the visitor's browser GPU under Cross-Origin Isolation (`COOP`/`COEP`). A pre-boot bridge (`portal/oip-bridge.js`) and a server-side **Decoupled Modbus TCP Edge Mirror** (`portal/modbus-mirror.mjs`) tunnel Modbus over authenticated WebSockets: `demo-portal` answers OpenPLC locally in `< 1 ms`, pushes actuator writes on change, and applies change-of-value sensor updates from the browser so remote 3D cells stay responsive over WAN ([OpenAPI 3.1 spec](docs/openapi.yaml)).

### Task 2 — Plain-English → OpenPLC + OIP Cell Generator

1. **Stage 1 — Plan the I/O Contract:** A reasoning-tier Orchestrator reads OIP's live part catalog, translates the user's prompt into `io-contract.json` and `process-spec.md`, confirms every requested part and signal exists in OIP, and derives `plc/modbus_master.json` deterministically.
2. **Stage 2 — Build in Parallel:** Three Flash-tier agents run concurrently in isolated `git worktree` sandboxes, each scoped to its own files and skill:
   - `plc-coder` ([`openplc-st`](.opencode/skills/openplc-st/SKILL.md)) writes the IEC 61131-3 Structured Text (`plc/program.st`).
   - `oip-builder` ([`oip-scene`](.opencode/skills/oip-scene/SKILL.md)) builds the 3D layout and Modbus wiring (`project.json`, `scene.json`, `parts/`).
   - `test-engineer` ([`plc-oip-verify`](.opencode/skills/plc-oip-verify/SKILL.md)) writes scan-cycle unit tests (`tests/program.test.st`).
3. **Stage 3 — Clean Merge:** Because each agent owns separate files, all three worktree branches merge into one Cell folder with zero conflicts.
4. **Stage 4 — Automated Verification & Save:** Three checks validate the merged Cell before it is saved:
   - **I/O Contract Check** verifies every signal name, Modbus address, and direction across the PLC code, Modbus config, and 3D scene.
   - **PLC Logic Tests** compile and execute the generated `STruC++` scan-cycle unit tests.
   - **OIP Scene Validation** runs OIP's strict project, Structured Text, wiring, and layout checks.

   If a check fails, the Orchestrator runs one targeted repair pass. Once all three pass, the pipeline writes the Cell to `scenes/<slug>/`, ready to deploy to OpenPLC and OIP 3D.

---

## Quick Start (Local)

### Prerequisites

- **Docker** (Docker Desktop on macOS/Windows, or Docker Engine on Linux)
- **Node.js `>= 24`** (zero runtime dependencies in root `package.json`; runs on macOS, Linux, and Windows)
- **Open Industry Project** cloned and built at `./Open-Industry-Project`:
  ```bash
  git clone https://github.com/Open-Industry-Project/Open-Industry-Project.git
  npm --prefix Open-Industry-Project install
  npm --prefix Open-Industry-Project run build
  npm --prefix Open-Industry-Project/apps/desktop install
  ```
- **STruC++ CLI (`v0.8.0`)** unpacked into `.tools/strucpp/strucpp/` from [`Autonomy-Logic/STruCpp` releases](https://github.com/Autonomy-Logic/STruCpp/releases)
- **OpenCode CLI (`v2.4+`)** with provider credentials outside git (`opencode auth list --standalone`) — needed only for live Task 2 generation

### Run Task 1 — Basic Conveyor Cell

```bash
# 1. Start OpenPLC Runtime v4 in Docker
docker compose up -d

# 2. Compile and deploy the Conveyor Cell PLC program
npm run plc:deploy:cell

# 3. Launch OIP Desktop on scenes/conveyor-cell
npm run oip:desktop
```

In OIP Desktop, open **External I/O**, start the Modbus TCP server on port `5020`, and press **Start** in the 3D scene:
- Boxes dispense with a 5 s cooldown so they stay spaced apart.
- Crossing the **Photo-Eye** increments `Box_Count`, stops the belt for a **2 s Inspection Dwell** (amber light), and resumes.
- After **5 boxes**, the **Batch** halts until you press **Reset** while stopped.
- Pressing **E-Stop** halts immediately (red light) and requires a fresh **Start** after release.

### Run Task 2 — Generate a New Cell from Plain English

```bash
# Interactive prompt
npm run generate

# Non-interactive example
npm run generate -- --preflight --name blade-stop-inspector \
  --prompt "A belt conveyor with a box spawner, a despawner, Start, Stop, and NC E-Stop push buttons, a Photo-Eye, and a blade stop just after the Photo-Eye. When Start is pressed, the belt runs continuously. When a box triggers the Photo-Eye, raise the blade stop for 2 seconds to hold the box for inspection, then lower the blade stop to release it."

# Verify and run a generated Cell
npm run cell:verify -- blade-stop-inspector
npm run cell:run -- blade-stop-inspector
```

---

## Verification Suite

Run all offline checks (without Docker or an LLM):

```bash
npm run verify:offline
```

Run the full local suite, including live OpenPLC Docker ↔ OIP headless 3D `SimWorld` physics tests:

```bash
npm run verify:all
```

| Command | Scope |
| :--- | :--- |
| `npm run test:contract` | `I/O Contract` schema, Modbus master derivation, and drift checks |
| `npm run plc:test` | 7/7 `STruC++` scan-cycle unit tests (`tests/conveyor_cell.test.st`) |
| `npm run oip:validate` | Strict OIP project, ST, wiring, and layout checks |
| `npm run test:opencode` | OpenCode agent/skill discovery and `.gitignore` secret rules |
| `npm run test:orchestrate` | 4-stage pipeline, parallel `git worktree` merge, and repair guards |
| `npm run test:portal` | Demo Portal auth, SPA, SSE streaming, OpenPLC deploy, and Modbus Edge Mirror |
| `npm run test:docker` | 3-container Docker Compose isolation, SHA-256 binary pins, and Caddy SSE config |
| `npm run test:e2e` | Live OpenPLC Docker ↔ OIP headless 3D `SimWorld` 5-box Batch E2E |
