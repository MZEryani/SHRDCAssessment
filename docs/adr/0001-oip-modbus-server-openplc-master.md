# OIP as Modbus TCP Server, OpenPLC Runtime v4 as Master

OIP runs on the macOS host as the Modbus TCP server (port `5020`) and OpenPLC Runtime v4 runs in Docker as the Modbus TCP master polling `host.docker.internal:5020` via its `modbus_master` plugin.

## Considered Options

- **OIP as Server + OpenPLC as Master (chosen)**: Matches OIP's official `scripts/openplc-loop.mjs` integration and maps IEC `%IX*` sensors to Discrete Inputs and `%QX*` actuators to Coils with zero register bit-packing.
- **OpenPLC as Server (`:502`) + OIP as Client**: Simplifies Docker networking (`127.0.0.1:502`), but OIP's client mode does not use Coils and packs `%IX`/`%QX` bits into Holding and Input Registers.

## Consequences

- Docker-to-host networking relies on `host.docker.internal:5020` on macOS.
- Headless integration tests can run OIP's `SimWorld` + `modbus-tcp-listen.mjs` (or a mock Modbus TCP server) on `:5020` without launching Electron.
