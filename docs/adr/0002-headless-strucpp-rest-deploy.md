# Headless STruC++ Compilation and REST API Deploy for OpenPLC v4.1

PLC Structured Text programs are compiled with the standalone `STruCpp` (`strucpp`) CLI and deployed to OpenPLC Runtime v4.1 via its HTTPS REST API on port `8443`, rather than relying on the OpenPLC Editor v4 GUI or legacy MatIEC.

## Considered Options

- **Headless `strucpp` CLI + `:8443` REST API (chosen)**: OpenPLC Runtime v4.1 explicitly rejects MatIEC output (`exit 2`) and requires STruC++ C++14 artifacts in `program.zip`. Using `strucpp` keeps the AI-generation-to-runtime loop fully scriptable and enables fast headless ST unit testing (`strucpp --test`), while remaining `.st`-compatible with OpenPLC Editor v4 for optional visual inspection.
- **OpenPLC Editor v4 GUI only**: Simpler initial setup, but introduces a manual GUI step that breaks reproducible automation for Task 2.
