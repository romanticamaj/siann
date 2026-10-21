# SIANN Harness Engineering Specification

Date: 2026-07-11

Status: Proposed

Author: Claude Fable 5 (Anthropic), prepared for the SIANN project at the
request of Gary Hsieh. Signature block at the end of this document.

## Purpose

SIANN's product thesis is that the durable gap is not AI audio generation but
an AI-operable DAW runtime: a session an agent can observe, plan against,
mutate through bounded commands, audition, and roll back. That thesis stands or
falls on harness quality. If the harness is ambiguous, nondeterministic, or
unverifiable, no model — however capable — can operate SIANN safely.

This specification defines the engineering harness for SIANN: the set of
contracts, conventions, and verification layers that make an Ardour-derived
engine operable by AI agents and trustworthy to producers. It consolidates
rules already proven in the codebase, and extends them into a single normative
reference for future engine, bridge, agent-runtime, and UI work.

"Harness" here means four coupled systems:

1. **Agent operation harness** — the machine-facing contract surface: CLI,
   runtime protocol, schemas, plan lifecycle, skills, and error taxonomy that
   agents use to drive SIANN.
2. **Verification harness** — the layered test, fixture, replay, and render
   verification system that proves commands do what they claim.
3. **Engine modification harness** — the rules for changing the Ardour-derived
   fork so it stays AI-friendly, upstream-syncable, and license-clean.
4. **Agent runtime harness** (forward-looking) — the provider-pluggable
   reasoning layer and its evaluation, policy, and privacy machinery.

## Scope And Non-Goals

In scope:

- Normative rules for every machine-facing contract in the `siann` repo and
  the `siann-engine` runtime protocol.
- The verification ladder and its gating rules.
- The process for growing the command surface.
- Engine fork divergence and upstream sync policy.
- Requirements the future agent runtime must satisfy before it may mutate
  sessions.

Out of scope:

- Studio UI design (see ADR-0007; UI remains a command-bridge client).
- Model choice, prompt design, or provider-specific behavior (ADR-0009 keeps
  providers runtime-pluggable).
- Prompt-to-song generation and automatic musical structure detection.
- Real-time collaboration.

## Normative Language

"Must" marks a rule the harness gate enforces. "Should" marks the default that
requires written justification to deviate from. "May" marks an allowed option.

## Design Principles

These principles are ordered; when they conflict, the earlier one wins.

1. **The engine is the trust boundary.** UI and AI layers never mutate session
   state directly. All mutation flows through typed commands validated by the
   bridge and executed by the engine (ADR-0006).
2. **Fail loudly, never guess.** Ambiguous name resolution, stale plans,
   mismatched session IDs, and unverifiable hashes are rejected, not repaired.
   A refused command is a harness success, not a failure.
3. **Deterministic before intelligent.** Every workflow must be drivable by
   static JSON with reproducible results before any model is attached to it.
   AI quality problems must never be able to corrupt a session.
4. **Machine-first outputs.** Every command surface emits structured JSON with
   stable field names and machine-readable error codes. Human-readable text is
   a rendering of the JSON, never the primary contract.
5. **Review before apply.** Mutation is separated into plan generation,
   validation, explicit approval, and application — each a distinct, auditable
   artifact linked by content hashes.
6. **Reversible by default.** Every applied mutation produces journal entries
   and snapshot-backed rollback metadata before it is considered complete.
7. **Stable IDs over mutable names.** Commands target stable entity IDs.
   Name-based lookup exists only as a dry-run helper and must error on
   ambiguity.
8. **Versioned schemas, additive evolution.** Every contract carries a
   `siann.<name>.v<N>` schema version. Consumers reject unknown versions.
9. **Privacy is a payload boundary.** What leaves the machine, to which
   provider, in what category, is explicit, logged, and user-controllable
   (ADR-0010).
10. **Dependency-light by intent.** The bridge repo uses CommonJS and Node
    built-ins only until the integration surface stabilizes. Every dependency
    is an attack surface and a portability risk for the harness.

## Harness Layer Map

```text
Agents (Claude, Codex, future SIANN agent runtime)
  entry: .claude/skills/, .codex/skills/, AGENTS.md, CLAUDE.md
    |
    v
Agent operation harness            (this repo)
  bin/siann.js CLI  --json everywhere
  plan lifecycle: plan -> validate -> approve -> apply -> rollback
  schemas: siann.command.v0, siann.result.v0, siann.command_journal.v0,
           siann.runtime_journal.v0, siann.observe.v0, intake plan v0,
           dawproject export v0
    |
    v
Command bridge                     (this repo: src/bridge, src/workflows)
  validation, canonical-JSON sha256 integrity, journal summaries,
  rollback command generation, runtime client (src/runtime/client.js)
    |
    v
Engine runtime protocol            (siann-engine, sibling checkout)
  line-delimited JSON over stdio, request/response envelopes,
  session ownership, snapshots, runtime journal
    |
    v
Ardour-derived audio core          (siann-engine)
  tracks, regions, import, trim, place, save, render
```

Two verification paths cross-check each other:

- **Engine path:** manifest -> plan -> approval -> engine command batch ->
  Ardour session + preview render + journal + rollback.
- **Engine-independent path (ADR-0015):** manifest -> DAWproject export ->
  Cubase or other DAWproject host. This path runs on any platform with Node 20
  and is the first validation flow on Windows.

An output produced by one path should be spot-checkable by the other: the same
manifest must yield equivalent track/region timelines in the Ardour session
and the DAWproject package.

## Part 1: Agent Operation Harness

### 1.1 CLI Contract

`bin/siann.js` is the canonical agent entry point. Rules:

- Every subcommand must support `--json` and emit exactly one JSON document to
  stdout in that mode. Diagnostics go to stderr.
- Exit code 0 means the reported operation succeeded; non-zero means it did
  not. Agents must be able to branch on exit code alone.
- JSON outputs must include `ok: boolean`. Failures should include a stable
  machine-readable `code` alongside a human `message`.
- Flags are long-form and kebab-case (`--engine-dir`, `--copy-media`,
  `--approved-by`). Positional arguments are inputs; outputs are always
  explicit via `--out` or similar flags. A command must never write an output
  file at an unstated path.
- Commands that mutate the engine require `--run`; without it they only write
  artifacts. Generation and execution are separate decisions.
- New subcommands must be added to `usage()` and to the command coverage
  expectations in `test/` before they ship.

### 1.2 Schema Registry And Versioning

All machine contracts are versioned as `siann.<name>.v<N>` and documented
under `docs/schemas/`. Current registry:

| Schema | Purpose | Producer |
| --- | --- | --- |
| `siann.command.v0` | Engine command batches | bridge workflows |
| `siann.result.v0` | Engine runner results | engine |
| `siann.command_journal.v0` | Batch journals + rollback metadata | engine |
| `siann.runtime_journal.v0` | Persistent live-runtime journal | engine runtime |
| `siann.observe.v0` | Canonical session read model | engine |
| `siann.import_pack_plan.v1` | Reviewable import-pack plan with JCS integrity hash (v0 still accepted) | bridge workflows |
| `siann.jcs_fixtures.v1` | Shared canonicalization fixtures (`fixtures/jcs/`) | maintained by hand from RFC 8785 |
| `siann.rfc6962_fixtures.v1` | Merkle tree vectors (`fixtures/hash/rfc6962.json`) | Certificate Transparency reference data |
| `siann.document_hash_fixtures.v1` | Document hash cases (`fixtures/hash/document.json`) | `scripts/generate-hash-fixtures.js` |
| intake plan v0 | AI-to-deterministic-bridge intake boundary | intake planner |
| DAWproject export v0 | Cubase-compatible exchange package | exporter |

Rules:

- Consumers must validate `schemaVersion` and reject unknown versions with a
  clear error, never best-effort parse.
- Within a version, changes must be additive (new optional fields only).
  Removing, renaming, or changing the meaning of a field requires a version
  bump and a schema doc update in the same change.
- Every schema change lands with: the schema doc update, a fixture update
  under `examples/`, and test coverage exercising the new shape.
- Hashes are always prefixed (`sha256:<64 lowercase hex>`), computed over
  RFC 8785 JSON Canonicalization Scheme (JCS) output as implemented in
  `src/hash/jcs.js`. Any new integrity hash must reuse that canonicalization,
  not invent a second one. Values JCS cannot represent (NaN, infinities, lone
  surrogates, non-JSON types) are rejected, never hashed.
- Every implementation of the canonicalization (the Node bridge now, the C++
  engine later) must pass the shared fixtures in `fixtures/jcs/cases.json`.
  Fixture outputs are written from the RFC, not generated by an
  implementation.

### 1.3 Plan Lifecycle Contract

The plan lifecycle is the core producer-trust mechanism and the agent's
mutation pathway. Its states:

```text
draft -> validated -> approved -> applied
                   -> rejected
applied -> rolled_back
```

Rules:

- **Generate** (`workflow import-pack --plan`, `plan intake`): produces a
  reviewable plan artifact. Generation must be pure — no engine mutation, no
  side effects beyond writing the plan file.
- **Validate** (`workflow validate-plan`): checks structural integrity,
  command hash consistency, referenced file existence, and reports whether the
  plan is approvable. Validation must be repeatable and read-only.
- **Approve / Reject** (`workflow approve-plan` / `reject-plan`): records who
  decided, when, and (for rejection) why. Approval binds to the plan's
  canonical-JSON sha256; an approved plan whose content hash no longer matches
  must be refused at apply time. Agents may generate and validate plans
  autonomously; approval identity must reflect the actual reviewer — an agent
  must not sign approval as the human user.
- **Apply** (`workflow apply-plan --run`): converts the approved plan into an
  engine command batch and executes it. Apply must re-verify the approval hash
  before execution.
- **Rollback** (`rollback`): generates and optionally runs a rollback command
  from the journal's snapshot metadata. Rollback must restore pre-batch state
  or fail loudly; partial restoration is not an acceptable silent outcome.

Risk tiers follow the autonomy model in ADR-0005:

- `low`: reversible, non-destructive (create track, place muted preview,
  create marker). Auto-apply is permissible when a policy layer exists; still
  journaled.
- `normal`: standard session mutation (import, place, trim, save, render).
  Requires the plan lifecycle.
- `high`: destructive or hard-to-reverse (delete regions, overwrite
  automation, commit generated audio over source material, export
  deliverables). Requires explicit human approval; never auto-applied.

Every plan and journal batch must carry its risk tier; the tier of a batch is
the maximum tier of its commands.

### 1.4 Observation And Stale-Plan Rejection

- Observation responses (`siann.observe.v0` / `session.observe`) are the only
  sanctioned way for agents to learn session state. Agents must not parse
  `.ardour` XML directly for planning.
- Observations include an `observationHash`. Plans should record the hash they
  were planned against; `commands.apply` should pass it as
  `expectedObservationHash`, and the runtime rejects the batch when the live
  hash differs. Stale plans are re-observed and re-planned, never patched.
- Any mutation outside the command path (for example manual edits in the
  legacy Ardour GUI) marks the session dirty/non-deterministic for replay
  purposes; the harness treats such sessions as non-replayable evidence.

### 1.5 Skills And Agent Onboarding Surface

`.claude/skills/siann-intake/SKILL.md` and `.codex/skills/siann-intake/SKILL.md`
are the committed agent-facing entry points. Rules:

- The two copies must stay consistent; `test/skill-docs.test.js` enforces
  this. Any workflow or flag change that a skill references must update the
  skill in the same change.
- Skills document boundaries, not just commands: what the agent may do
  autonomously (inspect, plan, validate, export), and what requires human
  action (approval of engine mutation, sending assets to providers).
- New agent-facing workflows get either a new skill or a documented section in
  an existing skill before they are considered shipped.
- `AGENTS.md` and `CLAUDE.md` are harness artifacts, not prose: command
  examples in them must remain copy-paste runnable, and portable forms
  (`../siann-engine`, `SIANN_ENGINE_DIR`) are preferred over any contributor's
  absolute paths.

### 1.6 Command Surface Growth Process

Adding a new operation (for example `move_region`, `set_track_gain`,
`create_marker`) follows this sequence, in order:

1. **Coverage entry** — add or update the row in
   `docs/research/engine-command-coverage.md`: operation, engine API path,
   risk tier, rollback strategy.
2. **Schema** — extend the command schema doc; bump versions if the change is
   not additive.
3. **Fixture** — add a runnable command fixture under `examples/`.
4. **Engine implementation** — implement in the engine runner/runtime with
   snapshot-backed rollback metadata.
5. **Bridge support** — CLI/workflow support with `--json` output.
6. **Tests** — Node contract tests always; engine-gated integration test when
   the op mutates sessions; determinism/replay coverage where feasible.
7. **Docs and skills** — update `AGENTS.md` command list and any affected
   skill.

A new mutating operation without a rollback strategy must not merge. If true
rollback is impossible for an op, it is classified `high` risk and its journal
entry must say `rollback: unsupported` explicitly.

## Part 2: Verification Harness

### 2.1 Verification Ladder

Tests are layered so that most confidence is available on any machine with
Node 20, and engine-dependent confidence is isolated behind explicit gates.

| Level | Name | Needs | Runs |
| --- | --- | --- | --- |
| L0 | Contract/unit | Node only | `npm test`, every change |
| L1 | Fixture determinism | Node only | `npm test`, every change |
| L2 | Node-only end-to-end smoke | Node only | `npm run smoke:dawproject`, every change |
| L3 | Engine-gated integration | `siann-engine` build | `SIANN_RUN_ENGINE_TESTS=1`, engine-capable machines |
| L4 | External host verification | Cubase / Ardour GUI | manual, release-oriented |

Rules:

- L0–L2 must pass on Windows, macOS, and Linux with no engine checkout. This
  is the harness's portability guarantee and the Windows-first validation flow.
- L3 tests are opt-in via `SIANN_RUN_ENGINE_TESTS=1` and must skip cleanly —
  not fail — when the gate or engine is absent.
- L4 is manual today: import the exported `.dawproject` into Cubase, or open
  the saved session in Ardour for visual comparison. Each L4 pass should be
  recorded (date, host version, pack used) in the relevant research doc.
- A bug found at L3/L4 should, wherever possible, be reproduced by a new L0–L2
  test before it is fixed, so the fix is guarded on all platforms.

### 2.2 Determinism Rules

- Artifacts that participate in hashing or approval (plans, command batches,
  journal-summarized state) must be byte-stable given the same inputs:
  canonical JSON key order, no wall-clock timestamps inside hashed regions, no
  environment-dependent absolute paths inside hashed regions. Timestamps and
  machine-local paths belong in unhashed envelope fields.
- Replay determinism is a standing requirement: the same fixture inputs plus
  the same command log must produce the same project graph, and where
  feasible the same render hash. Where bit-exact render hashing is not
  achievable, verification falls back to structural checks (duration, channel
  count, sample rate, region timeline) plus peak/RMS tolerance checks.
- Demo audio generators (`scripts/create-demo-audio.js`) must be
  deterministic: same parameters, same bytes.

### 2.3 Fixtures And Golden Artifacts

- `examples/` fixtures are contract documentation that executes. They must
  stay minimal, runnable, and covered by `test/bridge-fixtures.test.js`-style
  checks.
- Golden artifacts (expected manifests, plans, package entry lists) are
  updated only deliberately: a diff to a golden file must be explained in the
  commit that changes it, never regenerated silently alongside unrelated work.
- Fixtures must not contain licensed audio or user project material. Generated
  WAVs and synthetic placement notes only.

### 2.4 Required Test Categories

Per the architecture spec, the harness must maintain coverage across:

- Session command dry-run tests.
- Import and region placement tests (including `sourceStart`/`duration` trim).
- Time conversion tests: mm:ss, bars/beats, tempo maps, sample positions.
- Undo/rollback tests, including rollback-after-failure.
- Offline render smoke tests.
- Command log replay and fixture-session determinism tests.
- Journal validation tests (schema, status, risk, hash format).
- Protocol tests for the runtime client: request/response correlation, error
  envelopes, session-mismatch rejection.
- Skill/doc consistency tests.

AI quality evaluation (was the plan musically sensible?) is a separate,
lower-severity track from engine correctness. An engine-correctness failure
blocks merge; a plan-quality regression informs the future agent runtime but
must never be able to corrupt a session in the first place.

### 2.5 CI Shape

Target CI matrix (implement as the repo grows; local discipline substitutes
until then):

- Node-only job on `windows-latest`, `macos-latest`, `ubuntu-latest`:
  `npm test` plus `npm run smoke:dawproject -- --json` (L0–L2).
- Engine job on platforms with a working engine build: build `siann-engine`,
  run L3 gated tests.
- Docs job: link checking for `docs/` and ADR index consistency.

The Node-only jobs are required checks. Engine jobs may start as
allowed-to-fail while the engine's per-platform build story stabilizes, but a
red engine job must be triaged, not ignored.

### 2.6 Definition Of Done For Harness Changes

A change to any machine-facing surface is done when:

1. `npm test` passes with the new coverage included.
2. `npm run smoke:dawproject -- --json` passes where the change touches the
   export path.
3. Engine-gated tests pass on at least one engine-capable machine when the
   change touches engine commands or the runtime protocol.
4. Schema docs, fixtures, `AGENTS.md`/`CLAUDE.md` command lists, and skills are
   updated in the same change.
5. The rollback story for any new mutation is implemented and tested, or the
   op is explicitly marked `high` risk with `rollback: unsupported`.

## Part 3: Engine Modification Harness

The engine fork must stay three things at once: AI-friendly, Ardour-syncable,
and license-clean. These pull in different directions; the rules below manage
the tension.

### 3.1 Divergence Policy

- SIANN engine code should be **additive**: new session utilities
  (`session_utils/siann_command.cc`), a new long-running runtime binary, new
  headless entry points. Prefer adding adapters over editing `libardour`
  internals.
- When an `libardour` change is unavoidable (for example exposing a mutation
  point safely), keep the patch minimal, isolated, and documented in
  `docs/research/engine-command-coverage.md` with the reason, so upstream
  rebases can carry it deliberately.
- Do not fork the session format. SIANN-specific state lives beside the
  session (for example `.siann/runtime-journal.json`), never inside Ardour's
  XML in ways that break Ardour's own loading. Ardour compatibility is a
  verification asset (visual inspection) even though opening arbitrary Ardour
  projects is a non-goal.
- Track the upstream Ardour base version explicitly in the engine repo.
  Upstream syncs are scheduled work with their own verification pass (L3 suite
  green before and after), not opportunistic merges.

### 3.2 Runtime Protocol Rules

The headless runtime (per the 2026-07-07 runtime spec and ADR-0014) is the
long-term engine surface. Protocol invariants:

- Line-delimited JSON over stdio in v0; every request gets exactly one
  response carrying its `requestId`, even on failure. No response is ever
  silently dropped — a desynced client must be able to correlate every
  outcome.
- Errors use `ok: false` with a stable machine `code` (`session_mismatch`,
  `invalid_command`, `snapshot_failed`, ...). New codes are added to a
  documented registry in the runtime spec; codes are never repurposed.
- Session-scoped requests must carry the `sessionId` from `session.create`;
  mismatches are rejected.
- Requests are processed strictly in order. Async job envelopes for
  long-running work (import analysis, large renders) are deferred until after
  the persistent mutation loop is proven; when they arrive they must not break
  the one-response-per-request rule (job completion becomes an event, the
  submission still gets its one response).
- Runtime request surface (`session.save`, `render.preview`,
  `session.observe`) is canonical for new clients; batch-op equivalents remain
  valid inside `commands.apply` only for journal/fixture replay compatibility.
- Every `commands.apply` returns rollback metadata (`rollbackId`,
  `snapshotPath`, `snapshotSha256`, pre/post observation hashes) and appends to
  the persistent `siann.runtime_journal.v0`. A mutation that cannot produce
  this metadata must fail before mutating.
- On command failure the runtime restores pre-command state or marks the
  session as requiring recovery and refuses further mutation until recovered.

### 3.3 Session Ownership

- Only the headless runtime mutates the active session; one active session per
  runtime process in v0.
- The Ardour GUI is a diagnostic viewer of saved output, not a product
  mutation path. GUI mutations invalidate replay determinism for that session
  run and must be treated as such in any evidence chain.

### 3.4 AI-Friendliness Requirements For Engine Work

Every engine-side capability must be designed for machine operation first:

- Deterministic where possible; where the engine is inherently
  nondeterministic (thread timing, denormal behavior), the observable contract
  (observation output, journal, saved session) must still be stable.
- Observable: a new mutation is not complete until `session.observe` reflects
  its effect and the observation hash changes accordingly.
- Addressable: new entities get stable SIANN IDs surfaced through observation;
  commands never depend on display names or list ordering.
- Bounded: no engine command may implicitly cascade beyond its declared
  touched entities; the journal's touched-entity list is a contract, not a
  best-effort log.

### 3.5 Licensing

The engine path is GPL-2.0-or-later (ADR derived from the Ardour lineage).
Engine and bridge contributions must remain GPL-compatible; licensing or
attribution changes require explicit documentation. No provider SDKs or
proprietary code may be linked into the engine; provider integrations belong
in the agent runtime layer where pluggability keeps them out of the GPL
boundary question entirely.

## Part 4: Agent Runtime Harness (Forward-Looking)

The agent runtime is not implemented yet. These are the requirements it must
meet before it is allowed to drive mutations, so that its design is
constrained now rather than retrofitted later.

- **Tools mirror the harness.** Agent tool definitions map 1:1 onto the CLI /
  runtime request surface. No agent-runtime-only backdoors into the engine.
- **Observation-first loops.** Plan generation must begin from a fresh
  `session.observe`; the plan records the observation hash; apply uses
  `expectedObservationHash`.
- **Risk policy is enforced by the runtime, not the model.** The model may
  propose anything; the runtime classifies each command against the risk
  tiers and enforces copilot/auto-apply/approval-required behavior
  (ADR-0005). High-risk operations always require human approval.
- **Provider pluggability.** Adapters for cloud and local providers conform to
  one internal interface; API keys live outside project files; local-only mode
  hard-blocks cloud adapters (ADR-0009, ADR-0010).
- **Payload transparency.** Every provider call logs timestamp, provider and
  model ID, payload category (metadata summary, file names, raw audio, ...),
  and the command transaction it served. Raw audio, stems, or lyrics leaving
  the machine requires explicit per-event user approval.
- **Evaluation harness.** Agent quality gets its own fixture-based evaluation
  (given this observation and this instruction, is the produced plan valid,
  safe, and sensible?) using recorded observations — no engine required — so
  plan-quality regressions are measurable at L0.

## Part 5: Operational Conventions

- Generated working artifacts (demo audio, plans, journals, sessions,
  previews, exports) go under a per-task temp directory
  (`/tmp/siann-*` on POSIX, `$env:TEMP\siann-*` on Windows), never into the
  repo tree.
- Artifact naming inside a task directory follows the shipped patterns:
  `manifest.json`, `intake-plan.json`, `plan.json`, `approved-plan.json`,
  `*.command.json`, `journal.json`, `preview.wav`, `session.dawproject`.
- The engine checkout is a sibling (`../siann-engine`), overridable with
  `SIANN_ENGINE_DIR` or `--engine-dir`. Docs and scripts must use the portable
  form.
- Conventional Commit subjects; ADRs for boundary decisions (with
  `0000-adr-index.md` updated); dated specs for larger designs, like this one.

## Harness Gate Checklist

Copy into PRs that touch machine-facing surfaces:

```text
[ ] npm test passes (L0-L1)
[ ] smoke:dawproject passes if export path touched (L2)
[ ] engine-gated tests pass on an engine machine if engine/protocol touched (L3)
[ ] schema docs updated; schemaVersion bumped if non-additive
[ ] fixtures under examples/ updated and runnable
[ ] rollback implemented + tested for any new mutation (or op marked high/unsupported)
[ ] AGENTS.md / CLAUDE.md command lists still copy-paste runnable
[ ] skills updated and skill-docs test passes
[ ] no absolute contributor paths introduced; portable engine-dir forms used
[ ] no licensed audio or user material in fixtures
```

## Open Questions

- Bit-exact render hashing across platforms: feasible for the Ardour-derived
  render path, or standardize on structural + tolerance checks?
- Async job protocol shape for long renders without breaking
  one-response-per-request.
- Multi-session runtimes and how session ownership rules extend when UI and
  agent clients coexist.
- Where the evaluation-harness fixtures for agent plan quality should live
  (this repo vs a dedicated eval pack).
- CI hosting for engine builds per platform, and when the engine job graduates
  from allowed-to-fail to required.

## Relationship To Existing Documents

This spec consolidates and extends, but does not supersede:

- Architecture design (2026-07-06) — system boundaries and product thesis.
- Headless engine runtime v0 (2026-07-07) — runtime protocol detail.
- ADR-0004/0006 — layer separation and mutation boundary.
- ADR-0005 — autonomy and risk model.
- ADR-0009/0010 — provider pluggability and privacy boundary.
- ADR-0011 — journaled rollback.
- ADR-0014 — headless DAW runtime direction.
- ADR-0015 — engine-independent DAWproject first slice.

Where this document is stricter than an existing doc, this document governs
harness/verification questions; boundary decisions remain governed by their
ADRs. Conflicts should be resolved by a new ADR.

## Signature

This specification was researched against the SIANN repository state at commit
`1d47a34` (docs: record engine-independent dawproject slice) and authored on
2026-07-11.

Signed,

**Claude Fable 5**
Anthropic — via Claude Code
2026-07-11

Prepared at the request of Gary Hsieh (romanticamaj) for the SIANN project.
As an AI-authored engineering document, this spec should be treated as a
proposal until a human maintainer reviews and accepts it; acceptance can be
recorded by changing `Status: Proposed` to `Status: Accepted` with the
reviewer's name and date.
