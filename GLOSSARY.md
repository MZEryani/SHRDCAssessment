# SHRDC Conveyor Automation Assessment

Domain language for the OpenPLC + Open Industry Project factory automation cell and its AI-orchestrated authoring workflow.

## Language

**OIP**:
Open Industry Project, the 3D factory simulator where the physical cell runs and exposes field I/O over Modbus TCP.
_Avoid_: OpenProject, simulator web app

**Cell**:
The simulated factory station consisting of a box spawner, conveyor, photo-eye, operator controls, and indicator lights.
_Avoid_: Line, factory, scene-app

**Photo-Eye**:
The optical presence sensor mounted near the discharge end of the conveyor that detects arriving boxes.
_Avoid_: Sensor, detector, beam

**I/O Contract**:
The canonical mapping between symbolic process signals and IEC 61131-3 direct addresses shared by the PLC program, the OIP scene, and the verification suite.
_Avoid_: Pinout, tag list, register map

**Inspection Dwell**:
The fixed pause triggered when a box arrives at the Photo-Eye, during which the conveyor halts and box spawning is inhibited.
_Avoid_: Delay, sleep, wait state

**Batch**:
A fixed count of boxes processed at the Photo-Eye before the Cell halts automatically until reset.
_Avoid_: Lot, run, queue

**Jam Fault**:
A latched fault state triggered when the Photo-Eye remains continuously blocked while the conveyor is running, indicating touching or stalled boxes.
_Avoid_: Error, timeout, clog
