# Test matrix: feature x layer x platform

Audit of 2026-11-14 against `main` at `3759656`. Covers every feature in
`.claude/milestones/*.json` (done and pending), the architecture spec's test
layers ("Build, test and CI"), the UI redesign spec
(`docs/superpowers/specs/2026-11-13-siann-ui-redesign.md`) and the Node bridge
(`bin/siann.js`, `src/`). It is the reference the milestone workflow's verifier
checks a feature against (rules at the end, and `agent-rules.md`, "Test matrix").

Update this file in the same branch as the feature: add or fix its row, move a
closed gap out of the gap list.

**Where the gaps went.** The gaps of section 6 (and the proposals of sections 5
and 7) are harness features in `.claude/milestones/M5b.json`; each closes its
gaps here when it lands.

| Gap (section 6) | Feature | Wave |
|---|---|---|
| 0 stale nested CMake cache (section 7) | fixed in #103 | |
| 1 m5-ui-edit-basics, loop-click untested (m5-ui-transport closed its 8) | the M5 features themselves (in flight) | |
| 2 method/tool/doc/fixture parity | `m5b-protocol-parity` | 2 |
| 3 bridge targets the Ardour engine, gated tests dead | `m5b-bridge-native-client` | 2 |
| 4 tour states only in the manual tour | `m5b-nightly-quality` | 3 |
| 5 rollback never deletes media or renders | `m5b-bridge-cli-coverage` | 3 |
| 6 no ASAN/UBSAN, no fuzzing | `m5b-nightly-quality` | 3 |
| 7 desktop job skipped on core-library PRs | `m5b-nightly-quality` | 3 |
| 8 macOS-specific behaviour manual only | not taken: needs the macOS bundle (M0 `m0-macos-bundle`, apple-signing gate) | |
| 9 UI spec 5.6 performance budgets | `m5b-nightly-quality` | 3 |
| 10 bridge CLI holes (`reject-plan`, `validate-journal`, `--run`) | `m5b-bridge-cli-coverage` | 3 |
| 11 `read-model-sequence.json` not checked against the engine | not taken: stays an M5 follow-up | |
| 12 long tests not on macOS | `m5b-nightly-quality` | 3 |
| 13 M4 ordering / link assertions | not taken: stays an M4 follow-up | |
| native coverage (section 5), app unit coverage (section 7 item 7) | `m5b-nightly-quality` | 3 |

## 1. Layers and where they run

| Code | Layer | Where | Runs in CI on | When |
|---|---|---|---|---|
| **N** | Native Catch2, core-only build (`native/**/tests`, ctest) | `native` job | ubuntu, windows, macos | PR when `native/` changes; every push to main; nightly |
| **R** | Native suite under Clang 20 RealtimeSanitizer (`-DSIANN_RTSAN=ON`, `halt_on_error=1`) + `[src]` | `rtsan` job | ubuntu only | as N |
| **D** | Native suite with JUCE (`-DSIANN_WITH_JUCE=ON`: `siann_host_desktop_tests`, the JUCE half of `engine_launch_test`, `cli_realtime_test [juce]`) | `desktop` job | ubuntu (xvfb + openbox), windows, macos | PR when `native/libs/host_*`, `apps/engine`, CMake or `app/` change; push to main; nightly |
| **P** | pluginval strictness 5 on `siann_test_plugin` (VST3; AU on macOS) | `desktop` job | VST3: all three; AU: macos | as D |
| **U** | Electron unit tests (`app/test/unit`, `node --test` on `dist/`) | `app` job | ubuntu, windows, macos | PR when `app/` changes; push to main; nightly |
| **E** | Playwright Electron e2e (`app/test/e2e`) against the core-only `siann-engine` on the fake device | `app` job | ubuntu (xvfb, 150 % scale), windows, macos | as U |
| **Ew** | `editor.spec.ts` against the JUCE engine (editor owned by the Electron window) | `desktop` job | windows only | as D |
| **F** | Mockup fidelity gate (`docs/harness/agent-rules.md`, "UI fidelity"). Tokens and the manifest: `test/ui-tokens.test.js`, `test/mockup-fidelity.test.js` (in B). Geometry within 1 px, identical computed styles and chrome pixels per region: `app/test/e2e/mockup-fidelity.spec.ts`, the mockup in Chromium against the app in Electron at 1440x900 and device scale factor 1, en and zh-TW | `node` job (tokens, manifest); `app` job (the spec, `SIANN_FIDELITY=1`) | tokens: ubuntu, windows, macos; the spec: ubuntu (xvfb), windows; not macos | tokens: every PR. The spec: PR when `app/` or the mockup's directory changes; push to main; nightly. **Report-only** (`continue-on-error`, report uploaded as `fidelity-<os>`) until `m5-ui-mockup-alignment` lands; failing from then on |
| **B** | Node bridge, scripts and fixture tests (`test/*.js`, `npm test`) | `node` job | ubuntu, windows, macos (**since this PR**; ubuntu only before) | every PR |
| **L** | `[.][long]` Catch2 tests (`siann_cli_tests "[long]"`) | `long-tests.yml` | ubuntu, windows | nightly + manual; never on PRs |
| **G** | Engine-gated Node tests (`SIANN_RUN_ENGINE_TESTS=1`) | none | never | see 3.3 |
| **M** | Manual / env-gated (`SIANN_TEST_VST3`, `SIANN_TEST_AU`, `SIANN_TEST_CLAP`, `[hardware]`, `pluginval --compat`, `SIANN_UX_TOUR=1`, human gates) | maintainer's machines | never | see 3.2 |

Sizes at the audit: ~1,000 native `TEST_CASE`s (protocol 174, apps/engine 93,
realtime 87, command 82, playback 71, host_desktop 56, session 56, host_clap 55,
cli 35, media 32, graph 30, ...), 399 app unit tests, ~67 Playwright tests in 16
specs, 231 Node tests (2 skipped).

## 2. Feature matrix

Legend: **Y** = layer covers the feature's acceptance, **p** = partial (some
criteria, or one platform), **-** = no tests on that layer, blank = layer not
relevant. "Gaps" lists acceptance items (by number) with no automated test.
Platform column: which OSes the automated tests actually execute on in CI.

### M0 Spike

| Feature | N | R | D | P | U | E | B | M | Platforms | Gaps |
|---|---|---|---|---|---|---|---|---|---|---|
| m0-electron-shell | p | | | | Y | Y | p | | all 3 | - |
| m0-plugin-hosting | Y | p | Y | Y | | Ew | | VST3/AU | 3; editor ownership Windows only; AU macOS only | 3 ("macOS editors float": no test) |
| m0-macos-bundle (open) | - | | - | | | - | | | - | 1, 2: not built, no test, no signing job |

### M2 Realtime engine

| Feature | N | R | D | L | B | Platforms | Gaps |
|---|---|---|---|---|---|---|---|
| m2-playback-engine | Y (`playback_test`) | Y | | | | 3 + RTSan | - |
| m2-live-recompile | Y (`live_recompile_test`, `streaming_test`) | Y | | | | 3 + RTSan | - |
| m2-transport | Y (`transport_test`) | Y | | | | 3 + RTSan | - |
| m2-meters | Y (`meters_test`, `playback_test`) | Y | | | | 3 + RTSan | - |
| m2-device-src | Y (`src_test`, `recording_test`) | Y (`[src]`) | p (JUCE reopen; `[hardware]` SKIPs on runners) | | | 3 + RTSan | real-device half only on the maintainer's bench |
| m2-realtime-pdc | Y (`pdc_realtime_test`) | Y | | | | 3 + RTSan | - |
| m2-cli-realtime | Y (`cli_realtime_test`, `cli_kill_test`) | Y | p (`devices`) | | | 3 | - |
| m2-long-record | ctest guard only | | | Y | Y (`ci-long-tests`) | L: ubuntu, windows (no macOS) | 3 ("20 consecutive runs": manual) |
| m2-rtsan-ci | `[rtsan]` canaries | Y | | | Y (CI-structure) | Linux only (Apple Clang has no RTSan) | 1, 3: CI-structure/doc tests only, by design |

### M3 Agent access

| Feature | N | R | U | E | B | Platforms | Gaps |
|---|---|---|---|---|---|---|---|
| m3-protocol-server | Y (`protocol_server_test`, `ix_transport_test`) | Y | | | | 3 | 2: no test names the app scheme in the allow list |
| m3-events-sync | Y (`event_stream_test`, `sync_test`, `realtime_channel_test`, `build_info_test`) | Y | Y | Y | | 3 | - |
| m3-plans | Y (`plan_test`, `plan_methods_test`, `plan_hash_test`) | Y | p | p | Y (`plan-hash.test.js`) | 3 | - |
| m3-rollback | Y (`history_test`, `plan_methods_test`) | Y | - | - | | 3 | **2: "media and renders never deleted by rollback": no test** |
| m3-audition | Y (`history_test`, `audition_test`, `audition_methods_test`) | Y | p | p | | 3 | - |
| m3-mcp | Y (`mcp_adapter_test`, `mcp_e2e_test`) | Y | | | | 3 | no exhaustive method/tool parity test (see 4) |

### M4 Plugins

| Feature | N | R | D | P | E | M | Platforms | Gaps |
|---|---|---|---|---|---|---|---|---|
| m4-clap-host | Y (`clap_plugin_host_test`, 40 cases) | Y | p | | | | 3 | - |
| m4-engine-device | Y (`engine_host_test`, `engine_launch_test`, `transport_methods_test`) | Y | p | | p (`shell.spec`) | | 3 | 3: the alloc-guard link is CMake only, not asserted |
| m4-plugin-node | Y | Y | Y (4, 5, 9) | | p | | 3 | 8 is a ctest grep guard (`siann_no_locks_on_plugin_path`) |
| m4-hostile-plugin | Y (`hostile_plugin_test`) | Y | | | | | 3 | - |
| m4-juce-formats | p | | Y | Y | | compat set, audit | 3; AU macOS | 1 (compat set), 2 (the processBlock audit itself): manual |
| m4-crash-recovery | Y | | p (VST3 set_parameter) | | Y (`crash.spec`) | 3rd-party restart (`SIANN_TEST_VST3`) | 3; crash-dialog check Windows only | 3: nothing proves `main()` calls `disableCrashDialogs` before the first plugin load |

### M5 Desktop UI v1

| Feature | N | D | U | E | M (tour) | Platforms | Gaps |
|---|---|---|---|---|---|---|---|
| m5-plugin-registry | Y | Y | p | p | | 3 | - |
| m5-shell-hardening | p | | Y (`supervisor*.test`) | Y (`hardening`, `wedged-quit`) | | 3 | 7: convention, no guard; 6: the blocked-navigation case of `will-navigate` not confirmed |
| m5-engine-sessions-devices | Y | | | | | 3 | 1, 2: docs (Protocol v0 item 22, `protocol-mcp-v0.md` tool list) untested |
| m5-read-model | | | Y | Y | | 3 | - |
| m5-clap-editor-window | Y | Y | | Ew | Surge XT, macOS gate | Windows (ownership); macOS manual | 3: macOS float/level: manual only |
| m5-timeline | | | Y | Y (`timeline.spec`) | | 3 | - |
| m5-mixer | Y | | Y | Y | | 3 | - |
| m5-plan-review | Y | | Y | Y | | 3 | the diff view has no e2e |
| m5-ui-i18n | | | Y | Y (`i18n`, `i18n-fit`) | 8 | 3; first-launch language test skipped on macOS | 1: no negative test that `tsc` rejects a missing key; 8: tour only |
| m5-ui-engine-loop-click | Y (`cycle_test`, `click_test`, `locators_*`, `transport_methods_test`) | | p (read-model) | - | | 3 | - (engine side complete) |
| m5-ui-shell | | | Y | Y (`shell-layout`, `plain-tab`) | 10 | 3 | 7: both licence strings rendered: not confirmed; 10: tour only |
| m5-ui-connection | | | Y | Y (`connection.spec`) | 3 | 3 | 3: tour only |
| m5-ui-arrange | | | Y | Y (`arrange.spec`) | 10 | 3 (Linux at 150 % DPR) | 10: tour only |
| m5-ui-mixer | | | Y | Y (`mixer.spec`) | 8 | 3 | 3: "every value control" proven for fader and pan only; 8: tour only |
| m5-ui-plan-panel | | | Y | Y (`plan-review.spec`) | 8 | 3 | 8: tour only |
| m5-ui-transport | | | Y (`key-preset`, `key-dispatcher`, `transport-time`, `playhead-clock`, `auto-scroll`, `timeline-layers`, `undo-redo`, `transport-controls`, `layout`, `i18n-describe`) | Y (`transport.spec`, `i18n-fit`) | 8 | 3 | 8: tour only (state 04 and the top bar in every state); 1, 6: macOS Cmd+Z next to the Edit menu's accelerator is proven by the CI macOS e2e only |
| m5-ui-edit-basics (open) | - | | - | - | | - | 1-9: not on main |
| m5-ui-loop-click (open) | - | | - | - | | - | 1-8: not on main |
| m5-ui-mockup-alignment (open) | | | - | - (F: report-only baseline, 0 of 282 parts match) | every state | - | 1-8: not on main. Its acceptance is the F layer for every part the M5 features build (`app/test/fidelity/manifest.json`), in en and zh-TW, and an empty `app/test/fidelity/debt.json` |

### M5b, M6a, M6b, M6c, M7 (not started)

No code, so no tests. What matters now is whether each acceptance item says how
it will be tested. Share of acceptance items that name a test (unit, e2e,
ctest, ...): M5b 59/141 (the nine UI features that own mockup parts each gained a fidelity-gate item, layer F; the four test-gap features appended later are not in this count), M6a 1/3, M6b 0/3, M6c 2/3, M7 1/3. Weakest in M5b:
`m5b-engine-markers` 0/4, `m5b-engine-punch-count-in` 0/5,
`m5b-engine-clip-fades` 1/4, `m5b-engine-master` 1/4,
`m5b-engine-buses-sends` 1/5, `m5b-engine-record` 3/9, `m5b-ui-edit-more` 3/10.
The plan phase should add the test layer to those items before the build
agent starts (rule 1 below). M6b's one-hour 16-track criterion and M7's arm64
board run cannot run on hosted runners and need a named owner (rule 6).

### Node bridge (`bin/siann.js`)

| Subcommand / module | Tests (`test/`) | Line % | Gaps |
|---|---|---|---|
| `run <cmd> --runner`, `--help` | `bridge-cli` (fake runner) | `bin/siann.js` 74 % / branch 37 % | |
| `plan intake` | `intake-plan`, `skill-docs` | `intake-plan.js` 94 % | |
| `workflow import-pack` | `import-pack-workflow`, `import-pack-plan` | `import-pack-plan.js` 81 % | `--run` untested |
| `workflow validate-plan`, `approve-plan`, `apply-plan` | `import-pack-plan` (one CLI test) | | `--run` untested |
| `workflow reject-plan` | **none** | | CLI and `rejectImportPackPlan` untested |
| `rollback` | `rollback-workflow` | `rollback.js` 87 % / branch 50 % | `--run` untested |
| `export dawproject` | `dawproject-export`, `smoke-dawproject` | `dawproject.js` 95 % | |
| `live import-pack` | `live-import-pack` (fake runtime) | `live-import-pack.js` 93 % / branch 37 % | real run: G only |
| `validate-journal` | `validateJournal` unit in `bridge-runner` | | CLI untested |
| JCS / Merkle / plan hash | `jcs`, `merkle`, `plan-hash`, `fixture-parity` | 100 / 98 / 94 % | |
| runtime client | `runtime-client` (fake), `runtime-engine` (G) | `client.js` 84 % / branch 57 % | |

There is **no MCP server in Node**: MCP is served by the native engine
(`native/libs/protocol/src/mcp_adapter.cpp`, `POST /v0/mcp`). And the Node
bridge has **no client for the native protocol**: `src/runtime/client.js` and
`src/bridge/runner.js` speak the legacy Ardour runtime
(`ardour9-siann_runtime`, `ardour9-siann_command`).

## 3. Platforms and what never runs

### 3.1 Platform-gated tests

- **Windows only**: editor ownership through `GWLP_HWNDPARENT` (JUCE and CLAP:
  `juce_plugin_host_test`, `engine_launch_test`, `editor.spec.ts` in the desktop
  job); `disableCrashDialogs` (elsewhere `SUCCEED()`).
- **macOS only**: AU hosting (`juce_plugin_host_mac_test.mm`, pluginval on the
  `.component`), "the engine activates itself while an editor is open", AU sysex.
  `i18n.spec.ts`'s `navigator.languages` test is **skipped** on macOS.
- **Linux only**: RTSan (the whole suite). Display-dependent JUCE tests run under
  xvfb + openbox; e2e runs at 1.5 device pixel ratio there only.
- **Not covered on macOS**: the `long-tests` workflow (ubuntu, windows).
- **Never**: Linux arm64 (spec CI matrix lists it; M7), macOS universal binary,
  ASAN/TSAN/UBSAN builds (spec "Realtime safety" layer), fuzzing (spec "Fuzz").

### 3.2 Env-gated and manual tests (never in CI)

| Test | Gate | Who runs it, when |
|---|---|---|
| `juce_plugin_host_test` "the maintainer's VST3 ...", `engine_launch_test` third-party VST3 crash/restart | `SIANN_TEST_VST3` | maintainer, at M0/M4 exits and before a JUCE pin move |
| "the maintainer's AU ..." | `SIANN_TEST_AU` (macOS) | maintainer on the Mac, at M0/M4 exits |
| "the maintainer's CLAP opens its editor" (Surge XT) | `SIANN_TEST_CLAP` | maintainer, at M5 exit |
| `juce_device_test` `[hardware]` cases | an output device (SKIP on runners) | maintainer's bench, M2 exit |
| `node scripts/pluginval.js --compat` | one env var per plugin in `scripts/compat-plugins.json` | maintainer, M4 exit, before a JUCE pin move |
| `ux-tour.spec.ts` (every "Tour states changed" criterion) | `SIANN_UX_TOUR=1` (and `testIgnore`) | the feature's build agent attaches the states; the maintainer reviews at the `ux-review` gate |
| `mockup-fidelity.spec.ts` (F) | `SIANN_FIDELITY=1` (and its own Playwright project, `fidelity`) | **In CI** on ubuntu and windows (the `app` job sets the variable), so this is a gate, not a manual test; listed here because the plain `npm test` of `app/` skips it. Locally: `node scripts/check-all.js --only app`, or the command in the runbook. macOS does not run it: the reference rendering is compared on two OSes and the Mac lane would add font rasterisation without adding a layout engine |
| `test/runtime-engine.test.js`, `test/live-import-pack.test.js` (engine case) | `SIANN_RUN_ENGINE_TESTS=1` + the legacy Ardour checkout | nobody: the Ardour engine is superseded (architecture spec, "Documents made stale"). Port or delete (gap 3) |
| `[.][hostile-crash-child]` | hidden helper | run by its parent test; fine |
| M2 device bench, M0 macOS bundle signing, M4 JUCE `processBlock` audit, DAWproject into Cubase (L4) | human gates | maintainer, per milestone exit / release |

### 3.3 Path gating in pull requests

A pull request runs only the jobs its paths need (`stepsForPath` in
`scripts/check-all.js`). Consequences: a change in `native/libs/playback`
runs N and R but **not D** (the JUCE build), so JUCE-only regressions there
surface only on the push to main or the nightly run; a change in `native/`
never runs the app e2e against the new engine until main. The nightly
schedule (18:30 UTC) runs everything.

## 4. Parity: protocol method x MCP tool x clients

The engine serves 44 methods (`kMethods`, `protocol_server.cpp`); 26 are MCP
tools (`mcp_adapter.cpp`). Every method has a native test. Gaps:

- No test compares `kMethods` with the MCP tool table: 18 methods have no tool
  and only `plugin.registry`/`plugin.approve` and `plan.list`/`plan.preview` are
  asserted as deliberate exclusions; `session.sync`, `session.fetch`,
  `session.undo`, `session.redo`, `engine.about`, the other `plugin.*` and the
  `gesture.*` methods are excluded by nobody's decision on record.
- No test compares `engine.capabilities.methods` with `docs/schemas/protocol-*.md`
  (`plan.list` and `plan.preview` are in no protocol doc) or with the app's
  `app/test/unit/fixtures/capabilities-full.json` (missing `transport.set_cycle`,
  `transport.set_click`).
- MCP tools tested only in the adapter test, not end to end: `execute`,
  `list_commands`, `reject_plan`, `discard_proposal`, transport and device tools.
- App: `plan.submit`, `plan.rollback`, `render.start`, `job.status`,
  `transport.set_cycle`/`set_click`, devices, plugins have no app client yet
  (expected until m5-ui-loop-click, M5b). `transport.play`/`stop`/`locate`
  and `session.undo`/`redo` have one since m5-ui-transport
  (`model/transport.ts`, `undo-redo.test`).
- Shared fixtures used by all three languages: `jcs`, `hash`, `peaks`,
  `meter-frames`. `plan/plan-hash.json` has no app test (the app hashes plans
  for display); `protocol/read-model-sequence.json` is generated in Node and
  consumed by the app but **never checked against the native engine's output**;
  `time/*.json` has no app test though `musical-time.ts` converts positions.

## 5. Coverage measured

Taken on Windows, Node 22, 2026-11-14.

| Area | How | Lines | Branches | Functions | Least covered |
|---|---|---|---|---|---|
| Node bridge (`src/`, `bin/`) | `node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' test/*.test.js` | 89.2 % | 70.9 % | 96.0 % | `bin/siann.js` 74/37, `import-pack-plan.js` 81/72, `client.js` 84/57, `rollback.js` 87/50, `live-import-pack.js` 93/37 (branch), `import-pack.js` 94/62 (branch) |
| Node, incl. `scripts/` | same, no include filter | 86.5 % | 78.0 % | 91.2 % | `scripts/check-all.js` 53 % (the build steps), `create-daw-manifest.js` 73 % |
| App, unit tests only | `npm run build` then `node --test --experimental-test-coverage --test-coverage-exclude='dist/test/**' dist/test/unit/*.test.js` | 89.7 % of loaded files | 88.2 % | 79.7 % | `PlanPanel` 33 %, `TrackListDivider` 32 %, `ValueControl` 37 %, `Mixer` 42 %, `TrackList` 49 %, `Timeline` 51 %, `StepList` 72 %, `plans/diff` 79 %, `keys/commands` 80 %. Never loaded by a unit test: `main.ts`, `preload.ts`, `App.tsx`, `Shell.tsx`, `TopBar.tsx`, `index.tsx` (covered by e2e only) |
| App e2e | not measured | | | | proposal: `NODE_V8_COVERAGE` for the main process and Playwright's `page.coverage` (Chromium) for the renderer, merged with c8-style tooling in the app job |
| Native | not measured (heavy) | | | | proposal: a nightly ubuntu job, Clang `-fprofile-instr-generate -fcoverage-mapping`, ctest with `LLVM_PROFILE_FILE=%p.profraw`, `llvm-profdata merge`, `llvm-cov report --ignore-filename-regex='(_deps|tests)/'`; or GCC `--coverage` + gcovr. Report only, no threshold at first |

The low React-component numbers are expected: those components are exercised by
Playwright, which is not measured. The low `bin/siann.js` branch figure is the
error paths of each subcommand (usage errors, `--run`).

## 6. Gaps ranked by risk

| # | Gap | Risk | Proposed test | Owner |
|---|---|---|---|---|
| 1 | m5-ui-edit-basics, m5-ui-loop-click: 17 acceptance items, no tests on main (m5-ui-transport's 8 are covered, section 2) | High: M5 exit depends on them | per the manifests: unit (position display, snap maths, split builder) + e2e per operation (one revision, one undo) + capability-gated e2e | the features themselves (in flight) |
| 2 | No method/tool/doc/fixture parity test (section 4) | High: an agent-facing method can ship without an MCP tool, doc or app capability entry, silently | native test: every `kMethods` entry is an MCP tool or in an explicit `kNotMcp` list with a reason; Node test: every method in a protocol doc table and the reverse (read `kMethods` from source); app unit: `capabilities-full.json` equals `kMethods` | `m5b-protocol-parity` (M5b wave 2) |
| 3 | Node bridge's live path targets the superseded Ardour engine; `SIANN_RUN_ENGINE_TESTS` tests never run | High for AI-facing story: the bridge cannot drive the native engine, and its only integration tests are dead | port `src/runtime/client.js` to the native protocol (WebSocket + token, or MCP over HTTP), then a CI job that runs the Node integration tests against the core-only `siann-engine` built in the `app` job; meanwhile mark the two tests as legacy | `m5b-bridge-native-client` (M5b wave 2) |
| 4 | "Tour states changed" criteria (7 features) only in the manual tour | Medium: layout regressions are visible only to a human | run `ux-tour.spec.ts` in a nightly job on one OS with `SIANN_UX_TOUR=1` and upload the screenshots as an artifact; later pixel-diff against committed baselines (the `test/mockup-fidelity` work) | M5 `ux-review` gate |
| 5 | m3-rollback 2: media/renders never deleted by rollback | Medium: data loss | native: render a file, roll back the plan, assert the file and the media entry's blob remain | M3 follow-up |
| 6 | No ASAN/UBSAN/TSAN, no fuzzing (spec test layers) | Medium: protocol server parses untrusted JSON and WAV headers | nightly ubuntu Clang job with `-fsanitize=address,undefined` over ctest; a libFuzzer target for protocol messages, command JSON and the WAV reader | M5b infra / M7 |
| 7 | Desktop (JUCE) job skipped on PRs that change core libs | Medium: JUCE-only breakage lands on main | add `native/libs/playback`, `graph`, `realtime` to `DESKTOP_PATHS`, or rely on the nightly and track red nightlies | infra |
| 8 | macOS-specific behaviour manual only (editor float/level, `m0-macos-bundle`, AU third-party) | Medium | an XCTest-free check in the desktop job: window level of an open editor via `CGWindowListCopyWindowInfo`; bundle `Info.plist` assertions once m0-macos-bundle is built | M0 / M5 exit |
| 9 | Performance budgets of UI spec 5.6 (64 tracks, frame time, memory, cold start) have no scenario | Medium for M5b/M6c | Playwright perf scenario reading `performance.measure` marks; nightly, report-only first | UI phase 4 / M6c |
| 10 | Bridge CLI holes: `workflow reject-plan`, `validate-journal` CLI, every `--run` flag | Low-medium | CLI tests with the fake runner (as `bridge-cli.test.js` does) | Node bridge, next bridge change |
| 11 | `read-model-sequence.json` never checked against the engine | Low-medium | native test that replays the sequence's commands and compares the emitted events | M5 follow-up |
| 12 | Long tests not on macOS | Low | add macos-latest to `long-tests.yml` | infra |
| 13 | m4-crash-recovery 3, m4-engine-device 3: ordering / link not asserted | Low | ctest: `siann-engine --print-error-mode` (test-only flag) before any plugin; CMake check that `siann_engine_*_tests` link `siann_rt_alloc_guard` | M4 follow-up |

## 7. CI changes

Done in this PR:

- The `node` job runs `npm test` on ubuntu, windows and macos (`fail-fast: false`),
  pinned by `test/ci-workflow.test.js` "the Node job runs npm test on Windows,
  macOS and Linux".
- Its first run found a real bug that the ubuntu-only job hid:
  `test/stale-build-cache.test.js` "stale nested caches of a moved dependency
  source are removed" fails on windows-latest and macos-latest. The cause is
  `_siann_normalized_path` in `native/cmake/SiannStaleBuildCache.cmake`. It
  applies `file(REAL_PATH)` only to paths that exist, so a cache home inside
  the build tree that does not exist yet keeps its unresolved spelling.
  Meanwhile the existing binary directory is resolved: `/var` becomes
  `/private/var` on macOS, and the 8.3 short name `RUNNER~1` is expanded on
  Windows runners. The home then looks outside the build tree, and a valid
  nested cache is deleted. The fix is to resolve the longest existing ancestor
  and append the rest. That is a `native/cmake` change, outside this
  docs-and-CI pull request, so it is left to a separate fix (gap 0).

Proposed, not done (each needs a decision or touches build config others are editing):

1. Nightly `ux-tour` job with screenshot artifacts (gap 4).
2. Nightly sanitizer job (ASAN+UBSAN) and a fuzz smoke (gap 6).
3. Nightly native coverage job with llvm-cov, report-only (section 5).
4. Engine-gated Node job against the native `siann-engine`, once the bridge
   speaks the native protocol (gap 3). Running the current gated tests in CI is
   not possible: they need the Ardour checkout.
5. `long-tests.yml` on macos-latest (gap 12).
6. Desktop job on core-library PRs (gap 7).
7. App unit coverage printed in the app job (`--experimental-test-coverage`), no threshold.

## 8. How to keep it complete

1. **Every acceptance item names its test layer** (unit, e2e, ctest, Node,
   manual with owner) in the manifest, and the PR's acceptance checklist names
   the test. An item with no automated test says why and who runs it.
2. **Every new protocol method** gets: a native protocol test (params, errors,
   idempotency, `expectedRevision`), an entry in `engine.capabilities`, a row
   in its `docs/schemas/protocol-*.md`, an MCP tool with an adapter test **or**
   an explicit, reasoned exclusion, the app's `capabilities-full.json` entry,
   and an app client unit test when the app calls it. Node client tests follow
   once the bridge speaks the native protocol.
3. **Every UI feature** gets unit tests for its pure logic, a Playwright e2e for
   each user path against the real engine, the i18n fit check covering its new
   controls, and the tour states it changes (until the tour runs in CI, the
   build agent attaches them).
4. **Cross-platform by default**: new tests run on ubuntu, windows and macos
   unless the behaviour is platform-specific; a platform skip
   (`#if`, `test.skip(process.platform ...)`, `SKIP`) carries a reason, and the
   other platforms' behaviour has its own test or a row in 3.1.
5. **Shared fixtures are consumed by every language that implements the
   logic** (Node generator, native, app). A new fixture set lists its
   consumers here.
6. **Env-gated and manual tests are listed in 3.2** with the variable, who runs
   them and when. A new gate without a row is a review finding.
7. **Realtime code** is covered by the RTSan job (Linux) and the allocation
   guard (all OSes); a new audio-thread path links `siann_rt_alloc_guard` in its test.
8. **This file changes with the feature**: the verifier checks the feature's
   row (section 2) and fails the round when the row is missing or claims a test
   that does not exist.
9. **Every UI feature answers to the mockup fidelity gate (F)**: its parts are
   owned by a rule of `app/test/fidelity/manifest.json`, its row in section 2
   says so, and the pull request that lands it sets its gate to `enforce` and
   attaches the report. A part skipped as pending or unowned is named in the
   report, never silently dropped; a colour or size literal outside
   `app/renderer/tokens.css` fails `test/ui-tokens.test.js` on every OS.
