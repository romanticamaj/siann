# SIANN Docs

This directory contains product, architecture, and decision records for SIANN.

Key documents:

- [Architecture spec](superpowers/specs/2026-07-06-siann-architecture-design.md)
- [Headless engine runtime v0](superpowers/specs/2026-07-07-siann-headless-engine-runtime-v0.md)
- [Harness engineering spec](superpowers/specs/2026-07-11-siann-harness-engineering-spec.md)
- [ADR index](adr/0000-adr-index.md)
- [Initial product and architecture discussion](discussions/2026-07-06-product-architecture-discussion.md)
- [Engine command coverage](research/engine-command-coverage.md)
- [UI base evaluation](research/ui-base-evaluation.md)
- [DAWproject export v0](schemas/dawproject-export-v0.md)
- [Intake plan v0](schemas/intake-plan-v0.md)
- [Engine-independent DAWproject first slice](adr/0015-use-dawproject-export-as-engine-independent-first-slice.md)
- [Windows setup](setup/windows.md)
- [Internal schemas](schemas/README.md)

## Current Direction

SIANN is a local AI-native music production environment:

```text
native C++ audio engine (siann-engine)
+ command bridge
+ pluggable AI runtime
+ AI-friendly studio UI
```

The current milestone is the SIANN core command surface: prove that the
headless runtime can create and own a session, observe it, apply editing
commands, render previews, roll back safely, and export a DAWproject package for
visual verification in another DAW.

A newly accepted first slice can run before the engine is available:

```text
audio files + placement intent
-> agent-operable intake
-> SIANN import-pack manifest
-> DAWproject export
-> Cubase or DAWproject-compatible host verification
```

This engine-independent path is the recommended Windows validation flow. It
does not replace the headless runtime direction; it lets SIANN validate useful
AI-assisted session generation before native engine builds are stable on every
platform.

## Current Implementation Status

SIANN now has two active codebases:

- `native/` is the native C++ engine (architecture spec, `superpowers/specs/2026-10-14-siann-native-daw-architecture.md`); the `siann-engine` executable serves a session bundle over the protocol in `schemas/protocol-*.md`. The Node bridge starts it (`SIANN_ENGINE_EXE`, else the core preset's build) for every live command. The Ardour-derived engine fork it replaces is historical.
- `/Users/garyhsieh/siann` is the product, docs, and developer bridge repo. It now contains a Node CLI wrapper, workflow generators, approval-gated plan files, example fixtures, and tests. It is not docs-only anymore, but it does not yet contain the future Studio UI or AI runtime.

Current shipped workflow:

```text
extracted DAW test pack
-> agent-operable intake plan
-> multi-track manifest
-> DAWproject export
-> Cubase-compatible project exchange
```

Current engine-backed workflow:

```text
multi-track manifest
-> reviewable import plan
-> explicit approval gate
-> engine plan (session.create, media.import, plan.submit, approve, apply)
-> native session bundle
-> preview render
-> journaled rollback
```

The real-user DAW pack workflow supports:

- `_DAW/` BGM assets.
- `_DAW/placement.md` in-point and duration parsing.
- `_SpliceSFX/` sound effects.
- Intake plans with assumptions, evidence, confidence, and review blockers.
- One track per BGM bed or SFX cue.
- `sourceStart` and `duration` trim metadata.
- Rendered preview WAV output.
- A SIANN session bundle written by the native engine.
- DAWproject export for Cubase-compatible project exchange.
- Windows-side DAWproject smoke tests through Node-only scripts.

The headless engine is the native `siann-engine`: a persistent, SIANN-owned
session process that the UI and agent clients control over the protocol. Opening
projects from other DAWs is not the primary workflow; DAWproject export is the
exchange path.
