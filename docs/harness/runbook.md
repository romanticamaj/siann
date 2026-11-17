# Milestone runbook

How to run one milestone of the native engine with the harness. One milestone per run; check the result before starting the next.

## Pieces

| Piece | Path | Role |
|---|---|---|
| Manifests | `.claude/milestones/<M>.json` | Features, waves, acceptance, exit criteria, human gates |
| Workflow | `.claude/workflows/siann-milestone.js` | Preflight → Plan (Fable spec check) → Build (Opus TDD + verifier + Fable spec review, fix loop) → Land → Exit |
| Agent rules | `docs/harness/agent-rules.md` | What every subagent must follow |
| Local checks | `scripts/check-all.js` | One command for Node, native, desktop, app (Electron shell) and GCC checks; `--changed` runs what the branch's paths need, `--all` everything |
| Manifest tests | `test/milestones.test.js` | Keeps manifests and the workflow consistent |

## Checks: local, Mac and CI

| When | Command |
|---|---|
| Before every push (agents and you) | `node scripts/check-all.js --changed` |
| Milestone exit, or when the maintainer asks | `node scripts/check-all.js --all` |
| Which steps a branch needs, without running them | `node scripts/check-all.js --changed --plan` |

The path-to-step table is in `docs/harness/agent-rules.md` ("Checks") and in `stepsForPath` in `scripts/check-all.js`.

### UI fidelity gate

The UI is ported from the mockup, component by component, and compared with it (`docs/harness/agent-rules.md`, "UI fidelity"; UI redesign spec, section 10). The component port is finished for M5's parts (`m5-ui-port-cleanup`): the app links the mockup's stylesheets and then `shell.css`, which holds only what the mockup does not draw, and `app/test/fidelity/debt.json` is empty and stays empty (`test/ui-tokens.test.js` requires it). Three layers; only the first blocks, and the other two are a report (decided by the maintainer, 2026-11-17):

| Layer | Command | Needs |
|---|---|---|
| Tokens, shared stylesheets, the manifest | `node --test test/ui-tokens.test.js test/mockup-fidelity.test.js` (part of `npm test`) | Node only |
| Geometry, computed styles, pixels | `cd app && SIANN_FIDELITY=1 SIANN_FIDELITY_OUT=<dir> npx playwright test --project fidelity` | The app built (`npm run build`), `SIANN_ENGINE_EXE`, `SIANN_CLI_EXE`, Playwright's Chromium |
| The mockup against itself, before and after | `node scripts/fidelity-mockup-compare.js [--twice] [--base <ref>] [--base-from <dir>]` | The app built (for `compareMockupMeasurements`), Playwright's Chromium; no engine, no Electron |

`node scripts/check-all.js --only app` (and `--changed` when `app/` or the mockup's directory changed) runs the second after the app's own tests and prints where the report is: `app/test-results/fidelity/report.md`, with `report.json` and per region the mockup's, the app's and the diff PNG, for `en` and `zh-TW`. CI's app job runs it on Windows and Linux and uploads the directory as the artifact `fidelity-<os>`.

- The run forces device scale factor 1 (this PC runs at 150 %; the gate does not care). It needs no network: the mockup loads the app's stylesheets and fonts from the checkout.
- **A report, never a gate** (decided by the maintainer, 2026-11-17; UI redesign 10.9). The run never fails check-all or CI: check-all prints where the report is and notes a run that did not pass, and CI's step is `continue-on-error` and uploads `fidelity-<os>`. No gate in `app/test/fidelity/manifest.json` is `enforce`: a gate is `pending` (not built, skipped) or `report` (measured), and `test/mockup-fidelity.test.js` fails on any other mode. What blocks is the first row of the table above. For review, a UI pull request attaches side-by-side screenshots of the app and the mockup for the states it changes: the run writes them per locale as `<out>/<locale>/<region>.app.png` and `<region>.mockup.png` (and `app.png` and `mockup.png` for the whole window); the maintainer reviews by eye.
- Reading the report: start with "Computed-style differences, by how many parts show them" (one line there is often one fix), then "Parts, by visual impact". A part listed as pending was skipped on purpose: it is absent in the app and its space is empty (agent-rules, "UI fidelity"). No part is unowned since 2026-11-15.
- A change that must not move anything the mockup draws (the shared stylesheets' or the mockup script's literals becoming tokens, `m5-ui-tokens-spacing`) is proven with `scripts/fidelity-mockup-compare.js`: it checks the base commit (default: the merge-base with `origin/main`) out with `git worktree add --detach`, measures the mockup there and in this checkout with the gate's own collector (`mockup-fidelity.spec.ts` under `SIANN_FIDELITY_MOCKUP_ONLY=1` and `SIANN_FIDELITY_MOCKUP_ROOT=<checkout>`), compares every part's box, computed styles, the canvas masks and the window's and each region's image with no tolerance, writes `compare.md` and `compare.json` to `<temp>/siann-fidelity-mockup/` (or `--out`, never under `app/test-results`, which Playwright empties on every run) and exits 1 on any difference. `--twice` measures the base twice first (the measurement is deterministic); `--base-from <dir>` reuses the base a previous run wrote, for quick reruns while working.
- After changing `app/renderer/tokens.css`, run `node scripts/gen-ui-tokens.js` (the mirror for canvas code). Changing the tokens, `app/renderer/ui`, the mockup or the manifest's rules needs the maintainer.
- The baseline of 2026-11-14 (before any alignment work) is in `D:\siann-ui-proposal\fidelity\baseline\` on this PC.
- Retaking the mockup's PNGs (only when the maintainer has asked for a change of the mockup): a gate run writes the mockup's own screenshot per locale, `<out>/en/mockup.png` and `<out>/zh-TW/mockup.png`, at 1440x900 and scale 1 with the bundled fonts; those two files are `mockup.png` and `mockup-zh-TW.png` (checked pixel for pixel against the committed ones on 2026-11-15). Prove what moved by measuring the mockup before and after: every part's box and styles, and the pixels that differ. The repository holds no `@2x` copies; the ones of 2026-11-15 are in `D:\siann-ui-proposal\fidelity\2026-11-15-mockup\` on this PC, with the measurements before and after and the measuring scripts.
- The device and the build in the status bar are the mockup's in a gate run only: the spec hands the manifest's `environment` to the shell (`SIANN_FIDELITY_ENVIRONMENT`, read under `SIANN_SHELL_TEST=1` alone, since `m5-ui-alignment-chrome`).

### Local caches

`check-all` sets up two caches under one root outside every worktree: `SIANN_CACHE_DIR`, by default `<drive>:\siann-cache` on the repository's drive on Windows (`D:\siann-cache` here) and `~/.cache/siann` elsewhere.

- **Compiler cache.** `native/cmake/SiannCompilerCache.cmake` uses sccache (else ccache) as the compiler launcher when it finds one: `SIANN_SCCACHE`, then `PATH`, then winget's install folder. On Windows, `winget install Mozilla.sccache`. With MSVC it switches debug info to `/Z7` (`CMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded`), as sccache cannot cache `/Zi`. `check-all` points `SCCACHE_DIR` at `<root>\sccache` with a 20 GB limit; both only take effect when the sccache server starts, so run `sccache --stop-server` once after changing them. `sccache --show-stats` shows the hit rate. `SIANN_NO_COMPILER_CACHE=1` turns the cache off at the next configure. **Non-English Visual Studio:** Ninja tracks headers through cl's localized `/showIncludes` prefix, which sccache mangles when it is not ASCII; the configure then warns and builds without sccache rather than miss header changes. Install the English language pack (Visual Studio Installer → Modify → Language packs → English); `check-all` sets `VSLANG=1033`, and a fresh build directory picks sccache up.
- **Third-party sources.** `native/cmake/SiannDependencyCache.cmake` fetches JUCE, Catch2, dr_libs, r8brain, IXWebSocket and CLAP once into `<root>\fetchcontent\<name>-<hash of the pin>`; every build tree builds its own copy from there. A lock per dependency makes concurrent configures in several worktrees safe. Delete a directory to refetch it. Plain `cmake --preset` uses the cache too when `SIANN_DEPS_CACHE_DIR` is set in the environment.
- **WSL g++.** The gcc step runs its files in parallel, and through ccache when WSL has it (`sudo apt install ccache` in WSL; nothing installs it for you).
- **Long paths.** Worktrees under `.claude\worktrees` push Git checkouts past `MAX_PATH`. The shared source cache keeps dependency checkouts on a short path, and dr_libs is fetched without its test submodule. Also run `git config --global core.longpaths true` once on Windows.

### The Windows installer

`node scripts/check-all.js --only package` builds and checks the unsigned installer on this machine, as the `package` CI job does up to the install: the `desktop-release` engine (Release, JUCE with ASIO, static MSVC runtime, in `native/build/desktop-release`) and its crash tests (`ctest --preset desktop-release -R crash`: a plugin's `abort()` still ends the static-CRT engine with exit code 3 and no dialog), `npm ci` in `app/` when its dependencies are stale, `npm run dist` (the app build, `app/scripts/collect-licenses.js`, then electron-builder), the package tests (`node --test test/package/*.test.js` with `SIANN_PACKAGE_DIR=app/release/win-unpacked`: licence texts and PE imports) and the packaged e2e (`npx playwright test --project packaged` with `SIANN_PACKAGED_EXE` set to `app/release/win-unpacked/SIANN.exe` and `SIANN_EXPECT_COMMIT` to `git rev-parse HEAD`). The installer lands in `app/release/SIANN-Setup-<version>-x64.exe`. Nothing is signed: `CSC_IDENTITY_AUTO_DISCOVERY=false`, and no certificate variable reaches electron-builder. Off Windows the step reports skipped.

To try the installer by hand: `app\release\SIANN-Setup-<version>-x64.exe /S /D=<empty directory>` installs silently for the current user, and `"<directory>\Uninstall SIANN.exe" /S` removes it. The `installer-hands-on` gate of M5b uses the CI artifact (installer and `.sha256`) on a machine with no build tools.

`npm run app` at the root starts the app from the checkout instead, on the Debug `desktop` engine (`scripts/run-app.js`; `npm run app -- --plan` prints its steps).

### Mac lane (`siann-macos`)

macOS problems show up before CI when the Mac checks the branch while Windows does. On the Mac, in parallel with the Windows `check-all`:

```sh
git fetch origin && git checkout <branch> && git pull --ff-only
node scripts/check-all.js --changed
```

Run it in the logged-in Aqua session (Screen Sharing or the Mac's own terminal, not a plain SSH session): the AU hosting tests and pluginval's AU checks need the window server and fail or skip without it. The Mac uses ccache when installed (`brew install ccache`) and `~/.cache/siann` for the shared sources.

### CI

`.github/workflows/ci.yml` starts with a `changes` job that runs `check-all --changed --plan` on the pull request's diff and gates the other jobs: docs-only pull requests run the Node job alone; `native/` changes run the native and RTSan jobs (and desktop and package for the paths above, which include `native/libs/playback`, `native/libs/graph` and `native/libs/realtime`); `app/` runs the app job and the desktop job, which holds app's editor e2e; what goes into the Windows installer (the `package` step's paths) runs the `package` job, which also uploads the installer and its SHA-256. Pushes to main, the nightly schedule and manual runs (`workflow_dispatch`) run everything. The native, RTSan, desktop and app jobs keep a compiler cache in `actions/cache` (ccache on Linux and macOS, a pinned sccache on Windows, which builds with Ninja in the MSVC environment). The `CI ok` job passes when every job passed or was skipped for its paths: it is the check to require for merging, as skipped matrix jobs never report their per-OS names.

### Nightly quality jobs

`.github/workflows/nightly.yml` runs on a schedule and by hand (`gh workflow run nightly.yml --ref <branch>`), never on pull requests, and none of its jobs is in `CI ok`. `long-tests.yml` runs the `[long]` tests on ubuntu, windows and macos the same way. Each job locally (Linux or WSL with Clang 20 from apt.llvm.org for the native ones; the app ones need `npm run build` in `app/` and `SIANN_ENGINE_EXE`, `SIANN_CLI_EXE` as for the other e2e specs):

```sh
# tour, per locale (en | zh-Hant | zh-Hans): PNGs and index.json in the directory
cd app && SIANN_UX_TOUR=1 SIANN_UX_LOCALE=zh-Hant SIANN_UX_OUT=/tmp/tour-zh-Hant npx playwright test ux-tour
# fidelity gate
cd app && SIANN_FIDELITY=1 SIANN_FIDELITY_OUT=/tmp/fidelity npx playwright test --project fidelity
# performance scenario (report only): perf-report.json in the directory
cd app && SIANN_PERF=1 SIANN_PERF_OUT=/tmp/perf npx playwright test perf
# ASAN + UBSAN over the whole ctest suite
cmake -S native -B native/build/asan -G Ninja -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_COMPILER=clang++-20 -DSIANN_ASAN_UBSAN=ON
cmake --build native/build/asan && ASAN_OPTIONS=halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 ctest --test-dir native/build/asan --output-on-failure
# libFuzzer targets (siann_fuzz_protocol_ws, siann_fuzz_mcp_http, siann_fuzz_command_json)
cmake -S native -B native/build/fuzz -G Ninja -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_COMPILER=clang++-20 -DSIANN_FUZZ=ON -DSIANN_BUILD_TESTS=OFF
cmake --build native/build/fuzz && native/build/fuzz/fuzz/siann_fuzz_command_json -max_total_time=60 native/fuzz/corpus/command_json
# native coverage: HTML in native/build/coverage/html
cmake -S native -B native/build/coverage -G Ninja -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_COMPILER=clang++-20 -DSIANN_COVERAGE=ON
cmake --build native/build/coverage && LLVM_PROFILE_FILE="$PWD/native/build/coverage/prof/%p.profraw" ctest --test-dir native/build/coverage
```

A fuzz finding is fixed with its input added to `native/fuzz/corpus/<target>/` (the smoke test then replays it on every OS), or filed as an issue when the fix is large. A sanitizer suppression goes in `native/sanitizers/` with its reason in a comment on the line above it.

## Recommended order

M2 → M3 → M0 → M4 → M5 → M5b → M6a → M6b → M6c → M7. M0 waits for the M3 protocol server because the renderer connects through it; M6a–M6c can be reordered among themselves, but M6b and M6c need M5b (it holds the recording path, monitoring, punch, buses and sends they build on). M5b needs M5's `m5-ui-*` features merged, not M5's exit.

## Before each run

1. `git checkout main && git pull`, working tree clean.
2. The latest CI run on main is green (preflight waits for it; a local `node scripts/check-all.js --all` is optional).
3. In Claude Code `/config`, raise **Dynamic workflow size** (a milestone uses roughly 5 to 8 agents per feature; M2 with 7 features needs about 50).
4. Read the manifest's `humanGates` and `prerequisites`; settle what you can up front.

## Run everything

`/siann-all` runs every remaining milestone in order and stops only at human gates, failures it cannot fix, or anything touching secrets. `/siann-all M3` starts at M3; `/siann-all --only M2,M3` runs just those. The steps are in `.claude/commands/siann-all.md`.

## Run one milestone

Type in Claude Code:

```
用 siann-milestone workflow 跑 M2
```

Options (pass as workflow args):

- `features: ["m2-transport"]` — only these features (no exit check).
- `maxRounds: 3` — more fix rounds per feature (default 2).
- `land: false` — verify but do not open PRs; branches stay local.

Progress: `/workflows`. Each feature lands as its own PR, merged only after CI is green on Windows, macOS and Linux.

## When it stops

| Stop | Meaning | What you do |
|---|---|---|
| `preflight` | main is red, dirty tree or prerequisite missing | Fix or tell Claude to fix, rerun |
| `plan` / `needsHuman` | Fable found a decision that is yours | Answer the question; Claude updates the manifest or spec; rerun |
| feature `failed` | findings left after the fix rounds, or CI red twice | Read the reason and branch; rerun with `features: [id]` after deciding |
| feature `skipped` | a dependency failed | Rerun after the dependency lands |
| exit `needs_human` | hardware, long run or judgement | Do the check, report back, Claude records evidence |

## After each run

1. Read the summary: merged PRs, failed features, exit criteria.
2. Do the human gates (devices, long runs, macOS hands-on, accounts). Since M4,
   validate the installed third-party plugins with pluginval at strictness 5:
   `SIANN_PLUGINVAL=<pluginval v1.0.4> node scripts/pluginval.js --compat`, with
   one variable per plugin (`SIANN_PLUGIN_TDR_NOVA`, `SIANN_PLUGIN_SLICKEQ`,
   `SIANN_PLUGIN_SURGE_XT_VST3`, and when authorised `SIANN_PLUGIN_SD3`,
   `SIANN_PLUGIN_UAD_1176`, `SIANN_PLUGIN_HALION_SONIC`; on macOS
   `SIANN_PLUGIN_TDR_NOVA_AU`, `SIANN_PLUGIN_SURGE_XT_AU`). An unset variable is a
   `SKIP`; a missing path or a pluginval failure is a `FAIL` (exit 1). See
   `native/README.md`, "pluginval".
3. Ask Claude to record the results; the manifest status becomes `done` when every exit criterion is met.
4. Start the next milestone.

## Human gates by milestone

| Milestone | Gates |
|---|---|
| M2 | Exit runs on your audio interface (xrun bench at 256 samples). The 10-minute record + kill runs on the fake device in the `long-tests` workflow (`siann_cli_tests "[long]"`, scheduled or `workflow_dispatch`); trigger it once after merge and check it is green |
| M3 | — |
| M0 | Apple Developer ID and notarization key (asked before storing secrets), macOS hands-on (since M4 the editor opens through the protocol: `command.execute` `track.add`, `plugin.instantiate`, then `plugin.open_editor`; the engine's `--open-editor` flag and the shell's `SIANN_OPEN_EDITOR` are gone), choice of test plugins |
| M4 | Choice of third-party plugins; exit: `node scripts/pluginval.js --compat` passed on Windows and, for TDR Nova, on the Mac on 2026-11-11; still owed: the Mac's Surge XT entries (install Surge XT VST3 + AU there, then rerun `--compat` in the Aqua session); on macOS run AU tests in the logged-in Aqua session |
| M5 | `SIANN_TEST_CLAP` beside `SIANN_TEST_VST3` and `SIANN_TEST_AU`: set it to Surge XT's `.clap` for the engine's `[thirdparty]` CLAP editor case (it SKIPs naming the variable when unset); React or Svelte (before `m5-read-model`; the wave 1 hardening features `m5-plugin-registry`, `m5-shell-hardening` and `m5-engine-sessions-devices` run first as a subset without it), UX review |
| M5b | Exit only, none blocks the build: the unsigned installer on a clean Windows machine (`installer-hands-on`); `npm run app` and the walkthrough on the Mac through `siann-macos` (`macos-run`); recording on a real interface (`audio-hardware`); screenshot reviews in three locales after phase 2, after phase 3 and at the end (`phase2-tour-review`, `phase3-tour-review`, `final-tour-review`); the added Chinese terms (`zh-glossary-m5b`). No signing certificate or secret is involved |
| M6b | One-hour 16-track recording run |
| M6c | Reference machines for the 64-track criterion |
| M7 | Raspberry Pi class board |
