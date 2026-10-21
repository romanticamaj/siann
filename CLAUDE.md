# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

SIANN is a local AI-native DAW. This repo is the **product/bridge layer**: the Node command-bridge CLI, workflow generators, exporters, fixtures, tests, and product documentation. The Ardour-derived audio engine lives in a separate sibling checkout (`../siann-engine` by default; override with `SIANN_ENGINE_DIR` or `--engine-dir`). Everything except `siann live ...` and gated engine tests runs with this repo alone — no engine build needed. That Node-only path (intake planning, manifest generation, DAWproject export, tests) is the recommended validation flow on Windows.

`AGENTS.md` is the authoritative contributor guide, with the full command catalog and doc index. `README.md` is public/product-facing — do not put internal implementation details, ADR lists, or roadmap planning there.

## Commands

```sh
npm test                                  # all tests (Node built-in test runner)
node --test test/dawproject-export.test.js  # single test file
npm run smoke:dawproject -- --json        # end-to-end DAWproject smoke, no engine needed
```

Engine-gated integration tests (require the sibling engine checkout):

```sh
SIANN_RUN_ENGINE_TESTS=1 SIANN_ENGINE_DIR=../siann-engine node --test test/live-import-pack.test.js
```

The CLI entrypoint is `bin/siann.js` (`node bin/siann.js --help` prints all subcommands). The core plan-review lifecycle:

```sh
node bin/siann.js plan intake <source-dir> --out intake-plan.json --json      # loose files / DAW packs → reviewable plan
node bin/siann.js workflow import-pack <manifest.json> --plan plan.json --json  # manifest → reviewable plan (no mutation)
node bin/siann.js workflow validate-plan plan.json --json
node bin/siann.js workflow approve-plan plan.json --out approved.json --approved-by <name> --json
node bin/siann.js workflow apply-plan approved.json --out cmd.json --run --json  # --run needs the engine
node bin/siann.js rollback journal.json --source-command cmd.json --out rb.json --run --json
node bin/siann.js export dawproject <manifest.json> --out session.dawproject --copy-media --json  # no engine needed
node bin/siann.js live import-pack <manifest.json> --json                     # full live-session smoke (engine required)
```

Helper scripts: `scripts/create-demo-import-pack.js` (demo audio + manifest), `scripts/create-demo-audio.js` (WAV fixtures), `scripts/create-daw-manifest.js` (converts extracted `_DAW/` + `_SpliceSFX/` packs into multi-track manifests; placement.md trim fields become `sourceStart`/`duration`).

## Architecture

Four layers, top to bottom: **Studio UI** (not implemented) → **Agent Runtime** (not implemented) → **Command Bridge** (this repo, partial) → **Engine** (sibling checkout). The engine is the trust boundary: AI and UI layers never mutate session state directly — all mutation goes through typed JSON command files executed by the bridge.

Key invariants baked into the code:

- **Review-before-apply lifecycle**: workflows generate a plan, which is validated, then explicitly approved (or rejected), then applied. Plan integrity is enforced via RFC 8785 (JCS) canonical-JSON `sha256:` hashes (`src/hash/jcs.js`, shared fixtures in `fixtures/jcs/`) so an approved plan can't be silently altered before apply.
- **Journaled rollback**: every engine run writes a command journal (`siann.command_journal.v0`) with pre-state snapshots; `src/workflows/rollback.js` generates rollback commands from it. Schemas are versioned strings (`siann.result.v0`, etc.) and documented in `docs/schemas/`.
- **Commands target stable IDs, not mutable track names.** Name-based lookup may exist as a dry-run helper, but ambiguity must be rejected before mutation.

Source layout: `src/bridge/runner.js` spawns the engine command runner and parses/validates its result JSON; `src/workflows/` owns plan generation, approval, live orchestration, and rollback; `src/exporters/` writes Cubase-compatible `.dawproject` packages (WAV media only) using a dependency-free zip writer; `src/runtime/client.js` wraps the live engine runtime protocol. `examples/` holds runnable command and manifest fixtures used by tests.

`.claude/skills/siann-intake/` and `.codex/skills/siann-intake/` are the committed agent-facing intake skill; `test/skill-docs.test.js` keeps them consistent with the code.

## Conventions

- JavaScript is CommonJS with Node built-ins only — the project is intentionally dependency-free (zero npm dependencies) until the integration surface stabilizes. Node >= 20.
- Use `SIANN`/`siann` consistently in public names, CLI names, schemas, and fixture paths.
- Commits use Conventional Commit subjects (`feat:`, `docs:`, `test:`, `refactor:`).
- Architecture decisions are recorded as ADRs in `docs/adr/` (`NNNN-kebab-case-title.md`); update `0000-adr-index.md` when adding or superseding one. Dated specs/discussions use `YYYY-MM-DD-kebab-case-title.md`.
- Tests live in `test/` next to nothing else — add deterministic command-bridge coverage (session creation, import, placement, save, render, replay) close to the module they cover.
- GPL-2.0-or-later (Ardour-derived engine path); keep licensing changes explicit. Never commit provider keys, local audio assets, or rendered stems.
