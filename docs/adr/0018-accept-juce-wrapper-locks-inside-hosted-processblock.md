# ADR-0018: Accept JUCE's Wrapper Locks Inside A Hosted Plugin's processBlock

Date: 2026-11-07

Status: Accepted

Decided by: Fable (Claude), on blocking decisions delegated by the maintainer,
who may overrule this ADR.

## Context

The architecture spec's realtime rule is that the audio thread never locks,
allocates, frees, logs, throws or performs I/O ("Realtime rules and
enforcement"). SIANN hosts VST3 and AU plugins through JUCE 9.0.3
([ADR-0017](0017-license-desktop-engine-under-agplv3.md)), and JUCE's hosting
wrappers take locks inside `processBlock`, which `JucePluginInstance::process`
calls on the audio thread. Read in the pinned JUCE sources
(`juce_audio_processors_headless/format_types/`):

- VST3: a private per-instance `SpinLock processMutex` is taken on every block
  in `processBlock` (both precisions and the bypassed variants). The main thread
  holds it across the plugin's `setActive` in `reset()` (a `kReloadComponent`
  restart), `prepareToPlay` (which also runs `setupProcessing` and the bus
  arrangement) and `releaseResources`. A plugin-initiated
  `restartComponent(kReloadComponent | kIoChanged)` runs those on the message
  thread through `ComponentRestarter`; a `kLatencyChanged` restart only calls
  `setLatencySamples` and takes no lock. `processBlock` never calls
  `SpinLock::tryEnter`, and the restart reaches SIANN's `AudioProcessorListener`
  only after the work, so there is neither a try-lock nor a hook before the
  restart. `SpinLock::enter` tries 20 times, then yields in a loop. JUCE's own
  comment on the member says why it exists: VST3 forbids `process` during
  `setActive`.
- AU: a `CriticalSection midiInLock` per block when the plugin produces MIDI,
  contended only by the plugin's own MIDI output callback.
- Any plugin that reports an edit or a latency change from the audio thread
  passes `AudioProcessor::getListenerLocked`, a `CriticalSection` held for one
  array read and contended only by `addListener` and `removeListener`, which
  SIANN calls at construction and destruction, outside any `process` call.

So during a plugin-initiated reload or I/O-change restart the audio thread waits
for as long as that plugin's `setActive` takes: a deadline miss (an xrun) on the
affected block. Between the two halves of a `kIoChanged` restart the plugin is
inactive, `processBlock` does nothing and `process` passes its input through.
SIANN calls `prepareToPlay` and `releaseResources` only on an instance outside
any live graph (construction, destruction), so this is the one unbounded wait.

## Decision

Read with the Amendment at the end of this ADR, which corrects points 1 and 2:
the scope is the spec's audit of `processBlock`, not three locks, and the
attribution claim is withdrawn.

1. The three locks above are an accepted exception to "no locks on the audio
   thread" for M0. *(Scope corrected in the Amendment: the audit, not a count.)*
   The exception covers exactly those locks, taken by JUCE code
   inside `plugin_->processBlock` called from `JucePluginInstance::process` in
   `siann-host-desktop`. SIANN's own code, including the adapter around that
   call, takes no lock. A new lock in that path, or a JUCE pin that adds one,
   reopens this decision and updates the list in the spec.
2. The wait is made visible, not bounded: the graph driver times every device
   callback with `siann::rt::CallbackTimer` (atomics only on the audio thread)
   and reports deadline misses as `xruns` and the longest callback as
   `maxCallbackMicros` in its status (`siann-cli play` and `record` today; the
   protocol when the engine process plays). Every restart ends in a
   `restartRequested` event, so an xrun in the same callbacks is attributable to
   it. *(Withdrawn in the Amendment: nothing consumes the event in M0, the count
   is cumulative, and the event also follows a latency-only restart.)* `xruns`
   means deadline misses only; disk-stream `underruns` and SRC
   `srcUnderruns` stay separate counts.
3. The hosting test "a VST3 restart during playback keeps setActive and process
   apart" stays the regression guard for what the lock is for: no overlap, no
   allocation, blocks on both sides of the restart. Nothing measures the wait: a
   spin time is a wall-clock figure no deterministic test can bound.
4. Sunset: the exception is removed, not extended, when hosted plugins run in
   worker processes (spec, Open questions, item 1, which names the proposed
   trigger).

## Alternatives rejected

- A patched JUCE using `tryEnter` in `processBlock`, passing the block through
  while the lock is held. Licence-compatible (AGPLv3 permits modification; JUCE
  is fetched as a tarball, so a `PATCH_COMMAND` would do it) but not carried: a
  maintained patch on a pin that moves every release, for a wait that is rare,
  plugin-initiated, bounded by one plugin's restart, and removed properly by
  worker processes.
- A host-side guard. Impossible without a hook: SIANN never sees the restart
  before JUCE holds the lock.
- Plugin worker processes in M0. The right fix, and a milestone of its own;
  pulling it into M0 for an event most sessions never trigger would stall the
  shell and signing work.
- RealtimeSanitizer coverage. The RTSan CI job builds the core without JUCE on
  Linux; the uncontended spin lock is one compare-and-swap the sanitizer cannot
  see, and the contended path is nondeterministic. If hosting ever runs under
  RTSan, the wrapper locks of the spec's audit (*"these three locks" before the
  Amendment*) go in the suppressions file, one reason each, as the spec already
  provides for.
- A watchdog. A wait inside a callback is a deadline miss, counted, never a
  reason to stop the device.

## Consequences

- `docs/harness/agent-rules.md` cites this exception and forbids any other lock
  on the audio thread.
- `GraphDriver` gains callback timing; `srcUnderruns()` replaces the former
  `xruns()` accessor so the two counts cannot be confused.
- The M0 plugin-hosting feature gains an acceptance item for the counter.
- When worker processes land, this ADR is superseded and the spec's exception
  text is removed.

## Amendment, 2026-11-07 (after independent review; same decider)

An independent verifier read the pinned JUCE against the Context above and found
it incomplete. The decision stands, with its scope and its claims corrected:

1. **The scope is an audit, not "exactly three locks".** A complete pass over
   what JUCE 9.0.3 runs inside `processBlock` (the spec, "Realtime rules and
   enforcement", holds the list) adds: `MidiEventList::events`, an
   `Array<Vst::Event, CriticalSection>`, whose `clearQuick` takes a mutex twice
   per block (uncontended) and whose `add` locks and may allocate for every MIDI
   event a plugin produces; `AudioProcessorParameter::listenerLock`, held while a
   parameter's listeners run on each output parameter change, under which SIANN's
   event sink runs (via `ParameterChangeForwarder`), contended by the main
   thread's edits of that parameter; `processMutex` also held, without
   `setActive`, by `updateMidiMappings` (a `kMidiCCAssignmentChanged` restart)
   and `isBusesLayoutSupported`; and `toMidiBuffer` growing SIANN's `MidiBuffer`
   past its 4096 preallocated bytes. The exception now covers JUCE's wrapper code
   inside `processBlock` as audited, locks and the MIDI-output allocation alike;
   a JUCE pin bump repeats the audit before the pin moves.
2. **Latent in M0.** No graph node wraps a `PluginInstance` and `siann-engine`
   runs no audio device, so no shipped M0 path processes a hosted plugin; the
   hosting tests are `process`'s only caller. The exception stands because it is
   about `JucePluginInstance::process` as written and tested, not about a path
   that ships in M0, and because the alternatives in this ADR are unchanged by
   that fact. Its Visibility condition is in force for the driver (`siann-cli
   play` and `record` report `xruns`, `maxCallbackMicros` and
   `unmeasuredCallbacks`) and not yet for plugins. Before a hosted plugin
   processes audio in a shipped path (the M4 plugin node): the node calls
   `process` only from a `GraphDriver` callback; the event sink only pushes to
   `pluginEventAny` (never `setState`, `setParameter`, device control or any wait
   for the audio thread, which the spec's deadlock argument needs); MIDI output
   gets a decision (preallocate for Steinberg's 2048-event limit and accept
   JUCE's growth as plugin-caused, or worker processes first); the protocol
   carries the three counters once the engine process runs a device.
3. **Attribution withdrawn.** `xruns` is a cumulative end-of-run count of
   callbacks the driver timed over their period (never a device-reported xrun),
   nothing consumes `pluginEventAny` in M0, and `restartRequested` also follows a
   latency-only restart, so an xrun cannot be attributed to a restart from these
   counts. Attribution needs per-instance timing or a timestamped event log, both
   M4 follow-ups.
4. **The wait graph is written down.** The spec's "Threads and waiting rules" now
   carries the two-way audio ↔ main edge and the argument that no cycle closes,
   which rests on the sink rule above.
5. **Found alongside, fixed:** the launcher handshake shared stdout with hosted
   plugins (a plugin's line before the ready line failed the launch);
   `siann-engine` now duplicates the launcher's stdout for the ready line and
   points fd 1 at stderr before any plugin loads.

## Amendment 2, 2026-11-07 (M4 plan; same decider)

The audit was repeated for JUCE's LV2 wrapper (JUCE 9.0.3,
`juce_LV2PluginFormatImpl.h` and `juce_LV2PluginFormat.cpp`). Inside
`processBlockImpl` it finds:

- `HandleRegistry::ifContains` takes a blocking `SpinLock` when a plugin schedules
  worker work. The registry is shared by every LV2 instance in the process, and
  instantiate, destroy and the worker thread contend for it.
- `processPortsAfterRun` calls `setLatencySamples` on the audio thread, which takes
  `getListenerLocked` and runs SIANN's `audioProcessorChanged` there.
- Every output atom goes into a UI message vector of 8192 reserved bytes, whether or
  not an editor is open, and the vector can grow on the audio thread.
- `updateHostDisplay` takes `getListenerLocked` from the audio thread too.

This is not accepted. The first finding is a new class of lock, shared across
instances, for a format we could only test on our own plugin. LV2 stays off in the
JUCE host (`JUCE_PLUGINHOST_LV2=0`) and arrives through lilv (M7) or worker
processes. The spec's goals and M4's exit criterion do not name LV2.

One addition to the VST3 audit: `setDirty` reaches `getListenerLocked` from any
thread. It is on the wrapper's path and takes the lock only.

## Amendment 3, 2026-11-09 (m4-juce-formats re-audit; decided by Fable, delegated by the maintainer)

m4-juce-formats repeated the audit at the pin in use (JUCE 9.0.3, `be29c81`), as
its acceptance requires. Every lock the spec lists checks out. Two allocations the
list did not name, both on MIDI a plugin outputs inside `processBlock`, read in the
pinned sources:

- VST3: `processAudio` → `MidiEventList::toMidiBuffer` → `toMidiMessage (DataEvent)`
  → `MidiMessage::createSysExMessage` (`juce_VST3Common.h:1506`): a `HeapBlock` of
  the event's size, malloc'd and freed, for every sysex event the plugin outputs,
  and a second malloc in `MidiMessage::allocateSpace` for a message over 8 bytes
  (`juce_MidiMessage.cpp:694`, `:349`), freed when the temporary dies after
  `MidiBuffer::addEvent` has copied the bytes. Every sysex, not only on overflow;
  a note or controller message fits the 8-byte inline store and allocates nothing.
- AU: `AudioUnitRender` → `renderMidiOutput` → `MidiDataConcatenator::pushMidiData`
  (`juce_AudioUnitPluginFormatImpl.h:2288`): `pendingSysexData`, a `std::vector`
  reserved at 2048 bytes (`:885`, `juce_MidiDataConcatenator.h:207`), grows for a
  sysex longer than that (`:242`, `:248`), and the `MidiMessage` built from it
  mallocs for one over 8 bytes (`:259`). Both before `midiInLock` (`:1862`) and the
  `incomingMidi` growth the audit already lists. The byte-stream extractor in front
  of it holds fixed-size state and allocates nothing.

Accepted into the audit, as further plugin-caused MIDI-output allocation:

1. It is the class condition 3 already accepts (allocation inside JUCE's wrapper,
   on the audio thread, caused and sized only by the plugin's own MIDI output),
   with one difference: preallocation does not reach it. The `Array` and
   `MidiBuffer` growth of condition 3 stops once the buffers are large enough; the
   sysex allocations happen per event, every time, because `MidiMessage` keeps
   more than 8 bytes on the heap.
2. SIANN cannot step in front of it. The path runs inside `processBlock` before
   SIANN sees the output (`toMidiBuffer` is what fills SIANN's `MidiBuffer`; the
   AU render callback runs inside `AudioUnitRender`). JUCE's VST3 wrapper hands
   every plugin an output event list whether or not it `producesMidi`
   (`associateWith`), and the AU wrapper installs the MIDI output callback
   whenever the unit reports MIDI output; neither is under a host switch. Dropping
   sysex until MIDI tracks exist (M6b), which the node already does with all MIDI
   output, saves SIANN's downstream cost only. The one host-side lever, refusing
   plugins that produce MIDI, would refuse the instruments in M4's compatibility
   set for an output most of them never emit.
3. The alternatives are the ones this ADR rejected, unchanged: a patched JUCE
   (here `MidiMessage`'s storage, not one `tryEnter`) on a moving pin, and worker
   processes, which remain the remedy and the sunset.
4. Visibility, as for the overflow. `JucePluginInstance` counts, per instance and
   with an atomic, the sysex events in the plugin's output (`midiOutputSysex`),
   found after `processBlock` by walking the `MidiBuffer` SIANN already owns (the
   iterator and a first-byte test allocate nothing), and reports it beside
   `midiOutputOverflows` in `engine.status` `plugins[]`. `ClapPluginHost` counts
   `CLAP_EVENT_MIDI_SYSEX` pushes the same way, so the field means the same for
   every format, though only the JUCE formats allocate for it. The count says
   which instance's MIDI output allocated and how often; the per-instance timer
   says what it cost. The work is an acceptance item of m4-juce-formats.

The spec's audit bullets name both paths, and its VST3 MIDI bullet now gives the
preallocation as it is since m4-plugin-node (`kMaxBlockOutputEvents` events of
`midiEventBytes`, 2048 × 9 bytes), not the 4096 bytes Amendment 1 recorded.
