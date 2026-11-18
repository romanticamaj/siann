# Repository Guidelines

## Project Structure & Module Organization

This repository contains planning documents and the first developer-facing command bridge integration layer for SIANN, a local AI-native music production environment. It is not docs-only anymore: the native C++ engine lives in `native/` (the `siann-engine` executable; architecture spec `docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md`), the Electron shell in `app/`, and this repo also owns the Node bridge, workflow generators, fixtures, tests, and product documentation.

Use SIANN/`siann` consistently for public names, CLI names, schemas, fixture
paths, generated artifacts, and local repository references.

- `README.md` is public/product-facing. Do not expose internal implementation details, ADR lists, or roadmap-style planning there.
- `docs/README.md` summarizes the current product and architecture direction.
- `docs/adr/` contains architecture decision records. Keep `0000-adr-index.md` updated when adding or superseding ADRs.
- `docs/discussions/` stores dated product and architecture discussion notes.
- `docs/research/` stores engine spike findings, commandability maps, and implementation research.
- `docs/schemas/` stores command, observation, journal, and bridge contract drafts.
- `docs/superpowers/specs/` stores larger design specifications.
- `docs/harness/` holds the milestone harness: agent rules and the per-milestone runbook; manifests live in `.claude/milestones/` and the workflow in `.claude/workflows/siann-milestone.js`.
- UI work is ported from the redesign's mockup, component by component; the mockup is the reference implementation of styling and markup: `docs/superpowers/specs/2026-11-13-siann-ui-redesign/mockup.html` and the stylesheets it shares with the app (`app/renderer/tokens.css`, `app/renderer/ui/`). The rule is in `docs/harness/agent-rules.md`, "UI fidelity": token rules block, the fidelity run is a report, and a UI pull request attaches side-by-side screenshots of the app and the mockup (decided by the maintainer, 2026-11-17).
- `.codex/skills/siann-intake/SKILL.md` is the canonical agent-facing intake skill for arbitrary audio files, placement notes, and DAWproject export.
- `.claude/skills/siann-intake/SKILL.md` points Claude-style agents at the same SIANN intake boundary.
- `src/bridge/` contains the Node-based developer bridge wrapper around the engine command runner.
- `bin/siann.js` is the CLI entrypoint for bridge workflows.
- `examples/bridge/` contains command fixtures that developers can run against the native `siann-engine` (`SIANN_ENGINE_EXE`, else the core preset's build under `native/`).
- `examples/import-pack/` contains the first product workflow fixture: manifest-driven asset placement and preview rendering.
- `scripts/create-demo-audio.js` writes small WAV fixtures for workflow smoke tests and examples.
- `scripts/check-all.js` runs every local check (`--changed` picks the steps from the paths changed against `origin/main`, `--all` runs every step, `--gcc` adds a g++ -Werror syntax check through WSL, `--desktop` the JUCE preset, `--app` the Electron shell's unit and Playwright tests against the dev build's `siann-engine`).
- `scripts/create-daw-manifest.js` converts extracted `_DAW/` plus `_SpliceSFX/` packs into multi-track manifests with placement trim metadata.
- `test/` contains Node test-runner coverage for the bridge wrapper, CLI, and fixtures.
- `native/` holds the C++ engine (libraries under `native/libs/`, the `siann-cli` and `siann-engine` executables under `native/apps/`).
- `app/` holds the Electron shell (TypeScript; its own npm package with pinned dependencies) that spawns and supervises `siann-engine`; the root package stays dependency-free. In `app/`, `npm run build` type-checks with `tsc -p .` and bundles the React renderer (`src/renderer/index.tsx`) with esbuild (`scripts/bundle-renderer.js`) into `dist/src/renderer/renderer.js`; `npm run test:unit` runs the `node --test` unit tests (supervisor, read model, hashes, session client) and `npm run test:e2e` the Playwright Electron tests.

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
- [Command journal v1](docs/schemas/command-journal-v1.md) (v0, the Ardour engine's, is historical)
- [DAWproject export v0](docs/schemas/dawproject-export-v0.md)
- [Import pack plan v1](docs/schemas/import-pack-plan-v1.md)
- [Intake plan v0](docs/schemas/intake-plan-v0.md)
- [Session observation v0](docs/schemas/session-observation-v0.md)
- [UI base evaluation](docs/research/ui-base-evaluation.md)
- [Windows setup](docs/setup/windows.md)
- [Milestone runbook](docs/harness/runbook.md)
- [Harness agent rules](docs/harness/agent-rules.md)

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
  Native C++ session core (native/, siann-engine): tracks, clips, routing, plugins, render.
```

The engine is the trust boundary. AI and UI layers must not directly mutate low-level session state; they operate through the command bridge.

Implementation tracks:

- **Engine:** the native `siann-engine` in `native/`; owns the session bundle, its revision history and write-ahead journal, media import, plans, render, and rollback, behind the protocol in `docs/schemas/protocol-*.md`.
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
- `npm run smoke:dawproject -- --json` runs the cross-platform DAWproject smoke test without building or starting `siann-engine`.
- `node scripts/pluginval.js [--pluginval <exe>] <plugin>...` runs pluginval v1.0.4 at strictness 5 on plugins by path; `--compat` runs it on the third-party set in `scripts/compat-plugins.json` (one `SIANN_PLUGIN_*` variable each: unset is SKIP, a missing path or a failure is FAIL); see `native/README.md`, "pluginval".
- `node scripts/create-demo-import-pack.js --out /tmp/siann-import-pack-demo --json` creates portable demo audio plus a manifest under the chosen output directory.
- `node bin/siann.js run examples/bridge/create-session.command.json --device fake --json` runs a command fixture against `siann-engine`.
- `node scripts/create-demo-audio.js /tmp/siann-import-pack-demo/audio` creates the WAV files required by `examples/import-pack/manifest.json`.
- `node bin/siann.js plan intake /tmp/siann-user-daw-source --out /tmp/siann-user-daw-multitrack-demo/intake-plan.json --json` writes an agent-reviewable intake plan from loose source files or known DAW pack layouts.
- `node bin/siann.js live import-pack examples/import-pack/manifest.json --device fake --json` runs the live-session smoke path in one engine process: create the session, import the files, apply the tracks and clips as one plan, save, render the preview, and stop the engine.
- `node bin/siann.js export dawproject examples/import-pack/manifest.json --out /tmp/siann-import-pack-demo/session.dawproject --copy-media --json` writes the Cubase-compatible DAWproject exchange package.
- `node --test test/dawproject-export.test.js` runs focused DAWproject exporter coverage.
- `SIANN_RUN_ENGINE_TESTS=1 node --test test/runtime-engine.test.js test/live-import-pack.test.js` runs the engine-gated bridge tests against `siann-engine` (`SIANN_ENGINE_EXE`, else the core preset's build); `node scripts/check-all.js --only bridge` builds the engine and runs them, as CI's `bridge-engine` job does.
- `node bin/siann.js workflow import-pack examples/import-pack/manifest.json --plan /tmp/siann-import-pack-demo/plan.json --json` generates a reviewable import-pack plan without mutating the engine session.
- `node bin/siann.js workflow validate-plan /tmp/siann-import-pack-demo/plan.json --json` checks plan integrity and whether it can be approved or applied.
- `node bin/siann.js workflow approve-plan /tmp/siann-import-pack-demo/plan.json --out /tmp/siann-import-pack-demo/approved-plan.json --approved-by "$USER" --json` records explicit review approval and command integrity.
- `node bin/siann.js workflow apply-plan /tmp/siann-import-pack-demo/approved-plan.json --out /tmp/siann-import-pack-demo/import-pack.command.json --run --json` applies an approved plan by writing and running the engine command batch.
- `node bin/siann.js rollback /tmp/siann-import-pack-demo/journal.json --out /tmp/siann-import-pack-demo/rollback.command.json --run --json` opens the bundle the journal names and rolls back each plan revision it applied (`plan.rollback {revision}`); the imported media stays in the bundle.
- `node bin/siann.js validate-journal /tmp/siann-demo/create-session/journal.json --json` validates and summarizes a generated command journal.
- `node scripts/create-daw-manifest.js /tmp/siann-user-daw-source --out /tmp/siann-user-daw-multitrack-demo/manifest.json --session-dir /tmp/siann-user-daw-multitrack-demo/Session --preview /tmp/siann-user-daw-multitrack-demo/preview.wav --journal /tmp/siann-user-daw-multitrack-demo/journal.json --json` converts an extracted `_DAW/` plus `_SpliceSFX/` test pack into a multi-track import-pack manifest; `_DAW/placement.md` trim fields become `sourceStart` and `duration`.

The bridge starts the native `siann-engine` for each `run`, `--run` and `live` command, on a scratch bundle it removes afterwards: `SIANN_ENGINE_EXE=/path/to/siann-engine`, else the core preset's build `native/build/dev/apps/engine/siann-engine` (`cmake --preset dev && cmake --build --preset dev --target siann-engine` in `native/`). `--device <id>` is passed to the engine (`fake` needs no audio hardware).

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

The repository is GPL-2.0-or-later. Keep licensing and attribution changes explicit in docs and PR descriptions.
