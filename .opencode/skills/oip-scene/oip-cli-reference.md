# OIP Headless CLI Reference

Disclosed reference for [`oip-scene`](SKILL.md). Consult for exact OIP CLI syntax.

## Path Rule

`npm --prefix Open-Industry-Project` executes with `Open-Industry-Project/` as its CWD. Always pass `"$PWD/scenes/<slug>"` (absolute path) as the project folder argument.

## Building a Cell from Scratch

```bash
# 1. Create the Cell folder, bake built-in part copies into parts/, and place floor-rested parts
npm --prefix Open-Industry-Project run add-part -- "$PWD/scenes/<slug>" \
  oip.roller-conveyor --id <convId> --at <x>,<z> --params fpmUnits=false,speed=<mps>,runTag=<runTag> \
  oip.box-spawner --id <feedId> --at <x>,<y>,<z> --params keepSpacing=true,conveyorId=<convId>,release=enable,runTag=<feedTag> \
  oip.despawner --id <sinkId> --at <x>,<z> --params length=<len>,width=<wid>

# 2. Snap sensors, diverters, and push buttons cleanly onto a host conveyor
npm --prefix Open-Industry-Project run snap-part -- oip.push-button \
  --project "$PWD/scenes/<slug>" --host <convId> --id <btnId> --write

# 3. Update params on any placed part (--params is plural, comma-separated k=v)
npm --prefix Open-Industry-Project run edit-part -- "$PWD/scenes/<slug>" <btnId> \
  --params text=<label>,tag=<btnTag>
```

## Headless Validators

```bash
npm --prefix Open-Industry-Project run validate-project -- "$PWD/scenes/<slug>" --strict
npm --prefix Open-Industry-Project run check-wiring -- "$PWD/scenes/<slug>" --strict
npm --prefix Open-Industry-Project run check-layout -- "$PWD/scenes/<slug>"
```

- `check-layout` exits `1` on layout errors and exits `0` when only non-fatal warnings exist.
- Note: `check-st` runs post-merge once `plc-coder` supplies `scenes/<slug>/plc/program.st`.
