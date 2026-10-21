# Repository Guidelines

## Project Structure & Module Organization

This repository contains planning documents and the first developer-facing command bridge integration layer for SIANN, a local AI-native music production environment. It is not docs-only anymore: the engine fork lives in `/Users/garyhsieh/siann-engine`, while this repo owns the Node bridge wrapper, workflow generators, fixtures, tests, and product documentation.

Use SIANN/`siann` consistently for public names, CLI names, schemas, fixture
paths, generated artifacts, and local repository references.

- `README.md` is public/product-facing. Do not expose internal implementation details, ADR lists, or roadmap-style planning there.
- `docs/README.md` summarizes the current product and architecture direction.
- `docs/adr/` contains architecture decision records. Keep `0000-adr-index.md` updated when adding or superseding ADRs.
- `docs/discussions/` stores dated product and architecture discussion notes.
- `docs/research/` stores engine spike findings, commandability maps, and implementation research.
- `docs/schemas/` stores command, observation, journal, and bridge contract drafts.
- `docs/superpowers/specs/` stores larger design specifications.
- `.codex/skills/siann-intake/SKILL.md` is the canonical agent-facing intake skill for arbitrary audio files, placement notes, and DAWproject export.
- `.claude/skills/siann-intake/SKILL.md` points Claude-style agents at the same SIANN intake boundary.
- `src/bridge/` contains the Node-based developer bridge wrapper around the engine command runner.
- `bin/siann.js` is the CLI entrypoint for bridge workflows.
- `examples/bridge/` contains command fixtures that developers can run against a local engine checkout.
- `examples/import-pack/` contains the first product workflow fixture: manifest-driven asset placement and preview rendering.
- `scripts/create-demo-audio.js` writes small WAV fixtures for workflow smoke tests and examples.
- `scripts/create-daw-manifest.js` converts extracted `_DAW/` plus `_SpliceSFX/` packs into multi-track manifests with placement trim metadata.
- `test/` contains Node test-runner coverage for the bridge wrapper, CLI, and fixtures.

Keep implementation modules separate by the documented architecture: audio engine, command bridge, agent runtime, and UI.

Key internal documents:

- [Architecture design](docs/superpowers/specs/2026-07-06-siann-architecture-design.md)
- [Headless engine runtime v0](docs/superpowers/specs/2026-07-07-siann-headless-engine-runtime-v0.md)
- [Harness engineering spec](docs/superpowers/specs/2026-07-11-siann-harness-engineering-spec.md)
- [ADR index](docs/adr/0000-adr-index.md)
- [Initial product and architecture discussion](docs/discussions/2026-07-06-product-architecture-discussion.md)
- [Ardour commandability map](docs/research/ardour-commandability-map.md)
- [Engine command coverage](docs/research/engine-command-coverage.md)
- [Engine spike checklist](docs/research/engine-spike-checklist.md)
- [Command journal v0](docs/schemas/command-journal-v0.md)
- [DAWproject export v0](docs/schemas/dawproject-export-v0.md)
- [Import pack plan v1](docs/schemas/import-pack-plan-v1.md)
- [Intake plan v0](docs/schemas/intake-plan-v0.md)
- [Session observation v0](docs/schemas/session-observation-v0.md)
- [UI base evaluation](docs/research/ui-base-evaluation.md)
- [Windows setup](docs/setup/windows.md)

## Architecture & Implementation Boundaries

SIANN is structured around four conceptual layers:

```text
SIANN Studio UI
  DAW views, import tools, AI task panel, plan review, preview, rollback.

SIANN Agent Runtime
  Model adapters, API key handling, observation, planning, risk policy, tool calls.

SIANN Command Bridge
  Typed commands, validation, snapshots, transactions, undo, event logs, render hooks.

SIANN Engine
  Ardour-derived session core for tracks, regions, routing, plugins, automation, render.
```

The engine is the trust boundary. AI and UI layers must not directly mutate low-level session state; they operate through the command bridge.

Implementation tracks:

- **Engine:** implemented in `/Users/garyhsieh/siann-engine`; owns Ardour-derived session operations for import, trim, placement, save, render, observation, journal snapshots, and rollback.
- **Command bridge:** partially implemented in this repo; owns JSON command files, workflow manifests, plan approval, validation, rollback command generation, and Node test coverage.
- **Agent runtime:** not implemented yet; planned provider adapters, model configuration, tool calling, planning loops, risk policy, and local-only mode.
- **Studio UI:** not implemented yet; next likely direction is a local web frontend for import-pack workflows, mapping review, plan diffs, preview playback, and apply/rollback controls.
- **Verification:** fixture sessions, command logs, render artifacts, replay checks, time conversion tests, and rollback coverage.

Example command shape:

```json
{
  "op": "place_audio",
  "sourceMediaId": "media_riser_01",
  "trackId": "track_fx_risers",
  "start": "01:08.000",
  "gainDb": -7,
  "fadeInMs": 20,
  "fadeOutMs": 120
}
```

Commands target stable IDs, not mutable track names. Name-based lookup may exist as a dry-run helper, but ambiguity must be rejected before mutation.

## Architecture Decisions

Accepted decisions are tracked as ADRs:

- [ADR-0002: Build A Local Native AI-Operable DAW](docs/adr/0002-build-local-native-ai-operable-daw.md)
- [ADR-0003: Start From An Ardour-Derived Engine](docs/adr/0003-start-from-ardour-derived-engine.md)
- [ADR-0004: Separate Engine, Command Bridge, Agent Runtime, And UI](docs/adr/0004-separate-engine-command-bridge-agent-runtime-ui.md)
- [ADR-0005: Use Hybrid Copilot And Agent Autonomy](docs/adr/0005-use-hybrid-copilot-agent-autonomy.md)
- [ADR-0006: Make The Command Bridge The Agent Mutation Boundary](docs/adr/0006-command-bridge-agent-mutation-boundary.md)
- [ADR-0007: Prove Commandability Before UI Redesign](docs/adr/0007-prove-commandability-before-ui-redesign.md)
- [ADR-0008: Start With Import Pack Mapping Prompt Arrange](docs/adr/0008-start-with-import-pack-mapping-prompt-arrange.md)
- [ADR-0009: Keep AI Provider Integrations Runtime-Pluggable](docs/adr/0009-keep-ai-provider-integrations-runtime-pluggable.md)
- [ADR-0010: Treat Privacy And Provider Data Flow As A First-Class Boundary](docs/adr/0010-privacy-provider-data-flow-boundary.md)
- [ADR-0011: Use Journaled Command Rollback For The Engine Bridge](docs/adr/0011-use-journaled-command-rollback-for-engine-bridge.md)
- [ADR-0013: Rename Project To SIANN](docs/adr/0013-rename-project-to-siann.md)
- [ADR-0014: Build SIANN As A Headless DAW Runtime](docs/adr/0014-build-siann-as-headless-daw-runtime.md)

Superseded decisions:

- [ADR-0012: Move From Headless Batch Runner To Live Project Bridge](docs/adr/0012-move-from-headless-batch-runner-to-live-project-bridge.md), replaced by ADR-0014.

## Build, Test, and Development Commands

Useful repository checks are:

- `git status --short` shows local changes.
- `rg "term" docs/` searches the documentation.
- `find docs -type f | sort` lists tracked documentation areas.
- `npm test` runs the bridge wrapper, CLI, and fixture tests with Node's built-in test runner.
- `npm run smoke:dawproject -- --json` runs the cross-platform DAWproject smoke test without the engine checkout.
- `node scripts/create-demo-import-pack.js --out /tmp/siann-import-pack-demo --json` creates portable demo audio plus a manifest under the chosen output directory.
- `node bin/siann.js run examples/bridge/create-session.command.json --json` runs a command fixture against the local engine checkout.
- `node scripts/create-demo-audio.js /tmp/siann-import-pack-demo/audio` creates the WAV files required by `examples/import-pack/manifest.json`.
- `node bin/siann.js plan intake /tmp/siann-user-daw-source --out /tmp/siann-user-daw-multitrack-demo/intake-plan.json --json` writes an agent-reviewable intake plan from loose source files or known DAW pack layouts.
- `node bin/siann.js live import-pack examples/import-pack/manifest.json --engine-dir /Users/garyhsieh/siann-engine --json` runs the current live-session smoke path: start runtime, create session, import tracks and regions, render preview, save, close, and stop runtime.
- `node bin/siann.js export dawproject examples/import-pack/manifest.json --out /tmp/siann-import-pack-demo/session.dawproject --copy-media --json` writes the Cubase-compatible DAWproject exchange package.
- `node --test test/dawproject-export.test.js` runs focused DAWproject exporter coverage.
- `SIANN_RUN_ENGINE_TESTS=1 SIANN_ENGINE_DIR=/Users/garyhsieh/siann-engine node --test test/live-import-pack.test.js` runs the gated live import-pack integration test against the local engine checkout.
- `node bin/siann.js workflow import-pack examples/import-pack/manifest.json --plan /tmp/siann-import-pack-demo/plan.json --json` generates a reviewable import-pack plan without mutating the engine session.
- `node bin/siann.js workflow validate-plan /tmp/siann-import-pack-demo/plan.json --json` checks plan integrity and whether it can be approved or applied.
- `node bin/siann.js workflow approve-plan /tmp/siann-import-pack-demo/plan.json --out /tmp/siann-import-pack-demo/approved-plan.json --approved-by "$USER" --json` records explicit review approval and command integrity.
- `node bin/siann.js workflow apply-plan /tmp/siann-import-pack-demo/approved-plan.json --out /tmp/siann-import-pack-demo/import-pack.command.json --run --json` applies an approved plan by writing and running the engine command batch.
- `node bin/siann.js rollback /tmp/siann-import-pack-demo/journal.json --source-command /tmp/siann-import-pack-demo/import-pack.command.json --out /tmp/siann-import-pack-demo/rollback.command.json --run --json` restores the import-pack snapshot and observes the rolled-back session.
- `node bin/siann.js validate-journal /tmp/siann-demo/create-session/journal.json --json` validates and summarizes a generated command journal.
- `node scripts/create-daw-manifest.js /tmp/siann-user-daw-source --out /tmp/siann-user-daw-multitrack-demo/manifest.json --session-dir /tmp/siann-user-daw-multitrack-demo/Session --preview /tmp/siann-user-daw-multitrack-demo/preview.wav --journal /tmp/siann-user-daw-multitrack-demo/journal.json --json` converts an extracted `_DAW/` plus `_SpliceSFX/` test pack into a multi-track import-pack manifest; `_DAW/placement.md` trim fields become `sourceStart` and `duration`.

The bridge CLI defaults to `../siann-engine`. Use `SIANN_ENGINE_DIR=/path/to/siann-engine` or `--engine-dir /path/to/siann-engine` when needed.

## Coding Style & Naming Conventions

For Markdown, use sentence-case prose, concise sections, and fenced code blocks for commands or diagrams. Prefer ASCII unless a document specifically needs otherwise.

ADR files use a four-digit sequence and kebab-case title, for example `0007-prove-commandability-before-ui-redesign.md`. Dated discussion and spec files use `YYYY-MM-DD-kebab-case-title.md`.

JavaScript uses CommonJS modules and Node built-ins only for now. Keep bridge code dependency-light until the integration surface stabilizes.

## Testing Guidelines

For documentation-only changes, verify links and references manually, especially ADR index entries. For code, add tests close to the module they cover and include deterministic command-bridge tests for session creation, import, placement, save, render, and replay behavior where feasible.

Planned verification categories:

- Session command dry-run tests.
- Import and region placement tests.
- Time conversion tests for mm:ss, bars/beats, tempo maps, and sample positions.
- Undo and rollback tests.
- Offline render smoke tests.
- Bounce parity or null tests where applicable.
- Command log replay and fixture-session determinism tests.

## Commit & Pull Request Guidelines

Recent commits use short Conventional Commit-style subjects, such as `docs: record initial ADRs and discussion log`. Continue using `type: concise summary`, with `docs:` for documentation-only changes.

Pull requests should include a brief summary, the reason for the change, affected docs or modules, and any validation performed. Link related issues or ADRs when applicable. Include screenshots only for future UI changes.

## Security & Configuration Tips

Do not commit provider keys, local audio assets, rendered stems, or private project files. Keep AI provider integrations runtime-pluggable and document any data-flow or privacy boundary changes in an ADR.

The repository is GPL-2.0-or-later to stay aligned with the Ardour-derived engine path. Keep licensing and attribution changes explicit in docs and PR descriptions.
