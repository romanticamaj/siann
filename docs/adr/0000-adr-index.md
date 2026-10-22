# ADR Index

This directory records architecture decisions for SIANN.

Status values:

- Proposed: under discussion.
- Accepted: current project direction.
- Superseded: replaced by a later ADR.

## Accepted

- [ADR-0002: Build A Local Native AI-Operable DAW](0002-build-local-native-ai-operable-daw.md)
- [ADR-0004: Separate Engine, Command Bridge, Agent Runtime, And UI](0004-separate-engine-command-bridge-agent-runtime-ui.md)
- [ADR-0005: Use Hybrid Copilot And Agent Autonomy](0005-use-hybrid-copilot-agent-autonomy.md)
- [ADR-0006: Make The Command Bridge The Agent Mutation Boundary](0006-command-bridge-agent-mutation-boundary.md)
- [ADR-0007: Prove Commandability Before UI Redesign](0007-prove-commandability-before-ui-redesign.md)
- [ADR-0008: Start With Import Pack Mapping Prompt Arrange](0008-start-with-import-pack-mapping-prompt-arrange.md)
- [ADR-0009: Keep AI Provider Integrations Runtime-Pluggable](0009-keep-ai-provider-integrations-runtime-pluggable.md)
- [ADR-0010: Treat Privacy And Provider Data Flow As A First-Class Boundary](0010-privacy-provider-data-flow-boundary.md)
- [ADR-0011: Use Journaled Command Rollback For The Engine Bridge](0011-use-journaled-command-rollback-for-engine-bridge.md)
- [ADR-0013: Rename Project To SIANN](0013-rename-project-to-siann.md)
- [ADR-0015: Use DAWproject Export As An Engine-Independent First Slice](0015-use-dawproject-export-as-engine-independent-first-slice.md)
- [ADR-0016: Build A Native C++ DAW Engine From Scratch](0016-build-native-cpp-daw-engine.md)
- [ADR-0017: License The Desktop Engine Under AGPLv3, With ASIO](0017-license-desktop-engine-under-agplv3.md)

## Superseded

- [ADR-0003: Start From An Ardour-Derived Engine](0003-start-from-ardour-derived-engine.md), superseded by [ADR-0016](0016-build-native-cpp-daw-engine.md)
- [ADR-0014: Build SIANN As A Headless DAW Runtime](0014-build-siann-as-headless-daw-runtime.md), superseded by [ADR-0016](0016-build-native-cpp-daw-engine.md)
- [ADR-0012: Move From Headless Batch Runner To Live Project Bridge](0012-move-from-headless-batch-runner-to-live-project-bridge.md), superseded by [ADR-0014](0014-build-siann-as-headless-daw-runtime.md)
