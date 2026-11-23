# Verification Seams & Live Harness Reference

Disclosed reference for [`plc-oip-verify`](SKILL.md). Consult when writing or debugging headless `SimWorld` Modbus tests, `strucpp --test` files, or live OpenPLC Docker runs.

## Seam 1: End-to-End Modbus TCP + Headless `SimWorld` (`tests/conveyor-cell-e2e.test.mjs`)

- Load OIP modules via `Open-Industry-Project/scripts/lib/conveyor-loop.mjs` (`loadOurs`, `flattenTags`) and `modbus-tcp-listen.mjs` (`listenModbus`).
- Derive the Modbus server table from `openplc/io-contract.json` using `oip.modbusServerFromTags({ host: '0.0.0.0', port: 5020 }, tagDefs)` and `oip.validateExternalIo(derived.io)`.
- Bind `ModbusServerIo` to `SimWorld` (`world.setBehaviorDrivenTags(oip.externalDrivenTags(checked.io))`), seed initial operator inputs (`Start_PB`, `Stop_PB`, `EStop`, `Reset_Count_PB`), then call `deployProgram()` from `scripts/openplc-deploy.mjs`.
- Step `SimWorld` at real-time wall-clock 60 Hz so OpenPLC's real `TON` timers (`T#2s`, `T#5s`, `T#4s`) stay synchronized with 3D conveyor physics.
- Always clean up in `after()`: `client.stop()`, `server.close()`, `world.dispose()`.

## Seam 2: `strucpp --test` Syntax Constraints (`tests/conveyor_cell.test.st`)

- **Single-quoted test titles**: Write `TEST 'description'` with single quotes (IEC `STRING`). Double-quoted titles parse as `WSTRING` and fail compilation.
- **Top-level `ADVANCE_TIME`**: Place `ADVANCE_TIME(<nanoseconds>)` only as a top-level statement inside `TEST ... END_TEST`. Nesting `ADVANCE_TIME` inside `FOR` or `IF` blocks is rejected by `STruC++`.
- **Fresh state per test**: Initialize the `FUNCTION_BLOCK` instance in `SETUP ... END_SETUP` so each `TEST` starts deterministically.

## Live OpenPLC Docker Prerequisites

- Container `openplc-runtime` (`ghcr.io/autonomy-logic/openplc-runtime:latest`) must be running with port `8443` published and `--add-host=host.docker.internal:host-gateway`.
- Override endpoints via environment variables (`OPENPLC_URL`, `OPENPLC_USER`, `OPENPLC_PASSWORD`, `OIP_MODBUS_PORT`) outside git; never commit `.env` files.

## OpenCode Model Tiers (Catalog vs. Live-Callable)

- `opencode models --standalone` lists the static provider catalog, not live API-key entitlement or current capacity. Always run `npm run opencode:probe` (hard 12s per-model timeout) before a live orchestration run to resolve a live-callable pair.
- **Paid-tier defaults:** Orchestrator `google/gemini-4-neon` (fallback `google/gemini-3.1-pro-preview`), Workers `google/gemini-3.8-flash` (fallback `google/gemini-3-flash-preview`).
- **Free-tier fallback pair:** Orchestrator `google/gemini-3-flash-preview`, Workers `google/gemini-flash-lite-latest` (`15 RPM` cap; Pro/Gemini-4 models have `limit: 0` on Free Tier).
