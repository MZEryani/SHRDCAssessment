# SHRDC Automation Assessment

Domain language for the OpenPLC + Open Industry Project factory automation system and its AI-orchestrated Cell generator.

## Language

### Platform & Generator

**OIP**:
Open Industry Project, the 3D factory simulator where a Cell runs and exposes field I/O over Modbus TCP.
_Avoid_: OpenProject, simulator web app

**Cell**:
A self-contained simulated factory automation station combining an OIP scene, an OpenPLC Structured Text program, a Modbus master configuration, and an I/O Contract.
_Avoid_: Line, factory, scene-app

**I/O Contract**:
The canonical mapping between symbolic process signals and IEC 61131-3 direct addresses shared by a Cell's PLC program, OIP scene, and verification suite.
_Avoid_: Pinout, tag list, register map

### Task 1 Conveyor Cell Reference

**Photo-Eye**:
The optical presence sensor mounted near the discharge end of the conveyor that detects arriving boxes.
_Avoid_: Sensor, detector, beam

**Inspection Dwell**:
The fixed pause triggered when a box arrives at the Photo-Eye, during which the conveyor halts and box spawning is inhibited.
_Avoid_: Delay, sleep, wait state

**Batch**:
A fixed count of boxes processed at the Photo-Eye before the Cell halts automatically until reset.
_Avoid_: Lot, run, queue

**Jam Fault**:
A latched fault state triggered when the Photo-Eye remains continuously blocked while the conveyor is running, indicating touching or stalled boxes.
_Avoid_: Error, timeout, clog
