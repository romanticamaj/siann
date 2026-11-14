# Agent rules for the milestone harness

Every subagent started by `.claude/workflows/siann-milestone.js` reads this file first. It overrides agent defaults. `CLAUDE.md` and `AGENTS.md` still apply.

## Sources of truth

- Architecture spec: `docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md`. When code and spec disagree, either the code is wrong or the spec changes in the same branch (a `docs:` commit first, explaining why).
- Milestone manifests: `.claude/milestones/<M>.json` (`siann.milestone.v1`). A feature is finished when every acceptance item has a test that fails without the change.
- Decisions: `docs/adr/`. Never reverse an ADR without the maintainer.

## Branches and worktrees

- One branch per feature: `ms/<M>/<feature-id>`, from `origin/main`. Fix rounds commit to the same branch.
- Implementation agents run in their own worktree. **Before returning, run `git checkout --detach`** so the next agent can check out the branch elsewhere.
- Reviewers never edit. To inspect a branch, use `git worktree add --detach <scratch dir> <branch>` and remove the worktree when done.
- Do not touch the maintainer's main checkout (`D:\projects\siann`) except to read.

## TDD order

1. Write the failing tests for the acceptance items, build, and see them fail for the right reason. Commit (`test: ...`).
2. Implement until they pass. Commit (`feat: ...` / `fix: ...`).
3. Refactor with the tests green.

Fixture expectations come from outside the code under test (RFCs, published vectors, separate generators in `scripts/`). Tests are deterministic: no wall-clock sleeps as synchronization, no real devices in CI (use `ManualAudioDevice` or paced `FakeAudioDevice`).

## Test matrix

`docs/harness/test-matrix.md` maps every feature to its tests by layer and platform. Its section 8 rules apply to every feature:

1. Every acceptance item names its test layer (unit, e2e, ctest, Node, or manual with who runs it and when); the PR checklist names the test.
2. A new protocol method gets a native protocol test, an `engine.capabilities` entry, a row in its `docs/schemas/protocol-*.md`, an MCP tool with an adapter test or an explicit reasoned exclusion, the app's `capabilities-full.json` entry, and an app client unit test when the app calls it.
3. A UI feature gets unit tests for its pure logic, a Playwright e2e per user path against the real engine, the i18n fit check for its new controls, and its tour states.
4. Tests run on Windows, macOS and Linux unless the behaviour is platform-specific; every platform skip or env gate carries a reason and a row in the matrix's section 3.
5. The feature's branch adds or updates its row in the matrix (section 2) and moves closed gaps out of section 6. The verifier checks that row.

## Checks

```sh
node scripts/check-all.js --changed         # before every push: the steps your changes need
node scripts/check-all.js --changed --plan  # which steps those are, without running them
node scripts/check-all.js --all             # every step: milestone exits, or when the maintainer asks
node scripts/check-all.js --only native     # one step: node | native | desktop | app | gcc
```

`--changed` diffs against the merge-base with `origin/main` (fetch first), uncommitted and untracked files included, and picks steps by path: `app/` runs node and app; `native/` runs native and gcc, plus desktop for `native/libs/host_*`, `native/apps/engine`, `native/cmake`, `CMakePresets.json` and any CMake file; `scripts/pluginval.js` adds desktop, `scripts/check-all.js` runs everything; docs, `*.md`, `.claude/`, `.github/`, `test/` and the bridge run node only; an unknown path runs everything. The table is `stepsForPath` in `scripts/check-all.js`; CI picks its jobs with the same table. `--desktop`, `--app` and `--gcc` still add their step; `-j <n>` limits build parallelism when memory is short.

On Windows the native steps go through `native/tools/msvc-env.cmd`; the gcc step uses WSL `g++` (it configures the dev preset first when that has not run). All presets treat warnings as errors. Builds go through sccache (or ccache) when installed and share third-party sources across worktrees (runbook, "Local caches"), so a fresh worktree does not rebuild or re-download everything.

GCC catches what MSVC does not. Known traps:

- `-Wshadow`: a member, alias or enumerator with the same name as a parameter or local.
- `-Winterference-size`: do not use `std::hardware_destructive_interference_size`; use the project constant.
- Nested structs with default member initializers used in `noexcept` traits inside the enclosing class: put such `static_assert`s in a function body, not at class scope.
- `-Wdangling-reference` false positives on functions returning references: bind to a pointer instead.

## Realtime rules (audio thread)

No allocation, no locks, no blocking I/O, no logging, no exceptions on the audio thread. One exception, accepted 2026-11-07 (ADR-0018, amended the same day): what JUCE's own VST3 and AU hosting wrappers do inside `processBlock`, audited in the architecture spec under "Locks inside a hosted plugin's `processBlock`" (the locks, and the allocation a MIDI-producing plugin can cause there). It covers nothing in SIANN's code (`JucePluginInstance::process` takes no lock). In M0 no shipped path processes a hosted plugin (no graph node wraps a `PluginInstance`), so the exception is exercised by the hosting tests only; the graph driver's deadline-miss counter (`xruns`, `maxCallbackMicros`, `unmeasuredCallbacks` in `siann-cli play` and `record`, and in the engine's `engine.status`) is what will show a plugin's wait once the M4 plugin node puts one in a driver callback. A plugin event sink only pushes to `pluginEventAny`: never `setState`, `setParameter`, device control or any wait for the audio thread (it runs under a JUCE lock). Do not add a lock anywhere else and cite this exception. Communication only through the bounded preallocated queues in `siann-realtime`. Prove it in tests by linking `siann_rt_alloc_guard`. Follow revision 3.1 of the spec: one graph transition in flight, duck-and-swap, retirement acknowledged by the butler, generations on locate. Change a plugin parameter with `setParameter`, never with `setState`; a `setState` during playback holds that plugin out of processing (input passes through dry) until it returns.

## UI fidelity

Maintainer rule (2026-11-14): the UI is checked against the mockup, and the finished UI must look exactly like it. Design: UI redesign spec, section 10.

**The mockup is the reference implementation of styling and markup, and UI work ports from it.**

- Reference: `docs/superpowers/specs/2026-11-13-siann-ui-redesign/mockup.html` (`?lang=zh-TW` for Traditional Chinese). Its stylesheet is the app's: `app/renderer/tokens.css` (the one token source) and `app/renderer/ui/*.css` (the component rules). The mockup links those files and has no styles of its own.
- A UI component takes its DOM structure and class names from the corresponding mockup markup and is styled by the shared rules. Do not restyle from a screenshot, and do not write a second rule for something the shared rules already draw.
- Canvas code copies the mockup's drawing parameters (row heights, colours, the clip title strip, handles) from `app/src/renderer/tokens.ts`, generated from `tokens.css` by `node scripts/gen-ui-tokens.js`.
- No colour or size literal in renderer CSS or TypeScript: name a token. `test/ui-tokens.test.js` fails otherwise; `app/test/fidelity/debt.json` is the ledger of what does not hold yet, and it only shrinks. Decided by the maintainer, 2026-11-15: every spacing and size literal becomes a named token and there is no allowlist, in the shared rules and in the mockup's script alike (`m5-ui-tokens-spacing`); the ledger ends empty with `m5-ui-mockup-alignment`.
- Fonts: Inter variable, JetBrains Mono Regular and JetBrains Mono Medium (500) are bundled (decided by the maintainer, 2026-11-15; Medium arrives with `m5-ui-alignment-chrome`). Use 500 where the mockup's rules ask for it, and no weight that is not bundled.
- Every region and key component carries the mockup's id: `data-region`, `data-part`, or `data-part-item` with `data-part-of` for a repeated component (spec 10.3).
- **A part whose feature has not landed is absent, and it keeps its space empty** (spec 3.0). Decided by the maintainer, 2026-11-15: the part's box stays where the mockup draws it with nothing in it (no control, no label, no placeholder), so every other part lands where the mockup draws it. The 20 px marker track row stays empty until `m5b-ui-markers`; the insert row of a strip stays empty until `m5b-ui-inserts-master`.
  - A row or column the shared rules fix needs nothing more. A box the mockup sizes by its content takes its size from a `--hold-<part>-w` or `--hold-<part>-h` token in `tokens.css`, carrying the size the gate measures for that part in the mockup; adding one for a pending part is authorised, and the feature that lands the part deletes it (`test/mockup-fidelity.test.js` fails on a hold whose part is no longer pending).
  - The empty element has no role, is not focusable, is hidden from assistive technology and does not carry the part's `data-part` id. A placeholder or a disabled control is never a substitute and never passes the gate.
  - The part is `pending` in `app/test/fidelity/manifest.json` under the feature that owns it, and that feature's acceptance includes the gate for it. Every part has an owner (decided by the maintainer, 2026-11-15): the automation parts belong to M6a's `m6a-ui-automation`, every other one to an M5 or M5b feature. There is no unowned part.

**Every UI pull request runs the gate and attaches its report.**

```sh
node --test test/ui-tokens.test.js test/mockup-fidelity.test.js    # layer 1 and the manifest, no build needed
cd app && npm run build
SIANN_FIDELITY=1 SIANN_FIDELITY_OUT=<dir> npx playwright test --project fidelity   # layers 2 and 3, en and zh-TW
```

(`SIANN_ENGINE_EXE` and `SIANN_CLI_EXE` as for the other e2e specs; `node scripts/check-all.js --only app` sets them and runs the gate after the app's tests.) The gate compares, per part, the bounding box (within 1 px on x, y, width, height) and the listed computed styles (identical), and per region the chrome's pixels (at most 0.5 % differing; waveform interiors and dynamic content are masked). It forces device scale factor 1, so the display's scaling does not matter. Put `report.md` (with its region images) in the pull request: the parts your feature owns must be clean in both locales.

- A feature that lands sets its gate to `enforce` in the manifest, in the same pull request.
- The parts M5 built answer to the alignment feature of their region: `m5-ui-alignment-chrome` (top bar, status bar), `m5-ui-alignment-arrange` (project zone), `m5-ui-alignment-mixer-inspector` (left and lower zones), `m5-ui-alignment-plans` (right zone). Until one lands its gate is `report`: measured and reported, never failing. From the first enforced gate on, an enforced mismatch fails check-all and CI. `m5-ui-mockup-alignment` closes the series with all four enforced and the ledger empty.
- The gate compares absolute boxes against the full mockup, and that does not change (decided by the maintainer, 2026-11-15); it is why an absent part keeps its space.

**Not without the maintainer:** changing `tokens.css`, `app/renderer/ui/*.css`, `mockup.html` or its PNGs; changing the manifest's rules, thresholds, style list or masks; adding to `debt.json`; leaving a part without an owner. If the mockup is wrong or cannot be built as drawn, that is a stop condition: return `status: blocked` with the part and the reason.

What the maintainer has authorised (2026-11-15), each for the feature named and for nothing beyond it:

| Change | Feature |
|---|---|
| New tokens in `tokens.css` for every size literal, and the edits to `app/renderer/ui/*.css` and to `mockup.html`'s script that replace the literals with them. Condition: nothing the mockup draws changes, proven by the gate's measurement of the mockup before and after | `m5-ui-tokens-spacing` |
| The token values `--ruler-h` 40 px, `--zone-tabs` 26 px, `--meter-w` 6 px, `--focus` 20 % (the mockup wins) | `m5-ui-tokens-spacing` |
| `JetBrainsMono-Medium.woff2`, its `@font-face`, and the mockup's PNGs retaken once | `m5-ui-alignment-chrome` |
| A `--hold-<part>-w` / `-h` token for a pending part whose box the shared rules do not size, and its removal when the part lands | The feature that leaves the box empty; the feature that lands the part |

## Windows working tree

- Files are CRLF in the working tree (`core.autocrlf=true`). Scripted edits must keep CRLF; prefer the Edit tool.
- Write long Python or shell scripts to a scratch file and run it; long heredocs in Git Bash break.
- Git Bash `tar` cannot take `C:` paths; `cd` first.

## Commits

Conventional Commit subjects (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `build:`, `ci:`). End every commit message with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Never commit provider keys, signing material, local audio assets or rendered stems.

## Landing (land agents only)

1. `git fetch origin && git rebase origin/main`, rerun `node scripts/check-all.js --changed`.
2. `gh auth switch -u romanticamaj` (the default account `ulovemusic2023` gets 403 on this repo).
3. `git push -u origin <branch>`; `gh pr create --base main` with this body:
   - Summary (2 to 4 bullets)
   - Acceptance checklist copied from the manifest, each ticked with the test that covers it
   - Verification: check-all result, reviewer rounds, follow-ups (minor findings)
   - Final lines: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
4. Wait for CI (`gh pr checks --watch`). CI runs only the jobs the changed paths need; the `CI ok` check sums them up. macOS runners can queue for 10+ minutes. On red: reproduce, add a failing test where possible, fix, push. A second red run is a stop condition.
5. `gh pr merge --merge --delete-branch`.
6. **Always** `gh auth switch -u ulovemusic2023` afterwards, also on failure.

## Stop conditions

Return `status: blocked` with a precise reason instead of guessing when:

- CI is red twice on the same branch.
- An acceptance item needs hardware, an account, a long run or a judgement call from the maintainer (human gates in the manifest).
- The spec contradicts itself or an ADR, and the fix is not obvious.
- A dependency, licence or new third-party library would be added that no ADR covers.
- You would need to store a secret or change repository settings.
