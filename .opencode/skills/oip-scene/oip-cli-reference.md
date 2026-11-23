# OIP Headless CLI & Desktop Reference

Disclosed reference for [`oip-scene`](SKILL.md). Consult when running OIP scaffolding/editing commands or launching OIP Desktop.

## Headless Scene Authoring Commands

`npm --prefix Open-Industry-Project` runs with `Open-Industry-Project/` as its working directory, so pass `"$PWD/scenes/conveyor-cell"` (an absolute path) or `../scenes/conveyor-cell`:

```bash
# Add a part with scaffolded defaults
npm --prefix Open-Industry-Project run add-part -- "$PWD/scenes/conveyor-cell" <part-type> --id <id> --scaffold

# Edit parameters on an existing part (--params takes key=value pairs)
npm --prefix Open-Industry-Project run edit-part -- "$PWD/scenes/conveyor-cell" <id> --params key=value
```

## Validation & Desktop Launch

- **Validation gate**: Run `npm run oip:validate` (see `scripts/validate-oip-cell.mjs` for the full strict validator pipeline).
- **Native macOS Desktop**: Run `npm run oip:desktop` (launches Electron against prebuilt `Open-Industry-Project/dist/` with `OIP_DESKTOP_PROD=1`).
