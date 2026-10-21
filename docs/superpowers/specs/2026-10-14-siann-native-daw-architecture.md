# SIANN Native DAW Architecture

Date: 2026-10-14

Status: Accepted, revision 3 (realtime data flow resolved for M2). Revision 2.1 was
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
without cached runtime graphs.
Realtime topics found in the review of revision 2 (graph ownership without a
callback, command-thread duties, queue completeness, locate, instance lifetime) are
deferred to revision 3, which must be accepted before M2 starts. See "Deferred to
revision 3".

## Decision summary

| Topic | Decision |
|---|---|
| Product | A production-level DAW (multitrack audio and MIDI, automation, plugins, routing, groups, VCAs, recording, bounce) that AI agents operate through reviewed, reversible plans |
| Engine | Written from scratch in standard C++ (C++20), headless, its own process |
| Engine base | No Ardour fork. JUCE only in the desktop host target (audio devices, VST3/AU/LV2 hosting, plugin editor windows). A JUCE-free host target exists for embedded |
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
  reference machine per platform.
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
   VST3/AU/LV2 host, editors       |   LV2 via lilv
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
|   control thread    gestures, parameter dispatch, meters to clients                |
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
  processes; editors float and the engine activates itself.
- Crash: Electron restarts the engine with backoff; the engine recovers from the
  last checkpoint plus journal replay; the UI reconnects and resyncs. Exclusive-mode
  and ASIO devices may need a retry delay before reopening.
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
   latency changes. A compiler worker builds a new `PreparedGraph`, and the command
   thread publishes it through the graph driver (see "Graph ownership"). At most one
   structural transition is in flight. Throughput: occasional.
2. **Parameter channel**: gain, pan, mute, send level, plugin parameters, transport.
   A bounded SPSC queue of `ParamChange{slot, paramId, value, rampFrames, epoch}`
   applied at the start of the next block (or at a sample offset for sample-accurate
   targets). `slot` is the node's index in the compiled graph with that `epoch`; the
   audio thread drops changes whose epoch is not the current graph's. No snapshot,
   no recompile. Throughput: up to hundreds per second.

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
| audio | processes the live graph; pushes outboxes | nothing |
| main | JUCE message loop; plugin instantiate, destroy, state, editors | nothing it does not own |
| command | validates, applies and journals commands; publishes documents; asks for compiles; installs graphs through the driver | `AudioDevice::stop()` only, bounded by one device buffer |
| compiler | builds `PreparedGraph` from an immutable document and an immutable instance table | the main thread, for instantiation, with a timeout |
| control dispatcher | gestures, overlays, `paramInbox`, meters to the protocol | its own inbox |
| butler | disk read-ahead, seek preparation, record write-through, peaks | disk I/O |
| protocol | WebSocket/HTTP/MCP I/O | network I/O |

- Every request between non-realtime threads is a message with a completion message,
  never a synchronous call, except the two blocking edges in the table.
- The wait graph is therefore acyclic (compiler waits on main; command waits on the
  device callback exiting), so the threads cannot deadlock. Adding a blocking call
  requires updating this table and showing the graph stays acyclic.
- The compiler reads only immutable inputs: the document, the previous graph's
  descriptor (node identities, slots, latencies) and the instance table. It never
  reads live DSP state.

### Queues (all bounded, preallocated)

| Queue | Producer → consumer | Kind | Payload | Overflow policy |
|---|---|---|---|---|
| `graphInbox` | command → audio | SPSC, capacity 1 | `PreparedGraph*` + epoch | cannot overflow: one transition in flight |
| `retireOutbox` | audio → command | SPSC, capacity 1 | retired `PreparedGraph*` + epoch | cannot overflow: one transition in flight |
| `paramInbox` | dispatcher → audio | SPSC | `ParamChange` | dispatcher coalesces per (slot, param) and retries |
| `controlInbox` | protocol, main, command → dispatcher | MPSC, mutex | gestures, editor edits, committed values, locate | bounded; producers are non-realtime and wait briefly |
| `commandInbox` | protocol, main, compiler, butler → command | MPSC, mutex | requests and completions | bounded; non-realtime producers only |
| `midiInbox[device]` | MIDI driver thread → audio | SPSC per device | timestamped MIDI 1.0 events | drop and count; the audio thread then sends all-notes-off on the affected channels |
| `diskRing[track]` | butler → audio | SPSC ring per playing track | audio frames tagged with a seek generation | underrun outputs silence and counts an xrun |
| `butlerRequest` | audio → butler | SPSC | refill hints (track, consumed position) | latest-wins per track; the butler also polls |
| `seekRequest` | dispatcher → butler | MPSC, mutex | target position + generation | a newer generation replaces an older one |
| `recordOutbox` | audio → butler | SPSC ring | input blocks of armed tracks | overflow is a reported error, never a block |
| `meterOutbox` | audio → dispatcher | SPSC | meter blocks, playhead | latest-value-wins; drop when full |
| `automationOutbox` | audio → command | SPSC, per write pass | `(param, sample, value)` | thin in place and count |
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
- `stop` and device loss: `AudioDevice::stop()` returns only after the callback has
  exited and will not run again (a host contract). The command thread then takes the
  graph back, drains `graphInbox` and `retireOutbox`, and moves to `stopped`.
- Bounce and export stop realtime playback and move the graph to the offline driver,
  then back. M2 does not render offline while playing, so instances are never driven
  by two threads.

### Publishing and retiring graphs

- The audio thread holds a raw pointer to the live `PreparedGraph`. Each graph
  carries an epoch.
- A transition is duck-and-swap, not a crossfade between two running graphs: the
  audio thread ramps the outputs of affected paths in the old graph to zero over
  the fade length (default 5 ms), swaps at the next block boundary, and the new
  graph ramps those paths up again. Unaffected paths are untouched. Exactly one
  graph is processed per block, so a reused plugin instance is never processed
  twice.
- After the swap the audio thread pushes the old graph to `retireOutbox`. On that
  acknowledgement the command thread computes which runtime instances the old graph
  held and the new one does not (by instance identity, not by slot ID), and sends
  their destruction to the main thread. Only then may the next transition publish;
  compiling the next graph may already have started.
- If several revisions arrive during one compile, the next compile uses the latest
  document only.
- No `shared_ptr` whose count can reach zero is ever touched on the audio thread.
  `std::atomic<std::shared_ptr>` is not used (not lock-free on libstdc++ or MSVC).

### State migration

- The compiler reuses every plugin instance, delay line, smoother and meter whose
  entity ID is unchanged, looked up in the instance table. New plugins are
  instantiated on the main thread at the compiler's request before publication;
  removed ones are destroyed after the retire acknowledgement.
- Reverb tails and compressor envelopes survive unrelated edits.
- When a plugin's latency changes, the affected paths recompile; their delay lines
  are rebuilt and the paths are ducked and restored as above.

### Locate

- `transport.locate(target)` goes to the dispatcher, which sends a `seekRequest` with
  a new generation to the butler.
- The butler refills each playing track's `diskRing` from the target (default
  prefill 250 ms), tags the rings with the generation and reports ready.
- The dispatcher then sends the locate through `paramInbox`. At the next block
  boundary the audio thread moves the playhead, reads only rings with the matching
  generation, and ducks the master around the jump.
- Until ready, playback continues from the old position. A newer locate cancels an
  older one. If the butler is not ready within 1 s, the locate proceeds and any
  underrun is counted and reported.
- Play from stop is a locate to the current position followed by start. The offline
  driver reads media synchronously and needs no handshake.

### Realtime rules and enforcement

- The audio thread never locks, allocates, frees, logs, throws, or performs I/O.
- Debug builds mark the audio thread with a thread-local flag; global `operator
  new/delete` and malloc hooks abort if called on a marked thread.
- Clang RealtimeSanitizer (`-fsanitize=realtime`, `[[clang::nonblocking]]`) runs in
  CI on platforms where Clang is available.
- Diagnostics from the audio thread go through a lock-free log ring drained by a
  non-realtime thread (for example rtlog-cpp); spdlog is used only off the audio
  thread.
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
- Recording offset: what the performer hears trails the timeline by the graph's
  total latency plus the device output latency (plus output SRC latency when
  active), and what they play reaches the engine after the device input latency
  (plus input SRC latency). A captured block whose audio-thread timeline start is
  `t` is therefore placed at `t - totalLatency - outputLatency - inputLatency - srcLatency`.
- The formula is the same in every monitoring mode. Input monitoring (auto or input)
  uses a low-latency path that bypasses compensation delays, which changes what the
  performer hears of themselves, not where the take lands. M2 tests this with a fake
  loopback device in each mode.
- Latency change at runtime (VST3 `restartComponent(kLatencyChanged)`, CLAP
  `latency.changed`, AU property notifications) arrives on any thread, is forwarded
  to the command thread through `pluginEventOutbox`, and triggers a recompile with
  state migration.
- A global compensation limit (configurable) bounds delay line memory. Paths above
  the limit are flagged to the user and agents; they are not silently misaligned.
- Tests: a built-in `FakeLatency` node with settable and changeable latency; null
  tests across direct, send, aux and sidechain paths.

## Automation

### Precision contract

| Target | Precision |
|---|---|
| Built-in DSP | Sample-accurate (per-sample ramps) |
| CLAP plugins | Sample-accurate (events carry sample offsets) |
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
  `automationOutbox`. The command thread accumulates them and, at touch release or
  transport stop, thins them and commits one `automation.write_pass` command
  (one revision, one journal entry).

## Gestures

- `gesture.begin(target)` → many `param.set` on the parameter channel →
  `gesture.end(target, finalValue)`.
- Only `gesture.end` creates a revision and a journal entry, containing start and
  end values (and the automation pass, if writing).
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
  rate, the engine plays through device-side sample-rate conversion (SRC). The
  session is never silently converted.

### Device-side SRC (M2)

- The graph always runs at the session rate. SRC sits only at the device boundary:
  output SRC from session rate to device rate, input SRC from device rate to session
  rate. Offline render and bounce never pass through it.
- Pull model: the graph renders fixed-size session-rate blocks into a preallocated
  FIFO, and the output SRC consumes it to fill each device callback. The graph never
  sees a variable block size. The FIFO adds at most one graph block of latency.
- The SRC library runs on the audio thread, so it must be allocation-free after
  setup and pass the realtime checks. Candidate: r8brain-free-src streaming mode
  (MIT), verified with the allocation hooks and RealtimeSanitizer before adoption;
  libsamplerate (BSD-2) is the fallback.
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
  offline render passed through the same SRC.
- Playback streams from disk: a butler thread fills per-track ring buffers ahead of
  the playhead and refills on locate. Media is never fully decoded into RAM except
  for short files below a threshold.
- Underrun: the audio thread outputs silence for the missing samples, increments an
  xrun counter and emits an event; it never waits.
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
- `record.stop` creates exactly one revision: new `MediaSource` entries plus new
  clips (`record.commit_take`). Undoing it removes the clips and media references;
  recorded files are never deleted by undo or rollback. Unreferenced takes move to a
  trash folder inside the session and are purged only by an explicit command.
- The record offset follows the latency model.

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
  `plugin.insert {trackId, index, descriptor, stateBlob}` (pure command) enters the
  history. `media.import` produces files, then `media.add` enters the history.
- Rebuilding a document never requires a plugin to be installed or instantiable.
  Instantiation happens when audio starts; a plugin that cannot be loaded is shown as
  `missing` with its stored state preserved.
- `validate()` returns the declared effects, including cascades (deleting a bus
  lists the sends it removes). After `apply()`, the processor diffs the two
  documents; the actual changed IDs must be a subset of the declared ones, otherwise
  the command fails and nothing is published. The journal records the actual diff.
- VCA and group effects on derived values (effective gain) are not "touched" entities.

#### Revision DAG — single history

```text
Revision { id, parents, documentHash, cause, actor, time }   (envelope)
cause ∈ { command, plan(transaction), undo, redo, branch-merge, recovery }
```

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
- A plan applies as one transaction producing one revision.
- A proposal branch is a DAG branch. Committing it creates a merge revision on main;
  discarding it leaves it unreachable (kept in the journal for audit).
- Rollback of an applied plan when later edits exist: if the plan's affected
  entities were not changed afterwards, an inverse revision is created; otherwise
  rollback is refused with `rollback_conflict` and the conflicting entities are
  listed. No automatic three-way merge in v1.

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

#### Journal as write-ahead log

- `journal.ndjson` in the session bundle, append-only. One line is one complete
  record and one record is one revision: schema `siann.journal_record.v1`, a
  sequence number `seq` (decimal string, contiguous from 1), the revision envelope,
  the commands, the actual diff, and a SHA-256 over the JCS of the record without
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
  - `planHash = sha256(JCS(plan))`, excluding `hash`, `state` and approval fields
    (`approvedBy`, `approvedAt`, rejection notes).
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
- `JucePluginHost` for VST3, AU, LV2.
- Plugin editor windows (needs `juce_gui_basics`).
- Owns process startup: the main thread runs the JUCE message loop.

`siann-host-headless` (no JUCE, no display):

- `AlsaAudioDevice` / `JackAudioDevice`, ALSA sequencer MIDI.
- `Lv2PluginHost` via lilv (ISC).

Shared by both targets:

- `ClapPluginHost` via the CLAP SDK. CLAP is the only format available in both
  builds, so it is implemented first in M4.
- `MediaReader` via dr_libs / libFLAC etc. (not JUCE), so media reading is identical
  everywhere.

`PluginHost` contract:

- The core passes SIANN-owned buffer views (`float* const* channels, int frames`)
  and SIANN event lists; adapters wrap them without copying.
- Each method states its thread: `process` on the audio thread only; `instantiate`,
  `setState`, `openEditor` on the main thread; `getState` on the main thread with
  processing paused where the format requires it.
- Plugin-originated events (parameter edits from editors, latency changes, restart
  requests) arrive on arbitrary threads and go into `pluginEventOutbox`.
- The interface is message-shaped and never exposes raw pointers into plugin
  internals, so a later out-of-process worker (shared-memory audio ring, messages for
  params and state) can implement it without changing callers.
- Capability flags per instance (sample-accurate params, MIDI in/out, sidechain,
  variable latency, editor) are reported to the command layer and to agents.

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
McpAdapter       MCP (JSON-RPC) tools mapped onto the command registry:
                 list_commands, describe_capabilities, inspect_session,
                 submit_plan, plan_status, approve_plan (if the client is trusted),
                 execute (direct commands for trusted clients), job_status,
                 render, open/save session
```

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
| Desktop audio devices, VST3/AU/LV2 hosting, editors | JUCE (current major version; JUCE 9 is reported as current and must be verified) | AGPLv3 or commercial; tier conditions to verify |
| ASIO | Steinberg ASIO SDK | Proprietary; compatibility with GPL/AGPL distribution is disputed (Audacity does not ship ASIO builds). Decision required |
| VST3 | Steinberg VST3 SDK (via JUCE) | Check current terms for the chosen distribution model |
| CLAP hosting | CLAP SDK | MIT |
| LV2 hosting (headless) | lilv, serd, sord | ISC |
| Media decoding | dr_libs, libFLAC, libvorbis/libogg | public domain/MIT-0, BSD |
| Resampling (offline and device-side realtime) | r8brain-free-src; libsamplerate as realtime fallback | MIT; BSD-2 |
| Time-stretch | signalsmith-stretch (default); Rubber Band optional | MIT; GPL or commercial |
| Persistent data structures | immer or in-house | BSL-1.0 |
| Lock-free queues | moodycamel ReaderWriterQueue (audio side: `try_*` only, preallocated) | Simplified BSD |
| Realtime logging | rtlog-cpp or in-house ring | MIT |
| Logging (non-realtime) | spdlog | MIT |
| Plan and document hash | picosha2 + in-house JCS + in-house RFC 6962 Merkle | MIT |
| HTTP / WebSocket | IXWebSocket, pinned, behind a thin adapter (chosen at M0; replaced only on a measured gap) | BSD-3 |
| JSON | nlohmann/json (non-hashed I/O); JCS serializer in-house | MIT |
| MCP | in-house thin JSON-RPC | — |
| DAWproject | pugixml + miniz | MIT |
| Build / packages | CMake + vcpkg or CPM | — |
| Tests | Catch2 or GoogleTest; pluginval for hosting tests | BSL-1.0 / BSD; GPL tool, not linked |
| Desktop shell | Electron + Electron Forge or electron-builder | MIT |

Not used: Taskflow (allocates at runtime).

### Licensing decisions required before M2

These must be decided before the first build that links JUCE devices:

1. JUCE open source (AGPLv3) or commercial license, for the verified current
   version.
2. AGPL section 13: remote browser control and embedded devices are network
   interaction, so anyone offering a SIANN engine over a network must offer source.
   Acceptable for an open-source project; it matters for any hardware partner.
3. ASIO: ship ASIO builds or not, given the SDK license.
4. VST3 SDK terms under the chosen model.
5. Rubber Band: keep optional, so a future commercial path does not require a
   Rubber Band license.

## Build, test and CI

- CMake, C++20; MSVC (Windows), Apple Clang (macOS), GCC/Clang (Linux, arm64
  cross-compile).
- CI matrix: Windows x64, macOS universal, Linux x64, Linux arm64 headless build.
- A core-only build with no JUCE present runs on every CI job.

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
| Plugin (L3) | a built-in "hostile test plugin" (allocates, throws, changes latency, sleeps, calls back into the host) plus pluginval-checked real plugins |
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
| M2 Realtime engine | graph driver, control dispatcher and queues from revision 3 (tested first against a fake audio device), JUCE device, transport, single-threaded graph, structural and parameter channels, outboxes, retire queue, state migration, runtime latency changes, disk streaming, input node, simple recording to disk, device-side SRC | 32 tracks playback without xruns at 256 samples, also with SRC active (44.1 kHz session on a 48 kHz WASAPI shared device); SRC quality and record-offset tests pass; realtime PDC null tests pass, including a latency change during playback; gesture via parameter channel; record 10 minutes and recover after kill; realtime-safety checks clean | Persistent xruns not fixable within the design: Tracktion decision gate |
| M3 Agent access | Protocol server, consistency and security rules, MCP adapter, plans with approval, rollback, audition | An MCP client builds a session through approved plans, rolls back, auditions a branch; reconnect and gap sync tested | — |
| M4 Plugins | CLAP host first (both targets), then JUCE VST3/AU/LV2; capabilities; hostile test plugin | Third-party plugins load, save state, compensate latency, survive restart; capability flags exposed to agents | — |
| M5 Desktop UI v1 | Timeline, mixer, plan review UI in Electron | Arrange and mix by hand; review and approve an agent plan visually | — |
| M6a Automation | Write/Touch/Latch/Trim, lanes, precision contract | Automation passes recorded as single revisions; precision documented per format | — |
| M6b Recording production | Punch, loop record, takes/playlists, monitoring modes, MIDI recording | One hour 16-track recording criterion passes | — |
| M6c Mixing structure | Groups, VCAs, sidechain, bounce/stems | Production-level criteria list passes | — |
| M7 Embedded | Headless host target on arm64, browser control | Engine runs on a Raspberry Pi class board controlled from a browser | — |

### Status (2026-10-21)

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

M3 can start in parallel with M2 because M2's meter test page already needs the
protocol.

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

## Open questions

1. JUCE license choice and verified current version.
2. Ship ASIO builds or not.
3. When to introduce plugin worker processes.
4. Default plan approval granularity in the UI (whole plan vs step list).
5. An Apple Developer account with a Developer ID certificate must exist before the
   end of M0.

## References

- SoundCraft: https://github.com/storytold/soundcraft (architecture reference)
- Research brief: `D:\research\2026-09-19-ai-driven-daw-open-source-33u7\BRIEF.md`
- Reviews: `D:\research\siann-arch-review\`
- RFC 8785, JSON Canonicalization Scheme
- [Harness engineering spec](2026-07-11-siann-harness-engineering-spec.md)
- [ADR index](../../adr/0000-adr-index.md)
