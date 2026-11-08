# SIANN Native DAW Architecture

Date: 2026-10-14

Status: Accepted, revision 3.1 (realtime data flow resolved for M2, after review). Revision 2.1 was
accepted by [ADR-0016](../../adr/0016-build-native-cpp-daw-engine.md) on
2026-10-21; revision 3 was accepted on the same day to unblock M2.

Reviews of revision 1 (kept outside the repo):
`D:\research\siann-arch-review\review-codex.md`,
`review-claude-pane.md`, `review-fable-subagent.md`.
Reviews of revision 2: `rev2-review-claude-pane.md`, `rev2-review-codex.md` in the
same directory.

## Purpose

This document records the architecture for SIANN as a long-term, production-level
DAW that is natively operable by AI agents: an "open AI DAW" built from scratch in
C++, with a web-technology UI, a desktop shell, and a protocol that humans and agents
share equally.

It replaces the Ardour-derived engine direction (ADR-0003, ADR-0014). ADR-0015
(DAWproject export from the Node bridge) remains the shippable product and the
interchange path until the native app reaches M5. ADR-0016 supersedes ADR-0003 and
ADR-0014; see "Documents made stale by this decision".

Revision 2 incorporates three independent reviews. The main changes: the realtime
data flow is now specified (document vs prepared graph vs audio state, structural vs
parameter channels, retire queue), a latency model and automation precision contract
were added, the history model was unified into a revision DAG, recording and crash
recovery moved into the core design, the JUCE boundary was made honest (main thread,
GUI dependency, a separate JUCE-free host for embedded), MIDI, channel layouts, the
time model and the session format were specified, and milestones were reordered with
kill criteria.

Revision 2.1 records the decisions needed to start M0 and to freeze the M1
contracts: repository layout, WebSocket library, a framework-free `siann-host-api`
module, the hash and number encoding contracts, the revision envelope, write-ahead
log ordering, the time rounding rule, the job-then-command rule, and the M1 scope.
It also moves device-side realtime sample-rate conversion into M2, so sessions play
on devices that cannot run at the session rate (Windows WASAPI shared mode).

Revision 3 resolves the realtime gaps found in the review of revision 2: graph
ownership through a graph driver state machine, a thread table with an acyclic
wait graph, a control dispatcher as the single parameter producer, a complete
queue table, duck-and-swap graph transitions with one transition in flight,
generation-tagged locate, the recording offset per monitoring mode, and audition
without cached runtime graphs. Revision 3.1 applies an independent review of
revision 3: two ring slots per track for locate, pinned instance lifetimes,
epoch handling across a pending swap, non-blocking cross-thread messages with
device control on the main thread, a transition watchdog, parameter handling
during offline render, a write-pass end marker, and a calibrated recording
offset.
Realtime topics found in the review of revision 2 (graph ownership without a
callback, command-thread duties, queue completeness, locate, instance lifetime) are
deferred to revision 3, which must be accepted before M2 starts. See "Deferred to
revision 3".

## Decision summary

| Topic | Decision |
|---|---|
| Product | A production-level DAW (multitrack audio and MIDI, automation, plugins, routing, groups, VCAs, recording, bounce) that AI agents operate through reviewed, reversible plans |
| Engine | Written from scratch in standard C++ (C++20), headless, its own process |
| Engine base | No Ardour fork. JUCE only in the desktop host target (audio devices, VST3/AU hosting, plugin editor windows). A JUCE-free host target exists for embedded |
| Core purity | `time`, `model`, `command`, `midi`, the graph and built-in DSP depend on no framework; CI builds the core without JUCE |
| Threading v1 | One realtime audio thread processes the whole graph. Parallel graph processing is added later behind a deadline test |
| UI | Web technology (TypeScript), talking to the engine only through the SIANN protocol |
| Desktop shell | Electron. One Chromium everywhere, one UI test environment |
| macOS engine packaging | The engine ships as a helper app bundle inside the Electron bundle |
| Remote UI | The same web UI in a Chromium-based browser against a running engine |
| Agent access | MCP adapter over the same command layer the UI uses |
| History | One revision DAG is the single source of truth for undo, journal, plans and proposal branches |
| Hashing | RFC 8785 (JCS) canonical JSON, shared by the Node bridge and the C++ engine; document hash is an RFC 6962 Merkle tree over entity hashes (see "Canonical JSON and hashes") |
| Repository | Same repository: native code under `native/`, Electron app under `app/`, shared fixtures under `fixtures/` |
| WebSocket | IXWebSocket, pinned, behind a thin adapter, from M0 |
| Sample rate | Session rate is invariant; device-side realtime SRC in M2 when the device cannot run at the session rate |
| Reference | SoundCraft (`storytold/soundcraft`, MIT/Apache, Rust) for module layering and "every action is a command". Its realtime internals are explicitly not a reference (see "What we do not copy from SoundCraft") |
| Name | SIANN（聲） |

## Why these decisions

### Why C++ from scratch, not an Ardour fork

- Every major DAW core (Cubase, Pro Tools, Logic, Live, Bitwig, REAPER, Ardour) is
  C++. Realtime audio needs deterministic memory and no GC pauses; VST3, AU and CLAP
  SDKs are C/C++.
- The maintainer is fluent in C++ and not in Rust; for a multi-year project, fluency
  matters more than marginal language advantages.
- The Ardour fork path failed on Windows builds, carries GPL obligations, and Ardour
  9.5 ships its own MCP surface upstream that will not adopt SIANN's plan/review
  model. Owning the core makes the command/plan/journal model native.
- C++ keeps embedded Linux reachable.

### Why JUCE only in the desktop host

- Plugin hosting needs code that has met thousands of real plugins;
  `juce_audio_processors` has that history. `juce_audio_devices` covers ASIO,
  WASAPI, CoreAudio, ALSA and JACK.
- JUCE is not a thin library: on macOS its message loop must own the process main
  thread, and `juce_audio_processors` depends on `juce_gui_basics`/`juce_gui_extra`,
  which on Linux pull in X11. So JUCE cannot be "just a boundary" on a headless board.
  The design therefore has two host targets (see `siann-host`), and the core is
  framework-free so both targets share everything above the host.
- Tracktion Engine was considered as the fastest route to production features. It
  was not chosen because SIANN's model, command layer and journal must be the core,
  not an add-on to another model. A Tracktion decision gate is scheduled at the end
  of M2.

### Why a web UI with an Electron shell

- The UI becomes just another client of the command layer. ADR-0006 becomes a
  physical property of the system.
- The same frontend serves the desktop app and remote browser control.
- System-WebView shells (Tauri etc.) were rejected after experience showed WebKit and
  WebView2 diverge often enough to require per-engine UI fixes; a DAW UI (timeline,
  waveforms, automation curves, drag, high-rate meters, Canvas/WebGL) is the kind of
  UI that hits those differences. Electron ships one Chromium.
- Install size is irrelevant in this domain. VS Code and Figma desktop show Electron
  can host demanding professional UIs.

## Goals

1. Production-level DAW capability over time, defined by measurable criteria (see
   "Production-level criteria"), not by an open-ended feature list.
2. Every user-visible action is a typed command, reachable from UI, keyboard, CLI,
   protocol and MCP, with identical undo and journal behavior.
3. Agents propose; humans review and approve. Plans are hashed, approval is explicit,
   application is journaled, and session edits are reversible. External side effects
   (recorded audio, rendered files) are never destroyed by undo or rollback.
4. The core is portable to embedded Linux without the UI and without JUCE.
5. The project stays buildable and evolvable by a very small team for years.

## Non-goals (for now)

- Prompt-to-song generation inside the engine. Generative models plug in through
  provider adapters (ADR-0009).
- Pixel-perfect cloning of any existing DAW.
- Non-Chromium browsers for remote UI.
- Microcontroller targets.
- AAX plugin support.
- Real-time collaboration between multiple humans.

## Production-level criteria

"Production level" means these are met and covered by automated tests or recorded
manual runs:

- 64 tracks at 48 kHz, 128-sample buffer, 30 minutes playback, zero xruns on a
  reference machine per platform. An xrun here is a deadline miss: a device
  callback that took longer than its buffer period (`frames / deviceRate`).
  Disk-stream underruns and device-side SRC underfill are counted and reported
  separately, and must be zero as well (`siann-cli bench` reports all three).
- PDC error of 0 samples across direct, send, aux and sidechain paths (null tests).
- One hour of 16-track recording with a forced engine kill at a random time loses at
  most the last 1 second of audio and no session edits before the last journal fsync.
- Plugin crash during playback: UI survives, engine restarts, session recovers.
- Offline render equals realtime render (null test) for the same session.

Honest schedule: one person full-time reaches "lean production" in roughly 3 to 5
years. Milestones are designed so that something useful exists at every stage.

## System overview

```text
=========================== Clients (send commands, receive events) ===========================

  Electron app              Remote browser            MCP client              siann-cli
  (main: Node.js,           (Chromium only,           (Claude Code,           (headless tests,
   renderer: Web UI)         same Web UI)              Codex, ...)             replay, CI)
        |                        |                        |                        |
        +------------- WebSocket / HTTP (127.0.0.1 + token by default) ------------+
                                          |
=================================== siann-engine process ====================================
                                          |
   siann-protocol     ProtocolServer . McpAdapter . EventStream
                                          |
   siann-command      CommandProcessor . RevisionDag . Plan . Journal(WAL) . Jobs
                                          |
   siann-model        SessionDocument (immutable, structurally shared)
   siann-time         AudioTime / MusicTime . TempoMap . MeterMap . Timecode
   siann-midi         event lists, MIDI 1.0 now, UMP-ready
                                          |
   siann-graph        GraphCompiler . PreparedGraph . LatencyModel . StateMigration
   siann-engine       Engine . AudioThread . ParamChannel . Outbox . Butler . Transport
   siann-dsp          built-in processors, meters, loudness
                                          |
   siann-host-api     PluginHost . AudioDevice . MidiDevice . MediaReader
                      (pure interfaces, buffer views, event lists)
                                          |
   siann-host-desktop (JUCE)       |   siann-host-headless (no JUCE)
   AudioDevice, MidiDevice,        |   ALSA/JACK device, ALSA MIDI,
   VST3/AU host, editors           |   LV2 via lilv
   ClapPluginHost (shared by both targets)
                                          |
   siann-io           session bundle, media pool, blob store, DAWproject import/export
```

## Process model

```text
+--------------------- SIANN.app / SIANN.exe (Electron package) ---------------------+
|                                                                                    |
|  Electron main process (Node.js)                                                   |
|   |- BrowserWindow: Web UI (TypeScript); nodeIntegration off, contextIsolation on  |
|   |- spawns and supervises the engine; crash-loop backoff                          |
|   `- hands port + token to the renderer via preload                               |
|                                                                                    |
|  Engine (C++ process)                                                              |
|    macOS: SIANN.app/Contents/Helpers/SIANN Engine.app (LSUIElement=1)             |
|    Windows/Linux: siann-engine executable                                          |
|                                                                                    |
|   main thread       desktop: JUCE message loop (Cocoa/Win32 events, plugin         |
|                     instantiation, state get/set, plugin editor windows)           |
|                     headless: plain event loop                                     |
|   audio thread      realtime; v1 processes the whole graph alone                   |
|   command thread    the only session mutator; validates, applies, journals         |
|   compiler worker   builds PreparedGraph from immutable inputs                     |
|   control dispatcher gestures, parameter dispatch, meters to clients               |
|   butler thread(s)  disk read-ahead, seek prep, record write-through, peaks        |
|   protocol thread   WebSocket/HTTP/MCP I/O                                         |
+------------------------------------------------------------------------------------+
```

- The engine is the trust boundary. Only the command thread mutates the session.
- On desktop, the engine `main()` initializes JUCE, starts background threads, then
  enters the JUCE message loop on the main thread. JUCE-specific code stays in
  `siann-host-desktop`; the core never sees it.
- macOS: the engine is a helper app bundle with its own Info.plist and signature,
  hardened runtime and `com.apple.security.cs.disable-library-validation` (required
  to load third-party plugins). It temporarily switches activation policy to
  regular when opening a plugin editor. AU (especially AUv3) requires the host to be
  a bundle, which this satisfies.
- Windows: plugin editor windows are owned by the Electron window via
  `GWLP_HWNDPARENT` across processes for z-order. macOS cannot parent windows across
  processes; editors float and the engine activates itself. Float is what stands in
  for ownership there: the window sits at `NSFloatingWindowLevel`, so clicking the
  Electron window does not bury it, at the price of it staying above other
  applications too. The `macos-hands-on` gate judges whether that is acceptable.
  If it is not, the next step is conditional floating: the engine observes
  `NSWorkspaceDidActivateApplicationNotification` and keeps editors at
  `NSFloatingWindowLevel` only while Electron or the engine is the active
  application, at `NSNormalWindowLevel` otherwise, so an editor never covers a
  third application. The kill criterion in M0 applies only after both have been
  judged. The editor window also carries
  `NSWindowCollectionBehaviorFullScreenAuxiliary`, so it may join another
  application's fullscreen space instead of hiding behind a fullscreen Electron.
  The engine never calls `[NSApp finishLaunching]` (JUCE's message loop runs
  without it); the hands-on check watches for what that costs.
- The `siann-engine` executable (`native/apps/engine`, m0-electron-shell) is built
  by the core-only configuration too (CI builds it without JUCE). It links
  `siann::session`, `siann::protocol`, `siann::playback` and `siann::host_fake`; a
  `SIANN_WITH_JUCE` build also links `siann::host_desktop` and serves from
  `MainThreadLoop` on the main thread, where the core-only build sleeps between
  ticks. It is started as
  `siann-engine --session <bundle> [--host 127.0.0.1] [--port 0] [--mcp-trusted]
  [--owner-window <handle>] [--device <id>]
  [--device-backoff <initialMs>:<maxMs>:<resetAfterMs>] [--fake-callback-nanos N]
  [--fake-open-failures N]`
  and announces itself with the launcher handshake (siann-protocol, Protocol v0
  item 17).
- The engine runs the graph driver on a device (m4-engine-device). M4 interim note:
  the process's main thread is both the command thread and the control thread. The
  protocol server runs without a pump thread, and the main thread calls one tick at
  most every 10 ms between passes of its message loop: the server's pump (requests
  and events), the playback engine's tick (transport, dispatcher, driver poll,
  compiles), then the meter publisher. That keeps `GraphDriver`'s one non-realtime
  control thread, keeps device open, start and stop on the main thread ("Threads and
  waiting rules"), and is how `siann-cli` already drives the engine. A slow command
  delays a tick, never the audio thread; separate command and dispatcher threads
  arrive when the graph compiler moves off this thread. The graph compile runs on
  this thread too (m4-plugin-node, decided 2026-11-08): a plugin's instantiation is
  a synchronous call with no timeout, and the compiler -> main edge with a timeout
  in "Threads and waiting rules" describes the compiler thread to come; a slow
  plugin delays a tick, never audio.
- Device policy: `--device <id>` means what it means for `siann-cli play`. `fake` is
  the paced `FakeAudioDevice` with loopback and one buffer of input and output
  latency, on every build. `<type>/<name>` is a JUCE device of a `SIANN_WITH_JUCE`
  build; without the option that build opens the default output device of the first
  type, and a core-only build has no device. `--fake-callback-nanos N` times the
  driver's callbacks with a clock that advances N ns per reading, as in `siann-cli`
  (a usage error without `--device fake`), and `--fake-open-failures N` makes the fake
  device refuse its first N opens with `device_open_failed`, as a device another
  application holds does (the same usage error). A device failure at launch
  (`no_device`, `device_open_failed`, a core-only build's `no_audio_backend`) never
  fails the launch: the engine writes one diagnostic line to stderr and serves;
  `engine.status` shows `device: null` with `deviceError {code, message}`, and
  `transport.play`, `transport.stop` and `transport.locate` answer `no_device`. A
  session whose media cannot be loaded is served the same way, with the code in
  `deviceError`, and nothing is heard until a relaunch after its media is back. That
  is any failure to build the first graph: the engine's `media_missing`,
  `media_hash_mismatch` and `media_mismatch`, the readers' `unsupported_media`,
  `decode_failed` and `too_large`, and `load_failed` for anything else (an I/O error,
  say). One bad file must not end the process: the shell would restart it until it
  gave up, and the session could not be opened at all. A commit that needs such a file
  keeps the graph that plays, with one diagnostic line. A device that stops while the
  engine runs (`device_lost`) is served the same way too.
- Reopening the device: the shell restarts only an engine that exits, and an engine
  without a device serves on, so the engine does the retrying, under the shell's
  backoff. The shell passes its own constants with `--device-backoff` (without it the
  engine uses the same defaults: 250 ms, 10 s, 30 s). After a failed open or a
  `device_lost` the main thread opens the device again from its tick, the delay
  doubling from `initialMs` to `maxMs`; the count resets once a device has run for
  `resetAfterMs`. A relaunch after a crash that finds the device still held is this
  same path. Unlike the shell's restarts the retries never give up, because the engine
  is serving and a device can come back at any time; `no_audio_backend` and a session
  that did not load are not retried. Each new reason goes to stderr once, and
  `engine.status` shows the latest in `deviceError`. A reopened device starts stopped
  at the playhead, its counters from zero. An open runs on the main thread, so a slow
  one delays a tick, never audio.
- `--owner-window` carries the Electron window's native handle (decimal; the
  HWND on Windows). The shell creates its window first, so it has the handle to
  pass, and reads it again for every restart; only Windows uses it, and the core-only
  build accepts and ignores it. `--open-editor` was M0's only way to reach an
  editor, which the `macos-hands-on` gate and `m0-exit-signed` ran through: the
  engine probed the bundle, instantiated it and opened its editor, owned by that
  window, before the ready line. M4 (m4-plugin-node) removes the flag and the
  shell's `SIANN_OPEN_EDITOR`: `plugin.open_editor {slotId}` and
  `plugin.close_editor {slotId}` (Protocol v0 item 19) open and close the editor
  of a plugin in the graph on the engine's main thread, owned by `--owner-window`
  on Windows, and the two gates open an editor through the method. A core-only
  build answers `no_plugin_host`. Decided by Fable, delegated by the maintainer, 2026-11-08.
- Session at launch: `--session <bundle>` is required. When the directory does not
  exist the engine creates a new empty session there (`Session::create` with
  `Document::create(<bundle stem>, 48000, 120000)`), otherwise it calls
  `Session::open`. In M0 the Electron shell passes
  `<app.getPath('userData')>/sessions/Untitled.siann` (overridable by
  `SIANN_SESSION_DIR` for tests); opening and recent sessions arrive with M5.
- Crash-loop backoff: the shell restarts the engine after a delay that doubles from
  250 ms to a 10 s cap; the counter resets once the engine has stayed up 30 s;
  the shell allows 5 consecutive restarts (`SIANN_SHELL_MAX_RESTARTS`), so the exit
  after the fifth restart, the sixth exit in a row, ends the restarting and shows
  the exit code and the last stderr lines. The delays are shell constants that
  `SIANN_SHELL_BACKOFF_MS` and `SIANN_SHELL_MAX_RESTARTS` override, so tests run
  fast. A restart yields a new port and token (item 7: per-launch); the renderer
  receives the new pair through the preload API (`window.siann.engine.current()`
  and `onChange`) and reconnects. The M0 renderer holds no read model: it shows
  what the auth reply carries and does not call `session.sync`; a client that
  keeps a read model resyncs as in item 11.
- Ending the engine: the engine catches SIGTERM and only sets a flag its main
  thread polls, so neither stdin EOF nor SIGTERM ends a wedged engine. On quit the
  shell closes the engine's stdin and sends SIGKILL after 5 s. A failed launch (a
  bad ready line) gets SIGTERM, then SIGKILL after 2 s. In both cases, if no exit
  follows 2 s after SIGKILL the shell counts the engine as gone and carries on, so
  quitting and restarting are always bounded. The worst case for a quit is about
  11 s: a launch that fails just before the 2 s after SIGKILL run out starts the
  failed-launch sequence again, so 5 s, then 2 s, then 2 s, then 2 s. On Windows
  both signals are `TerminateProcess`.
- Crash: Electron restarts the engine with backoff; the engine recovers from the
  last checkpoint plus journal replay; the UI reconnects and resyncs. Exclusive-mode
  and ASIO devices may need a retry delay before reopening. The engine raises no
  dialog when it crashes: on Windows `main()` sets
  `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)` and
  `_set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT)` before any plugin
  loads, so a plugin crash ends the process at once instead of waiting on a WER or
  CRT dialog until the shell's kill path (m4-crash-recovery). A crash before a live
  parameter change is captured leaves the last durable revision, so the relaunched
  engine never re-runs the change that crashed the plugin ("Gestures", Protocol v0
  item 20). Decided by Fable, delegated by the maintainer, 2026-11-08.
- Plugin sandboxing (one or more plugin worker processes) is a later milestone. The
  `PluginHost` interface is shaped for it from day one (see `siann-host`).

## Realtime data flow

This section is normative. It is the part of the design most expensive to change
later.

### Three layers of state

| Layer | Owner | Mutability | Contents |
|---|---|---|---|
| `SessionDocument` | command thread | immutable values, structurally shared | tracks, clips, routing, automation, plugin slots (by ID + state blob reference), tempo, markers |
| `PreparedGraph` | built on command thread, then handed to the audio thread | immutable topology; owns preallocated buffers | nodes, schedule order, delay lines sized for PDC, references to plugin instances, flattened clip lists and automation segments |
| Audio state | audio thread only | mutable | plugin instances' runtime state, delay line contents, smoothers, meters, playhead |

The audio thread never reads `SessionDocument`. Everything it needs is flattened
into the `PreparedGraph` (clip lists sorted by time, automation as preevaluated
segments, tempo map as a lookup table).

### Two channels into the audio thread

1. **Structural channel**: adding/removing tracks, plugins, sends, routing changes,
   latency changes, and clip or media edits (anything that changes a track's
   flattened clip list). A compiler worker builds a new `PreparedGraph`, and the command
   thread publishes it through the graph driver (see "Graph ownership"). At most one
   structural transition is in flight. Throughput: occasional.
2. **Parameter channel**: gain, pan, mute, send level, plugin parameters, transport.
   A bounded SPSC queue of `ParamChange{slot, paramId, value, rampFrames, epoch}`
   applied at the start of the next block (or at a sample offset for sample-accurate
   targets). `slot` is the node's index in the compiled graph with that `epoch`. The
   audio thread drops changes with an older epoch, applies changes with the current
   epoch, and stops draining at the first change with a newer epoch, which stays at
   the head of the queue until that graph is swapped in. Transport changes carry no
   epoch and travel on their own SPSC lane of the parameter channel, `transportInbox`,
   so a graph swap in flight never holds them back. No snapshot, no recompile. Throughput: up to hundreds per second.

The **control dispatcher** thread is the only producer of `paramInbox`. Gestures from
the protocol thread, plugin editor edits from the main thread and committed values
from the command thread all reach it through `controlInbox`. It keeps, for each
published graph, the map from entity ID to slot, and the overlay of values held by
open gestures; after every graph publication it re-sends the overlay with the new
epoch, so a fader drag continues across a recompile. When `paramInbox` is full it
keeps only the latest value per (slot, param) and retries on its next tick.

Continuous gestures (fader drags, knob turns, Touch/Latch automation) use the
parameter channel for every intermediate value. The command layer records only the
gesture boundaries (see "Gestures").

### Threads and waiting rules

| Thread | Does | May block on |
|---|---|---|
| audio | processes the live graph; pushes outboxes | nothing of SIANN's; inside a hosted plugin's `processBlock`, JUCE's wrapper locks, held by the main thread (the exception under "Realtime rules and enforcement") |
| main | JUCE message loop; plugin instantiate, destroy, state, editors; audio and MIDI device open, start and stop | the audio callback exiting, inside `AudioDevice::stop()`; the block in flight, inside `PluginControl::setState` (`ProcessingPause`, at most one block); the same, inside `ClapPluginHost::runMainThreadCallbacks`, for a CLAP plugin's restart (deactivate and activate) and for a params flush when no block is coming (the driver has said so with `PluginInstance::setBlocksComing(false)`, or, told nothing, none has come for 50 ms or four block periods, whichever is longer); the next block, inside a CLAP `getState` with a value still on its way (no pause) |
| command | validates, applies and journals commands; publishes documents; asks for compiles; installs graphs through the driver | journal and checkpoint I/O |
| compiler | builds `PreparedGraph` from an immutable document and pinned instances | the main thread, for instantiation, with a timeout |
| control dispatcher | gestures, overlays, `paramInbox`, meters to the protocol | nothing outside its own inbox |
| butler | disk read-ahead, seek preparation, record write-through, peaks | disk I/O |
| protocol | WebSocket/HTTP/MCP I/O | network I/O; the command thread's answer to an MCP HTTP request (bounded by `ServerOptions::mcpRequestTimeout`, see Protocol v0 item 15) |
| offline render | drives a graph for bounce and export | disk I/O |
| MIDI driver | the platform's MIDI input callbacks | nothing (platform owned) |

- Every message between threads is pushed without blocking. A full queue means the
  sender coalesces (latest value per key) or receives a `queue_full` error for that
  request; nobody waits for space.
- Requests between non-realtime threads are messages with completion messages,
  never synchronous calls. Device control runs on the main thread (JUCE and ASIO
  expect that); the command thread asks for it and continues on the completion.
- The blocking edges are compiler → main (instantiation), main → audio
  callback (inside `stop()`), main → audio callback (one block, inside `setState`,
  and inside a CLAP plugin's restart or idle params flush), main → audio callback
  (the next block, inside a CLAP `getState` with a value still on its way; no pause),
  protocol → command (an MCP HTTP request waits for
  its answer, with a timeout; a full inbox is `queue_full` at once) and, with a
  hosted plugin in the graph, audio callback → main: inside `processBlock` the
  audio thread takes JUCE's `processMutex`, which the main thread holds across a
  plugin-initiated restart, and a parameter's `listenerLock`, which the main thread
  holds while running the listeners of a parameter it edits. The command thread
  never waits on the protocol thread. The audio ↔ main pair is the one two-way edge.
  The argument that no cycle closes: the main thread waits for the audio thread
  only in `AudioDevice::stop()`, `ProcessingPause` and a CLAP `getState`'s wait for
  a block (`ClapPluginHost` takes no lock the audio thread could wait on). It holds `processMutex`
  inside JUCE's `reset`, `prepareToPlay`, `releaseResources`,
  `updateMidiMappings` and `isBusesLayoutSupported`, and SIANN's code can run there: a plugin that changes its
  latency in `prepareToPlay` makes JUCE's client wrapper ask for a `kLatencyChanged`
  restart, which the host runs on the message thread at once (`setLatencySamples`,
  SIANN's `audioProcessorChanged`, `readLatency`, `readTail` and the event sink),
  all under `processMutex` (JUCE's client notes the same call stack for Wavelab);
  and it holds `listenerLock` while a parameter's listeners run, the plugin's own
  and the sink. So the adapter's listener code and the sink run under JUCE's locks,
  under `processMutex` as well as `listenerLock`, and the rule that keeps the graph
  acyclic is that nothing SIANN runs there waits: the adapter reads values into
  atomics and calls the sink; the sink pushes to `pluginEventAny` and does nothing
  else, never `setState` (its `ProcessingPause` would wait for a block that may be
  inside `processBlock` waiting for the lock the sink holds), `setParameter`,
  device control or any other wait for the audio thread. Measured by review: a
  sink that spun 30 ms under `processMutex` on each of four events held the audio
  thread at zero blocks throughout. The table's "at most one block" for
  `ProcessingPause`, and `stop()`'s bound, hold for a plugin whose `processBlock`
  returns; one that waits on the message thread inside `processBlock` hangs the
  main thread in either, with no timeout (worker processes are the remedy). A
  plugin that calls `restartComponent` with a flag that takes `processMutex`
  (`kReloadComponent`, `kIoChanged`, `kMidiCCAssignmentChanged`) from inside its
  own `setActive` deadlocks JUCE's non-recursive `SpinLock` by itself;
  `kLatencyChanged` takes no lock and is fine there. Adding a blocking call
  requires updating this table and showing the graph stays acyclic.
- The compiler reads only immutable inputs: the document, the previous graph's
  descriptor (node identities, slots, latencies) and the instance table. It never
  reads live DSP state.
- M4 interim (m4-plugin-node; decided by Fable, delegated by the maintainer, 2026-11-08):
  `pluginEventAny`'s consumer is the `EngineHost` tick on the main (command)
  thread. `latencyChanged` re-reads the instance's latency, and the `PluginNode`'s
  next block reports it through the graph's latency outbox, which
  `GraphDriver::poll` answers with a recompile; `restartRequested` re-reads tail
  and parameters and polls the JUCE adapter's tail-stale flag; `parameterEdited`
  is counted and dropped until editor edits become gestures (M6a, "Gestures");
  `failed` marks the slot's instance for replacement ("siann-host", Hostile test
  plugin); an overflow sets the instance's resync flag and the tick re-reads
  latency and parameters. The host's instance table calls
  `PluginInstance::setBlocksComing(true)` on every pinned instance when the
  driver's device starts, `false` after it stops, and `true` on an instance
  pinned while it runs (the follow-up "the graph driver says when blocks are
  coming", taken into m4-plugin-node).

### Queues (all bounded, preallocated)

| Queue | Producer → consumer | Kind | Payload | Overflow policy |
|---|---|---|---|---|
| `graphInbox` | command → audio | SPSC, capacity 1 | `PreparedGraph*` + epoch | cannot overflow: one transition in flight |
| `retireOutbox` | audio → command | SPSC, capacity 1 | retired `PreparedGraph*` + epoch | cannot overflow: one transition in flight |
| `paramInbox` | dispatcher → audio | SPSC | `ParamChange` | dispatcher coalesces per (slot, param) and retries |
| `transportInbox` | dispatcher → audio | SPSC | `TransportCommand{generation, position, play}` | bounded; the dispatcher keeps the latest locate pending and retries on its next tick |
| `controlInbox` | protocol, main, command, butler → dispatcher | MPSC, mutex | gestures, editor edits, committed values, locate, seek-ready | bounded; never waited on: coalesce per key or reply `queue_full` |
| `commandInbox` | protocol, main, compiler, butler, dispatcher → command | MPSC, mutex | requests, completions, gesture commits | bounded; never waited on: reply `queue_full`; gesture commits are coalesced per target |
| `midiInbox[device]` | MIDI driver thread → audio | SPSC per device | timestamped MIDI 1.0 events | drop and count; the audio thread then sends all-notes-off on the affected channels |
| `diskRing[track][2]` | butler → audio | two SPSC rings per playing track: the current and the pending slot | audio frames of one seek generation per slot | underrun outputs silence and counts a disk underrun (not an xrun) |
| `butlerRequest` | audio → butler | SPSC | refill hints (track, consumed position); slot releases after a locate | latest-wins per track for hints; releases are never coalesced; the butler also polls |
| `butlerControl` | command → butler | MPSC, mutex | add stream (with start position and the locate generation it was read under), remove stream | bounded; never waited on; completions (stream ready, stream released) are atomics read by the command thread on its tick; if a new stream is not ready within 1 s the graph is published anyway, and the player outputs silence and counts underruns until the butler has taken it |
| `seekRequest` | dispatcher → butler | MPSC, mutex | target position + generation | a newer generation replaces an older one |
| `recordOutbox` | audio → butler | SPSC ring | input blocks of armed tracks | overflow is a reported error, never a block: the take ends at the last frame before the block that did not fit, so a take never has a hole |
| `meterOutbox` | audio → dispatcher | SPSC | meter blocks, playhead | latest-value-wins; drop when full |
| `automationOutbox` | audio → command | SPSC, per write pass | `(param, sample, value)`, then an end marker | thin in place and count; the end marker always has a reserved slot |
| `pluginEventRt` | audio → command | SPSC | events raised inside `process()` (parameter output, latency changed) | coalesced per instance |
| `pluginEventAny` | plugin callbacks on any thread → command | lock-free bounded MPSC | editor edits, restart and latency requests | producer never blocks; on overflow sets the instance's atomic resync flag, and the command thread re-reads its parameters and latency |

### Graph ownership

Whoever calls `PreparedGraph::process()` owns the live graph. The **graph driver**
records who that is:

| Driver state | Owner of the live graph | How a new graph is installed |
|---|---|---|
| `stopped` | command thread | installed directly; the old graph retires at once |
| `realtime` | audio callback | pushed to `graphInbox`, swapped at a block boundary, acknowledged through `retireOutbox` |
| `offline` | the offline render loop | not changed while rendering; edits wait for the render to finish or cancel it |
| `stopping` | nobody until `AudioDevice::stop()` returns | queued until the state is `stopped` |

- `start`: the graph is handed to the audio state before the device starts, so no
  callback can see a half-installed graph.
- `stop` and device loss: the main thread calls `AudioDevice::stop()`, which returns
  only after the callback has exited and will not run again (a host contract). The
  audio state's current-graph pointer is then authoritative: if `graphInbox` still
  holds a pending graph, it is installed directly as live and the old graph retires;
  `retireOutbox` is drained; the state becomes `stopped`.
- Watchdog: a transition that is not acknowledged within 500 ms of audio time (or
  when the device reports itself invalid) moves the driver to `stopping` and asks the
  main thread to stop the device, so a silent device cannot block structural edits.
- Bounce and export stop realtime playback and move the graph to the offline driver,
  then back. M2 does not render offline while playing, so instances are never driven
  by two threads. During an offline render the dispatcher keeps parameter changes in
  its overlay instead of `paramInbox`; the render uses only the document and its
  automation. On return to realtime the overlay is re-sent with the live epoch.

### Publishing and retiring graphs

- The audio thread holds a raw pointer to the live `PreparedGraph`. Each graph
  carries an epoch.
- A transition is duck-and-swap, not a crossfade between two running graphs: the
  audio thread ramps the outputs of affected paths in the old graph to zero over
  the fade length (default 5 ms), swaps at the next block boundary, and the new
  graph ramps those paths up again. Unaffected paths are untouched (M2 ducks the
  whole output for structural edits; see the M2 interim notes under "Status").
  Exactly one
  graph is processed per block, so a reused plugin instance is never processed
  twice.
- After the swap the audio thread pushes the old graph to `retireOutbox`. Only then
  may the next transition publish; compiling the next graph may already have started.
- Instance lifetime is tracked by pins in the instance table, owned by the command
  thread and keyed by runtime instance identity (not slot ID). The live graph, a
  published graph not yet swapped in, and every compile in progress each pin the
  instances they use (a compile pins its inputs when it starts). On the retire
  acknowledgement the old graph's pins are released, and an instance is sent to the
  main thread for destruction only when its pin count reaches zero. A compile whose
  result is discarded (superseded by a newer revision) releases its pins and
  destroys the instances it created.
- If several revisions arrive during one compile, the next compile uses the latest
  document only.
- No `shared_ptr` whose count can reach zero is ever touched on the audio thread.
  `std::atomic<std::shared_ptr>` is not used (not lock-free on libstdc++ or MSVC).

### State migration

- The compiler reuses every plugin instance, delay line, smoother and meter whose
  entity ID is unchanged, looked up in the instance table and pinned for the
  compile. New plugins are
  instantiated on the main thread at the compiler's request before publication;
  removed ones are destroyed after the retire acknowledgement.
- Disk streams are reused when the track's flattened clip list is unchanged. A new
  or changed track gets a new `DiskStream`, registered with the butler and prefilled
  from the current playhead before the graph is published. If the butler is not
  ready within 1 s, the graph is published anyway (as a late locate proceeds) and
  the stream's underruns are counted and reported until it catches up. The
  registration carries the generation of the last applied locate, read before the
  playhead; when the butler has prepared a newer locate, the stream joins it with
  a second slot prefilled from that locate's target. The graph driver replays the
  last applied locate on every graph it swaps in, so a stream compiled before a
  locate that lands before its graph is published still follows it; streams that
  already follow that generation ignore the replay. The streaming player
  aligns to the timeline by position (slot start plus frames consumed versus the
  block start), so a stream created at compile time plays in time after a later
  swap. On the retire acknowledgement of the last graph that used a stream, the
  command thread asks the butler to remove it; the stream is destroyed only after
  the butler acknowledges the removal. A discarded compile removes the streams it
  created the same way.
- Reverb tails and compressor envelopes survive unrelated edits.
- When a plugin's latency changes, the affected paths recompile; their delay lines
  are rebuilt and the paths are ducked and restored as above.

### Locate

- `transport.locate(target)` goes to the dispatcher, which sends a `seekRequest` with
  a new generation to the butler.
- The butler fills the pending slot of each playing track's `diskRing` from the
  target (default prefill 250 ms), tags it with the generation and publishes the
  ready generation, which the dispatcher reads on its tick (a `controlInbox` message
  once the protocol thread exists in M3). The current slot keeps serving the old
  position, so playback continues untouched.
- The dispatcher then sends the locate through `transportInbox`. At the next block
  boundary the audio thread moves the playhead, swaps each track's current and
  pending slots itself, ducks the master around the jump, and returns the old slot
  to the butler through `butlerRequest`. The butler never touches a slot the audio
  thread is reading, so each ring stays single-producer single-consumer.
- Until ready, playback continues from the old position. A newer locate cancels an
  older one. If the butler is not ready within 1 s, the locate proceeds and any
  underrun is counted and reported.
- Play from stop is a locate to the current position followed by transport start.
  The locate command carries the start, so the playhead moves and starts advancing
  at the same block boundary. The offline
  driver reads media synchronously and needs no handshake.

### Realtime rules and enforcement

- The audio thread never locks, allocates, frees, logs, throws, or performs I/O.
  One exception, accepted for M0 on 2026-11-07 (Fable, delegated by the maintainer,
  who may overrule it; [ADR-0018](../../adr/0018-accept-juce-wrapper-locks-inside-hosted-processblock.md)):
  the locks JUCE's own hosting wrappers take inside a hosted plugin's
  `processBlock`, listed under "Locks inside a hosted plugin's `processBlock`"
  below. It is not a licence for SIANN's own code, and it ends when hosted plugins
  run in worker processes (Open questions, item 1). Catching what a hosted plugin
  threw out of `process()` ("siann-host", Hostile test plugin) is not SIANN
  throwing: the handler's cost falls only on the plugin that threw.
- Debug builds mark the audio thread with a thread-local flag; global `operator
  new/delete` and malloc hooks count a violation when called on a marked thread
  (`siann::rt::allocationViolations()`), which the tests that link
  `siann_rt_alloc_guard` assert is zero across the audio path.
- Clang RealtimeSanitizer (`-fsanitize=realtime`) runs in CI on platforms where
  Clang 20 or later is available (the Linux RTSan job; see "Build, test and CI").
  The sanitizer's realtime context is tied to `siann::rt::ScopedRealtimeThread`:
  in an RTSan build (`SIANN_RTSAN=ON`) its constructor and destructor call
  `__rtsan_realtime_enter` and `__rtsan_realtime_exit`. Every device (manual,
  fake, JUCE) opens that scope around each audio callback, so the graph driver's
  `process()` and everything it calls (nodes, recorder, disk streams, SRC) are
  checked without annotations. The fake device's pacing and stall sleeps run
  outside the scope, as a real driver's wait for the hardware would.
- `[[clang::nonblocking]]` is not put on `process()` or the callbacks: Clang's
  function-effect analysis then warns on every call to an unannotated callee
  (`std::function`, node virtuals, r8brain), which `-Werror` turns into a build
  failure across the whole graph; GCC and MSVC also warn on the unknown
  attribute. The runtime scope gives the same coverage.
- Tests that break the rules on purpose (the allocation guard's self-test, a
  callback that sleeps to test `stop()`) open
  `siann::rt::ScopedRealtimeSanitizerDisabler`, with the reason in a comment at
  each use; production code never does. Known-unavoidable calls would go in a
  suppressions file passed through `RTSAN_OPTIONS`, one documented reason per
  entry; there are none, so the job runs without one. Canaries (an allocation, a
  lock and a sleep inside the scope) must be reported, or the job fails.
- Diagnostics from the audio thread go through a lock-free log ring drained by a
  non-realtime thread (for example rtlog-cpp); spdlog is used only off the audio
  thread.
- Locks inside a hosted plugin's `processBlock`. SIANN takes no lock in
  `PluginInstance::process`, but JUCE's hosting wrappers do, and third-party plugin
  code is outside any guarantee. What JUCE 9.0.3 (pin `be29c81`) runs inside
  `processBlock`, read in full (`juce_VST3PluginFormatImpl.h`, `juce_VST3Common.h`,
  `juce_AudioProcessorParameter.cpp`, `juce_AudioUnitPluginFormatImpl.h`, and for
  the MIDI output they build, `juce_MidiMessage.cpp` and
  `juce_MidiDataConcatenator.h`); this list is the audit, repeated by
  m4-juce-formats on 2026-11-09 at the same pin (ADR-0018, Amendment 3), and a JUCE
  pin bump repeats it:
  - VST3, every block: the per-instance `SpinLock processMutex`. The main thread
    holds it across the plugin's `setActive` in `reset()` (a `kReloadComponent`
    restart), `prepareToPlay` (with `setupProcessing` and the bus arrangement) and
    `releaseResources`, and without `setActive` in `updateMidiMappings` (a
    `kMidiCCAssignmentChanged` restart) and `isBusesLayoutSupported`. VST3 forbids
    `process` during `setActive`, so something must keep them apart, and JUCE
    offers neither a try-lock nor a hook before the restart (`processMutex` is
    private; `processBlock` never calls `SpinLock::tryEnter`; the restart reaches
    SIANN's listener only after the work). While the main thread holds it the
    audio thread waits (`SpinLock::enter` tries 20 times, then yields in a loop):
    for a `setActive` restart as long as the plugin's `setActive` takes, an xrun
    on the affected block. Passing the block through instead would need a patched
    JUCE, which SIANN does not carry (see below). A `kLatencyChanged` restart
    takes no lock and calls no `setActive`. Between the two halves of a
    `kIoChanged` restart the plugin is inactive, `processBlock` does nothing and
    `process` passes its input through.
  - VST3, every block: `MidiEventList::events` is an
    `Array<Vst::Event, CriticalSection>`; `associateWith` clears the input and the
    output list (`clearQuick`, one lock each), two uncontended mutex takes per
    block, since only the audio thread touches them. A plugin that produces MIDI
    adds each event under the same lock (`events.add`), and the array grows, so a
    MIDI-producing plugin can allocate on the audio thread inside JUCE;
    `toMidiBuffer` then appends to SIANN's `juce::MidiBuffer`, preallocated since
    m4-plugin-node for `kMaxBlockOutputEvents` events of `midiEventBytes` (2048 × 9
    bytes), which grows past that. Each sysex event the plugin outputs allocates
    on its own, whatever the count (found by the m4-juce-formats re-audit,
    2026-11-09; ADR-0018, Amendment 3): `toMidiMessage (DataEvent)` calls
    `MidiMessage::createSysExMessage` (`juce_VST3Common.h:1506`), which mallocs and
    frees a `HeapBlock` of the event's size (`juce_MidiMessage.cpp:694`) and, for a
    message over 8 bytes, mallocs again in `MidiMessage::allocateSpace` (`:349`),
    freed once `addEvent` has copied the bytes. Notes and controllers fit the
    8-byte inline store and allocate nothing. SIANN hands the plugin an empty MIDI
    input, so the input side never adds.
  - VST3, per output parameter change: `outputParameterChanges->forEach` calls
    `VST3Parameter::setValueWithoutUpdatingProcessor`, which for a changed value
    runs `AudioProcessorParameter::sendValueChangedMessageToListeners` with that
    parameter's `listenerLock` (a `CriticalSection`) held while the listeners run:
    the plugin's own parameter listeners, then JUCE's `ParameterChangeForwarder`
    into `AudioProcessorListener::audioProcessorParameterChanged`, which is SIANN's
    adapter, which calls the event sink. So the sink runs on the audio thread under
    `listenerLock`, not under `getListenerLocked`. The lock is contended by the
    main thread's edits of the same parameter (`setValueNotifyingHost`, which the
    plugin's editor and `nudgeGain` use; SIANN's `setParameter` goes through
    `VST3Parameter::setValue`, which does not take it) and by `addListener` and
    `removeListener`, and held for the listener bodies. A restore
    (`setStateInformation` → `resetParameters`) takes it once per parameter whose
    value changed, on the main thread, while `process` is paused by SIANN.
  - A VST3 plugin that asks for a restart from the audio thread reaches
    `ComponentRestarter::restart`, which, off the message thread, calls
    `triggerAsyncUpdate`: a message allocation and a post to the platform queue
    (`InternalMessageQueue::lock`, a `CriticalSection`, on Linux; `PostMessage`
    on Windows; the run loop on macOS), on that plugin's behalf. A plugin that
    calls `AudioProcessor::updateHostDisplay` or `setLatencySamples` itself from
    the audio thread (a non-wrapper path) goes through
    `AudioProcessor::getListenerLocked`, a `CriticalSection` held for one array
    read and contended only by `addListener` and `removeListener`, which SIANN
    calls at construction and destruction, outside any `process` call; a hosted
    VST3's latency change arrives on the message thread instead.
  - Lock-free and allocation-free in the same path, verified: the parameter
    queues (`ParameterChanges` reserves at `initialise`; `ParamValueQueue` is one
    cached value), `CachedParamValues` (atomics), `parameterDispatcher.push` off
    the message thread (atomics), `updateTimingInformation` (no play head set) and
    `updateBypass` (SIANN never calls `processBlockBypassed`).
  - AU, per block when the plugin produces MIDI: `midiInLock` (a `CriticalSection`),
    taken by `processBlock` to swap the buffers and by the plugin's MIDI output
    callback (`handleIncomingMidiMessage`), which appends to `incomingMidi` under
    it: a `juce::MidiBuffer` that grows, so a MIDI-producing AU can allocate on the
    audio thread inside JUCE, as a VST3 can. Before that lock, inside
    `AudioUnitRender`, `renderMidiOutput` feeds each packet to
    `MidiDataConcatenator::pushMidiData` (`juce_AudioUnitPluginFormatImpl.h:2288`;
    found by the m4-juce-formats re-audit, 2026-11-09; ADR-0018, Amendment 3): its
    `pendingSysexData`, a `std::vector` reserved at 2048 bytes, grows for a sysex
    longer than that (`juce_MidiDataConcatenator.h:242`, `:248`), and the
    `MidiMessage` built from the sysex mallocs for one over 8 bytes (`:259`,
    `juce_MidiMessage.cpp:349`). The byte-stream extractor in front of it holds
    fixed-size state. `AudioUnitRender` itself runs under no JUCE lock; the AU
    wrapper's `lock` guards parameter calls on the main thread, not the render.
  No hosted plugin is in a driver graph in M0: no graph node wraps a
  `PluginInstance` (`siann-engine` runs a device since m4-engine-device, with no
  plugin in its graph until the M4 plugin node). The only callers of
  `JucePluginInstance::process` are the hosting tests, on a realtime-marked
  thread; `--open-editor` instantiates a plugin and never processes it. The
  exception is therefore latent in M0 and binds the M4 plugin node. Since
  m4-plugin-node the `PluginNode` processes hosted plugins in the driver's
  callback, timed into a per-instance `rt::CallbackTimer`, `--open-editor` is gone
  (editors open through `plugin.open_editor`), and a ctest check
  (`SiannNoLocks.cmake`) fails when `plugin_node.cpp`, `juce_plugin_host.cpp`,
  `clap_plugin_host.cpp` or `plugin_instances.cpp` (the plugin event sink, which
  runs under the hosting wrapper's locks) names a lock.

  The exception is accepted for M0 (2026-11-07, Fable, delegated by the maintainer;
  ADR-0018, amended the same day after review). Its conditions:
  - Scope: JUCE 9.0.3's wrapper code inside `plugin_->processBlock` as audited
    above, its locks and the allocation a MIDI-producing plugin can cause there,
    called from `JucePluginInstance::process` in `siann-host-desktop`. The scope is
    the audit, not a count: a JUCE pin bump repeats the audit before the pin
    moves, and a lock or allocation the audit does not list reopens the decision.
    SIANN's own code, the adapter included, takes no lock. No test can prove that
    today (the allocation guard sees allocations, not locks; RTSan does not build
    the desktop target), so it rests on reading `process()`: one `processBlock`
    call between two atomic stores, and buffers prepared at construction.
  - Bound: SIANN calls `prepareToPlay` and `releaseResources` only on an instance
    outside any live graph (construction, destruction). The waits with no bound of
    SIANN's are the plugin-initiated restarts during playback that hold
    `processMutex`: `kReloadComponent` and `kIoChanged` for that plugin's
    `setActive`, `kMidiCCAssignmentChanged` for a mapping copy. The `listenerLock`
    waits are bounded by the listener bodies (the sink's push to a bounded queue,
    and the plugin's own listeners); the MIDI lists' locks are never contended. A
    restart is rare and SIANN does not control it.
  - Latent in M0, binding for M4. No shipped path processes a hosted plugin in M0
    (see above), so the exception, the counter and the sink rule are not exercised
    by plugins in M0; the hosting tests are their only caller. Before a hosted
    plugin processes audio in a shipped path (the M4 plugin node), all of these
    hold: (1) the node calls `process` only from a `GraphDriver` callback, where
    the driver's `CallbackTimer` times it and `xruns` reports it, or from the
    offline driver during bounce and export, where no deadline exists and a wait
    only lengthens the render, and never both at once on one instance: the live
    graph pins its instances, and a `render.start` instantiates its own from the
    slots' state blobs ("Commands and jobs", Jobs v0, plugins), so no instance is
    ever driven by two threads ("Realtime and offline rendering use the same graph
    code"); (2) the event sink and the adapter's listener code push to
    `pluginEventAny` and do nothing else: never `setState`, `setParameter`,
    `stop()` or any call that waits for the audio thread, since they run under
    JUCE's `processMutex` and `listenerLock` (the deadlock argument under
    "Threads and waiting rules" depends on it); (3) MIDI
    output has a decision (taken 2026-11-08 by Fable, delegated by the maintainer,
    under the gate that proves MIDI output on `siann_test_plugin`): the first
    option. `JucePluginInstance` preallocates its `juce::MidiBuffer` for the 2048
    events Steinberg's limit allows (`ensureSize` for 2048 events of 9 bytes: a
    32-bit position, a 16-bit size and a three-byte message) and counts, per
    instance, the blocks whose output exceeded that (`midiOutputOverflows`, an
    atomic, in `engine.status`; JUCE's VST3 wrapper stops a JUCE-built plugin's
    output at 2048, so the adapter counts a block that reached 2048, where the
    events past it were lost, m4-plugin-node), accepting JUCE's
    `Array` growth as plugin-caused, and (ADR-0018, Amendment 3, 2026-11-09, after
    the m4-juce-formats re-audit) the allocations JUCE makes for every sysex event
    the plugin outputs (the VST3 and AU bullets above), which no preallocation
    reaches and SIANN cannot step in front of; the instance counts those events
    too (`midiOutputSysex`, an atomic, beside `midiOutputOverflows` in
    `engine.status`), by walking its `MidiBuffer` after `processBlock`, which
    allocates nothing; `ClapPluginHost`'s output event list is
    host-owned and bounded, its `try_push` refuses past capacity and the refusal
    is counted the same way, as are its `CLAP_EVENT_MIDI_SYSEX` pushes, so the
    field means the same for every format. Until MIDI tracks exist (M6b) the node
    drops the events after counting. Worker processes remain the remedy; (4) the
    protocol carries `xruns`, `maxCallbackMicros` and `unmeasuredCallbacks` in the
    engine's status once the engine process runs a device.
  - Visibility: the graph driver counts, on the audio thread with atomics only,
    device callbacks and callbacks that exceeded their period, and keeps the
    longest (`siann::rt::CallbackTimer`, which `siann-cli bench` also uses).
    `siann-cli play` and `record` report them as `xruns`, `maxCallbackMicros` and
    `unmeasuredCallbacks` (callbacks without a device rate, which no deadline could
    be checked against). `siann-engine` runs a device since m4-engine-device, and
    `engine.status` carries the same three fields from the driver's timer to any
    client (Protocol v0 item 18), so ADR-0018's condition 4 is met. `xruns` is a
    cumulative count, since the device started, of callbacks the driver timed over
    their period, never an xrun the device reported. Nothing
    consumes `pluginEventAny` in M0, and `restartRequested` also follows a
    latency-only restart (JUCE reports every restart's end as `programChanged` and
    `parameterInfoChanged`), so an xrun cannot be attributed to a restart from
    these counts; attribution needs per-instance timing of `process()` or a
    timestamped event log, both M4 follow-ups.
  - Not patched around: a JUCE patch using `tryEnter` in `processBlock` (pass the
    block through while the lock is held) is licence-compatible under ADR-0017 but
    is not carried: a maintained patch on a moving pin, for a wait that worker
    processes remove properly.
  - Not sanitized: the RTSan job builds the core without JUCE, the uncontended spin
    lock is one compare-and-swap the sanitizer cannot see, and the contended path is
    nondeterministic. If hosting ever runs under RTSan, the wrapper locks above go
    in the suppressions file, one reason each. No watchdog: a wait inside a
    callback is a deadline miss, counted, never a reason to stop the device.
  - Tests: "a VST3 restart during playback keeps setActive and process apart"
    stays the regression guard for what `processMutex` is for: no overlap, no
    allocation, blocks on both sides of the restart. "a restore waits for a block
    the plugin holds open" guards `ProcessingPause`'s wait; "a restart the plugin
    asks for reaches the sink as restartRequested" guards the event. Nothing
    measures the wait; a spin time is a wall-clock figure no deterministic test
    can bound.
  - Sunset: the exception is removed, not extended, when hosted plugins run in
    worker processes.
- `juce::AudioBuffer` is constructed over preallocated channel pointers (non-owning)
  and `juce::MidiBuffer` is preallocated with `ensureSize`, inside the desktop host
  adapter only.
- Realtime and offline rendering use the same graph code.

### Threading roadmap

- v1: one audio thread processes the graph in schedule order. Summation order is
  fixed.
- Later: a worker pool where the audio thread also processes nodes; per-node
  dependency counters precomputed at compile time; workers at realtime priority and
  joined to the device's audio workgroup on macOS; spin-then-wait. Introduced only
  when a deadline stress test passes. Output must be bit-identical to the
  single-threaded render on the same platform. Taskflow is not used (it allocates at
  runtime).

## Latency model

PDC determines graph structure, so it is part of compilation, not a post-pass.

- Every node reports `reportedLatency` (samples). Plugins report through their
  format API; built-in nodes report their own.
- Alignment happens at every summing input (bus inputs, aux returns, sidechain
  inputs, master). For each summing node, the compiler computes the accumulated
  latency of each incoming edge and inserts `compensationDelay = max - edge` on that
  edge. Pre-fader and post-fader sends are separate edges with their own latency.
- MIDI to instruments is scheduled earlier by the downstream compensation of the
  instrument's path, so instrument tracks line up with audio tracks.
- Input monitoring uses a low-latency path that bypasses compensation delays.
- Recording offset: realtime playback is not latency-shifted, so what the performer
  hears trails the timeline by the total latency of the output path they monitor
  (master or a cue mix) plus the device output latency (plus output SRC latency),
  and what they play reaches the engine after the device input latency (plus input
  SRC latency). A captured block whose audio-thread timeline start is `t` is placed
  at `t - monitoredPathLatency - outputLatency - inputLatency - srcLatency`.
- Device latencies are converted from the device rate to the session rate. Because
  backends disagree on whether reported latency includes the buffer, a loopback
  calibration (measured round trip) replaces `outputLatency + inputLatency` when
  available; the reported values are the fallback.
- The formula is the same in every monitoring mode. Input monitoring (auto or input)
  uses a low-latency path that bypasses compensation delays, which changes what the
  performer hears of themselves, not where the take lands. M2 tests this with a fake
  loopback device in each mode.
- Latency change at runtime (VST3 `restartComponent(kLatencyChanged)`, CLAP
  `latency.changed`, AU property notifications) arrives on any thread, is forwarded
  to the command thread through `pluginEventRt` or `pluginEventAny`, and triggers a recompile with
  state migration. CLAP's `latency.changed` is a main-thread call and takes effect only
  after the host deactivates and reactivates the plugin, during which process passes
  input through.
- A global compensation limit (configurable) bounds delay line memory. Paths above
  the limit are flagged to the user and agents; they are not silently misaligned.
- Tests: a built-in `FakeLatency` node with settable and changeable latency; null
  tests across direct, send, aux and sidechain paths.

## Automation

### Precision contract

| Target | Precision |
|---|---|
| Built-in DSP | Sample-accurate (per-sample ramps) |
| CLAP plugins | Sample-accurate (events carry sample offsets), up to 1024 events a block beyond one per parameter; past that, a parameter's newest value lands at the start of the next block |
| VST3 plugins | v1 through JUCE: block-accurate. Later option: a direct VST3 host path passing `IParameterChanges` with sample offsets |
| AU plugins | Block-accurate (with sub-block splitting as a later option) |

The documented precision is shown to users and agents.

### Lanes and evaluation

- Lanes store breakpoints in the document. The compiler converts them into segments
  for the audio thread.
- Interpolation domains: gain in dB, pan linear, plugin parameters in the plugin's
  normalized domain.
- Evaluation: built-in targets per sample; hosted plugins per block or per
  sub-block.

### Write modes

- Write, Touch, Latch and Trim passes capture values on the audio thread into
  `automationOutbox`. When the audio thread processes the gesture end (or transport
  stop) it pushes an end marker after the last captured value. The command thread
  accumulates values and commits one `automation.write_pass` command (one revision,
  one journal entry) only when it receives the marker, so no tail values are lost.

## Gestures

- `gesture.begin(target)` → many `param.set` on the parameter channel →
  `gesture.end(target, finalValue)`.
- Only `gesture.end` creates a revision and a journal entry, containing start and
  end values (and the automation pass, if writing). The M2 playback engine
  records the end value only (see the M2 interim note under "Status").
- The control dispatcher owns open gestures and their overlay values (see "Two
  channels into the audio thread"), so a recompile never snaps a held fader back.
- A gesture is held under a client lease, not an update timer. Holding a fader still
  is a valid gesture (Touch writes a constant value). The lease ends when the client
  sends `gesture.end`, cancels, or stops answering the protocol heartbeat; the
  gesture then commits the last accepted value and emits an event.
- Plugin editors have no socket. Their gestures are owned by the plugin instance and
  end on the plugin's end event, on editor close, or on instance destruction. If the
  engine crashes mid-gesture, the session returns to the last durable revision.
- Plugin editor edits arrive as plugin-originated begin/edit/end events and follow
  the same rule.

## Time model

- Positions carry a domain: `AudioTime` (int64 samples) or `MusicTime` (int64 ticks,
  resolution 1920 ticks per quarter note or finer; never floating point).
- Audio clips default to `AudioTime`; MIDI notes and tempo-anchored content use
  `MusicTime`. Changing the tempo map moves `MusicTime` content and leaves
  `AudioTime` content in place.
- `TempoMap` and `MeterMap` support ramps in the model. M1 implements constant-tempo
  segments with step changes only; tempo ramps are deferred and rejected by
  validation until implemented.
- Tempo is stored as integer milli-BPM (120 BPM is `120000`, range 1 to 999.999
  BPM). Conversions use integer arithmetic only, through an internal superclock
  of 282,240,000 units per second, which every common sample rate divides. A
  tempo's superclocks per quarter is `round(282240000 * 60 * 1000 / milliBpm)`,
  ties to even. Results are therefore bit-identical on every platform.
- Conversions between domains are not exact in general. A conversion that lands
  between samples or ticks rounds to nearest, ties to even. Content keeps the domain
  it was placed in, so repeated conversions never accumulate drift. Shared fixtures
  cover the rounding boundaries.
- Timecode (all frame rates including drop-frame), Bars|Beats, seconds and samples
  are display and input formats, never storage formats.

## Sample rate and media

- The session sample rate is an invariant of a session. Changing it is an explicit
  command that converts every `AudioTime` value and every media file (offline), as
  one revision.
- Media whose rate differs from the session is converted offline at import
  (r8brain-free-src) and both the original hash and the converted hash are recorded.
  A failed conversion commits nothing. Changing the rate of an existing session is
  deferred; M1 does not offer it.
- New sessions default to the sample rate the output device actually runs at.
- Opening a session whose rate differs from the device: the engine first asks the
  device to run at the session rate (ASIO, CoreAudio nominal rate, WASAPI exclusive,
  ALSA). If the device cannot, for example WASAPI shared mode fixed at the OS mix
  rate, the engine plays through device-side sample-rate conversion (SRC). Backends
  differ in how "cannot" shows: ASIO falls back to a rate it supports on its own,
  while WASAPI exclusive mode and CoreAudio refuse to open at an unsupported rate.
  A refused open is therefore retried once at the device's own current rate, and
  only a device that opens at neither is an error. The session is never silently
  converted. A backend that would accept any rate and
  convert it itself (JUCE's WASAPI shared mode, "Windows Audio", which asks the OS
  converter with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`) is not asked for the session
  rate: it is opened at its own mix rate, so the conversion is the engine's SRC and
  is reported, not the OS's default-quality converter.

### Device-side SRC (M2)

- The graph always runs at the session rate. SRC sits only at the device boundary:
  output SRC from session rate to device rate, input SRC from device rate to session
  rate. Offline render and bounce never pass through it.
- Pull model: the graph renders fixed-size session-rate blocks into a preallocated
  FIFO, and the output SRC consumes it to fill each device callback. The graph never
  sees a variable block size. The FIFO is primed to a fixed fill of one graph block
  before the device starts and kept there, so its latency is constant.
- The SRC library runs on the audio thread, so it must be allocation-free after
  setup and pass the realtime checks. Candidate: r8brain-free-src streaming mode
  (MIT), verified with the allocation hooks and RealtimeSanitizer before adoption;
  libsamplerate (BSD-2) is the fallback. M2 adopts r8brain on these three checks:
  - Allocations: the allocation-guard tests run `process()` on a marked audio
    thread and pump every SRC test through the guarded driver.
  - Locks and blocking calls: the allocation guard cannot see them, so this rests
    on a review of r8brain 6.5's source. Its only locks (`CSyncObject`, taken
    through `R8BSYNC`) guard the shared filter, filter-bank and FFT-object caches.
    They are taken only when a resampler is constructed or destroyed, which
    happens on the control thread. `process()` and `clear()` take none and make no
    system calls.
  - RealtimeSanitizer: the Linux RTSan CI job builds r8brain with
    `-fsanitize=realtime` and runs every `[src]` test (the direct `process()`
    test inside a realtime scope, and the sine, aliasing, impulse and
    record-offset tests through the graph driver on the manual device), both in
    the full ctest run and as an explicit `siann_realtime_tests "[src]"` step.
    Before the pull request, the job's commands were run as written in WSL
    (Ubuntu 24.04, Clang 20.1.8 from apt.llvm.org, CMake 3.28, Ninja): the
    `-Werror` build of the whole tree with `-fsanitize=realtime` (Catch2,
    dr_libs and r8brain included) succeeded, all 300 ctest tests passed with
    `RTSAN_OPTIONS=halt_on_error=1`, the `siann_rtsan_canary_*` tests saw
    RTSan's reports for `malloc`, `pthread_mutex_lock` and `nanosleep` (and
    none under the disabler), and `siann_realtime_tests "[src]"` passed (10
    test cases). RTSan reported nothing in r8brain's streaming path, so
    r8brain's adoption is final and libsamplerate is not needed. The CI job
    repeats this on every pull request and on `main`; a report there fails CI
    and is listed here with its fix.
    Before that run, a review against the realtime rules (not a sanitizer
    report) found and fixed these, none of them in SIANN's realtime path or
    r8brain: the fake device held the realtime scope across its pacing and
    stall sleeps (now per callback), a capture vector grew inside a
    fake-device callback (now reserved), the SRC test asserted inside its
    realtime scope (now after it), and two deliberate rule breaks in tests now
    run under the disabler.
- SRC latency (input and output filters plus the FIFO) is reported to the latency
  model. The record offset includes it, so recorded clips stay aligned.
- Recording through input SRC writes files at the session rate. Input monitoring
  through SRC has higher latency; the UI and agents are told when SRC is active and
  how much latency it adds.
- The user and agents see a "resampling" state with the device rate, session rate
  and added latency. Bypassing SRC is always possible by changing the device or its
  mode.
- Tests: sine and impulse through output and input SRC at 44.1 to 48 kHz and 48 to
  44.1 kHz, with frequency response, aliasing and alignment limits; record-offset null
  test through input SRC; the realtime-vs-offline parity test compares against the
  offline render passed through the same SRC. The limits:
  - Frequency response: the amplitude of a sine at 1 kHz, 10 kHz and 18 kHz is
    within +/-0.1 dB after the first second.
  - Aliasing and noise: the residual after subtracting the least-squares fitted sine
    is below -96 dB relative to the tone (it covers images, ripple and noise; float32
    and the attenuation of r8brain's 16-bit-class filter both leave margin). That
    measures in-band tones only. Aliasing proper is tested on both paths wherever
    they downsample. On output, a 48 kHz session on a 44.1 kHz device plays a sine
    between the device Nyquist and the session Nyquist (22.06 to 23.99 kHz). That
    tone would fold to the device rate minus its frequency. On input, a 44.1 kHz
    session on a 48 kHz device (the M2 exit setup) records a device-input sine in
    the same band, which would fold into the take at the session rate minus its
    frequency. In both cases, everything left of the tone (the folded tone and any
    other residue) must be below -96 dB relative to the tone.
  - Parity: the session played through the graph driver on the manual device with
    SRC active is sample-identical to `renderOffline()` passed through a
    `StreamResampler` primed and fed as the driver's output SRC is (lookahead and
    one FIFO block of silence, then whole graph blocks). The document is silent
    during the driver's start-up fade, so no tolerance is needed.
  - Alignment: an impulse at a session position that is integral at both rates lands
    on the expected device sample +/-1 (the peak of |x|, since the linear-phase
    filter pre-rings).
  - Record offset: the loopback null test through both SRCs places the impulse peak
    at its timeline position +/-1 sample.
- Implementation (M2): r8brain streaming mode, one resampler per channel, built on
  the control thread. At start the output resampler is fed its lookahead in silence
  and the FIFO is primed with one block of silence, so the output path delays the
  session by exactly `srcOutputLatency = lookahead + one graph block` and the first
  callback never renders more than its share. Each step renders one graph block into
  the FIFO and feeds the oldest block to the resampler, so the FIFO holds exactly one
  block between steps; the device-rate output carries over between callbacks.
  Because whole blocks are rendered, the playhead runs ahead of the audible position
  by the reported latency plus up to one block of carried output. Recording therefore
  does not stamp input with the raw playhead under SRC: the audio thread stamps it
  with the playhead-equivalent position (the timeline position the output path had
  reached for the matching device sample, plus the reported SRC latency), so the
  record-offset formula above places takes exactly.
- Playback streams from disk: a butler thread fills per-track ring buffers ahead of
  the playhead and refills on locate. Media is never fully decoded into RAM except
  for short files below a threshold.
- Underrun: the audio thread outputs silence for the missing samples, increments an
  underrun counter (not an xrun) and emits an event; it never waits.
- Peak data is a multi-resolution pyramid computed on the butler thread and cached
  beside the media.

## Recording

- Arming: `record.arm(trackId)`; input monitoring modes off / auto / input.
- During recording the audio thread pushes input blocks into `recordOutbox`; the
  butler thread writes them through to disk in RF64/BWF, rewriting the header
  periodically (default every second) so a crash leaves a readable file.
- Punch in/out, pre-roll, loop record with one take per pass mapped to playlists.
- Disk full or write failure stops recording, keeps everything written so far, and
  reports an error.
- A `recordOutbox` overflow (the writer fell behind the audio thread) is treated
  the same way: the audio thread captures nothing more for that take, so the take
  ends at the last frame before the block that did not fit and stays one
  contiguous run of the input. It is never resumed after the gap, and the gap is
  never filled with silence. The dropped blocks are counted
  (`Recorder::Result::overflows`, `Recorder::overflowed()`), and the owner stops
  the take once `Recorder::captureEnded()` is true. The ring is sized for the
  writer's worst stall in wall time, so a device paced faster than real time needs
  a proportionally larger ring.
- Before the first sample is written, the engine durably writes a take manifest
  (`media/recording/<takeId>.json`: session, track, start position, sample rate,
  channels, record offset, generation) and records into
  `media/recording/<takeId>.wav`. The butler periodically records the last frame
  boundary known to be on disk.
- On start after a crash, the engine scans `media/recording/`, trims each file to its
  last complete frame, flushes it, and offers an idempotent `record.recover_take`
  command per take. Accepting it moves the file into content-addressed media and
  commits the clips; rejecting it moves the file to `trash/`. Uncommitted takes are
  never deleted automatically.
- Implementation (M2): the manifest is `siann.take_manifest.v1`. The recorder's
  writer thread records the timeline position of the first frame in the manifest
  before writing any audio, so audio on disk always has a known position. Commit
  and recovery are the same operation: repair the file, move it into
  content-addressed media (durable before the journal record), then commit
  `media.add` and `clip.place` as one revision; if the commit fails, the file moves
  back and the take stays pending. Opening a session lists pending takes. Takes are
  32-bit float WAV with the header rewritten every second; RF64 above 4 GiB
  follows.
- A take can be capped at a number of frames (`Recorder::Options::maxFrames`):
  the audio thread stops capturing after exactly that many frames, mid-block if
  needed, without allocating. After each checkpoint has been flushed, the
  writer thread reports the frames now durable in the WAV header
  (`onCheckpoint(durableFrames)`), so the owner can publish how much of the take
  a crash would keep; the final checkpoint at stop is reported too.
- `record.stop` creates exactly one revision: new `MediaSource` entries plus new
  clips (`record.commit_take`). Undoing it removes the clips and media references;
  recorded files are never deleted by undo or rollback. Unreferenced takes move to a
  trash folder inside the session and are purged only by an explicit command.
- The record offset follows the latency model.

### siann-cli realtime commands (M2)

The headless CLI drives the realtime engine for tests, benchmarks and manual runs.
Every command prints one JSON object; exit codes stay 0, 1 (error with a code) and
2 (usage).

- `devices` lists output devices as `{type, name, isDefault}`; the device id
  accepted by `--device` is `"<type>/<name>"`. `--device fake` selects a paced
  software device with loopback (`FakeAudioDevice`), so every command runs on CI
  without hardware. A CLI built without JUCE (the dev preset) reports
  `no_audio_backend` for every real device instead of failing to build; device
  failures report `no_device` or `device_open_failed`. Three options shape a run on
  the fake device and are a usage error without `--device fake`: `--fake-speed N`
  paces it N times faster than real time (long runs in less wall time; device time
  is unchanged), `--fake-input counter` replaces loopback input with a counter
  (each input sample is `(frame mod 2^24) * 2^-24`, exact in float32 and
  continuous across blocks), so a take's content can be checked sample by sample,
  and `--fake-callback-nanos N` times the driver's callbacks with a clock that
  advances N ns per reading, so every callback "takes" N ns: a known deadline miss,
  or none, driven through to the report.
- `play <bundle> [--seconds S] [--buffer F] [--device ID]` plays from the start
  (default: to the document end) and reports `framesPlayed` in device frames,
  disk-stream `underruns`, SRC underfill as `srcUnderruns`, the driver's deadline
  misses as `xruns` with `maxCallbackMicros` and `unmeasuredCallbacks` (the graph
  driver times every device callback with `siann::rt::CallbackTimer`, atomics
  only; `record` reports the same), the resampling state and the latency report.
  An xrun here is a callback the driver timed over its period, a slow callback;
  it is never an xrun the device reported. `unmeasuredCallbacks` are callbacks
  without a device rate, which no deadline could be checked against, so a `"0"`
  in `xruns` never hides them.
- `record <bundle> --track ID [--seconds S] [--take-id ID] [--ready-file P]`
  attaches a recorder while the driver is stopped, starts the device with the
  transport stopped, begins the take with `recordOffset = recordOffsetFrames` of
  the opened device, starts the recorder (its first frame marks the take start),
  then plays. `--seconds` count from the start of the transport: the recorder is
  capped at S seconds of session frames, so the take is exactly `S * rate` frames
  long (the device run is only bounded above, a second past that). Without
  `--seconds` it runs until SIGINT / Ctrl+C. Then it stops and commits the take as
  one revision. A recorder overflow ends the take early (see Recording): the run
  stops, `overflows` is reported, and the take, shorter than `--seconds`, is still
  committed. With `--fake-speed N` the recorder ring holds N times its default, so
  the writer keeps the wall-time headroom it has at real time.
  `--ready-file P` is a readiness signal for tests and supervisors: P is replaced
  atomically with `{takeId, startPosition, durableFrames}` (decimal strings;
  `startPosition` null until known) when the take start is marked and after every
  checkpoint, from the recorder's writer thread; after the final checkpoint
  `durableFrames` equals the take's `frames`. A failed write is retried at the next
  checkpoint and never stops the recording.
- `info` lists pending takes; `recover <bundle> <takeId>` commits a pending take
  (the same operation as the commit after recording).
- `bench <bundle> --tracks N --buffer F --seconds S [--rate HZ]` generates the
  bundle when it does not exist (N tracks, one clip each on one shared generated
  sine), checks the track count of an existing one (`bench_track_mismatch`), plays
  it and reports `callbacks`, `xruns` (deadline misses: callback time above
  `frames / deviceRate`, measured around the device callback), `maxCallbackMicros`,
  and `underruns` and `srcUnderruns` separately. A run that cannot measure deadlines
  fails instead of reporting zero xruns: `bench_rate_unknown` when the device
  reports no sample rate, `bench_no_callbacks` when no callback ran.

## MIDI

- `siann-midi` (pure C++): event types with sample offsets inside a block and
  `MusicTime` positions in the document. Internal event format is MIDI 1.0 in v1 with
  a representation that can carry UMP (MIDI 2.0) later without changing command
  schemas.
- Graph nodes carry both audio and MIDI buffers. Node types: `MidiSourceNode` (clip
  playback), `MidiInputNode` (device input), `MidiFxNode`, `InstrumentNode`.
- `MidiDevice` interface in the host layer (CoreMIDI, WinMM/Windows MIDI Services,
  ALSA sequencer). Device input reaches the audio thread through a lock-free queue
  with timestamps converted to sample offsets.
- MIDI thru, recording MIDI takes, and MPE are in scope; MPE ships after basic MIDI.

## Channels and I/O

- Every track, bus and plugin slot has a `ChannelLayout` (mono, stereo, and layouts
  up to the surround formats added later). Routing targets carry channel offsets.
- `IoPort` models physical device inputs and outputs; `RouteTarget` can point at a
  bus, a track input or an `IoPort`.
- Panning is defined by a `PanLaw` and a channel matrix, so surround is additive.
  M1 default: mono sources use constant power (center -3 dB); stereo sources use
  linear balance (unity at center, the far side attenuated toward zero).
- M1 plays overlapping clips on one track by summing them; comping and
  take-on-top rules come with playlists.
- Plugin slots store their negotiated bus layout and sidechain configuration.

## Modules

Dependencies point downward only. CMake target visibility and a CI check enforce it;
CI also builds and tests the core (everything except `siann-host-desktop` and the
app) with no JUCE present.

### siann-host-api (pure C++)

The interfaces the graph and the engine use to reach devices, plugins and media,
with SIANN-owned buffer views (`float* const* channels, int frames`), event lists and
capability types. It contains no implementation and depends only on `siann-time` and
`siann-midi`. `siann-graph` depends on it; `siann-host-desktop` and
`siann-host-headless` implement it and are linked only into engine executables. The
interface definitions are listed under "siann-host". Control-only operations (scan,
editors) live in separate interfaces from the realtime `process` path.

### siann-hash (pure C++)

SHA-256, a strict I-JSON parser for hashed data, the RFC 8785 serializer and the
RFC 6962 Merkle tree with the document hash. It depends on nothing and sits below
`siann-model` and `siann-command`. It passes the same fixtures as the Node bridge
(`fixtures/jcs/`, `fixtures/hash/`).

### siann-time (pure C++)

`AudioTime`, `MusicTime`, `Position` (domain-tagged), `TempoMap`, `MeterMap`,
`Timecode`, `Grid`.

### siann-midi (pure C++)

Event types, event lists, MIDI file import/export.

### siann-model (pure C++)

The session document. Immutable values with structural sharing. M1 decision: an
in-house structure, with one copy-on-write table per entity type (a sorted vector
of `shared_ptr<const Entity>` plus the cached entity hash). An edit copies only the
pointer vector of the changed table; every unchanged entity is shared. Measured on
2026-10-21 (MSVC Release): building 500 tracks and 5,000 clips, then 100 edits with
document hashes, takes 0.16 s in total, so the M1 kill criterion is not triggered.
immer (BSL-1.0) remains the fallback if larger sessions need sub-linear edits.

```text
SessionDocument
 |- id: SessionId          (the revision ID lives in the revision envelope, not here)
 |- sampleRate (invariant)
 |- tracks, buses, auxInputs, vcas, groups, ioPorts
 |- tempoMap, meterMap, markers, loopRange, punchRange
 `- media: MediaPool (MediaSource by MediaId, content hash)

Track
 |- id: TrackId (stable, never reused); name (display only)
 |- kind: audio | midi | instrument | aux | folder
 |- channelLayout
 |- playlists (active + alternates / comp lanes)
 |- inserts: PluginSlot[]; sends: Send[]
 |- input, output: RouteTarget
 |- fader: gain, pan (PanLaw), mute, solo, solo-safe, phase, trim
 `- automation: AutomationLane[]

Clip            id, source MediaId, position (Position), sourceStart, length,
                gain, fades
MidiClip        id, position (MusicTime), events
PluginSlot      id, descriptor (format, uid), stateBlob (BlobId), busLayout, bypass
Send            id, target, level, pan, pre/post
AutomationLane  target ParamRef, points, mode
```

Rules:

- Every entity has a stable ID and a per-entity content hash. The document hash is a
  Merkle root over entity hashes (exact encoding in "Canonical JSON and hashes"), so
  a revision only re-serializes changed entities.
- IDs are ASCII `[A-Za-z0-9_-]`, 1 to 64 characters, so every sort order agrees.
  Entity types are `[a-z][a-z0-9_]*`, at most 32 characters (for example `track`,
  `plugin_slot`).
- Ordered collections (track order, insert order, send order) are lists of IDs inside
  the parent entity, so order is part of the parent's hash.
- Commands address IDs only. Name lookup is a dry-run helper and fails on ambiguity.
- Loop range, punch range and solo-safe are document data. Playhead and transport
  state are engine state.
- Plugin state lives in the blob store; the document holds only the blob hash.
- M4 `plugin_slot` (m4-plugin-node; decided by Fable, delegated by the maintainer, 2026-11-08):
  `{id, trackId, format, uid, name, path, stateBlob, bypass}`. `path` is an
  install hint and is not part of `uid`; `stateBlob` is `"sha256:<hex>"` or
  null; `busLayout` arrives with sidechain routing (M6c). `Track` gains
  `inserts`, the ordered slot ids (part of the track's hash). Commands:
  `plugin.insert {trackId, index, slotId, descriptor, stateBlob}` (`index` clamps
  to the end; `already_exists` on a used id), `plugin.remove {slotId}`,
  `plugin.set_bypass {slotId, bypass}`; `track.remove` declares its slots as
  cascades. Validation checks the hash's form only: a blob absent from `blobs/` at
  instantiation loads the plugin with its default state and reports it `running`
  with `error {code: "state_missing"}`; rebuilding the document never needs the
  blob or the plugin. `inserts` is omitted from the track's JSON when it is
  empty, and the document's `pluginSlots` table when it has no slot, so every
  M1 to M3 document, checkpoint and fixture keeps its entity and document hashes
  (`Session::open` checks the checkpoint document's hash against the revision
  envelope and would otherwise reject every existing session). The xrun and
  per-instance timer tests of m4-plugin-node use `siann_test_plugin`'s
  `holdProcessBlock` (each block stays in flight 20 ms, longer than a 256-frame
  period at 48 kHz) until `siann_hostile_plugin` lands (m4-hostile-plugin).

### siann-command (pure C++) — the core of SIANN

#### Commands and jobs

```text
<<interface>> Command                pure document transform
  +id(): string                      e.g. "track.add", "clip.place", "plugin.insert"
  +validate(const Document&): Result<DeclaredEffects>
  +apply(const Document&): Result<Document>
  +toJson() / fromJson()

<<interface>> Job                    side-effecting work with a result
  e.g. media.import, render.bounce, plugin.instantiate, plugin.capture_state
  +start() -> JobId; progress events; on completion emits a pure Command
  (e.g. media.add with the resulting hashes) that enters the history
```

- Replaying the journal replays only pure commands and must reproduce identical
  document hashes. Jobs are never re-executed by replay; their outputs (media,
  blobs) are content-addressed files.
- A job first makes its outputs durable (media and blob files written and flushed),
  then submits a pure command carrying their hashes and descriptors. Example:
  `plugin.instantiate` (job, main thread) produces a state blob, then
  `plugin.insert {trackId, index, slotId, descriptor, stateBlob}` (pure command) enters the
  history. `media.import` produces files, then `media.add` enters the history.
- Rebuilding a document never requires a plugin to be installed or instantiable.
  Instantiation happens when audio starts; a plugin that cannot be loaded is shown as
  `missing` with its stored state preserved.
- `validate()` returns the declared effects, including cascades (deleting a bus
  lists the sends it removes). After `apply()`, the processor diffs the two
  documents; the actual changed IDs must be a subset of the declared ones, otherwise
  the command fails and nothing is published. The journal records the actual diff.
- VCA and group effects on derived values (effective gain) are not "touched" entities.

Jobs v0 (m3-mcp). The first job is the offline render behind the protocol's
`render.start` and the MCP `render` tool:

- `render.start {name, start?, frames?}` snapshots the head document (immutable)
  and queues an offline render on the offline-render thread to
  `<bundle>/renders/<name>.wav`. `name` must match `^[A-Za-z0-9._-]{1,64}$` (and is
  not `.` or `..`); anything else is `invalid_params`, so an agent cannot name a
  path. `start` and `frames` are sample counts as decimal strings (default: the
  whole document, as `engine::renderOffline`). The file is written atomically
  through siann-io. Result `{jobId: "job_<n>", kind: "render", state: "queued"}`.
- `job.status {jobId}` returns `{jobId, kind, state: queued | running | done |
  failed, result?: {path, frames, sampleRate, channels, contentHash}, error?:
  {code, message}}` (`contentHash` is `sha256:<hex>` of the written file; `frames`
  is a decimal string). An unknown id is `not_found`. A failing render ends
  `failed` with the `EngineError` code (`media_missing`, ...).
- Jobs are in-memory, run one at a time in creation order, and are not
  journaled. A render emits no command (nothing in the document changes), unlike
  `media.import`. A job event (`job.changed`) is deferred; clients poll
  `job.status`.

Jobs v0, plugins (m4-plugin-node; decided by Fable, delegated by the maintainer, 2026-11-08):

- `plugin.instantiate {trackId, index, descriptor: {format, path?, uid?},
  stateBlob?}` runs on the command thread (the main thread in M4) inside the
  request, not on the worker: it probes and instantiates the plugin, writes the
  state blob to `<bundle>/blobs/<sha256 hex>` durably (or uses the blob it was
  given), commits `plugin.insert {trackId, index, slotId, descriptor, stateBlob}`
  as its completion command, and answers `{jobId, kind: "plugin.instantiate",
  state: "done", result: {revision, slotId, descriptor, stateBlob, latencyFrames,
  tailFrames, capabilities}}` at once (`capabilities` are the six `PluginHost`
  flags as booleans). A failure is `state: "failed"` with the `PluginError` code
  (`plugin_load_failed`, `not_found`, `no_plugin_host` for vst3 and au in a
  core-only build). The worker's one-at-a-time order covers render jobs only. The
  instance enters the instance table under the new slot id, so the next compile
  reuses it instead of loading the plugin again.
- Slot ids (fix round 1 of m4-plugin-node): the server picks
  `slt_<n>` with `n` one above the highest `slt_<n>` any revision of the history
  holds, so an id freed by `plugin.remove`, `track.remove` or an undo is never
  handed out again, like every other entity id. A client's `plugin.insert` may
  still name a free id that an earlier revision used; the instance table pins
  instances by entry, not by slot id, so a slot whose plugin, path or state blob
  differs from its entry gets a new instance at once (the old one keeps
  processing in the graphs that pin it and goes when they retired), and an
  unchanged slot keeps its instance.
- `render.start` keeps its snapshot semantics when the document holds plugin
  slots: the request, on the command thread, instantiates one instance per slot
  from its state blob before the job is queued; the offline-render thread drives
  those instances and nothing the live graph pins; a slot whose plugin cannot be
  loaded renders as pass-through, like a missing plugin in playback; the instances
  return to the command thread for destruction on the tick after the job ends. The
  live graph never moves to the offline driver for `render.start`. Moving the live
  graph (playback stopped, ducked) is bounce and export of the heard graph, M6c
  ("Graph ownership"). An agent's render therefore never interrupts playback, at
  the cost of a second instance set for the render's duration.

#### Revision DAG — single history

```text
Revision { id, parents, documentHash, cause, actor, time }   (envelope)
cause ∈ { create, command, plan(transaction), undo, redo, rollback, branch-merge, recovery }
```

`create` is the cause of the first revision (the journal's create record, which
carries the initial document).

- `id`, `parents`, `actor` and `time` are envelope data and are never part of the
  document or its hash. `documentHash` is the document hash defined in "Canonical
  JSON and hashes".
- Undo produces a new revision ID whose `documentHash` equals the earlier revision's.
  Revision identity and document identity are therefore different things, and tests
  compare `documentHash`, not revision IDs.

- Every published document is a revision. The journal is the append-only log of
  the DAG.
- Undo creates a new revision whose document equals an earlier one (like `git
  revert`); it is journaled. Redo likewise.
- A rollback revision records `target` (the rolled-back plan's revision ID) like
  undo and redo; replay recomputes the inverse from the DAG and must reproduce the
  recorded envelope.
- A plan applies as one transaction producing one revision.
- A proposal branch is a DAG branch. Committing it creates a merge revision on main;
  discarding it leaves it unreachable (kept in the journal for audit).
- Rollback of an applied plan: the plan's affected entities are the entities in
  its revision's recorded diff (added, removed, modified). If every one of them is
  unchanged at the current head (same entity hash; an added entity still present, a
  removed entity still absent), an inverse revision is created: the head document
  with those entities restored to their state in the plan revision's parent.
  `root` is shared session state, so it is compared and restored per field, not
  by entity hash: the plan owns only the root fields it changed (`name`,
  `sampleRate`, `tempo`; `trackOrder` as a whole only if it reordered tracks it
  neither added nor removed) and the order slots of the tracks it added or
  removed. Later unrelated root edits (another track added or removed, a rename,
  a tempo change) are kept and are not a conflict, so every track-adding plan
  stays rollbackable; a plan-removed track goes back right after its nearest
  earlier neighbour in the old order that is still present, or first. The
  inverse document must pass document validation like any command result; an
  entity that a later revision references (a clip placed on a plan-added track or
  media) is reported as a conflict on that referenced entity. Otherwise rollback is
  refused with `rollback_conflict` and the conflicting entities are listed. No
  automatic three-way merge in v1. Rollback changes only the document. Files the
  plan's jobs produced (media, blobs, renders) stay in the bundle,
  content-addressed and merely unreferenced; removing them is a separate explicit
  purge, never a side effect of rollback. The plan's revision is the `plan`
  revision on main or the `branch-merge` revision that landed a proposed plan
  (m3-mcp); both carry their diff against the first parent, from which the
  inverse is computed.

Decisions of 2026-11-05 (m3-audition):

- Branches. A proposal branch (id `p1`, `p2`, ... in creation order) starts at a
  base revision that is reachable from main's head. Its commits are revisions
  like any other (ids `r<n>` in commit order across main and every branch, cause
  `command` or `plan`, one parent: the branch's previous tip or the base). They
  never move main's head and never enter main's undo stack. Opening and
  discarding a branch are not revisions.
- Merge rule. The branch's write set is the union of the entities in its
  revisions' diffs. Merging is refused with `branch_conflict`, listing the
  entities as `"<type>:<id>"`, when any of them has a different entity hash at
  main's head than at the base revision (an entity added or removed on main
  counts as changed); nothing changes then. Otherwise the branch's commands, in
  order, are applied to main's head as one transaction. The result is one
  revision with cause `branch-merge`, parents `[main head, branch tip]`, the
  branch's commands, and a diff against main's head (so it lists only the
  branch's entities). If that diff would name an entity outside the write set
  (the commands reach further on main's head, e.g. `track.remove` also removing
  a clip main placed on the track since the base), or an entity of the write
  set does not come out as at the branch tip, the merge is refused with
  `branch_conflict` listing those entities. The merge closes the branch, enters main's undo stack
  (one undo restores the pre-merge document, through the first parent) and
  clears redo. No three-way merge in v1. The checked entities are the write set
  plus, for a branch a plan was proposed onto (below), every entity of that
  plan's `readSet` and `writeSet`: merging a proposed plan is never less strict
  than applying it on main, so an entity the agent declared it read that main
  changed since the base also refuses the merge with `branch_conflict`.
- Discard closes the branch. Its revisions stay in the history and the journal,
  findable by id, but unreachable: a revision is reachable when it is main's head
  or an ancestor of it through any parent.
- Proposed plans. Proposing an approved plan opens a branch at its
  `baseRevision` and commits its steps there as one revision with cause `plan`.
  The plan stays `approved` (no new state; `siann.plan.v1` is unchanged) and the
  plan store links it to the branch (one open branch per plan, one plan per
  branch). While linked, the plan cannot be applied on main, proposed again or
  rejected (`invalid_state`); discard the branch first. Merging the branch
  lands the plan: `state: applied`, `appliedRevision` = the merge revision.
  Discarding the branch removes the link and leaves the plan `approved`. The
  link is in-memory like the plan store and, like open branches, does not
  survive a restart.
- Restart rule. Open proposals do not survive a restart: branch creation and
  discard are not journaled. On open every branch revision is replayed (findable,
  unreachable unless merged) but no branch is open. A branch commit's journal
  record carries the optional record field `branch: "p<n>"` (outside the
  envelope, so not in any hash but the record checksum), because parents alone
  cannot tell a branch commit from a main commit when the branch starts at main's
  head. The schema stays `siann.journal_record.v1`: `parents` is already an array
  and journals without the field read unchanged. A merge record carries `branch`
  too, for audit; replay rebuilds it from its parents and commands, and new
  branch ids continue after the highest recorded one.
- The checkpoint is verified against the revision its `head.id` names, not the
  revision at index `coversSeq`: with branches, the newest record need not be
  main's head.

#### Plans

```text
Plan
  -steps: Command[]
  -baseRevision
  -readSet, writeSet: entity IDs with their content hashes at baseRevision
  -hash: "sha256:<hex>" over JCS canonical JSON
  -state: draft | validated | approved | rejected | applied | rolled_back
```

- Staleness is per entity: a plan stays valid while every entity in its read and
  write sets is unchanged since `baseRevision`. A user moving an unrelated fader
  does not invalidate an agent's plan.
- Approval re-validates against the current revision. If stale, approval returns
  `plan_stale` with the changed entities; the agent regenerates. Sessions are never
  locked while plans wait.
- Partial approval produces a new sub-plan (new hash) containing the approved steps,
  re-validated against the current revision; the original plan is marked rejected.

Decisions of 2026-11-04 (m3-plans):

- Plan JSON is `siann.plan.v1`:

  ```text
  { schema: "siann.plan.v1", baseRevision: "r12",
    steps: [ <command objects as accepted by prepare> ],
    readSet:  [ {type, id, hash} ... ],
    writeSet: [ {type, id, hash} ... ],
    parentPlan?: "sha256:...",                       (sub-plans only)
    hash?, state?, approvedBy?, approvedAt?, rejectedBy?, rejectedAt?,
    rejectionNote?, appliedRevision? }                (lifecycle, not hashed)
  ```

  Entity set entries are sorted by `(type, id)` compared as byte strings, with no
  duplicates. `hash` is the entity hash at `baseRevision`, or `null` when the entity
  is absent there (a plan that creates it). Unknown fields are rejected.
- The engine computes `writeSet` as the union of the declared effects of
  `prepareTransaction(steps)` at `baseRevision`; a submitter cannot narrow it. The
  submitter supplies `readSet` IDs (may be empty); the engine resolves them to
  hashes at `baseRevision`. An unknown entity type or an unknown `baseRevision` is
  rejected (`invalid_params`, `not_found`).
- Staleness check: for every entry of `readSet` and `writeSet`, the head's entity
  hash equals the recorded one (absent matches `null`). Otherwise `plan_stale`
  carries `changedEntities`, sorted like the sets, each `"<type>:<id>"` with
  `change` = `added` (recorded `null`, now present), `removed` or `modified`.
  `plan_stale` never changes the plan's state; an undo that restores the recorded
  hashes makes the plan valid again (per entity, not per head revision).
- Approval (full or partial) needs a `validated` plan, rejection a `validated` or
  `approved` one (`invalid_state` otherwise). Apply needs an `approved` plan, re-runs the staleness check, commits
  the steps as one revision with cause `plan`, sets `state: applied` and records
  `appliedRevision`. The journal record format is unchanged; the plan-to-revision
  link lives in the plan store.
- Partial approval with step indexes (a non-empty proper subset; duplicates and
  out-of-range indexes are `invalid_params`):
  1. Build the sub-plan: the chosen steps in original order, `baseRevision` and
     `readSet` copied, `writeSet` recomputed, `parentPlan` = the original's hash.
  2. `prepareTransaction` of the sub-plan at `baseRevision` must succeed, otherwise
     `invalid_params` with the failing step index (within the sub-plan) and nothing
     changes.
  3. Store the sub-plan as `validated` and mark the original `rejected`.
  4. Approve the sub-plan. If that is `plan_stale`, the sub-plan stays `validated`
     and the original stays `rejected`; the error names the sub-plan's hash.
- Plans are in-memory engine state in M3 and are not persisted in the bundle.

#### Journal as write-ahead log

- `journal.ndjson` in the session bundle, append-only. One line is one complete
  record and one record is one revision: schema `siann.journal_record.v1`, a
  sequence number `seq` (decimal string, contiguous from 1), the revision envelope,
  the commands, or the undo/redo/rollback target, the actual diff, and a SHA-256 over the JCS of the record without
  that field.
- Commit order for every revision:
  1. Everything the revision references (media, blobs) is written and flushed, and
     on POSIX its directory is flushed.
  2. The journal record is appended and flushed.
  3. Only then is the revision published to the engine and the client answered.
- Checkpoints: the full document is written every N revisions or M seconds, carrying
  `coversSeq`, the last journal sequence it includes. It is written to a temp file,
  flushed, then atomically replaced (`rename` plus directory flush on POSIX,
  `ReplaceFileW` or `MoveFileExW` with write-through on Windows). "Autosave" means
  checkpoint.
- Recovery on start: load the newest valid checkpoint, replay records with
  `seq > coversSeq` in order, and stop at the first record that fails to parse, fails
  its checksum, or breaks sequence continuity. Bytes from that point on are moved to
  `journal.corrupt-<time>` for diagnosis, never discarded silently. Report what was
  recovered.
- M1 never truncates or rotates the journal; it keeps all valid history. Rotation
  and compaction come later.
- M1 recovery replays the whole journal from its create record (which carries the
  initial document), so undo and redo state survive a restart exactly. Every
  replayed revision must reproduce its recorded envelope (`replay_mismatch`
  otherwise). The checkpoint is cross-checked against the revision it covers
  (`checkpoint_mismatch`), and a journal that ends before the checkpoint's
  `coversSeq` is reported (`journal_behind_checkpoint`) instead of guessed at.
  Loading the checkpoint and replaying only the tail arrives with rotation.
- Code: `siann-io` holds the durable file primitives (append with flush, atomic
  replace, directory flush; `F_FULLFSYNC` on macOS). `siann-session` holds the
  journal record format, the bundle, checkpoints and recovery, above
  `siann-command`.
- Undo history depth in memory is bounded; older revisions are reconstructible from
  checkpoints plus journal.

#### Canonical JSON and hashes

- Canonical form is RFC 8785 JSON Canonicalization Scheme (JCS): ECMAScript number
  serialization, keys sorted by UTF-16 code units, defined escaping.
- Number encoding inside hashed regions:
  - 64-bit quantities (sample positions, ticks, lengths, sequence numbers) are
    decimal strings matching `^-?(0|[1-9][0-9]*)$`, always, regardless of size.
  - Gain is an integer milli-dB JSON number in `[-144000, 24000]`, with
    `-2147483648` (`INT32_MIN`) meaning negative infinity. The sentinel is
    special-cased before any arithmetic or interpolation; ramps into or out of it run
    in linear amplitude. Mute stays a separate boolean.
  - Pan is an integer in `[-10000, 10000]`.
  - Values that are inherently floating point (normalized plugin parameters) are
    JSON numbers in ECMAScript shortest round-trip form; `-0`, NaN and infinities are
    rejected. The C++ serializer is tested against the same fixtures as Node.
  - Out-of-range values and malformed strings are rejected at validation, not
    clamped.
- Hash payloads (each carries its own `schema` field, so a change is a version bump):
  - `entityHash = sha256(JCS(entity))`, where the entity object excludes any hash
    field of its own. Root settings (sample rate, tempo map, meter map, markers, loop
    and punch ranges, top-level ID lists) form one entity with ID `root`.
  - `planHash = sha256(JCS(plan))` over the `siann.plan.v1` object without exactly
    these fields: `hash`, `state`, `approvedBy`, `approvedAt`, `rejectedBy`,
    `rejectedAt`, `rejectionNote`, `appliedRevision`. `parentPlan` is hashed, so a
    sub-plan never shares its parent's hash. Both implementations pass
    `fixtures/plan/plan-hash.json` (`siann.plan_hash_fixtures.v1`, generated by
    `scripts/generate-plan-fixtures.js`); input that cannot be canonicalized is
    `plan_not_canonicalizable`, a malformed or unsorted entity set is
    `invalid_entity_set`, any other malformed plan is `invalid_plan`.
  - `documentHash` is the RFC 6962 Merkle Tree Hash over leaves sorted by
    `"<entityType>:<id>"`. Leaf input is `0x00 || "<entityType>:<id>" || 0x00 ||
    entityHashBytes`; internal nodes are `0x01 || left || right`; the split rule and
    the empty tree follow RFC 6962 section 2.1.
  - All hashes are written as `sha256:<lowercase hex>`.
- `observationHash` in the harness spec is the `documentHash`. It identifies a full
  snapshot. Direct commands may require it unchanged; plans keep per-entity
  staleness through `readSet` and `writeSet`.
- The Node bridge switches to JCS (a schema version bump of the plan format), and a
  shared fixture set covers numbers (`1.0`, `1e21`, `-0`), non-BMP keys and escapes.
  Both implementations must pass the same fixtures, including Merkle trees of 0, 1,
  2, 3 and 5 leaves, the gain sentinel and the 64-bit string rule. These rules are
  added to the harness engineering spec sections 1.2 and 1.4.

### siann-graph and siann-engine

```text
GraphCompiler
  +compile(const Document&, const PreparedGraph* previous) -> PreparedGraph*
   - topological order; feedback only through explicit delayed returns
   - latency model and compensation delays
   - state migration by entity ID
   - flattened clip lists, automation segments, tempo lookup

PreparedGraph   nodes (TrackNode, ClipPlayerNode, MidiSourceNode, InstrumentNode,
                PluginNode, BusNode, SendNode, SidechainNode, InputNode,
                DiskWriterTap, MeterNode, FakeLatency in test builds), schedule,
                epoch

Engine
  +process(block)       audio callback: drain graphInbox, paramInbox; render;
                        push outboxes
  +renderOffline(range, target)   same graph code, driven by a non-realtime loop;
                        the output is shifted by the graph's total latency so
                        it lines up with the timeline
                        (M1: a synchronous driver that owns its graph exclusively;
                        compile, render and destroy happen on one thread, never
                        concurrently, and it never shares instances with a live
                        realtime graph)
Transport       play, stop, locate, loop, punch; engine state, not document
Butler          disk read-ahead, record write-through, peak pyramid
```

### siann-dsp (pure C++)

Built-in processors (EQ, dynamics, reverb, delay, utility), meters (peak, true
peak), loudness (EBU R128), FFT. Original code or permissively licensed.

### siann-host: two targets, one interface

The interfaces below are defined in `siann-host-api`.

```text
<<interface>> AudioDevice   open(config) / close / setCallback; reports
                            input/output latency, sample rate, buffer size
<<interface>> MidiDevice    open / close; timestamped input; output
<<interface>> PluginHost    scan, instantiate (async), capabilities, process,
                            params + metadata, state get/set (blob), latency,
                            tail, bus layout negotiation, bypass, editor
<<interface>> MediaReader   open, read frames, metadata
```

`siann-host-desktop` (JUCE):

- `JuceAudioDevice` (ASIO*, WASAPI, CoreAudio, ALSA, JACK), `JuceMidiDevice`.
- `JucePluginHost` for VST3 and AU. LV2 through JUCE stays off (ADR-0018, Amendment 2).
- Plugin editor windows (needs `juce_gui_basics`).
- Owns process startup: the main thread runs the JUCE message loop.

`siann-host-headless` (no JUCE, no display):

- `AlsaAudioDevice` / `JackAudioDevice`, ALSA sequencer MIDI.
- `Lv2PluginHost` via lilv (ISC).

Shared by both targets:

- `ClapPluginHost` via the CLAP SDK. CLAP is the only format available in both
  builds, so it is implemented first in M4. CLAP does not require a pause for
  `getState`: `state.save` is a main-thread call that may run while the plugin
  processes, and a value set just before reaches the plugin by its next `process`.
  `ClapPluginHost::getState` never pauses while blocks are coming, so a save during
  playback passes no block dry. A value set just before it still lands in the blob:
  while blocks are coming, `getState` waits for a block to take the value and for
  that block to finish (about one block period); when none is coming, it runs
  `params.flush` under a pause, which then holds out no block. Whether blocks are
  coming is the driver's word: the one that calls `process` says
  `PluginInstance::setBlocksComing(true)` when its callback source starts and
  `false` once it has stopped, so a stalled callback (an xrun, a debugger) waits
  rather than pauses. Told nothing, the host guesses from the last block that
  reached the plugin: blocks count as coming while it is within 50 ms or four block
  periods, whichever is longer, and a stall past that can see one block pass dry
  while a flush runs. A block that comes but does not reach the plugin (it has not
  started processing) leaves the value to the flush.
  A block carries the caller's parameter events, up to 1024 beyond one per
  parameter; past that, the newest value of each parameter left over is delivered
  at offset 0 of the next block, and is what `getParameter` reads meanwhile.
- `MediaReader` via dr_libs / libFLAC etc. (not JUCE), so media reading is identical
  everywhere.

`PluginHost` contract:

- The core passes SIANN-owned buffer views (`float* const* channels, int frames`)
  and SIANN event lists; adapters wrap them without copying.
- Each method states its thread: `process` on the audio thread or the offline render
  thread, never both at once; `instantiate`,
  `setState`, `openEditor` on the main thread; `getState` on the main thread with
  processing paused where the format requires it; `setBlocksComing` on the main
  thread, from the driver that calls `process` (when its callback source starts and
  after it stops; a format that never waits for a block ignores it).
- An instance has at most 31 channels in or out (`maxPluginChannels`:
  `juce::AudioBuffer` keeps up to 31 channel pointers without allocating, and
  `ClapPluginHost` applies the same limit so both hosts behave alike);
  `instantiate` fails with `plugin_load_failed` above it, after
  `releaseResources` (m4-juce-formats, decided 2026-11-08).
- Plugin-originated events (parameter edits from editors, latency changes, restart
  requests) arrive on arbitrary threads and go into `pluginEventAny`.
- The interface is message-shaped and never exposes raw pointers into plugin
  internals, so a later out-of-process worker (shared-memory audio ring, messages for
  params and state) can implement it without changing callers.
- Capability flags per instance (sample-accurate params, MIDI in/out, sidechain,
  variable latency, editor) are reported to the command layer and to agents. Where
  (m4-juce-formats, decided 2026-11-08): `engine.capabilities` carries the host's
  formats and the flag names, and the `plugin.instantiate` result and
  `engine.status`'s `plugins[]` carry each loaded instance's six booleans
  (Protocol v0 items 14, 18 and 19). They are facts about the loaded instance,
  not user intent, so the document never stores them and no state migration
  follows.

#### Hostile test plugin

Decided by Fable, delegated by the maintainer, 2026-11-08 (m4-hostile-plugin).
`siann_hostile_plugin` (`native/libs/host_clap/hostile_plugin/`) is a second CLAP
built beside `siann_test_plugin` in every preset, never installed, loaded by the
hosting tests from its build path (`SIANN_HOSTILE_PLUGIN_CLAP`). It is a stereo
pass-through whose behaviours are off-by-default stepped parameters, so a default
instance is harmless and `siann_test_plugin` stays the clean reference. The
behaviours, and the host's outcome for each, checked by `siann_host_clap_tests`
with `process()` on a realtime-marked thread:

1. `allocate`: `process()` allocates and frees every block. The block completes
   with the plugin's output; a shipped engine neither aborts nor notices. The
   allocation is the plugin's, outside SIANN's guarantee ("Realtime rules and
   enforcement"). The allocation guard counts it only where the plugin's `operator
   new` resolves to the test executable's (Linux), so the tests assert nothing
   about that count for this behaviour; RTSan does see it, so the hostile blocks
   run under `ScopedRealtimeSanitizerDisabler` with the reason in a comment.
2. `throwProcess`, `throwActivate`, `throwLoad`, `throwSave`, `throwMainThread`: a
   C++ exception out of `process()` on the audio thread, or out of `activate`,
   `state.load`, `state.save` or `on_main_thread` on the main thread. The host
   catches it at the boundary of every plugin call (`catch (...)`): SIANN throws
   nothing, the plugin did, and the table-based unwind costs nothing on the path
   with no throw. Out of `process()` the block's output is cleared and the
   instance is *failed*; out of `instantiate` the error is `plugin_load_failed`;
   out of `setState`, `bad_state` and the instance is failed (its parameters are
   unknown); out of `getState`, `bad_state`; out of a restart or `on_main_thread`
   inside `runMainThreadCallbacks`, the instance is failed. A failed instance
   passes its input through from its next block, like a paused one; reports
   `PluginEvent::Kind::failed` once through the sink (a new kind, plain data for
   `pluginEventAny`); answers `getState` and `setState` with `plugin_failed`;
   stores a `setParameter` that nothing delivers; keeps `latencyFrames()` and
   `tailFrames()` at their last values; and is replaced, never revived (the
   command layer instantiates again). This catch is the one handler on the audio
   thread, and it ends with worker processes like the ADR-0018 exception.
3. `latencyFlap`: from inside `process()` the plugin calls `latency.changed` (a
   main-thread call made from the audio thread) and every `activate` reports a
   different latency. `latency.changed` on any thread only sets the restart flag
   and wakes (atomics); the restart runs on the main thread under the pause; each
   restart whose latency differs reports `latencyChanged`; input passes through
   between deactivate and activate; a `latency.changed` inside `activate` is read
   after it, never recursed into. Nothing of SIANN's limits a plugin that asks on
   every block: each restart costs one pause, the engine survives it, and the
   restarts stop when the plugin stops asking.
4. `sleep`: `process()` sleeps 50 ms. A late block. The host's waits for the block
   in flight (`ProcessingPause` in `setState` and a restart, `getState`'s wait for
   a block) wait that long and return; nothing of SIANN's times out or stops the
   device; in a `GraphDriver` callback the driver's `CallbackTimer` counts the xrun
   (m4-plugin-node's test).
5. `callbacksAudio` and `callbacksMain`: from `process()` the plugin calls
   `params.rescan(VALUES)`, `tail.changed`, `latency.changed`,
   `params.request_flush`, `request_restart`, `request_callback` and
   `state.mark_dirty`; from inside `params.get_info`, `params.get_value`, `activate`
   and `state.load` it calls `params.rescan(ALL)` and `request_restart`. Every host
   callback is atomics plus a wake on any thread and takes effect at the next
   `runMainThreadCallbacks`: a `rescan` from a thread other than the main thread
   marks the values stale and the main thread reads them (the host never calls
   `params.get_value` on the caller's thread); a callback made from inside a
   host -> plugin call is honoured after that call returns, never inside it (a
   rescan inside `get_info` does not re-enter the parameter table's rebuild; a
   `request_restart` inside `activate` schedules one more restart). The audio
   thread never waits.
6. `crash`: when the parameter turns on, in `process()` at its event or in
   `params.flush` when no block is coming, the plugin ends the process with
   `std::abort()`: exit code 3 on Windows, SIGABRT elsewhere. It turns off no
   crash dialog itself; that is the host's job (the engine's `main()`, "Process
   model", Crash), and a host that leaves them on gets the CRT's "abort() has
   been called" box or a WER fast-fail instead of exit code 3. On Windows it first
   writes one line to stderr with `GetErrorMode()` and the CRT's abort flags as
   they were when its entry was initialized (`siann_hostile_plugin: crash; at load
   errorMode 0x<hex> abortBehavior 0x<hex>`), so the engine launch tests check
   that `main()` turned the dialogs off before the plugin loaded. The parameter is reached through the live path only
   (`plugin.set_parameter`, Protocol v0 item 20); the plugin leaves it out of
   `state.save` and ignores it in `state.load`, so a restored blob never crashes
   again and the relaunched engine plays the recovered session. Nothing in the
   process catches it; a crash leaves the host with no instance to fail, and the
   shell's restart and the session's recovery are m4-crash-recovery's
   ("Production-level criteria": plugin crash during playback).

### siann-io

- Session bundle format (see "Session bundle").
- Media pool, blob store, peak cache.
- DAWproject import/export (continuing ADR-0015).
- Media decoding: dr_libs (WAV, FLAC, MP3), libvorbis/libogg; AAC/ALAC later.

### siann-protocol

```text
ProtocolServer   HTTP + WebSocket
EventStream      JSON events with revision numbers; binary frames for meters,
                 playhead and peaks
McpAdapter       MCP (JSON-RPC) tools mapped onto the command registry and the
                 protocol methods (Protocol v0 items 14 and 15):
                 list_commands, describe_capabilities, inspect_session,
                 submit_plan, plan_status, approve_plan, reject_plan,
                 apply_plan, rollback_plan, propose_plan, audition,
                 merge_proposal, discard_proposal, execute, job_status, render,
                 open_session, save_session
AuditionPort     the server's way to the auditioner (below)
```

Audition through the protocol needs the playback engine, which siann-protocol does
not link (protocol links session, realtime and engine; playback sits above the
engine). The server reaches it through an `AuditionPort` interface in
`ServerOptions` (`audition(branch)`, hear main, `heard()`, `merge`, `discard`,
plus the commit notifications the auditioner follows), implemented by the engine
host over `playback::Auditioner`. `proposal.merge` and `proposal.discard` go
through the port when one is present, so the sound follows (the m3-audition
decision: merges and discards go through the auditioner), and to the session
directly otherwise. Without a port `audition.hear` is `audition_unavailable`.
Branch commits and merges publish `proposal.changed {branch, revision, changedIds}`
and `proposal.closed {branch, merged, revision?}` events; main's `session.changed`
is unchanged (`docs/schemas/protocol-events-v1.md`).

Consistency rules:

- Every mutating request carries `sessionId`, an idempotency `requestId`, and an
  optional `expectedRevision`. Duplicate `requestId` returns the original response.
- Every request gets exactly one response with its `requestId`; errors carry a
  stable `code`.
- Events carry a monotonically increasing sequence number and the revision. A client
  detecting a gap calls `session.sync`, receives a full read model at a revision, and
  continues from there. Large sessions sync in chunks; changes are sent as deltas
  (`session.changed {revision, changedIds}` plus on-demand fetch).
- Channels are separated by priority: commands and events (reliable, ordered);
  gestures (parameter channel, latest wins per target); meters and playhead (binary,
  latest wins, dropped when the socket is congested). Meters never queue behind
  commands.
- Playhead position is sent with engine timestamps; the UI interpolates.
- The UI is optimistic only for continuous gestures; structural edits wait for the
  engine's revision.

Security rules:

- Default bind `127.0.0.1` with a random per-launch token.
- Browser WebSockets cannot set headers, so the token is sent in the first message
  (authentication handshake) before any other request is accepted.
- Electron loads the UI from a custom scheme; its Origin may be `null`, so Origin
  checks use an explicit allow list including the app scheme, and the token is
  required regardless.
- LAN mode is an explicit opt-in: token plus Origin allow list plus TLS (self-signed
  certificate with pairing in v1) and a permission scope per client (read-only,
  operate, approve).
- MCP clients default to the "propose" scope: they can submit plans but not approve
  them unless the user grants that scope.

Scopes v0 (decided with m3-mcp). v0 has two MCP scopes: `propose` (the MCP
default) and `trusted` (the "approve" scope above; read-only and operate stay with
LAN mode). A tool that changes main's document or the served session needs
`trusted`: `approve_plan`, `apply_plan`, `execute` (`command.execute`; undo and
redo are not tools in v0 and would be `trusted`), `merge_proposal`,
`rollback_plan`, `open_session`. Everything else is `propose`: `list_commands`,
`describe_capabilities`, `inspect_session`, `submit_plan`, `plan_status`,
`reject_plan`, `propose_plan` (a branch; main is unchanged), `audition`,
`discard_proposal`, `render`, `job_status`, `save_session`. In M3 the scope is set
by the launcher (`ServerOptions::mcpScope`; the `siann-engine` executable
(native/apps/engine, m0-electron-shell) takes `--mcp-trusted`); the
per-client grant in the UI arrives with M5. A denied tool call answers
`scope_denied` (a stable code), executes nothing and is not cached, so it can be
retried with the same id once the scope is granted. Note for the maintainer:
`propose_plan` and `audition` under `propose` let an agent change what the user
hears without changing main; if that is unwanted, flip them to `trusted` (one row
of the tool table in `docs/schemas/protocol-mcp-v0.md`).

The scope is tied to a credential and enforced by the server, so it cannot be
side-stepped (m3-mcp, fix round 1). The server holds two per-launch secrets, made
the same way (item 7) and never equal: the UI token (`ProtocolServer::token()`),
which authenticates the WebSocket, the realtime path and plain HTTP, and the MCP
token (`ProtocolServer::mcpToken()`), which authenticates `POST /v0/mcp` only and
carries `ServerOptions::mcpScope`. Neither opens the other's routes: the UI token
on `/v0/mcp` is 401, the MCP token in a WebSocket auth frame is `invalid_token`.
The launcher hands the UI token to the UI and only the MCP token to agents, so a
`propose` agent has no way to send `plan.approve` over the WebSocket. The command
thread checks every MCP request's method against the scope its credential carries
(a method no tool maps is denied), not the adapter. The UI is the user acting and
is not scoped in v0; LAN mode's per-client scopes (above) replace this split.
Maintainer decision recorded here: a separate MCP credential was chosen over
scoping the one shared token, because a shared token gives the WebSocket path the
same reach as the agent. If you would rather scope the WebSocket instead, this
paragraph and `docs/schemas/protocol-mcp-v0.md`, Transport, change together.

Protocol v0 (decided 2026-11-04 with m3-protocol-server; refines the rules above,
contradicts none of them):

1. Every request, not only mutating ones, carries `sessionId` and `requestId`.
   `sessionId` is assigned by the server for the open session (`ses_<random hex>`,
   new on every open) and returned by the authentication reply. A request for
   another session gets `session_mismatch`.
2. Envelope. Request `{requestId, sessionId, method, params, expectedRevision?}`. Response
   `{requestId, ok: true, result}` or
   `{requestId, ok: false, error: {code, message, step?, data?}}`. `data` (m3-mcp)
   carries the structured details of `plan_stale` `{plan, changedEntities: [{ref,
   change}]}`, `rollback_conflict` `{entities}`, `branch_conflict` `{entities}`
   (`"<type>:<id>"` strings) and `audition_budget_exceeded` `{resource: "memory" |
   "cpu", needed, budget}` (decimal strings); it is absent for every other code.
   Authentication: the
   first text frame is `{type: "auth", token}`; the reply is
   `{type: "auth", ok: true, sessionId, revision, documentHash}`, or
   `{type: "auth", ok: false, error: {code: "invalid_token"}}` followed by a close.
   Any other frame before authentication gets one `unauthenticated` error response
   and the socket is closed. Malformed JSON or a missing field gets `bad_request`,
   with the `requestId` echoed when it can be read and `null` otherwise.
   `expectedRevision`, when present, is a revision id (`r<n>`, a string; anything
   else is `bad_request`). The command thread compares it with the head revision
   before the method runs, for any method; when they differ the answer is
   `revision_mismatch` and nothing is executed. Like any executed answer it is
   cached under its `requestId`.
3. Stable codes so far: `unauthenticated`, `invalid_token`, `bad_request`,
   `session_mismatch`, `revision_mismatch`, `unknown_method`, `invalid_params`,
   `queue_full`, `internal_error`, plus the
   `CommandError` and `SessionError` codes passed through unchanged (with `step` for
   commands). HTTP error bodies are `{ok: false, error: {code, message}}` with
   `unauthenticated` (401), `origin_not_allowed` (403) and `not_found` (404).
   `message` is for people and not stable. It is always valid UTF-8: the server never
   echoes request bytes it has not parsed as JSON (Origin, HTTP method and path), and
   replaces each byte of an exception message that is not UTF-8 (for example a
   Windows path in the ANSI code page inside an `IoError`) with U+FFFD. Every
   executed request gets exactly one response, also when the method throws
   something that is not a `std::exception` (`internal_error`).
4. Origin is checked at the HTTP upgrade. No Origin header (non-browser clients) is
   accepted; the token is still required. An Origin in the allow list is accepted.
   Anything else, including the literal `null` unless it is listed, gets 403 and no
   socket. The app scheme is the constant `siann://app` in `siann-protocol` (the
   Electron shell reuses it); the default allow list is that constant alone and the
   server options can replace it.
5. Idempotency: the server keeps, per `sessionId`, the exact response text of the
   last 1024 executed requests keyed by `requestId` (oldest evicted). The cache
   lives in the server, not the connection, so a duplicate after a reconnect still
   returns the original response. Envelope errors answered before execution
   (`bad_request`, `session_mismatch`, `queue_full`) are not cached: the request was
   never executed and may be retried with the same `requestId`. (m3-mcp) The
   command thread checks `sessionId` again before the cache, for a request queued
   before a `session.open` in the same pump: it is `session_mismatch`, not cached,
   and never answered from the cache. The MCP `scope_denied` is checked there too
   and is not cached either.
6. Plain HTTP requests need `Authorization: Bearer <token>` (401 otherwise). The
   only route so far is `GET /v0/health` returning `200 {"ok":true}`; everything
   else is 404. Further routes come with later features.
7. The token is 32 random bytes from `std::random_device` as lowercase hex,
   generated when the server is constructed, and handed to the launcher (Electron
   or the CLI) through the ready line of item 17. The protocol thread hands validated requests to the command thread
   through a bounded inbox; a full inbox answers `queue_full` at once and is never
   waited on. Protocol JSON uses the in-house strict parser and JCS serializer;
   nlohmann/json is not adopted while those suffice.
8. Methods so far (the surface m3-events-sync, m3-plans and m3-mcp build on; later
   features add methods, and an unknown name is `unknown_method`):
   - `session.inspect`, params `{}` (ignored). Result
     `{revision, documentHash, revisions}`: the head revision id, its
     `sha256:<hex>` document hash, and the number of revisions in the history.
   - `command.execute`, params `{commands: [command, ...]}` with the commands in
     their journal JSON form (`op` plus fields). A missing, non-array or empty
     `commands` is `invalid_params` without `step` (the `CommandError` code of the
     same name, for a bad field in one command, carries `step`). The list commits as one revision
     (all or nothing) with the server's `actor` and clock. Result
     `{revision: {...envelope, diff, target?}}`: the revision envelope as journaled
     (`id`, `parents`, `documentHash`, `cause`, `actor`, `time`), `diff` as
     `"<entityType>:<id>"` strings, and `target` when the cause has one. A command
     that does not parse or fails validation answers its `CommandError` code with
     `step`, the index in `commands`, and nothing is committed.

Protocol events v1 (decided 2026-11-04 with m3-events-sync; the wire details are in
`docs/schemas/protocol-events-v1.md`):

9. Events are opt-in per connection (`events: true` in the auth frame), so v0
   clients are unchanged. Envelope `{schema: "siann.event.v1", seq, sessionId,
   revision, type, ...payload}`. `seq` is one counter per session and server
   process for every event type, starting at 1, independent of the journal `seq`;
   `revision` is the head revision id. 64-bit values (`seq`, epochs, sample
   positions) are decimal strings. The auth reply carries the current `seq`, so a
   reconnecting client knows whether it missed events.
10. Each subscribed connection has a bounded outbox, flushed while the socket's
    buffered amount is below a high-water mark. A full outbox drops the event for
    that connection and counts it; nothing blocks and there is no replay buffer in
    v1, so the client sees a `seq` gap and calls `session.sync`.
11. `session.changed {revision, parents, cause, actor, time, documentHash,
    changedIds: [{ref: "<type>:<id>", change}]}` follows every commit, undo and
    redo after it is durable and published. `session.fetch {refs, revision?}` returns
    entities at that revision or the head (`missing: true` for absent ones;
    `revision_unavailable` for a revision no longer kept). `session.sync {cursor?}` pins the
    head document for the connection and returns it in chunks of at most
    `syncChunkEntities` entities (default 500), all at the pinned revision, chained
    by `next` cursors; a cursor that does not match the connection's pinned sync is
    `sync_cursor_invalid`. Entity JSON is the hashed form, so clients recompute
    hashes. `session.undo` and `session.redo` complete the command methods.
12. Meters and playhead go on a separate WebSocket (`/v1/realtime`), authenticated
    by the same first frame, carrying only binary frames (`"SMTR"`, version 1,
    epoch, engine timestamp, playhead, playing flag, per-entity peak and RMS). The
    entity indexes refer to a `meters.legend {epoch, entities}` event sent after each
    graph publication. The newest legend is also part of the stream position: the
    auth reply and every `session.sync` chunk carry it as `meters` (null before the
    first graph), taken at the same `seq`, so a client that connects after the
    graph was published (the normal case: the engine publishes at open, the UI
    connects later) or lost the event in a gap can decode frames without waiting
    for the next structural edit. The publisher sends the newest values once per tick and drops
    the frame for a connection whose socket is congested; the audio thread still
    only writes the meterOutbox. In `siann-engine` the playing flag and the playhead
    come from the transport (`Transport::playing` and `position`), so a client sees
    a locate at once, also while stopped: a frame then goes out even with no meter
    reading yet (entry count 0). Without a transport the playhead is the newest
    meter block's position.
13. The auth reply and `engine.about` carry `{name, version, source: {url, commit,
    dirty}, license}` (ADR-0017, point 4), captured from git at build time with cache
    overrides `SIANN_SOURCE_URL` and `SIANN_SOURCE_COMMIT` for tarball builds.

Protocol v0, agent methods (decided with m3-mcp; the MCP mapping is in
`docs/schemas/protocol-mcp-v0.md`):

14. Every MCP tool is a one-to-one wrapper of a protocol method with the same
    params, result and error codes, so the UI and agents share one surface. New
    methods (all go through the command thread, honour `expectedRevision` and the
    idempotency cache like every method):
    - `command.list {}` -> `{commands}` (`command::commandNames()`; per-command
      parameter schemas are a follow-up, the registry has none yet).
    - `engine.capabilities {}` -> `{about, scope, scopes: ["propose", "trusted"],
      commands, methods, features: {plans: true, proposals: true, audition: <a port
      is present>, transport: <a port is present>, render: true, plugins},
      limits: {syncChunkEntities,
      inboxCapacity, idempotencyCapacity}}`. `scope` is the MCP scope the launcher
      set. `plugins` is `false` until a plugin port is present (item 19), then
      `{formats: ["clap", "vst3", "au"] as this build hosts them, flags:
      ["sampleAccurateParameters", "midiInput", "midiOutput", "sidechain",
      "variableLatency", "editor"]}`, host-level and from `ServerOptions`
      (siann-protocol links no JUCE); the per-instance values are in items 18 and
      19 (m4-juce-formats, decided 2026-11-08).
    - `plan.submit {steps, readSet?: ["<type>:<id>"], baseRevision?}` (default
      base: the head) -> the `siann.plan.v1` object with its lifecycle fields.
    - `plan.status {plan}` -> the plan object plus `stale: [{ref, change}]`
      (`PlanStore::validate`) and `proposalBranch` when it is proposed.
    - `plan.approve {plan, steps?}` -> the approved plan, or with `steps` (step
      indexes) the approved sub-plan (partial approval).
    - `plan.reject {plan, note?}` -> the rejected plan.
    - `plan.apply {plan}` -> `{revision}`, published like `command.execute`.
    - `plan.rollback {plan}` -> `{revision}` (the inverse revision).
    - `plan.propose {plan}` -> `{branch, revision}` (the branch's plan revision).
    - `proposal.merge {branch}` -> `{revision}` (the branch-merge revision).
    - `proposal.discard {branch}` -> `{}`.
    - `audition.hear {side: "main" | "<branch>"}` -> `{heard}` (`"main"` or the
      branch).
    - `render.start` and `job.status` (Jobs v0), `session.save` and
      `session.open` (item 16).
    - `session.inspect` adds `branches` (the open proposal branches) and, when an
      audition port is present, `heard`.
    Errors pass the `CommandError`, `SessionError`, `EngineError` and audition codes
    through unchanged, with `data` as in item 2. New stable codes: `scope_denied`,
    `audition_unavailable`, `not_supported`, `request_timeout`.
15. MCP transport: Streamable HTTP on the protocol server. `POST /v0/mcp` with
    `Authorization: Bearer <mcp token>` (the MCP credential, not the UI token; see
    Scopes v0; 401 otherwise; a request with an Origin header
    not in the allow list is 403, as at upgrades); the body is one JSON-RPC 2.0
    request or notification. The reply is `application/json` with exactly one
    JSON-RPC response (no SSE in v0); a notification gets 202 with an empty body.
    `initialize` (protocolVersion `2025-06-18`, capabilities `{tools: {}}`,
    serverInfo `{name, version}` from BuildInfo) assigns `Mcp-Session-Id` (a
    response header, `mcp_<random hex>`), required on every later request: 400
    when missing, 404 when unknown, so the client initializes again.
    `notifications/initialized`, `ping`, `tools/list` and `tools/call` are served;
    an unknown method is JSON-RPC `-32601`, malformed JSON `-32700`, a bad envelope
    `-32600`, bad tool arguments `-32602`. A tool call maps to the protocol request
    with `requestId = "<Mcp-Session-Id>/<jsonrpc id as canonical JSON>"` and the
    server's current `sessionId`, so a client's retry of the same id returns the
    original answer (item 5) and ids of different clients never collide. Success:
    `result.content[0].text` is the method result as canonical JSON and
    `result.structuredContent` the same object. A protocol error: `result.isError:
    true` with the error object `{code, message, step?, data?}` as the text and as
    `structuredContent.error`. The protocol thread waits for the command thread's
    answer at most `ServerOptions::mcpRequestTimeout` (default 30 s), then answers
    JSON-RPC `-32000` with `data.code: "request_timeout"`; a full inbox is
    `queue_full` at once. The command thread never waits on the protocol, so the
    wait graph stays acyclic ("Threads and waiting rules"). A stdio shim is a later
    item.
16. Open and save. `session.save {}` writes the checkpoint (`Session::checkpoint`)
    and returns `{revision, path}` (the `session.json` path). `session.open {path}`
    goes through `ServerOptions::openSession`, a callback the launcher supplies (the
    engine host rebinds its playback engine and auditioner inside it). On success the
    server serves the new session: a new `sessionId` (item 1), the event stream's
    head moved to the new session's head (its `seq` keeps counting, so subscribers
    see no gap), sync pins forgotten, the idempotency cache dropped with the old
    session, and the old session's plans gone with it (render jobs already queued
    finish into the old bundle and stay queryable by id). The result is
    `{sessionId, revision, documentHash}`; requests still naming the old id get
    `session_mismatch`; subscribed connections receive `session.opened {sessionId,
    revision, documentHash}` (the event carries the new `sessionId`). A path that
    does not exist is `not_found`; without an `openSession` callback the method is
    `not_supported`.

Protocol v0, launcher (decided with m0-electron-shell):

17. Launcher handshake. `siann-engine --session <bundle> [--host 127.0.0.1]
    [--port 0] [--mcp-trusted] [--owner-window <handle>]
    [--device <id>] [--device-backoff <initialMs>:<maxMs>:<resetAfterMs>]
    [--fake-callback-nanos N] [--fake-open-failures N]`
    writes exactly one line to stdout once it is
    listening,
    `{"schema":"siann.engine.ready.v0","port":<n>,"token":"<64 hex>","mcpToken":"<64 hex>","sessionId":"ses_<hex>","pid":<n>,"about":{...aboutJson()}}`,
    and nothing else on stdout for the life of the process (diagnostics go to
    stderr). Hosted plugins and JUCE print to the process's stdout, so before
    any plugin can load `main()` duplicates the launcher's stdout for the ready
    line and points fd 1 (and, on Windows, the standard output handle) at
    stderr, so nothing of theirs reaches the handshake (`siann_test_plugin`
    prints a line when it loads, and the launch tests check the ready line is
    still the first and only stdout line). Where that output goes: on POSIX fd 1
    is the kernel's, so any plugin's stdout output lands in the shell's stderr
    log; on Windows it does for code sharing the engine's CRT, while a plugin
    with its own CRT holds the handle value the launcher passed in
    `lpReserved2`, which the redirect closes. `main()` re-occupies the freed value
    with `NUL`, so that plugin's writes normally succeed into `NUL`, or fail if
    re-occupying did not land on the value; either way the output is dropped and
    a handle the engine opens later cannot receive it. A dedicated handshake pipe from the
    launcher would carry the plugins' stdout to the log on Windows too; it
    needs the shell to spawn a fourth stdio pipe and the launch tests to hand an
    `lpReserved2` block to the child, and is deferred. Tokens never appear on the command line or in the environment. The
    engine exits with code 0 when its stdin reaches EOF (the launcher holds the
    pipe, so a dead launcher never leaves an orphan) and on SIGTERM / CTRL_BREAK.
    A bad launch (a `--session` that is an existing file, a bad option) exits 1
    with one JSON error `{ok: false, error: {code, message}}` as the last line of
    stderr (JUCE and plugins may print before it) and nothing on stdout. Electron reads the ready line and exposes only
    `{port, token}` to the renderer through the preload bridge; `mcpToken` stays
    in the main process.

Protocol v0, transport and engine status (decided with m4-engine-device):

18. `transport.play {}`, `transport.stop {}` and `transport.locate {frames}`
    (`frames` a non-negative decimal string, item 9; anything else `invalid_params`)
    return `{playing, position}`, `position` a decimal string, from
    `Transport::playing` and `position`: a locate reports its target at once, and the playhead
    reaches it when the butler is ready ("Locate"). `engine.status {}` returns
    `{device, deviceError?, playing, xruns, maxCallbackMicros, unmeasuredCallbacks,
    underruns, srcUnderruns}`. `device` is null or `{id, sampleRate, bufferFrames,
    inputLatencyFrames, outputLatencyFrames}` as the device reported them, `id` being
    `fake`, `<type>/<name>`, or `default` for the default device. `deviceError
    {code, message}` is there when `device` is null and says why ("Process model").
    `xruns`, `unmeasuredCallbacks`, `underruns` and `srcUnderruns` are decimal strings
    and `maxCallbackMicros` is a number, as in `siann-cli play`, all since the device
    started: the driver's `CallbackTimer` for the first three fields (a known miss
    can be driven with `--fake-callback-nanos`). With a plugin port (item 19)
    `engine.status` also returns `plugins: [{slotId, trackId, format, uid, state:
    "running" | "missing", error?: {code, message}, capabilities, latencyFrames,
    tailFrames, callbacks, xruns, maxCallbackMicros, unmeasuredCallbacks,
    midiOutputOverflows, midiOutputSysex}]`, one per plugin slot of the heard document: the
    counters since the instance was created, from the `PluginNode`'s per-instance
    `rt::CallbackTimer`, decimal strings and a number as the driver's fields are;
    `capabilities` the six booleans of the loaded instance. A missing plugin has
    no instance: its `capabilities`, `latencyFrames`, `tailFrames` and counters
    are null, its slot keeps its `stateBlob` in the document and passes audio
    through (m4-plugin-node and m4-juce-formats, decided 2026-11-08). All four
    methods go through the
    command thread, honour `expectedRevision` and the idempotency cache, and are in
    `engine.capabilities`' `methods`. They reach the engine through
    `ServerOptions::transportPort` (`protocol::TransportPort`; siann-protocol does not
    link the playback engine); without one they are `not_supported`, and without a
    running device `no_device` is the transport methods' answer, a new stable code.
    They are not MCP tools yet: item 14 wraps tools onto methods, not every method
    onto a tool.

Protocol v0, plugins (decided 2026-11-08 by Fable, delegated by the maintainer,
with the M4 wave 2 and 3 plans):

19. Plugin methods, through `ServerOptions::pluginPort` (`protocol::PluginPort`,
    implemented by the engine host as `TransportPort` is; siann-protocol links no
    plugin host). Without a port they are `not_supported`; a core-only build
    answers `no_plugin_host` for `vst3` and `au`. `plugin.instantiate` and its
    `job.status` are in "Commands and jobs", Jobs v0, plugins.
    `plugin.open_editor {slotId}` and `plugin.close_editor {slotId}` run on the
    command thread; the engine's main thread opens the window, owned by
    `--owner-window` on Windows; both return `{slotId, editorOpen, nativeHandle}`.
    Errors: `not_found` (no such slot), `plugin_missing` (the slot's plugin did
    not load), `editor_failed` (the plugin has no editor, or a CLAP plugin on the
    desktop target until siann-host-desktop supplies a window: follow-ups, "Before
    M5: CLAP editor windows"), `no_plugin_host`. `--open-editor` and
    `SIANN_OPEN_EDITOR` are removed ("Process model"). All of them go through the
    command thread, honour `expectedRevision` and the idempotency cache, and are
    in `engine.capabilities`' `methods`; none is an MCP tool yet.
20. `plugin.set_parameter {slotId, paramId, value}` (m4-crash-recovery): the live
    parameter path for a hosted plugin. `paramId` is a string, the id the
    instance's parameter list reports (`PluginParameterInfo::id`; a CLAP plugin's
    decimal `clap_id`), and `value` a normalized number from 0 to 1 as
    `setParameter` takes. The method runs through the command thread like every
    method but mutates no document and is not journaled. For a CLAP slot it hands
    one `ParamChange` (the parameter's index) to the control dispatcher through
    `controlInbox` ("Two channels into the audio thread"), which sends it on
    `paramInbox` to the slot's `PluginNode` (the dispatcher's key
    `plugin:<slotId>`); the instance gets it as a parameter event at the start of
    the node's next processed block (the "Precision contract": block-accurate).
    Between the driver and that block the node keeps the latest value per
    parameter in a set with room for every parameter the instance listed when the
    plugin table installed it (allocated then, on the control thread), so however
    many are set while the transport is stopped, each lands at the first block
    played and none is dropped; a parameter the plugin added after install goes
    through `PluginControl::setParameter`, which a CLAP instance also delivers by
    its next block. The waiting rules' full-queue rule stays the only bound: the
    dispatcher coalesces a full `paramInbox`. JUCE's formats discard block events, so a VST3 or AU slot never goes through
    `paramInbox`: the engine host calls `PluginControl::setParameter` on the main
    thread. Neither path calls the plugin from the audio thread outside its
    block. The value
    lives in the instance until its state is next captured, so a crash before
    that leaves the last durable revision and the relaunched engine never re-runs
    the change ("Gestures"). Errors: `not_found` (slot or parameter),
    `plugin_missing`, `queue_full`, `not_supported` without a port. It stands in
    for `gesture.begin` / `param.set` / `gesture.end` on plugin parameters, which
    arrive when a gesture's end has a command to commit for one (plugin state
    capture, automation: M6a); the method stays as the one-shot form. Rejected:
    carrying a test plugin's crash trigger in its state blob, because a durable
    trigger re-crashes the relaunched engine at its first block (the fake device
    runs callbacks while stopped) and the shell gives up after five restarts.

## Plugin editor windows

1. Every plugin gets a generic parameter UI in the web frontend; agents use the same
   parameter list.
2. Desktop: the engine opens native editors from its main thread (helper app on
   macOS; owner window set to the Electron window on Windows).
3. Later and separate: streaming a native editor window to a remote browser (capture,
   encode, draw to canvas, forward input). This is a product feature with known
   limits (input injection, macOS permissions, Wayland, HiDPI, 50–100 ms latency), not
   a guarantee of remote plugin control.

## Proposal audition (A/B)

- Only one proposal branch can be auditioned at a time.
- Auditioning compiles the branch document into a graph and swaps it in like any
  structural change.
- Only the live graph exists. Switching A/B is an ordinary structural transition
  (duck-and-swap): unchanged slots keep their instances through the instance table,
  and slots the branch adds or changes are instantiated from their state blobs at
  the switch. The branch not being heard keeps only its document and state blobs,
  never a cached runtime graph. Instantiation is bounded by a configurable memory
  and CPU budget; if the budget is exceeded, audition is refused with a reason.
- Transport and playhead are shared; automation follows the auditioned branch.

Decisions of 2026-11-05 (m3-audition):

- One side is heard: main or one open proposal. Auditioning another proposal
  replaces the one heard. Edits that end while a proposal is heard (fader
  gestures) commit onto that proposal's branch; main commits made meanwhile do
  not change the sound until main is heard again. Merging and discarding go
  through the auditioner: discarding the heard proposal returns the sound to
  main, and merging it makes main heard at once, playing the merged head (no
  recompile when the documents are equal); gestures commit onto main again. A
  refused merge (`branch_conflict`) keeps the proposal heard. If the heard
  branch is closed on the session directly instead, a gesture that ends before
  main is heard again is refused with `audition_not_found` and commits nothing
  (the sound returns to main's value for that parameter); hearing main
  recovers.
- M3 budget stand-in. Until the instance table and plugins exist (M4), the cost
  of a switch is estimated from the document before anything is allocated:
  memory is the bytes of the disk-stream rings the switch would create (per
  track whose stream cannot be reused: 2 ring slots × ring frames, rounded up to
  a power of two, × channels × 4 bytes), CPU is the node count of the compiled
  graph. Both limits default to unlimited. A refusal
  is `audition_budget_exceeded` with the bytes or nodes needed against the
  budget, and changes nothing (the live graph, the compile count and the streams
  stay as they were). An unknown or closed proposal is `audition_not_found`.
  Per-plugin instantiation cost replaces the node count with M4.

## Session bundle

```text
MySong.siann/                    a directory
  session.json                   latest checkpoint, JCS canonical JSON
  journal.ndjson                 append-only WAL, all revisions (no rotation in M1)
  media/recording/               in-progress takes and their manifests
  checkpoints/                   older checkpoints (bounded)
  media/<sha256>.<ext>           content-addressed audio and MIDI files
  media/originals.json           original file names and paths for relink
  blobs/<sha256>                 plugin states and other binary data
  peaks/<sha256>.peaks           peak pyramids (regenerable)
  renders/<name>.wav             offline renders (regenerable; never touched by rollback)
  trash/                         unreferenced takes, purged only on request
```

- Atomic writes everywhere (temp + rename). Version field and migration functions
  for every format change.
- Missing media is reported on open with relink by hash.
- A zip container is used only for exchange (alongside DAWproject), never as the
  working format.

## Frontend

- TypeScript, one codebase for the Electron renderer and remote browsers.
- Framework choice (React or Svelte) is made at the start of M5.
- Timeline, waveforms, automation and meters are drawn with Canvas/WebGL.
- The frontend holds a read model keyed by revision; it never owns session truth.
- Plan review is a first-class UI: diff of the plan against the current revision,
  audition of the branch, approve / reject / partial approve.
- Reusing open-source web DAW UI code requires a license check first (openDAW is
  AGPL).

## Libraries

License notes are working assumptions; versions and terms are verified and pinned
before adoption, including transitive dependencies.

| Area | Library | License note |
|---|---|---|
| Desktop audio devices, VST3/AU hosting, editors | JUCE 9.0.3 (verified current major on 2026-10-22) | AGPLv3 (ADR-0017) |
| ASIO | Steinberg ASIO SDK, bundled with JUCE 9 | GPLv3 option since October 2025; shipped (ADR-0017) |
| VST3 | Steinberg VST3 SDK (via JUCE) | MIT since VST 3.8 |
| CLAP hosting | CLAP SDK 1.2.10, first adopted in M4 by m4-clap-host | MIT |
| LV2 hosting (headless) | lilv, serd, sord | ISC |
| Media decoding | dr_libs, libFLAC, libvorbis/libogg | public domain/MIT-0, BSD |
| Resampling (offline and device-side realtime) | r8brain-free-src; libsamplerate as realtime fallback | MIT; BSD-2 |
| Time-stretch | signalsmith-stretch (default); Rubber Band optional | MIT; GPL or commercial |
| Persistent data structures | immer or in-house | BSL-1.0 |
| Lock-free queues | moodycamel ReaderWriterQueue (audio side: `try_*` only, preallocated) | Simplified BSD |
| Realtime logging | rtlog-cpp or in-house ring | MIT |
| Logging (non-realtime) | spdlog | MIT |
| Plan and document hash | picosha2 + in-house JCS + in-house RFC 6962 Merkle | MIT |
| HTTP / WebSocket | IXWebSocket, pinned, behind a thin adapter (first adopted in M3 by m3-protocol-server, v11.4.6 without zlib or TLS; replaced only on a measured gap) | BSD-3 |
| JSON | nlohmann/json (non-hashed I/O) when the in-house strict parser stops sufficing; not adopted yet. JCS serializer in-house | MIT |
| MCP | in-house thin JSON-RPC | — |
| DAWproject | pugixml + miniz | MIT |
| Build / packages | CMake + vcpkg or CPM | — |
| Tests | Catch2 or GoogleTest; pluginval for hosting tests | BSL-1.0 / BSD; GPL tool, not linked |
| Desktop shell | Electron + Electron Forge or electron-builder | MIT |
| Electron shell tests | Playwright (`@playwright/test`, Electron driver), pinned | Apache-2.0 |
| Frontend language | TypeScript, pinned | Apache-2.0 |

Not used: Taskflow (allocates at runtime).

### Licensing decisions (decided 2026-10-22, ADR-0017)

1. JUCE 9 under the AGPLv3, pinned to 9.0.3. Distributed desktop engine builds are
   offered under the AGPLv3 as a whole; SIANN's own code stays GPL-2.0-or-later,
   which may be combined with AGPLv3 code through GPLv3 section 13.
2. AGPL section 13: the protocol exposes the source location and exact commit of
   the running build to every client, and the UI shows it.
3. ASIO ships, using the GPLv3 ASIO SDK bundled with JUCE 9.
4. VST3 through JUCE under the SDK's MIT licence (VST 3.8 and later).
5. Rubber Band stays optional.

## Build, test and CI

- CMake, C++20; MSVC (Windows), Apple Clang (macOS), GCC/Clang (Linux, arm64
  cross-compile).
- CI matrix: Windows x64, macOS universal, Linux x64, Linux arm64 headless build.
  Plus a Linux x64 RealtimeSanitizer job ("Native core RTSan (ubuntu, Clang 20)"):
  Clang 20 from apt.llvm.org, the core built with `-DSIANN_RTSAN=ON`
  (`-fsanitize=realtime` on every target, third-party code included), the whole
  ctest suite with `RTSAN_OPTIONS=halt_on_error=1`, then the `[src]` tests
  explicitly. macOS is not covered: Apple Clang ships no RealtimeSanitizer
  runtime, and the Linux job already runs the same platform-independent core.
  Windows has no RTSan; the allocation guard runs there.
- A core-only build with no JUCE present runs on every CI job.
- `app/` is its own npm package with pinned dependencies (Electron, TypeScript,
  Playwright); the root bridge package stays dependency-free. An `app` CI job on
  windows-latest, macos-latest and ubuntu-latest (under `xvfb-run` with openbox) builds the
  core-only `siann-engine` target, runs `npm ci` and the Playwright Electron tests
  in `app/` with `SIANN_ENGINE_EXE` pointing at the built engine; locally
  `node scripts/check-all.js --app` runs the same after the native step.
- Long tests are Catch2 tests tagged `[.][long]`: hidden, so the default ctest run
  leaves them out (a ctest guard checks that), and run by the scheduled or
  manually triggered `long-tests` workflow (`siann_cli_tests "[long]"`). M2's
  10-minute recording and kill test is the first.

Test layers:

| Layer | Contents |
|---|---|
| L0 unit | time, midi, model, command, JCS fixtures shared with Node, DSP |
| L1 determinism | journal replay yields identical document hashes; offline render golden files with tolerance |
| L2 headless end-to-end | CLI builds a session, records from a file-backed fake device, renders, compares |
| Realtime safety | audio-thread allocation hooks, RealtimeSanitizer, TSAN/ASAN/UBSAN builds |
| Stress | fake device driving callbacks at small buffers; deadline-miss counting; rapid graph swaps; queue overflow; device hot-unplug; disk full; sample-rate mismatch |
| PDC | null tests across direct, send, aux, sidechain; latency change during playback |
| Parity | offline vs realtime null test (through the same SRC when SRC is active); single vs multi-thread bit-identical (when threading exists) |
| Fuzz | command JSON and protocol messages |
| Plugin (L3) | a built-in hostile test plugin (`siann_hostile_plugin`: allocates, throws, changes latency, sleeps, calls back into the host, crashes on a parameter; outcomes under "siann-host: two targets, one interface", Hostile test plugin) plus pluginval-checked real plugins (VST3 and AU at strictness 5; pluginval is JUCE-based and checks no CLAP; `siann_test_plugin` in CI, the compatibility set on maintainer runs) |
| Recovery | kill the engine at random points during recording and editing; verify recovery criteria |
| L4 manual | DAWproject into Cubase / Studio One / Bitwig; recorded per release |

## Embedded Linux

- Engine built with `siann-host-headless`: no JUCE, no X11, no Electron.
- Audio via ALSA or JACK; MIDI via ALSA sequencer.
- Plugins: CLAP and LV2 (headless). No native editors.
- Controlled from a browser on another device (LAN mode rules apply).

## What we do not copy from SoundCraft

SoundCraft is a good reference for layering and its command catalog. These parts are
explicitly not a reference for production realtime design:

- Replacing the session `Arc` inside the audio callback and syncing the mixer there
  (`crates/playback/src/lib.rs`), which can free and allocate on the audio thread.
- Decoding whole media files into RAM (`SourcePool`).
- Global PDC that aligns every strip to the slowest one instead of per-edge
  compensation.
- In-process plugins with no isolation plan.

## Documents made stale by this decision

To be updated together with the superseding ADR:

- `docs/adr/0003-start-from-ardour-derived-engine.md` and
  `docs/adr/0014-build-siann-as-headless-daw-runtime.md`: mark superseded; update
  `docs/adr/0000-adr-index.md`.
- `AGENTS.md`: "Engine: implemented in /Users/garyhsieh/siann-engine" and the Ardour
  descriptions; command catalog entries that require the Ardour engine.
- `CLAUDE.md`: "The Ardour-derived audio engine lives in a separate sibling checkout".
- Harness engineering spec: Part 3 (Engine Modification Harness, an Ardour fork
  policy, including 3.2 runtime protocol rules) and 3.5 licensing; section 1.2 gains
  the JCS, number encoding and hash payload rules; section 1.4 and Part 4 point
  `observationHash` at the document hash and keep per-entity plan staleness.
- `docs/superpowers/specs/2026-07-07-siann-headless-engine-runtime-v0.md`: historical.
- `docs/schemas/command-journal-v0.md`: v1 for the native engine (revision DAG,
  WAL, diff-based touched IDs).
- Naming: the existing Ardour checkout directory `siann-engine` collides with the
  new engine name. Rename or archive the checkout (for example
  `siann-engine-ardour-archive`) before new engine code lands.

## Migration from the current repository

- The Ardour engine path is retired.
- The Node bridge remains the shippable product (intake, plans, DAWproject export)
  until M5, and the reference implementation of plan semantics. It moves to JCS
  hashing in M1 so both implementations share fixtures.
- The `siann-intake` skill keeps working against the Node path and later against the
  engine's MCP adapter.
- New code lives in this repository: `native/` (CMake, C++), `app/` (Electron and
  web UI), `fixtures/` (JCS, hash, time and recovery fixtures shared by Node and
  C++). The Node bridge keeps building and testing on its own.

## Milestones

Each milestone has exit criteria and a kill criterion that triggers a design
review instead of pushing on.

| Milestone | Scope | Exit criteria | Kill criterion |
|---|---|---|---|
| M0 Spike | Electron + engine helper process on macOS and Windows; JUCE hosting inside the engine helper process; IXWebSocket server; `siann-host-api` interfaces drafted | Engine starts/stops with the app; renderer connects with token handshake; one third-party VST3 and one AU load, save/restore state, report latency, open editors; signed (Developer ID, hardened runtime) and notarized macOS build runs, built by hand once; focus/Cmd-Tab behavior acceptable | No acceptable editor-window behavior on macOS after 2 weeks: evaluate engine-in-main-process or Tracktion |
| M1 Headless core | time, midi, model, command, revision DAG, journal WAL, checkpoints, session bundle, JCS and Merkle hashing, `siann-host-api`, minimal graph (GraphCompiler, PreparedGraph, ClipPlayerNode, TrackNode with gain, BusNode, SendNode, SidechainNode, MeterNode, FakeLatency), WAV/FLAC decode via dr_libs, offline import conversion, synchronous offline render, CLI | CLI creates a session, imports audio, places clips, sets gain, renders WAV; replay gives identical document hashes; offline PDC null tests pass across direct, send, aux and sidechain paths with static `FakeLatency`; a kill at each commit step (after blob write, after journal append, during checkpoint replace) recovers correctly; Node and C++ pass the same JCS, hash and time fixtures | Structural sharing too slow for 500-track documents: revisit data structure |
| M2 Realtime engine | graph driver, control dispatcher and queues from revision 3 (tested first against a fake audio device), JUCE device, transport, single-threaded graph, structural and parameter channels, outboxes, retire queue, state migration, runtime latency changes, disk streaming, input node, simple recording to disk, device-side SRC | 32 tracks playback without xruns (deadline misses, measured by `siann-cli bench`; disk underruns and SRC underfill also zero) at 256 samples, also with SRC active (44.1 kHz session on a 48 kHz WASAPI shared device); SRC quality and record-offset tests pass; realtime PDC null tests pass, including a latency change during playback; gesture via parameter channel; record 10 minutes and recover after kill; realtime-safety checks clean | Persistent xruns not fixable within the design: Tracktion decision gate |
| M3 Agent access | Protocol server, consistency and security rules, MCP adapter, plans with approval, rollback, audition | An MCP client builds a session through approved plans, rolls back, auditions a branch; reconnect and gap sync tested | — |
| M4 Plugins | CLAP host first (both targets), then JUCE VST3/AU; capabilities; hostile test plugin | Third-party plugins load, save state, compensate latency, survive restart; capability flags exposed to agents | — |
| M5 Desktop UI v1 | Timeline, mixer, plan review UI in Electron | Arrange and mix by hand; review and approve an agent plan visually | — |
| M6a Automation | Write/Touch/Latch/Trim, lanes, precision contract | Automation passes recorded as single revisions; precision documented per format | — |
| M6b Recording production | Punch, loop record, takes/playlists, monitoring modes, MIDI recording | One hour 16-track recording criterion passes | — |
| M6c Mixing structure | Groups, VCAs, sidechain, bounce/stems | Production-level criteria list passes | — |
| M7 Embedded | Headless host target on arm64, browser control | Engine runs on a Raspberry Pi class board controlled from a browser | — |

### Status (2026-11-06)

M1 is done (status as of 2026-10-21 below). M2 is exit pending: every feature
is merged (PRs #14, #16 to #18, #20, #21, #24 to #30, #35 and #36), four exit
criteria are met with passing tests in CI (the long recording test included),
and two need the device bench on the maintainer's machine (see "M2 exit check
(2026-11-04)"). M3 is done: every feature is merged (PRs #38 to #43) and both
exit criteria are met with tests that pass in CI (see "M3 exit check
(2026-11-06)").

M4 interim note (m4-engine-device): `siann-engine` loads its session into a
`PlaybackEngine` and runs the graph driver on a device. `EngineHost`
(`native/apps/engine`) owns the device, the playback engine, an `Auditioner` and the
meter publisher, and serves `protocol::TransportPort` and `protocol::AuditionPort`,
so `command.execute`, `plan.apply`, undo and redo reach the live graph and
`audition.hear` works in the engine process. The main thread is the command and
control thread for now ("Process model"). `session.open` stays `not_supported` in
`siann-engine` until the host can rebind inside it; that, a device selection method,
and MCP tools for the transport and `engine.status` are follow-ups before M5.

M4 decisions (2026-11-08, Fable, delegated by the maintainer; the wave 2 and 3
plans stopped on them): `render.start` keeps its snapshot and instantiates its
own instances, and `plugin.instantiate` runs inside the request on the command
thread ("Commands and jobs", Jobs v0, plugins); `plugin_slot` and its commands
are fixed ("siann-model"); MIDI output takes the preallocate-and-count option
("Realtime rules and enforcement", condition 3); `pluginEventAny` is drained by
the host's tick and the instance table calls `setBlocksComing` ("Threads and
waiting rules"); the editor flag gives way to `plugin.open_editor` and
`plugin.close_editor`, the capability flags and per-instance status have their
protocol places, and `plugin.set_parameter` is the live, non-journaled path the
plugin crash test needs (Protocol v0 items 14, 18, 19 and 20); the hostile test
plugin's outcomes are written down ("siann-host", Hostile test plugin). Rejected:
the crash trigger in the state blob (item 20) and `render.start` stopping the
transport to move the live graph (an agent's render would interrupt playback and
render the heard side, not head). CLAP editor windows on the desktop target move
to "Before M5" in the follow-ups: M4's exit names no editor, and the UI is their
first consumer.

M1 is implemented in `native/` (PRs #3 to #12) and every exit criterion has an
automated test that runs in CI on Windows, macOS and Linux:

| M1 exit criterion | Evidence |
|---|---|
| CLI creates a session, imports audio, places clips, sets gain, renders WAV | `apps/cli` test "M1 exit criterion", run in a non-ASCII bundle path |
| Replay gives identical document hashes | `siann-cli verify` in the same test; `siann-session` reopen tests compare every revision envelope |
| Offline PDC null tests across direct, send, aux and sidechain paths | `siann-graph` tests; three paths cancel to exact zero, nested buses within 1e-6 |
| A kill at each commit step recovers | `siann-session` tests: media written but not journaled, torn journal tail, corrupted record, interrupted and tampered checkpoint |
| Node and C++ pass the same JCS, hash and time fixtures | `fixtures/` checked by `test/jcs.test.js`, `test/merkle.test.js`, `test/fixture-parity.test.js` and the native suites |
| Kill criterion: structural sharing too slow for 500-track documents | Not triggered: 500 tracks and 5,000 clips with 100 edits take 0.16 s (MSVC Release) |

Known limits carried into later milestones: the PDC tests build graphs
directly, because the M1 document has no buses or sends yet; the history is a
single chain (proposal branches arrive with audition in M3); overlapping clips
sum. Revision 3 (realtime data flow) is still required before M2.

M2 interim (playback engine): the playback assembly (session document to
streaming graph plus the entity-to-slot map for the control dispatcher) lives
in `siann-playback`, above `siann-engine` and `siann-realtime`. FLAC media plays
through an in-memory `MediaReader` (decoded once when the graph is compiled)
until a streaming FLAC reader exists; WAV media streams from disk.
Gestures on a track fader (gain, pan, mute) commit at `gesture.end` as one
plain `track.set_gain`, `track.set_pan` or `track.set_mute` revision carrying
only the end value. The start value is not recorded in the command: the
overlay never changes the document mid-gesture, so the start value is the
value in the parent revision. Recording both values in the
journal entry, as "Gestures" requires, arrives with the protocol's
`gesture.end` and automation write passes; other parameters are rejected
before a gesture opens, so every open gesture can be ended.
Duck-and-swap for a structural edit ducks the whole master output in M2, not
only the affected paths ("Publishing and retiring graphs"): a structural
compile builds a new graph from the document and does not yet report which
streams and instances it reused, so every structural recompile (a track added,
removed or changed in anything but gain, pan and mute) dips the full mix for
one fade length (5 ms) down and back up. Ducking only the affected paths
follows when buses and plugins make the recompile paths distinct (latency
recompiles already ramp only their affected edges; see the next note).

M2 interim (realtime PDC): a runtime latency change is answered by the graph
driver itself, in its control-side `poll()`, with
`PreparedGraph::recompile()`. Until the instance table exists (plugins, M4),
state migration is done by the recompiled graph sharing the previous graph's
node instances and every compensation delay line whose length is unchanged
(shared ownership, released on the control side when the last graph using
them retires); only the delay lines whose compensation changed are rebuilt.
The disk streams the shared instances read stay alive with them: the driver
reports a graph as retired to the playback engine only when the last graph
recompiled from it is retired.
The swap ramps only the affected edges (rebuilt delay lines and edges leaving
the node whose latency changed), holds them at zero until the rebuilt lines
are full, then raises them; unaffected paths are untouched. A recompile that
arrives while a rise is still running (start-up, after a locate, or the hold
and rise of an earlier recompile) ducks the whole output instead, and the
affected edges, plus those an earlier hold still covers, are held after the
swap all the same. A recompile keeps every slot, so parameter changes for the
original epoch still apply. A recompile that fails (a path above the
compensation limit) leaves the live graph playing with its old compensation
and is flagged through `latencyFault()` on the graph driver and the playback
engine (node, new latency, error code) until a later recompile succeeds; the
protocol event that reports it to clients and agents arrives with M3.
Structural edits (other publishes) and locates still duck the whole output.

M2 exit check (2026-11-04), on `main` at 9c6c00c. `node scripts/check-all.js
--gcc --desktop` passes (Node tests, dev preset 307 ctest tests, desktop preset
319 ctest tests, g++ -Werror syntax check), and CI on that commit is green
(run 41753381539, every job including "Native core RTSan (ubuntu, Clang 20)"):

| M2 exit criterion | Status | Evidence |
|---|---|---|
| 32 tracks for 60 s at 256 samples, zero xruns, default device (`m2-exit-xruns`) | Needs the maintainer | Not run by the harness: the default device is the maintainer's studio monitors, and the bench session sums 32 in-phase 440 Hz sines at 0.1 each (peak 3.2, clipped at full scale). Run `siann-cli bench <dir> --tracks 32 --buffer 256 --seconds 60` from the desktop preset (Release recommended) with the monitors muted or on a silent output, and record the JSON here. On the paced fake device the same run reports 11,250 callbacks, 0 xruns, 0 underruns, 0 SRC underruns and a 3.9 ms maximum callback against a 5.3 ms period (Debug build); this does not replace the device run. |
| Same bench with SRC active (44.1 kHz session, 48 kHz device); SRC quality and record-offset tests (`m2-exit-src`) | Tests met; device run needs the maintainer | The `[src]` tests in `siann-realtime` (sine, aliasing and impulse through output and input SRC, block-size independence, resampling state), the playback parity test through SRC and "Loopback null test through input and output SRC" pass. The bench with `--rate 44100` on the 48 kHz WASAPI shared default device is owed, with the same caution as above. On the fake device (which runs at the session rate, so no SRC) the 44.1 kHz run reports 0 xruns. |
| Realtime PDC null tests, including a latency change during playback (`m2-exit-pdc`) | Met | `ctest -R pdc`: 22 tests pass, including the four realtime null tests through the graph driver, the four "latency change during playback is recompiled and nulls again" tests and the offline/realtime parity test. |
| A fader gesture through the parameter channel commits one revision (`m2-exit-gesture`) | Met | `siann-playback` test "A fader gesture moves the sound through the parameter channel and ending it commits exactly one revision", plus the pan and mute gesture tests. |
| Record 10 minutes and recover after a kill (`m2-exit-record`) | Met | `siann_cli_tests "[long]"` (hidden from the default ctest run, guarded by `siann_cli_long_tests_hidden` and `siann_cli_long_tests_listed`): "A 10-minute take records every frame of the counter and commits" records 600 s of device time on the fake device at 4x with the counter input and checks 28,800,000 frames, zero overflows and every sample on one consecutive counter; "A 10-minute take killed at 9 minutes recovers every flushed block" kills the child once its ready file reports 540 s durable and recovers at least those frames, content checked the same way. Both pass on Windows (dev preset, Debug): 154 s and 139 s. They run nightly and on `workflow_dispatch` in `.github/workflows/long-tests.yml` (Linux and Windows); its first run, dispatched on `main` at 9c6c00c (run 41755387142, 2026-11-04), passed on ubuntu-latest and windows-latest. The CLI kill test "A recording siann-cli killed mid-take leaves a pending take that recovers" now waits on `--ready-file` instead of polling the WAV header and the manifest the child rewrites (a reader could make the child's atomic replace fail on Windows) and passed 20 consecutive runs (`ctest -R "killed mid-take" --repeat until-fail:20`). |
| Realtime-safety checks clean: allocation guard on every realtime test, RTSan where Clang is available (`m2-exit-rt-safety`) | Met | Every realtime test binary links `siann_rt_alloc_guard` (rt, realtime, playback, host_fake, host_desktop, cli). The CI job "Native core RTSan (ubuntu, Clang 20)" (`m2-rtsan-ci`) builds the core with Clang 20 from apt.llvm.org, `-DSIANN_RTSAN=ON` and `-DSIANN_WERROR=ON`, runs the whole ctest suite with `RTSAN_OPTIONS=halt_on_error=1` (the dev preset's tests plus the four `siann_rtsan_canary_*` tests, which expect allocation, lock and sleep inside the realtime scope to be reported and nothing under the disabler), then `siann_realtime_tests "[src]"` explicitly. Its commands, run as written in WSL with Clang 20.1.8 before the pull request: build clean, 300 ctest tests passed, `[src]` passed, no RTSan report outside the canaries (see "Device-side SRC (M2)"). The job reruns on every pull request and on `main`; it passed on `main` at 9c6c00c (run 41753381539). |

Kill criterion (persistent xruns): not triggered so far; it can only be judged
after the device bench runs.

M3 can start in parallel with M2 because M2's meter test page already needs the
protocol.

M0 interim (plugin hosting, m0-plugin-hosting): `JucePluginHost` in
`siann-host-desktop` implements `PluginHost` for VST3, and AU on macOS (ADR-0018, Amendment 2); LV2 stays
off until a milestone needs it. What the audio thread may call stays on
`PluginInstance`: `process` and the any-thread reads of capabilities, latency and
tail. In M0 `process` discards its `EventList`: the plugin gets an empty MIDI
input, and MIDI it produces is dropped with the block (the M4 plugin node decides
how MIDI output is carried). The tail and the latency are values kept by the
instance: the formats allow the call behind the tail on the UI thread only (VST3
`getTailSamples`), and JUCE's latency is a plain int written on the message
thread, so the main thread reads both at load, after `setState` and when the
plugin reports a change, into atomics, and neither the reader nor the audio
thread enters the plugin. Everything else lives on `PluginControl`,
reached through
`PluginInstance::control()`, as "siann-host-api" requires of control-only
operations: `getState`, `setState`, and, all message-shaped, `parameters`,
`getParameter`, `setParameter` (normalized values), `openEditor` (with an
`EditorOwner` holding the native window), `closeEditor`, `editorOpen`,
`editorNativeHandle` and `setEventSink`, whose `PluginEvent` values (latency
changed, parameter edited, restart requested) are plain data for
`pluginEventAny`; `PluginHost` gained `scanPath` for one bundle. `getState` wraps
the plugin's blob in an envelope (magic, version, plugin uid, size), so `setState`
refuses another plugin's blob with parameters unchanged; a plugin that refuses
its own payload cannot be seen through VST3 or AU and keeps its parameters. `setState`
during playback holds the plugin out of processing until it returns: JUCE's VST3
wrapper reads pending parameter values into a block and hands them to the plugin
inside `process`, so a value set just before a restore could otherwise land after
it and silently win. `process` never waits for this. It skips the plugin and passes
its input through, as it does between the halves of a `kIoChanged` restart; the main
thread waits for the block in flight, and a restore during playback costs that dry
stretch. Accepted for M0 (2026-11-07): a restore is a user or agent action (load,
undo, an audition switch), its dry stretch is the plugin's `setStateInformation`
plus at most one block, and no production path calls `setState` during playback
yet. `setState` is never a parameter path: a value change goes through
`setParameter`. Audition (A/B of proposals) is the case that will make restores
during playback frequent; its design records that each switch of a plugin's state
is one such stretch. A fade around the gap belongs with worker processes. A
descriptor's `uid` leaves out the install path, so state follows a plugin to
another machine; `instantiate` keeps the two apart, loading the bundle at the
descriptor's `path` and nothing else, so two installs of one plugin never stand in
for each other. A stale path fails; a descriptor without a path needs exactly one
known install. `scan` lists format, path and name without running plugin code,
because a bundle that crashes on load would take the engine with it (one on the
maintainer's machine does, now and then); `scanPath` loads and probes a single
bundle in the process until plugin workers exist, and the rest of a descriptor
comes from it.
`MainThreadLoop` makes the main thread JUCE's message thread and dispatches until
a predicate holds, which needs `JUCE_MODAL_LOOPS_PERMITTED=1`. Windows owns editors
through `GWLP_HWNDPARENT`; on macOS they float and the engine switches from
accessory to regular while one is open. The hosting tests load
`siann_test_plugin`, a delay of known length built by the desktop preset, so
latency is checked against audio, and the plugins named by `SIANN_TEST_VST3` and
`SIANN_TEST_AU` on the maintainer's machines. The same checks (state round trip,
runtime latency change measured in audio, editor) run against the plugin's VST3 and,
on macOS, its AU. The maintainer plugins prove state, an editor they must have, and
reported latency against the delay of an impulse; the runtime latency change is
proven on `siann_test_plugin` only, because TDR Nova has none to drive: every value
tried on all 75 of its parameters left it at 184 frames at 48 kHz, its Quality
modes included. The engine's `main()` runs `MainThreadLoop` in a `SIANN_WITH_JUCE`
build, and `--owner-window` carries the Electron window handle; since M4 the
plugin comes through `plugin.instantiate` and `plugin.open_editor` (see "Process
model"); a launch test checks the owner across
processes and an Electron test checks it is the real window. The macOS and Linux
halves count only once the desktop CI matrix is green on the pull request: they
cannot be built on the Windows machine this was written on.

M3 interim (proposal audition, m3-audition): proposal branches live in
`siann-command`'s `History` (`branch`, `commitOn`, `merge`, `discard`,
`reachable`, plus `commitOnParent` and `mergeReplay` for replay) and are
journaled by `siann-session`, whose branch commit records carry `branch`.
`Session::proposePlan` applies an approved plan onto a new branch at its base
revision, the entry point for m3-mcp; the plan-to-branch link lives in
`PlanStore` (`proposalBranch`, `proposedPlan`), `Session::merge` guards the
plan's read and write sets through `History::merge`'s guarded entities and
marks the plan applied at the merge revision, and `Session::discard` drops the
link. Audition is an `Auditioner` in `siann-playback` over the playback engine:
it hands the heard side's document to `PlaybackEngine::update`, points gesture
commits at the heard branch (`setGestureBranch`), merges and discards through
`Auditioner::merge` and `Auditioner::discard`, and checks
`PlaybackEngine::estimateCost` against `PlaybackOptions::auditionBudget` first.
M2's whole-output duck applies to an A/B switch as to any structural edit. The
budget is the stand-in described under "Proposal audition (A/B)". The protocol
methods for proposals arrive with m3-mcp.

M3 exit check (2026-11-06), on `main` at 04c8f6c. CI on that commit is green
(run 42105732783, every job: Node bridge, native core on Windows, macOS and
Linux, the JUCE desktop host on all three, and RTSan); the native core runs
467 ctest tests on each platform. `node scripts/check-all.js --gcc` on the
exit branch passes (Node tests, dev preset build and ctest, g++ -Werror syntax
check).

| M3 exit criterion | Status | Evidence |
|---|---|---|
| An MCP client builds a session through approved plans, rolls back and auditions a branch (`m3-exit-e2e`) | Met | `siann_protocol_tests` "an MCP client builds a session through approved plans, rolls back and auditions a branch" (`[protocol][mcp][e2e]`) passes in CI on Windows, macOS and Linux. Over real HTTP (IXWebSocket, 127.0.0.1) with the MCP bearer token (a request without it is 401) it submits, approves and applies a plan that adds a track and a clip, submits and approves a second plan, proposes it onto branch `p1`, auditions `p1`, merges it (`branch-merge`), rolls the merged plan back (`rollback`, document hash back to the pre-merge hash), renders and polls the job, saves, and opens another bundle. The MCP scope rules (propose by default, `approve_plan` and `execute` scope_denied there) are covered by the `[protocol][mcp]` adapter tests. |
| Reconnect and gap sync are tested (`m3-exit-sync`) | Met | `siann_protocol_tests` `[protocol][sync]` and `[protocol][events]`, all passing in CI on the three platforms: "a client that detects a gap syncs and continues" (an outbox of two on a congested socket drops three events; the next event reveals the gap, the client calls `session.sync`, its read model matches the head document hash and the following event applies without another sync), "a reconnecting client resyncs" (two commits while disconnected; the hello reports seq, revision and document hash, the client syncs once, and a reconnect that missed nothing does not sync), "large sessions sync in chunks at one revision", "an overflowing outbox drops events and leaves a visible gap", and "a duplicate requestId returns the original response, also after a reconnect". |

Seen during the check, outside M3: the scheduled "Long tests" run on `main`
(run 42014565325, 2026-11-05) failed on windows-latest in "A 10-minute take
killed at 9 minutes recovers every flushed block" (`content.mismatchAt` was
22,782,208, a sample off the counter, after recovery); ubuntu-latest passed.
It belongs to `m2-exit-record` and is a follow-up for M2.

## Risks

1. Scope: a production DAW is multi-year work. Mitigation: measurable criteria,
   kill criteria, the Node product shipping meanwhile.
2. Plugin compatibility and stability. Mitigation: JUCE hosting on desktop, hostile
   test plugin, crash recovery, a message-shaped host interface ready for sandboxing.
3. Realtime correctness. Mitigation: the realtime data flow rules, enforcement in
   debug and CI, stress tests.
4. macOS packaging and plugin windows. Mitigation: helper app design validated in M0.
5. Licensing (JUCE, ASIO, VST3, AGPL network clause). Mitigation: decisions before M2.
6. Reference drift: SoundCraft moves fast; it is a reference, not a dependency.
7. Protocol latency for gestures. Mitigation: parameter channel and optimistic UI for
   continuous gestures only.

## Revision 3 changes

The review of revision 2 found six gaps in the realtime data flow. Revision 3
resolves them in the sections named here:

1. Graph ownership without a callback: "Graph ownership" (graph driver states).
2. Command-thread duties and deadlock risk: "Threads and waiting rules" and the
   control dispatcher in "Two channels into the audio thread".
3. Queue completeness: "Queues", now including MIDI, disk rings, butler requests,
   seeks and two plugin event queues.
4. Locate without underruns: "Locate".
5. Instance lifetime: "Publishing and retiring graphs" (one transition in flight,
   duck-and-swap, identity-based retirement).
6. Gestures, audition and recording offset: "Gestures", "Proposal audition" and
   "Latency model".

Revision 3.1 changes after an independent review: two ring slots per track
("Locate"); pinned instance lifetimes ("Publishing and retiring graphs"); newer
epochs wait at the queue head ("Two channels into the audio thread");
non-blocking messages, device control on the main thread, and the render and MIDI
threads in the table ("Threads and waiting rules"); the watchdog, the pending-graph
rule and offline parameters ("Graph ownership"); the write-pass end marker
("Write modes"); the calibrated, monitored-path recording offset and a fixed SRC
FIFO fill ("Latency model", "Device-side SRC").

## Open questions

1. When to introduce plugin worker processes. They end the hosted-plugin lock
   exception under "Realtime rules and enforcement" (ADR-0018). Proposed trigger
   (2026-11-07, open to the maintainer): the first of (a) a hosted-plugin crash or
   a restart-attributed xrun reproduced on a maintainer machine, (b) hosting a
   plugin set the maintainer did not choose, (c) the first build distributed
   beyond the maintainer's machines.
2. Default plan approval granularity in the UI (whole plan vs step list).
3. Developer ID certificate and notarization key: the maintainer's Apple Developer
   account exists; the certificate and key are created at the end of M0 (ADR-0017).

## References

- SoundCraft: https://github.com/storytold/soundcraft (architecture reference)
- Research brief: `D:\research\2026-09-19-ai-driven-daw-open-source-33u7\BRIEF.md`
- Reviews: `D:\research\siann-arch-review\`
- RFC 8785, JSON Canonicalization Scheme
- [Harness engineering spec](2026-07-11-siann-harness-engineering-spec.md)
- [ADR index](../../adr/0000-adr-index.md)
