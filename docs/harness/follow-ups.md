# Milestone follow-ups

Findings from reviews that did not block a merge. A milestone's `prerequisites`
point here; its first run takes the listed section into its features.

## Before M5: a session must not choose what code loads (from PR #55)

Taken into `m5-plugin-registry` (decided by Fable, delegated by the maintainer,
2026-11-09): the "Before M5" sections are M5's wave 1 and 2 features, built by the
workflow's TDD, verify and land loop before the UI features that depend on them,
rather than fixed by hand before the run. Each section below names its feature.

Found by the automated security review of `m4-plugin-node`. Neither is reachable
while the engine opens only the maintainer's own sessions; both must be fixed before
a session from anyone else can be opened (import, a shared bundle, the M5 UI's open).

- `PluginInstanceTable` loads `slot.path` from the document as given
  (`native/libs/playback/src/plugin_instances.cpp`, `descriptorOf`), so a session
  names a library and opening it runs that library. The spec calls the path an
  install hint. Resolve the plugin by `format` and `uid` through a registry of
  scanned, user-approved installs, use the path only to choose between known
  installs, and refuse a path outside it, a UNC path and a path inside the bundle.
- `blobPath` joins the `stateBlob` text to `<bundle>/blobs` without checking it is
  64 hex digits, so `sha256:../../x` reads a file outside the bundle as plugin
  state. Validate the id where the document is parsed and in `blobPath`.

Taken: `m5-plugin-registry` (Protocol v0 item 21) fixes both. Every load resolves
`{format, uid}` through `host::PluginRegistry` (installs keyed by `{format, path}`,
filled from `scan` and `--plugin-dir`, approved through `plugin.approve` and kept in
`--plugin-registry`); a slot's path is only a hint between approved installs, and a
UNC path, a path inside the bundle or an unregistered one is never opened.
`blobPath` throws `bad_state` for anything but `sha256:` and 64 lowercase hex digits.

What it leaves:

- A library holding several plugins (a VST3 shell, a CLAP file with more than one
  descriptor) is one install, approved as the first plugin its probe lists. The
  others in it stay unresolvable until installs are keyed by `{format, path, uid}`
  once probed.
- The e2e tests pass `--plugin-dir` through `SIANN_ENGINE_TEST_ARGS`, which the shell
  splits at spaces, so a plugin build path with a space in it cannot be given there.

## Before M5: the shell (from PR #47)

Taken into `m5-shell-hardening` (decided by Fable, delegated by the maintainer,
2026-11-09), except the session lock, which lives in the engine (the trust boundary,
where `session.open` is made to work) and is `m5-engine-sessions-devices`'.

- Two app instances can share one session: there is no `requestSingleInstanceLock`
  and no session lock. Fix before any UI can write to a session.
- No ready timeout: a launch that neither writes a ready line nor exits waits
  forever (`supervisor.ts`).
- A kill failure leaves a live child counted as gone: `failLaunch` never ends its
  stdin, and a failed SIGTERM never tries SIGKILL.
- `main.ts` has no permission handler: `getUserMedia` and notifications are granted
  in the renderer.
- The default menu exposes `toggledevtools` and reload. Check the packaged build.
- Untested: ready during stop, start twice, stderr trim, ready-line strictness, CRLF,
  and the window-open and navigation guards.
- `supervisor-process.test.ts`: stop the supervisor in `finally`, as a give-up
  regression still hangs the runner.
- The bounded quit wait on a wedged engine has unit and process tests but no e2e.

## Before M5: CLAP editor windows on the desktop target (gui extension embedding into a window siann-host-desktop supplies)

Done (2026-11-10) in `m5-clap-editor-window`: `host::EditorWindowFactory` in
siann-host-api, `JuceEditorWindowFactory` in siann-host-desktop, and the engine's
desktop build hands it to `ClapPluginHost` (spec, "siann-host: two targets, one
interface"; Protocol v0 item 19). The headless target supplies no factory and keeps
`editor_failed`.

Taken into `m5-clap-editor-window`, wave 2 after `m5-plugin-registry` so its tests
name the plugin the registry's way (decided by Fable, delegated by the maintainer,
2026-11-09).

Moved from "Before M4 wave 2". Decided by Fable, delegated by the maintainer,
2026-11-08: `plugin.open_editor` lands in `m4-plugin-node` and answers
`editor_failed` for a CLAP plugin on the desktop target until this window exists
(Protocol v0 item 19). M4's exit names no editor, and the M5 UI is the first to
open one by a click, so the window is M5's.

`ClapPluginHost` reports the gui extension in `capabilities().editor` and
`hasEditor`, and `openEditor` throws `editor_failed`: siann-host-clap has no window
to embed into, and the core must not gain one. The editor protocol method
(`m4-plugin-node`, last item) needs siann-host-desktop to supply a top-level window
and hand its native handle to the host, which then runs the gui extension's
create, set_parent and show on the main thread. Editors in the headless target stay
out, as the spec says.

## Before M5: the M4 exit's third-party restart (from PR #62)

The M4 exit check (2026-11-09) proved the restart only with the built-in plugins.
Decided by Fable, delegated by the maintainer, 2026-11-09: M4 stays
`exit_pending` with the maintainer's pluginval runs owed (runbook, "Human gates by
milestone"), and M5 starts. Not an M5 feature and not an M5 prerequisite (2026-11-09):
it is a test of M4's exit, not of the UI. An agent closes the restart gap in one small PR beside
M5's first feature: a `[engine][launch][crash][thirdparty]` case in
`engine_launch_test.cpp` puts the `SIANN_TEST_VST3` plugin in slot A with one
parameter set and the hostile plugin in slot B, crashes the engine through
`plugin.set_parameter`, relaunches, and checks slot A is `running` with its
parameter and latency restored. It SKIPs naming the variable when unset. Run it here
with TDR Nova, and on the Mac through `siann-macos`.

Windows half done (2026-11-09): the case is in `engine_launch_test.cpp` ("a
third-party plugin beside a crashing one comes back running with its parameter and
latency"). The moved parameter goes into slot A's state blob, written before the
instantiate, because a live `plugin.set_parameter` is not durable (Protocol v0 item
20) and a crash drops it; no method reads a parameter back yet, so the test checks
the value through the blob (a fresh instance in the test process reads it back) and
the relaunch's unchanged document hash. On this machine with `SIANN_TEST_VST3` set to
`C:\Program Files\Common Files\VST3\TDR Nova.vst3` it passes, 139 assertions: Nova's
"Band 1 selected" moved to 0, latency 184 frames before the crash and after the
relaunch, slot A `running` before and after playing again.

Mac half done (2026-11-10, through `siann-macos`, main a4b8f96): the same case with
`SIANN_TEST_VST3=/Library/Audio/Plug-Ins/VST3/TDR Nova.vst3` passes, 133
assertions, with the same parameter and 184 frames before and after the relaunch.

## Before the M5 exit: in-memory decoders trust the header (from PR #73)

- `decodeWav` and `decodeFlac` in `native/libs/media/src/audio.cpp` allocate
  `frames x channels` from the header (the RF64 sample count, the FLAC STREAMINFO
  total) before decoding; the size check guards only against `size_t` overflow.
  Grow as samples decode, or clamp to what the input bytes can hold, as PR #73 did
  for `computePeaks` and the WAV file reader, with a test whose header lies.

## Before the M5 exit: the plugin registry's minor findings (from PR #70)

- A library holding several plugins is approved as the first plugin its probe lists.
- `SIANN_ENGINE_TEST_ARGS` is split at spaces, so a plugin path with a space cannot
  be passed through it.
- The launch-time filter that skips installs inside the bundle runs against the
  launch bundle only: after `session.open`, an install inside the new bundle can
  still be listed by `plugin.registry` (approving or loading it is refused).
- Rooted paths with one leading separator, such as a path that starts with one backslash and a dot, are not refused;
  they resolve on the current drive and are not device paths.

## Before M4 wave 2: the graph driver says when blocks are coming (from m4-clap-host)

Taken into `m4-plugin-node` (decided by Fable, delegated by the maintainer,
2026-11-08): its acceptance names the three calls below, and the spec's "Threads
and waiting rules" M4 interim note records them.

`PluginInstance::setBlocksComing` exists so a CLAP `getState` or params flush waits
for the next block instead of pausing while the driver runs. Nothing calls it yet:
`m4-plugin-node` (PluginNode in a GraphDriver callback) calls it with true when the
driver's callback source starts and false after it stops, for each instance it
holds, and for an instance inserted while it runs. Until then `ClapPluginHost` falls
back to its guess from the last block (spec, "siann-host: two targets, one
interface").

## Before M5: the engine's device (from m4-engine-device)

Taken into `m5-engine-sessions-devices`, with the session lock from "the shell"
above (decided by Fable, delegated by the maintainer, 2026-11-09). Closed by that
feature: `engine.devices` and `engine.select_device`, the six MCP tools,
`session.open` rebinding the host, the media retry and the bundle lock (Protocol v0
item 22, docs/schemas/protocol-engine-v0.md).

- A protocol method to list and select devices, so a UI choice needs no restart.
- MCP tools for `transport.*` and `engine.status`: they are protocol methods only.
- `session.open` is `not_supported` in `siann-engine`: rebind the `EngineHost` (its
  playback engine and auditioner) inside `ServerOptions::openSession`.
- A session whose media cannot be loaded stays silent until a relaunch, even after a
  commit repairs it: let `EngineHost` load again then.

## Before M4: plugin hosting (from PR #48)

Decided by Fable, delegated by the maintainer, 2026-11-07. Taken into M4's features:
the engine running a device (new `m4-engine-device`, with ADR-0018 condition 4),
condition 1's test, per-instance timing, the no-lock check and the >31-channel guard.

Closed:

- Bench's `TimedDevice`: it already wraps `rt::CallbackTimer`, and the engine reports
  from the driver's own timer, so there is no second consumer.
- An X server with no window manager kills an opened editor with BadAtom. That is a
  CI artifact, not a product target, and CI runs openbox.
Deferred:

- MSVC's localized `/showIncludes` is not parsed, so a changed commit header does not
  rebuild `about.cpp` locally. `VSLANG=1033` had no effect on this machine's compiler.
  Workaround: delete `about.cpp.obj`. CI is not affected.

- `startInBackground` registers every engine launch with LaunchServices about 110 ms
  after spawn. Measure engine ready time with and without it on `siann-macos`; it
  becomes a feature only if the cost is over 100 ms.

## Before M6a: fader gestures (from m5-mixer)

1. `gesture.update` reaches the control dispatcher through the command inbox and
   the command thread (Protocol v0 item 24). If fader latency through that path is
   noticed, hand `param.set` from the protocol thread straight to `controlInbox`,
   keeping the lease checks on the command thread.
2. Multi-touch gestures: the renderer's `ReadModel` holds one gesture overlay and
   the `GestureController` one gesture, so two faders cannot move at once (the
   server's lease table already keys by target).
3. Record the start value next to the end value in the journal entry of a
   gesture's commit, with automation write passes (spec, "Gestures", M5
   amendments); `gesture.end` and `gesture.ended` report it until then.
4. The fake device meters only while the transport plays (frames carry no entries
   while stopped); the mixer's meters e2e test plays the transport. Decide whether a
   stopped engine should still meter its inputs once input monitoring arrives.
5. A realtime socket the engine closes on its own while the command socket stays
   open is reopened at the session client's next state change, not at once.

## Before M6b: recording (from PR #46)

1. Make an early end unmissable: add `endedBy: "seconds" | "overflow" | "interrupt"`
   next to `overflows` in the `record` result.
2. Record `overflows` and `endedBy` in the take manifest as an optional field, and
   surface it as a protocol event when recording reaches the protocol.
3. After an overflow, start a new take at the next block, so the rest of the
   performance is captured with a known gap.
4. Add an end-to-end CLI overflow test with a test-only `--ring-frames`, and cover
   the `--fake-speed` ring scaling.
5. Put `overflows` in the ready file, so the kill tests say "overflowed" instead of
   failing at `REQUIRE(child.running())`.
6. Stop the writer thread stalling: write the ready file without a flush, and move
   the periodic fsync off the drain loop.

## Where tests run

- GitHub Actions is the required gate. It has no audio device and no third-party
  plugin.
- The maintainer's Windows machine runs real VST3s (`SIANN_TEST_VST3`) and Docker
  for Linux. A shell from Git Bash hides Windows error dialogs; to see what CI sees,
  start the process with `SetErrorMode(0)`.
- A Claude session on the maintainer's Mac (`siann-macos`) builds and tests on
  request, without commit or push rights.
- A self-hosted GitHub runner is not used: the repository is public, so a pull
  request could run code on the maintainer's machine.
