# STruC++ Packaging and Modbus Master Reference

Disclosed reference for [`openplc-st`](SKILL.md). Consult when packaging Runtime v4 bundles or editing Modbus master polling tables.

## OpenPLC Runtime v4.1+ `program.zip` Packaging

OpenPLC Runtime v4.1+ rejects legacy MatIEC bundles (`exit 2`). Use `scripts/openplc-deploy.mjs` (`npm run plc:deploy:cell`), which delegates packaging to `scripts/plc-bundle.mjs` (compiling with `.tools/strucpp/strucpp/strucpp --debug` and building `program.zip`) containing:

- `generated.hpp` and `generated.cpp` (emitted by `STruC++`)
- `generated_debug.cpp` — standalone `strucpp` CLI omits this TU, so `scripts/plc-bundle.mjs` supplies an 8-line empty `strucpp::debug` table so `dlopen` resolves `debug_array_count`
- `defines.h` containing `#define PROGRAM_MD5 "<md5-of-st>"`
- `strucpp_runtime/include/*.hpp` copied from `.tools/strucpp/strucpp/runtime/include`
- `conf/modbus_master.json` — placing this file in the zip automatically enables `modbus_master` in `plugins.conf`

## Modbus TCP Master Configuration (`openplc/conveyor_cell_modbus_master.json`)

Topology (ADR 0001): OIP runs as the Modbus TCP server on the macOS host; OpenPLC Runtime v4 (Docker) polls it as Modbus Master via `host.docker.internal:5020` (`slave_id: 1`, `cycle_time_ms: 50`).

Map each `I/O Contract` direction to the matching Modbus function code:
- `oip_to_plc` (`%IX0.0`, `len: 5`) -> `fc: 2` (Read Discrete Inputs)
- `plc_to_oip` (`%QX0.0`, `len: 5`) -> `fc: 15` (Write Multiple Coils)
- `plc_to_oip` (`%QW0`, `len: 1`) -> `fc: 16` (Write Multiple Registers)
