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

### Local caches

`check-all` sets up two caches under one root outside every worktree: `SIANN_CACHE_DIR`, by default `<drive>:\siann-cache` on the repository's drive on Windows (`D:\siann-cache` here) and `~/.cache/siann` elsewhere.

- **Compiler cache.** `native/cmake/SiannCompilerCache.cmake` uses sccache (else ccache) as the compiler launcher when it finds one: `SIANN_SCCACHE`, then `PATH`, then winget's install folder. On Windows, `winget install Mozilla.sccache`. With MSVC it switches debug info to `/Z7` (`CMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded`), as sccache cannot cache `/Zi`. `check-all` points `SCCACHE_DIR` at `<root>\sccache` with a 20 GB limit; both only take effect when the sccache server starts, so run `sccache --stop-server` once after changing them. `sccache --show-stats` shows the hit rate. `SIANN_NO_COMPILER_CACHE=1` turns the cache off at the next configure. **Non-English Visual Studio:** Ninja tracks headers through cl's localized `/showIncludes` prefix, which sccache mangles when it is not ASCII; the configure then warns and builds without sccache rather than miss header changes. Install the English language pack (Visual Studio Installer → Modify → Language packs → English); `check-all` sets `VSLANG=1033`, and a fresh build directory picks sccache up.
- **Third-party sources.** `native/cmake/SiannDependencyCache.cmake` fetches JUCE, Catch2, dr_libs, r8brain, IXWebSocket and CLAP once into `<root>\fetchcontent\<name>-<hash of the pin>`; every build tree builds its own copy from there. A lock per dependency makes concurrent configures in several worktrees safe. Delete a directory to refetch it. Plain `cmake --preset` uses the cache too when `SIANN_DEPS_CACHE_DIR` is set in the environment.
- **WSL g++.** The gcc step runs its files in parallel, and through ccache when WSL has it (`sudo apt install ccache` in WSL; nothing installs it for you).
- **Long paths.** Worktrees under `.claude\worktrees` push Git checkouts past `MAX_PATH`. The shared source cache keeps dependency checkouts on a short path, and dr_libs is fetched without its test submodule. Also run `git config --global core.longpaths true` once on Windows.

### Mac lane (`siann-macos`)

macOS problems show up before CI when the Mac checks the branch while Windows does. On the Mac, in parallel with the Windows `check-all`:

```sh
git fetch origin && git checkout <branch> && git pull --ff-only
node scripts/check-all.js --changed
```

Run it in the logged-in Aqua session (Screen Sharing or the Mac's own terminal, not a plain SSH session): the AU hosting tests and pluginval's AU checks need the window server and fail or skip without it. The Mac uses ccache when installed (`brew install ccache`) and `~/.cache/siann` for the shared sources.

### CI

`.github/workflows/ci.yml` starts with a `changes` job that runs `check-all --changed --plan` on the pull request's diff and gates the other jobs: docs-only pull requests run the Node job alone; `native/` changes run the native and RTSan jobs (and desktop for the paths above); `app/` runs the app job and the desktop job, which holds app's editor e2e. Pushes to main, the nightly schedule and manual runs (`workflow_dispatch`) run everything. The native, RTSan, desktop and app jobs keep a compiler cache in `actions/cache` (ccache on Linux and macOS, a pinned sccache on Windows, which builds with Ninja in the MSVC environment). The `CI ok` job passes when every job passed or was skipped for its paths: it is the check to require for merging, as skipped matrix jobs never report their per-OS names.

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
