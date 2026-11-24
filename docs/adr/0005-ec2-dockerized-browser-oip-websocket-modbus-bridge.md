---
status: accepted
---

# Containerized EC2 Stack with Browser-Native OIP and WebSocket-to-Modbus Bridge

To let a recruiter evaluate both assessment tasks (live OpenPLC ↔ OIP integration and live AI-orchestrated Cell generation) from a browser with zero local Docker or desktop setup while showcasing AWS and Docker engineering, we supersede ADR-0003 and host a three-container Docker Compose stack (`caddy`, `demo-portal`, `openplc-runtime`) on a CPU-only Amazon EC2 instance (`t3.medium`, `ap-southeast-1`, permanent Elastic IP with automatic Let's Encrypt HTTPS on `<eip>.sslip.io`). Unmodified OIP static web assets run natively at 60 FPS on the visitor's own browser GPU under Cross-Origin Isolation (`COOP`/`COEP`), while a thin pre-boot bridge script implements `window.oipPlcIo` (tunneling raw binary Modbus TCP frames over WebSockets to `demo-portal:5020` polled by Dockerized OpenPLC Runtime v4) and read-only `window.oipProject` (auto-loading Cell folders without allowing browser mutations to dirty EC2 disk or git).

## Considered Options

- **CPU-Only Containerized EC2 + Browser-Native OIP over WebSocket-to-Modbus Bridge (chosen)**: Solves ADR-0003's core objection by offloading 3D WebGL/Jolt rendering to the visitor's own GPU instead of software WebGL on a cloud CPU, requires no OIP fork, avoids expensive GPU EC2 instances and AWS GPU vCPU quota friction, isolates OpenPLC Runtime v4 on a private Docker bridge network, and keeps host costs to ~$0.05/hr while running.
- **Streamed Linux Remote Desktop on EC2 (KasmVNC / noVNC / Amazon DCV)**: Avoids a browser bridge shim by running OIP Electron Desktop directly on EC2, but either requires a GPU instance (`g4dn.xlarge`, ~$0.53/hr and quota approval) or degrades to sluggish software-WebGL rendering over compressed video.
- **Local Desktop Only (ADR-0003)**: Zero cloud cost, but forces recruiters to install Docker, Node.js, STruC++, OpenCode, and OIP locally and fails to demonstrate AWS infrastructure proficiency.

## Consequences

- Because OIP requires `SharedArrayBuffer` (threaded Jolt physics), non-localhost deployments must serve `/app/*` over HTTPS with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and open OIP in a dedicated full-viewport tab to honor `X-Frame-Options: DENY` / `frame-ancestors 'none'`.
- OpenPLC Runtime v4 is single-tenant (one active PLC program polling port `5020`), so the WebSocket-to-Modbus bridge enforces strict single-session exclusivity with a 30-minute timeout (protecting extended Cell observation and multi-minute Task 2 generations) behind a shareable magic-link / passphrase cookie gate.
- On EC2, live-generated Cells persist in a dedicated named Docker volume (`PORTAL_CELLS_DIR`) outside the repository's git working tree so Task 2 worktrees stay clean while preserving ADR-0004's untracked `scenes/<slug>/` layout for local CLI runs.
- Existing root `docker-compose.yml` and local desktop workflows remain untouched for local development and headless verification.
- **Decoupled Edge Mirror & Report-by-Exception (RBE) over WAN:** Because OpenPLC Runtime v4 polls 3 sequential Modbus TCP function codes per scan (`FC 2` discrete inputs, `FC 15` coils, `FC 16` holding registers), synchronous end-to-end tunneling stacks 3–4 WAN round-trips (~0.7–1.1 s on a ~230 ms link). Opt-in Edge Mirror mode (`portal/modbus-mirror.mjs`) answers OpenPLC locally on `demo-portal` in `< 1 ms` using a mirrored I/O image, forwards the first unseeded read synchronously so fail-safe NC E-Stop state is preserved, lets the browser shim push sensor deltas immediately via change-of-value `input_update` messages (20 ms local OIP poll), and pushes actuator writes immediately on change with a `400 ms` heartbeat to keep OIP's `1000 ms` `POLL_TIMEOUT_MS` watchdog healthy — cutting closed-loop Photo-Eye reaction to a single WAN RTT without modifying OIP or OpenPLC.
