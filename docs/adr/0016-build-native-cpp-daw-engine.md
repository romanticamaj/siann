# ADR-0016: Build A Native C++ DAW Engine From Scratch

Date: 2026-10-21

Status: Accepted

Supersedes: [ADR-0003](0003-start-from-ardour-derived-engine.md),
[ADR-0014](0014-build-siann-as-headless-daw-runtime.md)

## Context

The Ardour-derived engine path (ADR-0003, ADR-0014) did not build reliably on
Windows, carries an upstream model that does not adopt SIANN's plan, review and
journal semantics, and would keep the command layer an add-on instead of the
core. Two review rounds of a from-scratch design produced
[the native DAW architecture](../superpowers/specs/2026-10-14-siann-native-daw-architecture.md),
revision 2.1, with M0 and M1 decisions recorded and realtime topics deferred to
revision 3.

## Decision

Build the SIANN engine from scratch in C++20 following that architecture:

- A framework-free core (`siann-time`, `siann-midi`, `siann-model`,
  `siann-command`, `siann-graph`, `siann-dsp`, `siann-host-api`) that builds
  and tests without JUCE.
- JUCE only in the desktop host target; a JUCE-free host target for embedded.
- An Electron shell with a web UI that talks to the engine only through the
  SIANN protocol.
- One revision DAG for undo, journal, plans and proposal branches; RFC 8785
  canonical JSON and an RFC 6962 Merkle document hash shared with the Node
  bridge.
- Native code lives in this repository under `native/`, the app under `app/`,
  shared fixtures under `fixtures/`.

The Node bridge and DAWproject export (ADR-0015) stay the shippable product
until the native app reaches M5.

## Consequences

- The sibling `siann-engine` Ardour checkout is retired. It must be renamed or
  archived before code that assumes the new engine name depends on it; the Node
  bridge's `live` commands keep working against it until then.
- Revision 3 of the architecture (realtime data flow) must be accepted before
  M2 work writes audio-thread code.
- Licensing decisions (JUCE, ASIO, VST3, AGPL network clause) are due before
  M2, when JUCE device code is first linked into a distributed build.
- Documents listed in the architecture's "Documents made stale by this
  decision" section are updated as the native engine replaces the Ardour path.
