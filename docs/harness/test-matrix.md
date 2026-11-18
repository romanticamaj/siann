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
| 1 the component port after `m5-ui-tokens-spacing` (`m5-ui-alignment-chrome` in review; seven `m5-ui-port-*` not started, which replaced the other alignment features on 2026-11-17) (m5-ui-transport closed its 8, m5-ui-edit-basics its 9, m5-ui-loop-click its 11; gap 1 of section 6 is closed) | the chrome and the port features (in flight) | 9 to 12 |
| 2 method/tool/doc/fixture parity | `m5b-protocol-parity` | 2 |
| 3 bridge targets the Ardour engine, gated tests dead | closed by `m5b-bridge-native-client` (layer G in CI) | 2 |
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
| **F** | Mockup fidelity run (`docs/harness/agent-rules.md`, "UI fidelity"). Blocking: tokens and the manifest, `test/ui-tokens.test.js`, `test/mockup-fidelity.test.js` (in B). A report, never blocking (decided by the maintainer, 2026-11-17): geometry against 1 px, computed styles and chrome pixels per region, `app/test/e2e/mockup-fidelity.spec.ts`, the mockup in Chromium against the app in Electron at 1440x900 and device scale factor 1, en and zh-TW; its region images are the side-by-side screenshots a UI pull request attaches | `node` job (tokens, manifest); `app` job (the spec, `SIANN_FIDELITY=1`) | tokens: ubuntu, windows, macos; the spec: ubuntu (xvfb), windows; not macos | tokens: every PR. The spec: PR when `app/` or the mockup's directory changes; push to main; nightly. **A report for good** (`continue-on-error`, report uploaded as `fidelity-<os>`): no gate is `enforce` and the step never fails the job |
| **B** | Node bridge, scripts and fixture tests (`test/*.js`, `npm test`) | `node` job | ubuntu, windows, macos (**since this PR**; ubuntu only before) | every PR |
| **L** | `[.][long]` Catch2 tests (`siann_cli_tests "[long]"`) | `long-tests.yml` | ubuntu, windows | nightly + manual; never on PRs |
| **G** | Engine-gated Node tests (`SIANN_RUN_ENGINE_TESTS=1`): `test/runtime-engine.test.js`, the engine case of `test/live-import-pack.test.js`, against the core-only `siann-engine` with `--device fake` | `bridge-engine` job (`npm test` with the gate on; locally `node scripts/check-all.js --only bridge`) | ubuntu, windows, macos | PR when `src/`, `bin/`, `test/`, `native/libs/protocol` or `native/apps/engine` change (the `bridge` step of `stepsForPath`); push to main; nightly |
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
| m5-ui-transport | | | Y (`key-preset`, `key-dispatcher`, `transport-time`, `playhead-clock`, `auto-scroll`, `timeline-layers`, `undo-redo`, `transport-controls`, `layout`, `i18n-describe`) | Y (`transport.spec`, `i18n-fit`; F: report-only, its parts gated by `m5-ui-mockup-alignment`) | 8 | 3 | 8: tour only (state 04 and the top bar in every state); 1, 6: macOS Cmd+Z next to the Edit menu's accelerator is proven by the CI macOS e2e only |
| m5-ui-edit-basics | | | Y (`edit-commands`, `snap`, `selection`, `tool-modifiers`, `edit-basics-mod-keys`, `timeline-geometry`, `timeline-layers`, `key-preset`, `key-dispatcher`, `capabilities`, `layout`) | Y (`edit-basics.spec`, six paths, one revision and one undo each; toolbar labels in `i18n-fit`) | 9 | 3 | 9: tour only |
| m5-ui-loop-click | | | Y (`locators`: band geometry from the exported upper-half constant (`RULER_UPPER`, `--ruler-upper-h`), hit zones, draw / move / end drag with snap on and off, the set rules of 3.2, P, 2^42; `locator-commands`: one `session.set_locators` per edit, Alt+P's order, no device, refusal toast, capability gate, the keys; `transport-state`: engine.status seed, `transport.changed`, results, reconnect and sync re-read; `transport-controls`: pressed and lit, disabled with the reason, the empty boxes without E-1 and the `--display-locators-empty-w` cell, bars and beats across a tempo change, the level control; `key-preset`, `key-dispatcher`; `timeline-layers`: light / grey band, tint, no band without the capability, redraw outside React, the upper-half gestures; `capabilities` (fixture and gates, the empty-width token is no hold token); `i18n-catalogs`) | Y (`loop-click.spec`: 1 draw / Ctrl-click / Alt-click / move / adjust / Ctrl+Num 1-2 / Ctrl+Z with no `invalid_locators` answered; 2 the 0..position and zero-length rules; 3 toggles and P / Alt+P / Num 1-2 / Shift+1-2; 6 metronome, C, level; 8 a second client, undo and an applied plan; 7 no device; 9 reopen; 10 `SIANN_TEST_CAPABILITIES` without the methods: no control, same boxes, no request; `i18n-fit` for the new controls; F: report-only, its parts gated by `m5-ui-alignment-chrome` and `m5-ui-port-arrange-canvas`; the five parts' sizes match the mockup in en and zh-TW, and their x positions, the locator cell's right border and the inherited text styles are left to those gates; `transport-controls` checks the ported markup and the holds' sizes; `locators` checks the band's `--locator-*` tokens) | the top bar in every state; 23, 24 | 3 | 11: tour only (states 23 and 24 appended with explicit numbers; 01-22 and 25 change in the top bar alone) |
| m5-ui-tokens-spacing | | | Y (`timeline-ruler`: RULER_HEIGHT, RULER_UPPER, RULER_LOWER from TOKENS; `timeline-layers`: press and pointer switch at RULER_UPPER; `fidelity`: `compareMockupMeasurements`; `timeline-geometry`, `timeline-zoom`, `selection` fixtures on RULER_HEIGHT) | Y (`shell-layout.spec`: zone tab rows 26 px, focus frame at 20 %, the 2 px ring of controls and dividers at 55 % (`--focus-ring`); `mixer.spec`: meter slot 6 px; `arrange.spec`: track list head 40 px; F: report-only, report attached; F on the mockup alone, `SIANN_FIDELITY_MOCKUP_ONLY=1` through `scripts/fidelity-mockup-compare.js`, run by the implementer before the PR: base and branch identical in en and zh-TW) | every state, by four token values (manual, at the `ui-redesign-review` gate) | 3 | Items 1, 2, 3, 5 and 7: Node (B), `ui-tokens` (no literal or negative literal in `app/renderer/ui`, the SIZES table names tokens, the mockup's script reads through one helper with a floor of reads, the scale convention and one token per spacing step, every font weight of the shared rules and the mockup a `--fw-*` token or its value, `--focus-ring` at 55 % on the control and divider ring, no token entry and nothing of `app/renderer/ui` or the mockup in `debt.json`) and `mockup-fidelity` (the mockup's status bar). Item 4: Node (B) pins the four values from the spec's text; unit and e2e as listed. Item 6: F mockup-only compare, not in CI (it needs a worktree of the base commit; gate row in 3.2). Item 8: F report (report-only). Item 9: tour, manual |
| m5-ui-alignment-chrome | | | Y (`top-bar`: the mockup's structure of header.topbar, the five holds (no role, focus, id or text), the locator cell's empty width, undo lit and redo dim from `UndoHistory`, the display separators; `shell-frame`: the .app grid's regions in the mockup's order, the zone sizes as custom properties, dividers out of the grid, no panel library; `status-bar`: the mockup's structure and words in three locales, the 7-character commit, the whole commit and +dirty in the About panel; `engine-status`: `statusFields` type · name · kHz / buffer · round-trip ms; `transport-time`: `hh:mm:ss.mmm`, two-decimal tempo, the three typed forms; `engine-args`: `fidelityEnvironmentArgs` only under `SIANN_SHELL_TEST=1`; `session-client` (20): the environment answers the device and the about field by field; `fonts-csp`: the Medium file's README row and SHA-256; `transport-controls`, `i18n-catalogs`, `i18n-describe`, `plan-bidi`) | Y (`fonts.spec`: the face Chromium used (CDP) is JetBrainsMono-Medium at 500 and Regular at 400 in the app and the mockup, and no mono text asks for another weight; `transport.spec`, `shell.spec`, `shell-layout.spec`, `i18n.spec`, `plan-review.spec`, `packaged.spec` updated for the formats and the markup; `shell-layout.spec`: the top bar in small windows (spec 2.4), centred with its holds at 1440 and 1301 px, the transport after the left group and the branch chip, DSP load and Record holds gone at 1280 px, the brand and the locator, tempo and signature displays gone at 1080 px with the session name kept, no overflow; `i18n-fit` unchanged; F: report (decided by the maintainer, 2026-11-17: the run never blocks), the report and the side-by-side screenshot of the top bar and the status bar attached, the run sets the locators as its one undoable command and checks 0 xruns and a two-digit revision) | every state (01, 02, 03 and 05 for review) | 3 | Node (B): `mockup-fidelity` (the chrome gate is `report`, check-all notes a failed fidelity run and CI's step keeps `continue-on-error`, the five hold tokens applied in `shell.css` only, the chrome's stylesheets linked in the mockup's order, `SIANN_FIDELITY_ENVIRONMENT` from the manifest, the UI spec builds the zones without react-resizable-panels in its four places, the breakpoints of `shell.css` are the 1300 and 1100 px of spec 2.4 and 3.0), `ui-tokens` (no font entry, the Medium `@font-face`, no rule asks JetBrains Mono for a weight but 400 or 500), `package-config` and `test/package/licences` (react-resizable-panels gone). Item 10: tour, manual |
| m5-ui-port-arrange-canvas | | | Y (`timeline-geometry`: `MARKER_HEIGHT`, `LANES_TOP`, `clipBox`, `titleStrip`, `cornerHandles` from draw()'s numbers at two zooms, hit parts over the inset box, nothing in the marker row; `timeline-colour`: `clipPalette` from the tokens and draw()'s mix ratios, computed by hand; `timeline-waveform`: `waveformColumns` for a hand-built pyramid at two zooms (the level chosen), with `sourceStart`, at ratio 1 and 2, each column filled between the min and the max (a one-sided bin, a DC offset, a stereo pair), silence 1 px high, inner 52 %; `clip-title`: media.name, else the media id; `timeline-layers`: draw()'s order and colours, the empty marker row, a muted track's clip at .5, the title font and a rename without a new canvas, no fade, repeat or ghost, the cursor from RU+2 and its five-point head, `parts()` without a pending id, a selection redraws the content and a cursor move does not, a one-sided signal drawn above the middle only; `event-display`: `.lanes` / `#tl` / `.hscroll` against the mockup's template, `.arr-body`, the track list's empty marker row, `--zoom-at` on u from the zoom) | Y (`arrange.spec`: the demo WAV's loud and silent halves in `waveColumns`, after a right and a left trim; `media.rename` changes the title without a reload; every id found and no pending id; headers level with the lanes; the zoom handle on the thumb, following H, G and a click; `timeline`, `arrange`, `edit-basics`, `transport`, `loop-click`, `shell-layout`, `i18n-fit`, `ux-tour` on `LANES_TOP` and the inset box; F: the event display, report, resting and selected-clip screenshots attached; `mockup-fidelity.spec` reads the canvas parts from `parts()` and names each clip's media as the mockup names the clip, checked against its CLIPS table) | every state (01, 02, 06, 07, 10, 11, 12 for review) | 3 | Node (B): `ui-tokens` (no `TimelineCanvas.ts` entry in `debt.json`, `shell.css` lowered), `mockup-fidelity` (ui/project-zone.css linked in the mockup's order, the gate is report, no `.arrange` rule in `shell.css`, no `--hold-marker-*` token). Item 9: F report (report-only). Item 10: tour, manual |
| m5-ui-port-mixer-strip | | | Y (`knob`: the Knob's path data and colours against the mockup's own knob() for C, L35, R100 and L100, run from mockup.html in a vm (`support/mockup.ts`); `strip-port`: per strip the rows, classes and order of strip(), the PAN label's style in en and zh-TW, .msr.m / .msr.s with .on and the empty box of e, the scale's seven labels and the cap at the taper's positions, two meter wells, the readout, muted and sel, the master's fader area, scale, meter, peak value and name with every other row an empty box, the fidelity ids equal to the mockup's minus the manifest's pending ones, reduced capabilities, a gain above +6 dB; `mixer-meters`: the gradient over --meter-scale-h, the hold line and the clip band from `tokens.ts`, no colour literal and no meter value in React state; `meter-store`: level and hold per channel, mono in both, carried across an epoch and reset; `shell-frame`: section.lower with the mockup's .tabs and the MixConsole tab, no Editor tab or rack switches; `strip-model`, `plan-bidi` updated) | Y (`mixer.spec`: every gesture, typed value, meter and clip path unchanged, two channels of 6 px and 9 px on the master, and a new path that finds every landed lower-zone id and none of a pending one, derived from the manifest; `i18n-fit`: the knob, pan value, M, S, readout and tab in four locales at two sizes; `shell-layout.spec`: the .tabs row is 26 px; F: the lower zone, report, and `lower-zone.fader-held.app.png` per locale (Bass held before the release, FX muted); side-by-side screenshots attached) | every state (04, 08 and 09 for review) | 3 | Wave 11, after `m5-ui-port-arrange-canvas`: M and S take `.msr` from `project-zone.css`, which the canvas links; the branch is built on `ms/M5/m5-ui-port-arrange-canvas` and lands after it. `mixer.spec` checks the chips: M and S off are the `--bg-4` box of `--ms-w` by `--ms-h` with a hairline border, M on is `--mute`, S on is `--solo`. Node (B): `mockup-fidelity` (lower-zone.css linked in the mockup's order, every `ui/*.css` that draws `.msr` linked and no `.msr` rule in `shell.css`, the gate report, no hold token, the ledger without `MixerMeters.ts`), `ui-tokens` (the ledger lowered for `shell.css`). The readout keeps the app's "-2.5 dB" format (the mockup writes "−2.5"), so the existing gesture specs and the Inspector agree with it. Item 9: F writes the lower-zone pair and `lower-zone.fader-held.app.png` in en and zh-TW (`mockup-fidelity` checks the spec writes it); the maintainer reviews them by eye at review. Node (B) `mockup-fidelity` also checks that `shell.css`'s pinned pre-port text styles do not reach the lower zone |
| m5-ui-port-plans | | | Y (`plans-tab`: the right zone's tree (tags, classes, data-part and data-part-item ids) against the mockup's own template and `step()` evaluated from mockup.html, the six holds (no role, focus, id or text), no pending id, empty `.go`, no `kbd`, one steps-head link, the hot row, the old markup gone, the derived texts; `plan-chips`: order, omitted kinds, −N, edit, three locales, zh-Hant from the mockup's ZH table; `plan-step-rows`: titles and details of the six mockup steps and every other op, old values from `plan.preview` with earlier steps applied, no preview, the applied plan's "after", the dot's colour, zh-Hant equal to the mockup's; `plan-entity-homes`: every diff row has a home (each naming step, else the cascade's step, else the other row; `track.remove`, `plugin.remove`, a stale ref the preview lacks); `plan-actions`: "Approve N of M" with every step ticked, the three `.acts` cells per state; `plan-card`: the default selection, history rows (one badge, detail lines, split, part-of, the note), "Earlier" and "N plans" with plurals; `plan-panel`: card and rows, the link, no ids while closed, the step disclosure with its entities, a cascaded clip under `track.remove` and the "Other changes" row for an entity no step names, the reason row, the refusal and stale rows, capabilities; `plan-bidi`, `i18n-catalogs`) | Y (`plan-review.spec`: every id of acceptance 4 in the window and no pending id, the hot row, a row selects, "Approve 5 of 5", "Applied · r" badge, Select all / none, the reason row (Escape, Enter), the step disclosure; `connection`, `i18n`, `shell-layout` (the right zone scrolls in `.p-scroll`), `shell` (the right zone takes `base.css`'s text styles, the zones not ported keep the pinned ones), `i18n-fit` (the tab, the hearing segments, the link, the action buttons, the badges, the reason field) updated; F: report, the fidelity session submits stale (approved), rejected (the mockup's note) and applied (4 steps) plans before the pending one, no click, the pointer on step 3; side-by-side screenshots of the right zone in en and zh-TW and app-only ones of an auditioned and an applied card) | 13-22, the right zone's frame in every state | 3 | Node (B): `mockup-fidelity` (the six hold tokens, per locale where they differ, applied in `shell.css`; `right-zone.css` linked in the mockup's order after `project-zone.css` and `lower-zone.css`, whose `.tab`, `.seg` and `.stepn` draw the tab row, the hearing switch and the step numbers; the replaced `shell.css` rules gone; the gate report), `ui-tokens` (the ledger lowered to 42 sizes). 8: the screenshots, by eye (maintainer) |
| m5-ui-port-inspector (open) | | | - | - (F: the left zone, report; side-by-side screenshot attached) | every state with the left zone | - | 1-8: not on main. Ports the left zone's markup (2026-11-17), after `m5-ui-port-arrange-canvas` (wave 11), whose `project-zone.css` draws M and S (`.msr`). Unit tests on the structure, the values and formats per locale and the empty state; e2e: volume, pan, mute and solo from the Inspector, one revision each, the strip and the header follow |
| m5-ui-port-track-list | | | Y (`track-list-port`: `.headers` holding `.corner` (`.add`, `.cnt`), the empty marker box and the headers; each header against the mockup's own th() run from mockup.html in a vm (`support/mockup.ts`): `.th` with `--c`, `.col`, `.idx`, `.body`, `.r1` (`.name`, `.msr.m`, `.msr.s`, three empty boxes) and `.r2` (`.db.num`, `.pan.num`, `.hmeter`); `sel`, `muted` (muted and implicitly muted), `.on` from mute and solo; the number, `formatDb` and `formatPan` against fdb/fpan for the mockup's seven tracks; the fidelity ids equal to the mockup's minus the manifest's pending ones, no `marker-head`, record, read, write or ghost id; reduced capabilities; rename renders the input; the count in en (plurals), zh-Hant and zh-Hans with `track-count` as `data-part` and `data-testid`; `header-meters`: a horizontal bar inside each measured `.hmeter` slot, the gradient stops from `tokens.ts`, no draw without a new frame or moved slots; `status-bar`: `about-track-count`; `event-display`, `capabilities`, `plan-bidi` updated) | Y (`arrange.spec`: add with `.add`, rename, select, mute and solo from the list, one revision each; the count follows a placed and a removed clip; every non-pending id of the track-list rule found and no pending one, derived from the manifest; the specs reading the diagnostics row use `about-track-count`; `i18n-fit`: the add label and the count in four locales; F: the track list, report; side-by-side screenshots attached) | every state (01, 02, 06 and 07 for review) | 3 | Node (B): `ui-tokens` (the ledger lowered for `shell.css`), `mockup-fidelity` (the gate is report). The gain keeps the app's "-2.5 dB" format (the mockup writes "−2.5"), as the strip's readout does. Item 7: F report (report-only). Item 8: tour, manual |
| m5-ui-port-toolbar | | | Y (`toolbar-port`: `div.arr-toolbar`'s children in the template's order against the mockup's own block and `tool()` evaluated from mockup.html, tools 1 and 3 as `.b` with the P table's icon and `kbd`, `.on` and `aria-pressed` on the active one, the seven empty boxes of tools 2 and 4 to 9 and the pill's (no role, focus, id or text), the snap field (magnet, label, `<em>` Grid, chevron, `.on`), the grid type field for Bar, Beat and Adapt to Zoom, auto-scroll (the follow icon, the inline padding, `.on`), the labels in en and zh-TW equal to `L()`, the ids minus the pending ones, the edit-basics test ids kept, no media button or Delete clip button, `timeline-error` empty with no refusal, an engine without the commands keeping every box; `info-line-port`: one `span.f` per field in the template's order, the name in the track's colour (`trackColourVar`) with the clip's title (media.name, else the media id), each field its label and `b.num` per locale, the mockup's row for the mockup's clip, the fades' boxes empty at the end, nothing between the edges with no selection, the primary clip of several; `timeline-info-line`: `formatPosition` and `formatLength` (bar.beat.sixteenth.tick, the boundaries at 479, 480, 1920 and 7680 ticks), the mockup's row, `formatDb2` (two decimals, `formatDb`'s sign, rounding and `-inf`), `formatBbt` kept for the top bar and the tooltip; `key-preset` and `key-dispatcher`: `Mod+P` is `pool.open` in the window, Cmd+P on macOS, no clash with P, Alt+P, Shift+P and Mod+Alt+P; `pool`: the list by name or id, `media-pool` and `pool-<id>`, the armed one pressed, a click arms and a second disarms, plain text without `clip.place`, closed is nothing, Escape closes; `capabilities` (no Pool and no Delete clip button at rest, the boxes kept), `i18n-catalogs` (the new words, the mockup's in en and zh-TW, the old keys gone)) | Y (`arrange.spec`: every id of acceptance 7 in the window and no pending one; tools by click and by 1 and 3, snap by click and J, each grid type from the field's menu, auto-scroll by click and F; the info line follows a move and a left trim in the new formats, empty with no selection; Ctrl+P opens the Pool over the project zone, Escape closes it, a click arms placing and a click in the event display places one clip in one revision, the event display's context menu opens it; `edit-basics`, `timeline`, `connection`, `i18n`, `i18n-fit` (the tools, fields, info line fields and the open Pool in four locales at both sizes) updated through `support/toolbar.ts` (`openPool`, `armPlacing`, `chooseGrid`); F: report, the fidelity session selects the mockup's clip with auto-scroll off; side-by-side screenshots of the project zone in en and zh-TW, and the Pool open from the app alone) | every state (the toolbar and the info line); 26, the Pool open | 3 | Node (B): `mockup-fidelity` (the ten hold tokens, per locale where they differ, applied in `shell.css`; the replaced `shell.css` rules gone and no second rule for `.arr-toolbar`, `.seg`, `.b`, `.field`, `.spacer`, `.infoline` or `.f`; the pinned pre-port text styles no longer reach the project zone; the gate report), `ui-tokens` (the ledger lowered to 27 sizes). 10: the screenshots, by eye (maintainer). The empty box of the snap or the grid type field on an engine without the clip commands is the field's height only: their width is the label's, and no permanent `--<part>-empty-w` token is authorised for them |
| m5-ui-port-cleanup | | | Y (`port-cleanup`: every module of app/src/renderer reachable from index.tsx and every exported component rendered by the app, the whole window rendered with the zones' real components holding each `data-part` and `data-region` once; `i18n-catalogs`: every key of `en.ts` named by the renderer or one of four dynamic prefixes; `status-bar`, `plan-bidi`, `inspector-port`, `toolbar-port`: the hook classes gone and the computed class names looked up in literal tables) | Y (`shell.spec`: on the fidelity run's session, `support/fidelity-session.ts`, no id of a pending part in the window and every landed, non-dynamic id the mockup names; F: the whole window, report; side-by-side screenshot of the window attached) | the whole tour retaken once in en, zh-Hant and zh-Hans (manual, at the `ui-redesign-review` gate) | 3 | The component port is finished for M5's parts. Item 1: Node (B), `mockup-fidelity` (the app's links are the mockup's nine then `shell.css`; no selector of `shell.css` is one of `app/renderer/ui`'s outside a media or container query, with the parser's self-check; nothing pinned for unported zones; no comment inside a selector). Item 2: Node (B), `mockup-fidelity` (every class the renderer emits, the literal tables included, has a rule in `app/renderer/ui` or `shell.css`, and every class of `shell.css` is emitted; no computed class name), and unit as listed. Item 3: Node (B), `ui-tokens` (`debt.json` empty and this feature its gate, unconditionally; no literal in the renderer, `shell.css`'s negative ones included; the app-only tokens of 10.7 (4) declared, app-only, and every earlier token held to `test/fixtures/ui-tokens-before-cleanup.json`, a snapshot of origin/main's `tokens.css`; `--focus-ring` once; the focus widths as tokens). Item 4: e2e as listed; Node (B), `mockup-fidelity` (every rule owned, every `--hold-*` token a pending part's). Item 5: Node (B), `mockup-fidelity` (M5's seven gates report, none enforce; check-all and CI keep the report; the rules, the runbook and this matrix say the port is finished). Items 6 and 7: manual, attached to the pull request by the land agent and reviewed by the maintainer by eye |

### M5b Usable release (landed features)

| Feature | N | R | D | B | Platforms | Gaps |
|---|---|---|---|---|---|---|
| m5b-bridge-native-client | Y (`plan_methods_test` plan.rollback {revision} after a reopen, both or neither param, not_a_plan, not on main, the stored plan rolled_back with plan.changed; `mcp_adapter_test` rollback_plan's argument) | | | Y (`ws-codec` RFC 6455 vectors; `runtime-client` against the in-process fake engine; `bridge-runner`, `bridge-cli`, `rollback-workflow`, `live-import-pack` against the fake engine (`test/helpers/fake-engine*.js`); G: `runtime-engine`, `live-import-pack` engine case against siann-engine) | 3 (B and G) | - |
| m5b-engine-record | Y (`engine_record_test`, `record_methods_test`, `capture_bank_test`, `recording_test`, `takes_test`, `realtime_channel_test` input meters, `mcp_adapter_test` record tools and propose stop/locate while recording, `commands_test`/`document_test` `track.set_input`, `cycle_test`, `session_test` head guard, `engine_launch_test` kill-and-recover, wire loopback `track_recording` and a propose agent's stop over the wire) | Y | Y (the same engine tests with JUCE) | | 3 + RTSan | - (1: the real-device half (a JUCE input on hardware) only on the maintainer's bench; 9: no UI) |

Per acceptance item (`m5b-bridge-native-client`): 1 `runtime-client` (start,
envelope, `resolveEngineExe`, the source no longer names the Ardour runtime),
`bridge-runner` "runner.js no longer spawns the Ardour command runner",
`bridge-cli` "--engine-dir is an unknown option"; 2 `runtime-client` (refused
token, unknown method, error mapping, failed and cancelled jobs, the engine
exiting mid-request, stop with requests in flight; `client.js` branch coverage
above 57 %); 3 `bridge-runner` (the method sequence, the Node plan hash, the
v1 journal, the rate refusal, the render copied out, a render format,
`inputChannels` or `snapshotRetention` the engine cannot honour refused),
`import-pack-workflow` (the preview format refused when the command file is
built), `rollback-workflow` (a
second process rolls back by revision), G: `runtime-engine` "plan intake,
validate, approve, apply --run and rollback --run against siann-engine"; 4 G:
`runtime-engine`, `live-import-pack` "creates a native session"; 5
`ci-workflow` (the `bridge-engine` job), `check-all-changed` (the `bridge`
step); 6 `skill-docs` (the skills, and no doc still names the engine
checkout or an Ardour session), `test-matrix`, and the PR's list of changed mentions; 7
`plan_methods_test`, `mcp_adapter_test`.

Per acceptance item: 1 `engine_record_test` "engine.devices carries channel
counts ...", "an input reports the channels the device opened ...", "a device
that opens fewer inputs than asked records and meters through device-side
SRC", `record_methods_test` "engine.select_device passes inputId ..."; 2
`commands_test`, `document_test`, `engine_record_test` "arming needs an input
...", "the armed set follows a new head with no tick in between",
`record_methods_test` "record.changed reaches every subscribed connection ...";
3 `engine_record_test` "transport.record needs an armed track ...", "a
recorded impulse lands within one sample ..." (plain, stereo, SRC, latent
insert), "transport.locate while recording ends the take and commits it
first", `engine_launch_test` "a loopback recording over the wire ..."; 4
`record_methods_test`, `realtime_channel_test` "armed tracks' input meters
...", `engine_record_test` "an armed track's input meter is read while
stopped"; 5 `engine_record_test` "an early end is named ...", `recording_test`,
`takes_test`; 6 `engine_launch_test` "a take a kill interrupted ...",
`engine_record_test` "record.recover_take ..."; 7 `capture_bank_test` "The
cycle wrap is suspended ...", `engine_record_test` "recording with cycle on
...", `cycle_test`; 8 `record_methods_test` "engine.capabilities lists ...",
`mcp_adapter_test`, the alloc guard linked into `siann_engine_host_tests` and
the realtime tests; 9 none (no UI).

| Feature | N | R | D | B | Platforms | Gaps |
|---|---|---|---|---|---|---|
| m5b-engine-master | Y (`document_test`, `commands_test`, `history_test`, `plan_test`, `plan_hash_test`, `master_session_test`, `master_methods_test`, `gesture_methods_test`, `mcp_adapter_test`, `playback_test`, `audition_test`, `click_test`, `offline_test`, `engine_host_test`) | Y (`playback_test` alloc guard with a master gesture) | | Y (`fixture-parity`, `read-model-fixtures`; app unit `read-model`, `capabilities`) | 3 | - (no UI: the master strip stays a meter until `m5b-ui-inserts-master`; tour states changed: none) |
| m5b-engine-buses-sends | Y (`document_test`, `commands_test`, `history_test`, `plan_test`, `plan_hash_test`, `buses_session_test`, `graph_test`, `offline_test`, `playback_test`, `plugin_instances_test`, `realtime_channel_test`, `buses_methods_test`, `gesture_methods_test`, `plugin_methods_test`, `mcp_adapter_test`, `engine_host_test`) | Y (`playback_test` alloc guard with a bus and a send gesture) | | Y (`fixture-parity`, `read-model-fixtures`, `plan-hash`; app unit `read-model`, `plan-diff`, `capabilities`) | 3 | - (no UI: buses reach the mixer in a later UI feature; tour states changed: none) |

Per acceptance item (`m5b-engine-master`): 1 `document_test` "The master
fixture gives the Node bridge's hashes ...", "A v2 document without the master
reads with its hash unchanged ...", "The master entity rejects 0 dB, a wrong id
or schema ...", "A master gain out of range is invalid_gain ...", "The master is
added, modified and removed like any entity"; `commands_test` "master.set_gain
sets the master and declares exactly master:master" (set and set back to 0 give
the original hash), "... refuses a gain out of range and malformed params";
`history_test` "master.set_gain is one revision each; undo and redo ...";
`plan_test` "A plan may set the master gain ...", "A master plan goes stale on a
master change and not on session.rename", "Rolling back a plan that set the
master back to 0 dB restores it"; `plan_hash_test` and the fixtures
`master_write_set` / `master_with_another_id`; `master_session_test` (checkpoint,
journal replay, journal record, a bundle after set and set back to 0);
`master_methods_test` (execute, session.changed to a second connection, fetch,
sync and its chunk boundary, plan.preview `before: null` / `after: null`);
`mcp_adapter_test` "execute and a plan carry master.set_gain ..."; app unit
`read-model` "(e) master:master parses ...". 2 `gesture_methods_test` "the
master target takes gain only ...", "a master gesture with no entity starts at
0 ...", "a master gesture that never moved ...", "the master target follows a
track fader's lease rules"; `playback_test` "A master gesture moves the sound
without a recompile ..."; `audition_test` "A master gesture ended while a
proposal is heard ..."; `engine_host_test` "a master gesture through the port
...". 3 `playback_test` "compileForPlayback has a master:master gain slot ...",
"Realtime at master -6 dB is sample-identical to renderOffline ..." (null test),
"A master.set_gain revision reaches the audio thread as a parameter set ...",
"The master meter reads the post-gain level ..."; `offline_test` "A render at
master -6 dB is the 0 dB render scaled ...", "A master at minus infinity renders
silence", "A document without the master renders bit-identically ...";
`click_test` "The click level is unchanged by a master gain of -6 dB". 4
`master_methods_test` "engine.capabilities lists master.set_gain and
features.masterGain", plan.preview and the second connection above;
`mcp_adapter_test`; app unit `capabilities`.

Per acceptance item (`m5b-engine-buses-sends`): 1 `document_test` "The buses
fixture gives the Node bridge's hashes ...", "Empty bus and send fields are
omitted ...", "validate() checks bus and send references, order and ranges", "A
cyclic bus output chain is routing_cycle"; `commands_test` "bus.add adds a stereo
bus ...", "The bus edits change one field ...", "bus.set_output refuses a route
that reaches the bus itself ...", "track.set_output routes a track ...",
"send.add and the send edits declare exactly their entities", "bus.remove removes
its sends and slots and routes its inputs to the master in one revision",
"track.remove cascades the track's sends", "commandCascades lists ...";
`history_test` "One undo of bus.remove restores ..."; `plan_test` "Plan entity
sets accept bus and send refs", "A bus plan goes stale when the bus changes",
"Rolling back a plan that added a bus restores the bus order ...";
`buses_methods_test` command.list cascades and routing_cycle. 2 `offline_test`
"PDC null: a latent track insert and a send to a bus with a latent insert", "PDC
null: a three-level bus chain ...", "A post-fader send follows the track's gain
and pan; a pre-fader send does not", "Track mute silences both kinds of send
...", "Solo with buses and sends follows the Channels and I/O rules";
`plugin_instances_test` "PDC nulls in realtime across a send and a three-level bus
chain with latent inserts"; `playback_test` "Realtime with buses and sends is
sample-identical ...", "Realtime through a three-level bus chain ...";
`graph_test` SendNode cases. 3 `gesture_methods_test` "bus:<id> takes gain and
send:<id> takes level ...", "a bus gesture commits one bus.set_gain ...", "bus
and send targets follow a track fader's lease rules"; `playback_test` "Bus gain
and send level gestures move the sound with no recompile ...", "No allocations on
the audio thread during bus and send gestures"; `engine_host_test` "bus and send
gestures through the port"; `playback_test` "A bus meter reaches the dispatcher
under bus:<id> ..." and `realtime_channel_test` "the meter legend lists every bus
as bus:<id> ..."; `document_test` (slot with both or neither owner),
`commands_test` "plugin.insert takes exactly one of trackId or busId";
`plugin_methods_test` "plugin.instantiate takes exactly one of trackId or busId
...". 4 `buses_session_test` "A v2 bundle opens with every recorded hash ...", "A
bundle with buses and sends replays to identical hashes"; `buses_methods_test`
"plan.preview shows buses and sends with before and after", "engine.capabilities
lists features.buses and features.sends ...", sync chunks; `fixture-parity`,
`read-model-fixtures`, `plan-hash`; app unit `read-model` "(f) bus and send refs
parse ...", "the buses model fixture syncs ...". 5 none (no UI).

| Feature | N | R | U | B | Platforms | Gaps |
|---|---|---|---|---|---|---|
| m5b-engine-plan-metadata (E-7, E-14) | Y (`plan_hash_test`, `plan_test` `[metadata]`, `plan_methods_test` `[metadata]`, `mcp_adapter_test` `[metadata]` and DELETE, `agent_methods_test`, `transport_methods_test` engine.status keys) | Y | Y (`capabilities`, `session-client` (18b)) | Y (`plan-hash`, `read-model-fixtures`) | 3 | - (7: no UI, no tour state) |

Per acceptance item: 1 `plan_methods_test` "plan.submit refuses a title or
intent outside the limits with invalid_plan_metadata" (200 and 201 bytes, a
multi-byte title in bytes, LF, CR, tab, C0 and C1 controls, empty and non-string,
intent 2,000 and 2,001; nothing listed, no `plan.changed`), "plan.status,
plan.list and plan.changed carry title, intent and actor" (also the resubmission
that keeps the first title), `plan_test` "Submit stores the title, intent and
actor; a resubmission keeps the first", "Submit refuses a title or intent outside
the limits ...", `plan_hash_test` "A plan with and without title, intent and
actor has the same planHash", Node `plan-hash` "a plan hashed with and without a
title ..." over `fixtures/plan/plan-hash.json` (`titled_plan`, `plan_with_intent`,
`plan_with_actor`, `non_ascii_title` and the malformed-metadata invalid cases);
2 `plan_methods_test` "The actor of a UI submission comes from the auth frame,
never from the params" (default, sanitised, malformed client; `actor`, `kind`,
`name`, `owner` params are `invalid_params`), `mcp_adapter_test` "submit_plan
stores title, intent and the actor from clientInfo.name", "the MCP actor's name:
the default without clientInfo, sanitised otherwise", `plan_test` "A sub-plan
keeps its parent's title, intent and actor; approve and apply ignore them",
`plan_methods_test` "plan.changed and plan.status carry the rejection note; a
split keeps the parent's metadata"; 3 the same test (`plan.reject {note}` and
partial approval's "partially approved as ..."); 4 `agent_methods_test`
"engine.status lists no agent before initialize, then the MCP session's agent",
"a second client sees agent.changed on connect, action, idle, reconnect and
DELETE" (marker in the arguments never in the payload, the injected steady
clock), "past agentsRetained the oldest disconnected agent is forgotten",
`mcp_adapter_test` "DELETE /v0/mcp ends the session; without the header it is
400"; 5 `agent_methods_test` "engine.capabilities lists planMetadata, agents and
the agent limits", `mcp_adapter_test` "tools/list: submit_plan takes a title of
200 and an intent of 2000 at most", Node `read-model-fixtures` "the unmodelled
events ...", app `session-client` (18b) and `capabilities` (`capabilities-full.json`
with both features, `capabilities-reduced.json` without); 6 the tests above;
7 none (no UI).

Display-unsafe metadata (security fix after #121; `plan-v1.md`, "Metadata"):
`plan_test` "Submit refuses bidi formatting, line separators and invalid UTF-8
in a title or intent" (each of U+061C, U+200E, U+200F, U+202A to U+202E, U+2066
to U+2069, U+2028 and U+2029 in a title and an intent; six malformed UTF-8
sequences; CJK, Hebrew, Arabic and emoji with a ZWJ pass), `plan_methods_test`
"plan.submit refuses a title or intent outside the limits ..." (RLO, RLI, RLM,
ALM, LS, LRO and PS through the protocol), `mcp_adapter_test` "the MCP actor's
name ..." (bidi formatting and separators stripped, CJK and emoji kept), app
`plan-bidi` (the card's lead and rejection note, step text, stale reasons and
the audition banner render with `dir="auto"` and `unicode-bidi: isolate`). Node
has no mirror: `src/hash/plan-hash.js` checks only the metadata's shape.

| Feature | N | R | U | B | Platforms | Gaps |
|---|---|---|---|---|---|---|
| m5b-engine-clip-fades (UR-6, the fade half of E-9) | Y (`document_test` `[fades]`, `session_test` pre-fade bundle, `commands_test` `[fades]`, `history_test` `[fades]`, `plan_hash_test`, `graph_test` `[fades]`, `offline_test` `[fades]`, `playback_test` `[fades]`, `cycle_test` `[fades]`, `live_recompile_test` `[fades]`, `plan_methods_test` `[fades]`, `mcp_adapter_test` `list_commands`) | Y (`cycle_test` alloc guard with faded clips) | Y (`read-model`, `capabilities`, `edit-commands` fades) | Y (`plan-hash`, `read-model-fixtures`, `fixture-parity`) | 3 | - (no new method, so no MCP tool (rule 2): the command goes through `execute` and plans; 4: no UI, tour states changed: none) |

Per acceptance item (`m5b-engine-clip-fades`): 1 `document_test` "A clip
without fades keeps its literal pre-fade JSON and hash", "The fades fixture
round-trips with the Node bridge's hashes", "A malformed fade is rejected when
the clip is read", "validate reports invalid_fade ..."; `session_test` "A bundle
whose journal and checkpoint are literal pre-fade text opens ..."; `commands_test`
"clip.set_fade sets either side ...", "clip.set_fade refuses ...", "clip.trim
shortens fades that no longer fit ..."; `history_test` "clip.set_fade is one revision ...". 2
`graph_test` "ClipPlayerNode applies the fade formula ...", "A faded clip renders
the same for any block size"; `offline_test` "The offline render of a faded clip equals the
curve's formula within one LSB at 24 bit"; `playback_test` "Realtime output of
faded clips is sample-identical to renderOffline ..."; `cycle_test` "A locate
into the middle of a fade ...", "A cycle that starts inside a fade in and ends
inside a fade out ...", the alloc guard; `live_recompile_test` "A fade-only edit
replaces the track's stream ...". 3 `plan_methods_test` "engine.capabilities
lists clip.set_fade and features.clipFades ...", "plan.preview of a clip.set_fade
step ...", "command.execute of an over-long fade answers invalid_fade";
`mcp_adapter_test`; `plan_hash_test` and Node `plan-hash` over
`clip_set_fade_step`; Node `read-model-fixtures`; app unit `read-model`,
`capabilities`. 4 app unit `edit-commands` "split carries a faded clip's fades ...",
"duplicate and copy carry both fades ...". 5 none (no UI).

Display-safe names (follow-up to #123; `protocol-engine-v0.md`, "Names"):
`commands_test` "track.add and track.rename ...", "media.add and media.rename
...", "bus.add and bus.rename ...", "session.rename ...", "plugin.insert refuses a display-unsafe descriptor
name ..." (RLO, LRI, PDI, ALM, LRM, LS, LF, NEL and a malformed byte, each
`invalid_name`; Hebrew, CJK and emoji pass) and "A transaction stops at the
step whose name is unsafe"; `document_test` "Validation refuses display-unsafe
names as invalid_name" (root, track, media and bus) and "Opening a document with a
display-unsafe name is invalid_document" (a crafted v1 document with the
character in a track, the session, a plugin slot and a media name);
`session_create_test` "session.create refuses an unsafe given name and strips
one taken from the folder"; `media_import_test` "The media name drops control
and display-unsafe characters from the file name"; Node `display-name` (the
import-pack manifest refuses them in session, track and region names; the
DAW-pack intake strips them from names it derives from file names); app
`plan-bidi` (each name in step text, stale reasons, refusal lines and diff rows
is wrapped in U+2068 ... U+2069 in every locale; the track list, inspector,
mixer strip and session name isolate the name they show).

| Feature | N | R | U | B | Platforms | Gaps |
|---|---|---|---|---|---|---|
| m5b-engine-load-loudness (E-13, UR-14) | Y (`loudness_test` (new `siann_dsp_tests`), `load_window_test`, `graph_driver_test` `[loudness]` `[load]`, `realtime_channel_test` `[loudness]`, `transport_methods_test` `[loudness]` `[load]`, `mcp_adapter_test` `[loudness]`, `engine_host_test` `[loudness]` `[load]`) | Y (`loudness_test`, `load_window_test`, `graph_driver_test` alloc guard under `ScopedRealtimeThread`; RTSan build) | Y (`capabilities`, `meter-frames` "a SLUD frame is not an SMTR frame") | Y (`protocol-fixtures` loudness frames) | 3 + RTSan | - (6: no UI, no tour state) |
| m5b-engine-agent-requests (UR-16; gate `agent-request-shape`) | Y (`agent_requests_test`, `mcp_adapter_test` `[requests]`, `plan_methods_test` `[metadata]` request link) | Y | Y (`capabilities`, `session-client` agent requests) | - | 3 | - (7: no UI, no tour state) |

Per acceptance item (`m5b-engine-load-loudness`): 1 `load_window_test` "LoadWindow
publishes the average and the peak of a full second of device frames", "LoadWindow
reports nothing before the first full window", "LoadWindow: unmeasured callbacks
contribute nothing", "LoadWindow: blocks of different sizes weigh by their period",
"LoadWindow: reset clears ...", "LoadWindow: record does not allocate on a realtime
thread"; `graph_driver_test` "The driver reports DSP load from the callback clock"
(alloc guard, restart on start); `transport_methods_test` "engine.status carries
load {average, peak} as numbers from the port"; `mcp_adapter_test` "engine_status
passes the DSP load through"; `engine_host_test` "engine.status load is the
driver's and 0 once the device is gone"; 2 `graph_driver_test` "The loudness meter
reads the master output before the click" (equal readings with the click on, equal
to a reference meter over the device output), "The master gain at -6 dB lowers the
loudness by 6 LU", "A locate and a transport stop do not restart the integrated
value; a reset request does"; `loudness_test` "reset restarts the integrated value
and leaves momentary and short-term"; `realtime_channel_test` "the publisher sends
SMTR then SLUD per tick with a subscriber"; `transport_methods_test`
"meter.reset_loudness calls the port once and answers {}", "meter.reset_loudness: a
duplicate requestId is cached ...", "meter.reset_loudness is not_supported without
a transport port ..."; `engine_host_test` "a -23 dBFS 1 kHz tone through the engine
reads -23 LUFS, and -6 dB of master gain 6 LU less", "a realtime client receives
loudness frames while the session plays", "engine.select_device keeps the
integrated value; meter.reset_loudness returns it to -inf"; `engine_launch_test` "a
client on the fake device plays ..." (the loudness frame over the wire); 3
`loudness_test` "EBU Tech 3341 case 1: ...", "EBU Tech 3341 case 2: ...", "EBU Tech
3341 gating cases 3 to 5 read -23.0 LUFS integrated" (each at 44.1, 48 and 96 kHz),
"the 48 kHz K-weighting equals the table of BS.1770-4 Annex 1", "silence reads minus
infinity on all three values", "silence after a signal: ...", "the readings do not
depend on the size of the process() calls"; `graph_driver_test` "The loudness meter
runs at the session rate behind device-side SRC"; `realtime_channel_test` "loudness
frames match the shared fixture byte for byte" (negative infinity as `00 00 80 ff`);
the engine-level reading in `engine_host_test` above; 4 `realtime_channel_test`
"with no subscriber the publisher never reads the loudness and sends no frame";
`graph_driver_test` "The loudness history survives a graph swap and a device
change", "Before the first start the loudness reads minus infinity"; `loudness_test`
"process, processSilence and reset do not allocate on a realtime thread"; 5
`transport_methods_test` "engine.capabilities lists meter.reset_loudness with
features load and loudness", `mcp_adapter_test` "meter.reset_loudness is no MCP tool
and the adapter lists its exclusion", app unit `capabilities` (`capabilities-full.json`
with the method and both features) and `meter-frames` "a SLUD frame is not an SMTR
frame and is ignored", Node `protocol-fixtures` (fixture, layout, doc rows); the
schema docs; 6 none (no UI).

Per acceptance item (`m5b-engine-agent-requests`): 1 `agent_requests_test` "agent.request from the UI returns
the pending request with the stamped context; a second client sees
agent.request_changed", "the text is 1 to 4,000 code points of display-safe
UTF-8; selection ids are checked; the 17th open request is agent_busy",
"agent.request to an unknown or disconnected agent is agent_not_connected",
"the request methods belong to one credential: scope_denied otherwise"; 2
"next_request returns the oldest pending request at once and marks it taken",
"next_request parks with an empty queue: a later request, the wait, a second
call and the clamp", "a retry of next_request with the same id returns the same
request; an empty poll is no action", "answer_request: a message, a decline, a
plan the agent submitted; the refusals", "plan.submit {request} links the plan
and answers the request; the head revision is unchanged", `plan_methods_test`
"a plan submitted with a request has the hash of the same plan without it",
`mcp_adapter_test` "tools/list: next_request and answer_request are propose
tools; submit_plan takes a request"; 3 "agent.cancel_request cancels an open
request; next_request does not deliver it", "DELETE, idle and session.open
expire the open requests", "agent.requests lists the open requests and the last
16 closed ones"; 4 "plan.submit {request} ..." (plan `validated`,
`session.inspect`'s head unchanged); 5 the gate's resolution in the manifest;
6 "engine.capabilities lists the request methods, features.agentRequests and
the request limits", app `capabilities` (`capabilities-full.json`) and
`session-client` "agent.request, agent.cancel_request and agent.requests go out
as typed calls; agent.request_changed reaches a listener"; 7 none (no UI).

### M5b (not landed), M6a, M6b, M6c, M7 (not started)

No code, so no tests. What matters now is whether each acceptance item says how
it will be tested. Share of acceptance items that name a test (unit, e2e,
ctest, ...): M5b 60/133 (the nine UI features that own mockup parts each gained an item for those parts, layer F: since 2026-11-17 "ported from the mockup's markup, side-by-side screenshot attached", with the fidelity run as a report; the four test-gap features appended later are not in this count; `m5b-engine-record`, `m5b-engine-master` and `m5b-engine-clip-fades` (1/4 before its plan, 4/4 since) moved to the table above), M6a 1/3, M6b 0/3, M6c 2/3, M7 1/3. Weakest in M5b:
`m5b-engine-markers` 0/4, `m5b-engine-punch-count-in` 0/5,
`m5b-ui-edit-more` 3/10 (`m5b-engine-buses-sends` moved to the table above).

Added on 2026-11-15, with the maintainer's decision that no part of the mockup
is unowned (UI redesign 10.5); not in the counts above:

| Feature | Wave | After | Owns (layer F) | Tests its acceptance names |
|---|---|---|---|---|
| `m5b-engine-plan-metadata` (E-7, E-14; landed, see the table above) | 1 | | | protocol and MCP tests: limits, actor, note in status and changed, `agent.changed`; hash unchanged by a title (native and `src/hash/plan-hash.js`) |
| `m5b-ui-signature` | 1 | | `display-signature` | unit: the cell and the bar maths read one constant |
| `m5b-engine-load-loudness` (E-13; landed, see the table above) | 2 | | | conformance: BS.1770 / EBU Tech 3341 signals at three rates; realtime allocation guard |
| `m5b-engine-agent-requests` (landed, see the table above) | 2 | `m5b-engine-plan-metadata` | | protocol tests: states, scopes, bounds (4,000 characters, 16 open per agent, `agent_busy`), the `next_request` long poll, a second client; gate `agent-request-shape` (resolved) |
| `m5b-ui-plan-metadata` | 2 | `m5b-engine-plan-metadata` | `agent-row`, `plan-title`, `plan-intent` | e2e with a reduced capabilities fixture; the fidelity session's plan carries its title; unmasks the history rows (`plan-history-1` to `plan-history-3` leave `pixels.dynamic`) |
| `m5b-engine-track-notes` | 3 | | | command tests: validation, undo, replay |
| `m5b-ui-meter` | 3 | `m5b-engine-load-loudness` | `dsp-load`, `strip-master-loudness`, `tab-meter` | e2e with a reduced capabilities fixture |
| `m5b-ui-composer` | 3 | `m5b-engine-agent-requests`, `m5b-ui-plan-metadata` | `composer` | e2e with an MCP client: sent, taken, answered by a plan, declined, cancelled; `agent_busy` shown |
| `m5b-ui-notepad` | 4 | `m5b-engine-track-notes` | `inspector-notepad` | e2e with a reduced capabilities fixture; one revision per commit |
| `m5b-ui-editor-channel` | 4 | `m5b-ui-edit-more` | `tab-editor`, `zone-button-channel` | one revision and one undo per edit in the editor |
| `m6a-ui-automation` (M6a) | 3 | `m6a-lanes`, `m6a-write-passes` | `*-read`, `*-write`, `strip-*-automation`, `inspector-automation` | e2e with a reduced capabilities fixture |

`m5b-ui-keymap` (wave 6) now also waits for `m5b-ui-signature`, `m5b-ui-meter`,
`m5b-ui-composer`, `m5b-ui-notepad` and `m5b-ui-editor-channel`, and the
walkthrough's tour states start at 46.
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
| runtime client | `ws-codec`, `runtime-client` (in-process fake engine), `runtime-engine` (G) | | |
| command runner | `bridge-runner` (fake engine), `bridge-cli` and `rollback-workflow` (fake engine process), G | | |

There is **no MCP server in Node**: MCP is served by the native engine
(`native/libs/protocol/src/mcp_adapter.cpp`, `POST /v0/mcp`). The Node bridge
speaks the native protocol since `m5b-bridge-native-client`:
`src/runtime/client.js` starts `siann-engine` and talks to its WebSocket with
the codec in `src/runtime/ws.js`; `src/bridge/runner.js` maps command files
onto session.create, media.import, plans, session.save and render.start.

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
| `mockup-fidelity.spec.ts` (F) | `SIANN_FIDELITY=1` (and its own Playwright project, `fidelity`) | **In CI** on ubuntu and windows (the `app` job sets the variable), as a report that never fails the job (decided by the maintainer, 2026-11-17), so it is run and uploaded on every such PR, not left to a manual test; listed here because the plain `npm test` of `app/` skips it. Locally: `node scripts/check-all.js --only app`, or the command in the runbook. macOS does not run it: the reference rendering is compared on two OSes and the Mac lane would add font rasterisation without adding a layout engine |
| `mockup-fidelity.spec.ts` "the mockup's measurement (<locale>)" (F on the mockup alone) | `SIANN_FIDELITY_MOCKUP_ONLY=1` with `SIANN_FIDELITY=1` and `SIANN_FIDELITY_MOCKUP_ROOT` (set by `scripts/fidelity-mockup-compare.js`); with the flag set the spec's app gate test skips, without it this test skips | **Not in CI**: it measures a worktree of the base commit, which the CI checkout does not have. The implementer of a change to `tokens.css`, `app/renderer/ui/*.css` or the mockup's script runs `node scripts/fidelity-mockup-compare.js` before the PR (first `m5-ui-tokens-spacing`) and attaches the result; the reviewer checks it at review |
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
| Node bridge (`src/`, `bin/`) | `node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' test/*.test.js` | 92.7 % | 80.7 % | 97.0 % | Retaken with `m5b-bridge-native-client` (2026-11-15; the audit's figures were 89.2 / 70.9 / 96.0 with `client.js` 84/57): `bin/siann.js` 80/42, `import-pack-plan.js` 81/72, `live-import-pack.js` 100/46 (branch), `import-pack.js` 94/75 (branch), `runner.js` 94/79, `client.js` 95/84, `ws.js` 97/93, `rollback.js` 100/100 |
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
| 2 | No method/tool/doc/fixture parity test (section 4) | High: an agent-facing method can ship without an MCP tool, doc or app capability entry, silently | native test: every `kMethods` entry is an MCP tool or in an explicit `kNotMcp` list with a reason; Node test: every method in a protocol doc table and the reverse (read `kMethods` from source); app unit: `capabilities-full.json` equals `kMethods` | `m5b-protocol-parity` (M5b wave 2) |
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
4. Engine-gated Node job against the native `siann-engine`: done by
   `m5b-bridge-native-client` (the `bridge-engine` job, layer G; gap 3 closed).
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
   and an app client unit test when the app calls it, and a Node bridge test
   (fake engine, plus layer G) when the bridge calls it.
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
9. **Every UI feature is ported from the mockup and reviewed by eye, and the
   fidelity run (F) is its report** (decided by the maintainer, 2026-11-17): its
   parts are owned by a rule of `app/test/fidelity/manifest.json`, its row in
   section 2 says so, and the pull request that lands it sets its gate from
   `pending` to `report` and attaches the side-by-side screenshots (app and
   mockup) of the states it changes with the report. No gate is `enforce` and
   no geometry or pixel result blocks. A part skipped as pending is named in
   the report, never silently dropped; a colour or size literal outside
   `app/renderer/tokens.css` fails `test/ui-tokens.test.js` on every OS, and
   that does block.
