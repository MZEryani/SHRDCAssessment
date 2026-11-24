# OIP Headless CLI Reference

Disclosed reference for [`oip-scene`](SKILL.md). Consult for exact OIP CLI syntax.

## Path Rule

`npm --prefix Open-Industry-Project` executes with `Open-Industry-Project/` as its CWD. Always pass `"$PWD/scenes/<slug>"` (absolute path) as the project folder argument.

## Fast One-Shot Cell Build (`add-part --scaffold`)

Prefer a **single** `add-part ... --scaffold` command listing every part from `scenes/<slug>/io-contract.json` (plus any cargo/despawner parts). One command creates `project.json`, copies and registers every built-in `oip.*` package (including cargo dependencies like `oip.box`) into `parts/`, snaps sensors/diverters/buttons onto the conveyor, and writes `scene.json`:

```bash
npm --prefix Open-Industry-Project run add-part -- "$PWD/scenes/<slug>" \
  oip.roller-conveyor --id <convId> --params speed=<mps>,runTag=<runTag> \
  oip.box-spawner --id <feedId> --params release=enable,runTag=<feedTag> \
  oip.color-sensor --id <sensorId> --at 1.5,0 --params colorTag=<colorTag> \
  oip.diverter --id <divId> --at 2.5,0 --params tag=<divTag> \
  oip.push-button --id <btnId> --at 0.6,0 --params text=<label>,tag=<btnTag> \
  oip.stack-light --id <lampId> --at 1.8,-0.7 --params tag=<lampTag> \
  oip.despawner --id <sinkId> \
  --scaffold
```

After running `add-part --scaffold`:
1. Edit `scenes/<slug>/scene.json` directly to add the top-level Modbus auto-serve block:
   ```json
   "plcs": [{ "name": "PLC1", "runsOn": "plc", "protocol": "serve", "connect": true }]
   ```
   and adjust any part positions (e.g., separating push buttons along X or placing a side reject despawner beside a diverter) and verify every `sceneRole.partId` + `sceneRole.param` matches `io-contract.json` 1:1.
2. Verify `scenes/<slug>/project.json` lists `"program": ["plc/program.st"]`.

## Pre-Merge Headless Validators (Run Once After Editing)

```bash
npm --prefix Open-Industry-Project run validate-project -- "$PWD/scenes/<slug>" --strict && \
npm --prefix Open-Industry-Project run check-layout -- "$PWD/scenes/<slug>"
```

- `check-layout` exits `1` on layout errors and exits `0` when only non-fatal warnings exist.
- `check-st` and `check-wiring --strict` require `plc-coder`'s final `plc/program.st` and run automatically post-merge in Stage 4 (`cell:verify`).
- `add-part --scaffold` writes a placeholder `plc/program.st` in your worktree — ignore it; `plc-coder` owns `plc/program.st` on merge.
