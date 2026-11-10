# Schemas

This directory defines internal SIANN command and observation contracts before implementation code is added.

- [Command journal v0](command-journal-v0.md) records command execution, rollback metadata, and replay evidence for the Ardour-derived engine bridge.
- [DAWproject export v0](dawproject-export-v0.md) defines the first Cubase-compatible session exchange package.
- [Import pack plan v1](import-pack-plan-v1.md) defines the reviewable import-pack plan, its RFC 8785 (JCS) integrity hash, and the shared JCS fixtures.
- [Intake plan v0](intake-plan-v0.md) defines the AI-to-deterministic-bridge boundary for loose audio inputs.
- [Plan v1](plan-v1.md) defines the engine-side plan with per-entity read and write sets, its lifecycle, and the shared plan hash fixtures.
- [Protocol events v1](protocol-events-v1.md) defines the native engine's protocol event stream, gap detection with `session.sync`, the binary meter channel and the build's source location.
- [Protocol gestures v0](protocol-gestures-v0.md) defines the fader gesture methods (gesture.begin, update, hold, end, cancel), their client lease and the gesture.ended event.
- [Protocol engine v0](protocol-engine-v0.md) defines the transport, engine.status, the device list and selection, session.open's rebind in siann-engine and the session bundle lock.
- [Protocol plugins v0](protocol-plugins-v0.md) defines the plugin slot entity, plugin.instantiate, the plugin registry (plugin.registry, plugin.approve), the editor methods, engine.status plugins[] and render.start's own plugin instances.
- [Protocol MCP v0](protocol-mcp-v0.md) defines the MCP adapter on the native protocol server: Streamable HTTP framing, the tool table with scopes, and examples.
- [Session observation v0](session-observation-v0.md) defines the canonical read model consumed by the Studio UI and agent runtime.
