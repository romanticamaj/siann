# Schemas

This directory defines internal SIANN command and observation contracts before implementation code is added.

- [Command journal v0](command-journal-v0.md) records command execution, rollback metadata, and replay evidence for the Ardour-derived engine bridge.
- [DAWproject export v0](dawproject-export-v0.md) defines the first Cubase-compatible session exchange package.
- [Import pack plan v1](import-pack-plan-v1.md) defines the reviewable import-pack plan, its RFC 8785 (JCS) integrity hash, and the shared JCS fixtures.
- [Intake plan v0](intake-plan-v0.md) defines the AI-to-deterministic-bridge boundary for loose audio inputs.
- [Plan v1](plan-v1.md) defines the engine-side plan with per-entity read and write sets, its lifecycle, and the shared plan hash fixtures.
- [Protocol events v1](protocol-events-v1.md) defines the native engine's protocol event stream, gap detection with `session.sync`, the binary meter channel and the build's source location.
- [Session observation v0](session-observation-v0.md) defines the canonical read model consumed by the Studio UI and agent runtime.
