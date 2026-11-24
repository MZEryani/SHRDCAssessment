---
status: superseded by ADR-0005
---

# Local macOS Desktop + Docker Demo Over Hosted Cloud VM

> Superseded by [ADR-0005](./0005-ec2-dockerized-browser-oip-websocket-modbus-bridge.md). Retained for historical context.

The primary demonstration runs locally on macOS (OIP Electron Desktop + OpenPLC Runtime v4 in Docker) accompanied by a reproducible repo, automated headless verification tests, and a short demo video, rather than hosting the simulator on a free-tier cloud VM.

## Considered Options

- **Local macOS Desktop + Docker + Demo Video (chosen)**: OIP's external Modbus TCP connectivity requires the Electron desktop app (Three.js WebGL + Jolt physics), which runs natively at full frame rate on macOS and keeps setup focused on the core PLC integration and AI workflow.
- **Hosted Linux Cloud VM (Xvfb + noVNC)**: Free-tier CPU-only VMs lack GPU acceleration, causing sluggish software-WebGL rendering and significant networking/security overhead unrelated to the core assessment goals.
