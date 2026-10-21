# SIANN Native DAW Architecture

Date: 2026-10-14

Status: Proposed, revision 2 (after review)

Reviews of revision 1 (kept outside the repo):
`D:\research\siann-arch-review\review-codex.md`,
`review-claude-pane.md`, `review-fable-subagent.md`.

## Purpose

This document records the architecture for SIANN as a long-term, production-level
DAW that is natively operable by AI agents: an "open AI DAW" built from scratch in
C++, with a web-technology UI, a desktop shell, and a protocol that humans and agents
share equally.

It replaces the Ardour-derived engine direction (ADR-0003, ADR-0014). ADR-0015
(DAWproject export from the Node bridge) remains the shippable product and the
interchange path until the native app reaches M5. A superseding ADR will be written
once this revision is accepted; see "Documents made stale by this decision".

Revision 2 incorporates three independent reviews. The main changes: the realtime
data flow is now specified (document vs prepared graph vs audio state, structural vs
parameter channels, retire queue), a latency model and automation precision contract
were added, the history model was unified into a revision DAG, recording and crash
recovery moved into the core design, the JUCE boundary was made honest (main thread,
GUI dependency, a separate JUCE-free host for embedded), MIDI, channel layouts, the
time model and the session format were specified, and milestones were reordered with
kill criteria.

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
| Hashing | RFC 8785 (JCS) canonical JSON, shared by the Node bridge and the C++ engine |
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
- Realtime sample-rate conversion between session and device in v1.

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
|   command thread    the only session mutator; validates, applies, compiles graphs  |
|   butler thread(s)  disk read-ahead, record write-through, peak generation         |
|   protocol thread   WebSocket/HTTP/MCP I/O                                         |
|   reclaim           runs on the command thread: frees retired graphs and objects   |
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
   latency changes. Command thread compiles a new `PreparedGraph` (taking the old one
   as input), then publishes it. Throughput: occasional.
2. **Parameter channel**: gain, pan, mute, send level, plugin parameters, transport
   commands. A bounded SPSC queue of `ParamChange{nodeId, paramId, value,
   rampSamples}` applied at the start of the next block (or at a sample offset for
   sample-accurate targets). No snapshot, no recompile. Throughput: up to hundreds
   per second.

Continuous gestures (fader drags, knob turns, Touch/Latch automation) use the
parameter channel for every intermediate value. The command layer records only the
gesture boundaries (see "Gestures").

### Queues (all bounded, preallocated)

| Queue | Producer → consumer | Payload | Overflow policy |
|---|---|---|---|
| `graphInbox` | command → audio | `PreparedGraph*` + epoch | capacity 2; command thread waits for the audio thread to take the previous graph before publishing again |
| `paramInbox` | command → audio | `ParamChange` | sized for worst case; overflow coalesces to latest value per (node, param) on the command side |
| `retireOutbox` | audio → command | old `PreparedGraph*`, removed plugin instances | capacity sized to `graphInbox` + max removals per graph; never full by construction |
| `meterOutbox` | audio → command | meter blocks, playhead | latest-value-wins; drop when full |
| `automationOutbox` | audio → command | `(param, sample, value)` during write passes | preallocated per write pass; on overflow thin in place and count |
| `recordOutbox` | audio → butler | audio blocks of armed inputs | ring buffer sized to seconds of audio; overflow is a reported error, never a block |
| `pluginEventOutbox` | audio/main → command | plugin-originated param edits, latency changes, restart requests | bounded; coalesced per plugin |

Only the command thread writes to `graphInbox` and `paramInbox`. Other threads
(main thread instantiating plugins, butler) go through the command thread.

### Publishing and retiring graphs

- The audio thread holds a raw pointer to the current `PreparedGraph`. At a block
  boundary it dequeues a new graph, swaps, and enqueues the old pointer and any
  removed plugin instances to `retireOutbox`.
- The command thread drains `retireOutbox` and destroys retired objects. Plugin
  instance destruction is forwarded to the main thread where formats require it.
- No `shared_ptr` whose count can reach zero is ever touched on the audio thread.
  `std::atomic<std::shared_ptr>` is not used (not lock-free on libstdc++ or MSVC).
- Each graph carries an epoch number; retire and rebuild logic uses epochs, not
  pointer identity.

### State migration

- `GraphCompiler::compile(document, previousGraph)` reuses every plugin instance,
  delay line, smoother and meter whose entity ID is unchanged. Only new entities are
  instantiated (on the main thread, before publishing); only removed ones are
  retired.
- Reverb tails and compressor envelopes survive unrelated edits.
- When topology changes affect an audible path, the new graph fades the affected
  outputs over a short crossfade (default 10 ms) to avoid clicks.
- When a plugin's latency changes, the affected paths recompile; the delay lines on
  those paths are faded out, resized, and faded in.

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
- Recording offset = device input latency + device output latency (as reported by
  the device) + the compensation applied to the monitoring reference; recorded clips
  are placed with that offset.
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
- Gestures time out (for example 10 s without updates) and close automatically, so a
  disconnected client cannot leave a gesture open.
- Plugin editor edits arrive as plugin-originated begin/edit/end events and follow
  the same rule.

## Time model

- Positions carry a domain: `AudioTime` (int64 samples) or `MusicTime` (int64 ticks,
  resolution 1920 ticks per quarter note or finer; never floating point).
- Audio clips default to `AudioTime`; MIDI notes and tempo-anchored content use
  `MusicTime`. Changing the tempo map moves `MusicTime` content and leaves
  `AudioTime` content in place.
- `TempoMap` and `MeterMap` support ramps. Conversions between domains are exact for
  integer ticks within the map.
- Timecode (all frame rates including drop-frame), Bars|Beats, seconds and samples
  are display and input formats, never storage formats.

## Sample rate and media

- The session sample rate is an invariant of a session. Changing it is an explicit
  command that converts every `AudioTime` value and every media file (offline), as
  one revision.
- Media whose rate differs from the session is converted offline at import
  (r8brain-free-src) and both the original hash and the converted hash are recorded.
- The device runs at the session rate. If the device cannot, the engine refuses to
  start playback and reports why. Realtime device-side SRC is a later option.
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
- Plugin slots store their negotiated bus layout and sidechain configuration.

## Modules

Dependencies point downward only. CMake target visibility and a CI check enforce it;
CI also builds and tests the core (everything except `siann-host-desktop` and the
app) with no JUCE present.

### siann-time (pure C++)

`AudioTime`, `MusicTime`, `Position` (domain-tagged), `TempoMap`, `MeterMap`,
`Timecode`, `Grid`.

### siann-midi (pure C++)

Event types, event lists, MIDI file import/export.

### siann-model (pure C++)

The session document. Immutable values with structural sharing via a persistent
data structure library (immer, BSL-1.0) or an in-house chunked vector; this choice
is made in M1.

```text
SessionDocument
 |- id: SessionId, revisionId
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
  Merkle root over entity hashes, so a revision only rehashes changed paths.
- Commands address IDs only. Name lookup is a dry-run helper and fails on ambiguity.
- Loop range, punch range and solo-safe are document data. Playhead and transport
  state are engine state.
- Plugin state lives in the blob store; the document holds only the blob hash.

### siann-command (pure C++) — the core of SIANN

#### Commands and jobs

```text
<<interface>> Command                pure document transform
  +id(): string                      e.g. "track.add", "clip.place", "mix.insert"
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
- `validate()` returns the declared effects, including cascades (deleting a bus
  lists the sends it removes). After `apply()`, the processor diffs the two
  documents; the actual changed IDs must be a subset of the declared ones, otherwise
  the command fails and nothing is published. The journal records the actual diff.
- VCA and group effects on derived values (effective gain) are not "touched" entities.

#### Revision DAG — single history

```text
Revision { id, parent(s), document, cause, actor, time, hash }
cause ∈ { command, plan(transaction), undo, redo, branch-merge, recovery }
```

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

- `journal.ndjson` in the session bundle, append-only, one fsync per revision.
- Checkpoints: the full document is written every N revisions or M seconds
  (atomic write: temp file + rename). "Autosave" means checkpoint.
- Recovery on start: load the latest checkpoint, replay journal entries after it up
  to the last complete entry, report what was recovered.
- Undo history depth in memory is bounded; older revisions are reconstructible from
  checkpoints plus journal.

#### Canonical JSON and hashes

- Canonical form is RFC 8785 JSON Canonicalization Scheme (JCS): ECMAScript number
  serialization, keys sorted by UTF-16 code units, defined escaping.
- Inside hashed regions, values should be integers or strings where practical
  (gain stored as integer milli-dB, positions as integers), which removes most
  floating-point formatting risk.
- The Node bridge switches to JCS (a schema version bump of the plan format), and a
  shared fixture set covers numbers (`1.0`, `1e21`, `-0`), non-BMP keys and escapes.
  Both implementations must pass the same fixtures. This rule is added to the
  harness engineering spec section 1.2.

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
  +renderOffline(range, target)   same graph code, driven by a non-realtime loop
Transport       play, stop, locate, loop, punch; engine state, not document
Butler          disk read-ahead, record write-through, peak pyramid
```

### siann-dsp (pure C++)

Built-in processors (EQ, dynamics, reverb, delay, utility), meters (peak, true
peak), loudness (EBU R128), FFT. Original code or permissively licensed.

### siann-host: two targets, one interface

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
  structural change; switching A/B is a graph swap with crossfade.
- Plugin instances whose slot ID and state are identical are shared between the two
  graphs. Slots the branch adds or changes get their own instances (instantiated
  from serialized state), bounded by a configurable memory and CPU budget; if the
  budget is exceeded, audition is refused with a reason.
- Transport and playhead are shared; automation follows the auditioned branch.

## Session bundle

```text
MySong.siann/                    a directory
  session.json                   latest checkpoint, JCS canonical JSON
  journal.ndjson                 append-only WAL since the checkpoint
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
| Resampling (offline) | r8brain-free-src | MIT |
| Time-stretch | signalsmith-stretch (default); Rubber Band optional | MIT; GPL or commercial |
| Persistent data structures | immer or in-house | BSL-1.0 |
| Lock-free queues | moodycamel ReaderWriterQueue (audio side: `try_*` only, preallocated) | Simplified BSD |
| Realtime logging | rtlog-cpp or in-house ring | MIT |
| Logging (non-realtime) | spdlog | MIT |
| Plan hash | picosha2 + in-house JCS | MIT |
| HTTP / WebSocket | candidates: IXWebSocket, libwebsockets, uWebSockets, Boost.Beast (chosen in M3) | BSD / MIT / Apache-2 / BSL-1.0 |
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
| Parity | offline vs realtime null test; single vs multi-thread bit-identical (when threading exists) |
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
  policy) and 3.5 licensing; section 1.2 gains the JCS rule.
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
- Repository layout for new code (same repo under `native/` and `app/`, or a new
  repository) is decided at M0.

## Milestones

Each milestone has exit criteria and a kill criterion that triggers a design
review instead of pushing on.

| Milestone | Scope | Exit criteria | Kill criterion |
|---|---|---|---|
| M0 Spike | Electron + engine helper app on macOS and Windows; JUCE hosting inside the headless child | Engine starts/stops with the app; renderer connects with token handshake; one third-party VST3 and one AU load, save/restore state, report latency, open editors; signed and notarized macOS build runs; focus/Cmd-Tab behavior acceptable | No acceptable editor-window behavior on macOS after 2 weeks: evaluate engine-in-main-process or Tracktion |
| M1 Headless core | time, midi, model, command, revision DAG, journal WAL, checkpoints, session bundle, JCS, offline render, CLI | CLI creates a session, imports audio, places clips, sets gain, renders WAV; replay gives identical hashes; recovery test passes; Node and C++ pass the same JCS fixtures | Structural sharing too slow for 500-track documents: revisit data structure |
| M2 Realtime engine | JUCE device, transport, single-threaded graph, structural and parameter channels, outboxes, retire queue, state migration, latency model with `FakeLatency`, disk streaming, input node, simple recording to disk | 32 tracks playback without xruns at 256 samples; PDC null tests pass; gesture via parameter channel; record 10 minutes and recover after kill; realtime-safety checks clean | Persistent xruns not fixable within the design: Tracktion decision gate |
| M3 Agent access | Protocol server, consistency and security rules, MCP adapter, plans with approval, rollback, audition | An MCP client builds a session through approved plans, rolls back, auditions a branch; reconnect and gap sync tested | — |
| M4 Plugins | CLAP host first (both targets), then JUCE VST3/AU/LV2; capabilities; hostile test plugin | Third-party plugins load, save state, compensate latency, survive restart; capability flags exposed to agents | — |
| M5 Desktop UI v1 | Timeline, mixer, plan review UI in Electron | Arrange and mix by hand; review and approve an agent plan visually | — |
| M6a Automation | Write/Touch/Latch/Trim, lanes, precision contract | Automation passes recorded as single revisions; precision documented per format | — |
| M6b Recording production | Punch, loop record, takes/playlists, monitoring modes, MIDI recording | One hour 16-track recording criterion passes | — |
| M6c Mixing structure | Groups, VCAs, sidechain, bounce/stems | Production-level criteria list passes | — |
| M7 Embedded | Headless host target on arm64, browser control | Engine runs on a Raspberry Pi class board controlled from a browser | — |

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

## Open questions

1. JUCE license choice and verified current version.
2. Ship ASIO builds or not.
3. Same repository or new repository for native code and the Electron app.
4. immer or in-house persistent structures.
5. HTTP/WebSocket library.
6. When to introduce plugin worker processes.
7. Default plan approval granularity in the UI (whole plan vs step list).

## References

- SoundCraft: https://github.com/storytold/soundcraft (architecture reference)
- Research brief: `D:\research\2026-09-19-ai-driven-daw-open-source-33u7\BRIEF.md`
- Reviews: `D:\research\siann-arch-review\`
- RFC 8785, JSON Canonicalization Scheme
- [Harness engineering spec](2026-07-11-siann-harness-engineering-spec.md)
- [ADR index](../../adr/0000-adr-index.md)
