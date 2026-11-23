# SHRDC Pre-Assessment: OpenPLC + Open Industry Project

This repository contains the PLC logic, simulation scenes, Docker setup, and AI agent skills for integrating **OpenPLC (Autonomy Logic)** with **Open Industry Project** using **OpenCode**.

## Structure

- `openplc/` — IEC 61131-3 Structured Text / OpenPLC project files
- `scenes/` — Open Industry Project scene configurations and I/O mappings
- `.opencode/skills/` — Custom OpenCode skills (`SKILL.md`) for context-efficient AI generation
- `.agents/` — Installed workflow skills (`skills-lock.json`)
- `docker-compose.yml` — Headless OpenPLC Runtime v4 container (`8443` REST API, `502` Modbus TCP)
- `Open-Industry-Project/` — Cloned upstream simulator (ignored via `.gitignore`)

## Setup

### 1. Clone Open Industry Project (Local Simulator)
```bash
git clone https://github.com/Open-Industry-Project/Open-Industry-Project.git
```

### 2. Start OpenPLC Runtime v4 (Docker)
```bash
docker compose up -d
```
Connect **OpenPLC Editor** (v4) to `127.0.0.1:8443` to compile, upload, and start/stop your PLC program.
