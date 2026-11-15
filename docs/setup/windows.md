# Windows Setup

This guide covers the SIANN product/bridge repo on Windows. The DAWproject
export path is fully Node-based and is the first Windows verification target.

The native engine (`native/`, the `siann-engine` executable) builds on Windows
with MSVC (`native/tools/msvc-env.cmd`, see `native/README.md`). Use the Windows
flow below to verify intake planning, manifest generation, and
Cubase-compatible `.dawproject` export first; they need no engine.

## What This Repo Can Run

After cloning only `romanticamaj/siann`, a developer or agent session can:

- Load the `siann-intake` skill when the client supports repo-local or
  user-level skills.
- Inspect audio files and placement notes.
- Generate a SIANN import-pack manifest.
- Export a Cubase-compatible `.dawproject` package.
- Run Node tests and DAWproject smoke tests.

This path does not compile or launch the SIANN audio engine.

The native `siann-engine`, built from `native/` in this repository (see
"Engine Build" below), is only required for live session commands such as
`node bin/siann.js live import-pack ...`, `--run` and `run`, preview rendering
through the engine, and the engine-gated bridge tests.

## Requirements

- Windows 10 or 11.
- Git for Windows.
- Node.js 20 or newer.
- Cubase 14.0.20 or newer for DAWproject import testing.

Optional:

- PowerShell 7.
- WSL2 for engine-side experiments before native Windows engine support is
  ready.

## Clone And Test

```powershell
git clone https://github.com/romanticamaj/siann.git
cd siann
node --version
npm test
```

## DAWproject Smoke Test

This command creates demo WAV files, writes a portable manifest, exports a
DAWproject package, and verifies the package entries using Node only.

```powershell
node scripts/smoke-dawproject.js --out "$env:TEMP\siann-dawproject-smoke" --json
```

Equivalent npm command:

```powershell
npm run smoke:dawproject -- --out "$env:TEMP\siann-dawproject-smoke" --json
```

Expected output includes:

```json
{
  "ok": true,
  "workflow": "smoke-dawproject",
  "outputFile": "..."
}
```

Open the reported `session.dawproject` in Cubase:

```text
File > Import > DAWproject
```

## Test A User Audio Pack

If you have a zip with `_DAW/`, `_SpliceSFX/`, and optional placement notes,
extract it first:

```powershell
$source = "$env:TEMP\siann-user-example-source"
$out = "$env:TEMP\siann-user-example-export"
Remove-Item $source, $out -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path "$HOME\Downloads\_DAW.zip" -DestinationPath $source -Force
node scripts/create-daw-manifest.js $source `
  --out "$out\manifest.json" `
  --session-dir "$out\Session" `
  --preview "$out\preview.wav" `
  --journal "$out\journal.json" `
  --json
node bin/siann.js export dawproject "$out\manifest.json" `
  --out "$out\session.dawproject" `
  --copy-media `
  --json
```

Then import:

```text
File > Import > DAWproject
```

## Agent Skill Install

Repo-local skills are committed under:

```text
.codex/skills/siann-intake/SKILL.md
.claude/skills/siann-intake/SKILL.md
```

Some clients do not auto-load repo-local skills. If a new session cannot see
`siann-intake`, copy the canonical skill into the user-level skill root used by
that client. On Windows, common locations are under your user profile, for
example:

```powershell
New-Item -ItemType Directory -Force "$HOME\.codex\skills\siann-intake"
Copy-Item ".codex\skills\siann-intake\SKILL.md" "$HOME\.codex\skills\siann-intake\SKILL.md" -Force
```

Restart the agent session after installing the skill.

## Engine Build

The engine is part of this repository. Build the core preset when you need
engine-facing work (`node scripts/check-all.js --only bridge` does it and runs
the engine-gated bridge tests):

```powershell
cd native
tools\msvc-env.cmd cmake --preset dev
tools\msvc-env.cmd cmake --build --preset dev --target siann-engine
```

The bridge starts `native\build\dev\apps\engine\siann-engine.exe`. Set
`SIANN_ENGINE_EXE=<path>` to use another build, and pass `--device fake` to run
without audio hardware.

Do not start Windows validation by building the engine. First verify the
Node-only DAWproject path.

## Current Limits

- DAWproject export supports WAV media only.
- DAWproject XML schema validation with `xmllint` is optional on Windows; the
  Node smoke test validates package shape without external tools.
- `live import-pack` and every `--run` need a built `siann-engine` (above).
