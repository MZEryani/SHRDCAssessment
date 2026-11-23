# Conveyor Cell Plain-English Process Specification

Input specification for the OpenCode multi-agent orchestration workflow (`npm run orchestrate`).

## Cell Behavior

1. **Start / Stop Latch**: A momentary `Start_PB` rising edge latches the Conveyor Cell into running mode (`Run_Light` on, `Conveyor_Run` on). Pressing `Stop_PB` halts the Cell cleanly and cancels any active Inspection Dwell.
2. **Emergency Stop Interlock**: Engaging `EStop` immediately drops `Conveyor_Run`, inhibits `Spawner_Enable`, lights `Fault_Light`, and blocks restart until `EStop` is released and a fresh `Start_PB` rising edge occurs.
3. **Photo-Eye Counting & Inspection Dwell**: Each box reaching `PhotoEye` increments `Box_Count` once on the rising edge and triggers a 2-second Inspection Dwell (`Conveyor_Run` off, `Spawner_Enable` off, `Dwell_Light` on) before the conveyor resumes.
4. **Batch Auto-Halt & Reset**: When `Box_Count` reaches the Batch target of `5`, the Cell halts automatically until `Reset_Count_PB` is pressed while the Cell is stopped.
5. **Anti-Touching Spawner Gating**: `Spawner_Enable` is inhibited whenever `Conveyor_Run` is off and enforces a 500ms dispense pulse followed by a 5-second running cooldown. Dropping `Conveyor_Run` mid-pulse transitions directly into cooldown so boxes never spawn touching.
6. **Jam Fault**: If `PhotoEye` remains continuously blocked for more than 4 seconds while the conveyor is running, latch `Jam_Fault` (`Fault_Light` on, `Conveyor_Run` off) until `PhotoEye` clears, `EStop` is clear, and the operator resets or stops.

## Integration Architecture

- Canonical `I/O Contract`: `openplc/io-contract.json` (11 signals across `%IX0.0..%IX0.4`, `%QX0.0..%QX0.4`, `%QW0`).
- OpenPLC Runtime v4 (Docker, `STruC++`) polls OIP (macOS host Modbus TCP server on port `5020`, `host.docker.internal`) every `50ms`.
- Terminology must follow `GLOSSARY.md`.
