# STruC++ Packaging and Modbus Master Reference

Disclosed reference for [`openplc-st`](SKILL.md). Consult when debugging `STruC++` compiler rules, OpenPLC Runtime v4 `program.zip` packaging, or Modbus area mappings.

## `STruC++` Compiler Quirks

- **Dedicated located `VAR` block**: Place all `AT %I*` / `AT %Q*` declarations in one `VAR ... END_VAR` block and instantiate function blocks (`ctrl : <FBName>;`) in a separate `VAR ... END_VAR` block. Mixing them causes OIP `check-st` or `STruC++` parse drift.
- **Standard library FBs**: `TON`, `TOF`, `TP`, `R_TRIG`, `F_TRIG`, `CTU`, `CTD`, `SR`, `RS` are built in. Always pass `PT := T#...ms` or `T#...s` literals.
- **Zero-initialized startup**: Output coils default to `FALSE` and registers to `0`; write explicit safe-state assignments on every scan when stopped or faulted.

## Modbus TCP Function Code Map

Topology (ADR 0001): OIP runs as the Modbus TCP server (`port: 5020`, `slaveId: 1`); OpenPLC Runtime v4 polls it as Modbus Master (`scripts/io-contract.mjs` `deriveModbusMaster` derives `plc/modbus_master.json` automatically):

| IEC Prefix | Direction | `modbusArea` | Modbus FC | Type |
| :--- | :--- | :--- | :---: | :--- |
| `%IX<byte>.<bit>` | `oip_to_plc` | `discreteInput` | `2` | `BOOL` |
| `%IW<word>` | `oip_to_plc` | `inputRegister` | `4` | `INT` / `WORD` |
| `%QX<byte>.<bit>` | `plc_to_oip` | `coil` | `15` | `BOOL` |
| `%QW<word>` | `plc_to_oip` | `holdingRegister` | `16` | `INT` / `WORD` |

## OpenPLC Runtime v4.1+ `program.zip` Packaging

`scripts/plc-bundle.mjs` compiles `program.st` with `.tools/strucpp/strucpp/strucpp --debug` and bundles `generated.hpp`, `generated.cpp`, a minimal `generated_debug.cpp`, `defines.h` (`PROGRAM_MD5`), `strucpp_runtime/include/*.hpp`, and `conf/modbus_master.json`.
