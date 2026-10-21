# ADR-0014: Build SIANN As A Headless DAW Runtime

Date: 2026-07-07

Status: Superseded by [ADR-0016: Build A Native C++ DAW Engine From Scratch](0016-build-native-cpp-daw-engine.md)

## Context

The current SIANN bridge proves that an Ardour-derived session can be operated
through JSON commands, journals, rollback snapshots, import-pack plans, and
preview renders. ADR-0012 moved the direction from one-shot batch mutation
toward a live bridge over an open project.

That framing is still too close to "SIANN controls Ardour." The intended product
is an independent DAW runtime: SIANN owns the project/session lifecycle, while
Ardour-derived code supplies proven audio, session, routing, plugin, and render
primitives.

## Decision

Build SIANN around a **headless DAW runtime**.

The runtime is a long-running process that:

- Creates and owns SIANN sessions.
- Keeps one live session active at a time in v0.
- Applies commands through a serialized command queue.
- Emits observations and command events.
- Saves, renders, snapshots, and closes sessions.
- Exposes a SIANN command/observation API for future UI and agent clients.

Do not prioritize attaching to a running Ardour GUI or opening arbitrary legacy
Ardour projects. Ardour compatibility remains useful for verification,
regression comparison, and migration research, but it is not the primary user
workflow.

Use this conceptual layering:

```text
SIANN Studio UI
SIANN Agent Runtime
SIANN Command Bridge
SIANN Headless Engine Runtime
Ardour-Derived Audio Core
```

## Consequences

ADR-0012 is superseded. Its command queue, live-safety, observation, and stale
plan ideas still apply, but the owner is now the SIANN headless runtime rather
than a bridge attached to an Ardour product session.

The first implementation should not attempt a full UI revamp or AI agent. It
should prove that a persistent SIANN-owned runtime can create a session, observe
it, mutate it, save it, render it, and close it without restarting the engine
process for each command. The v0 contract is specified in
[`docs/superpowers/specs/2026-07-07-siann-headless-engine-runtime-v0.md`](../superpowers/specs/2026-07-07-siann-headless-engine-runtime-v0.md).

The batch runner remains useful for tests, import automation, replay, and
offline recovery while the headless runtime matures.

Future work may replace or reshape Ardour persistence details behind a SIANN
session contract. That migration should be hidden from UI and agent clients.
