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

1. The three locks above are an accepted exception to "no locks on the audio
   thread" for M0. The exception covers exactly those locks, taken by JUCE code
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
   it. `xruns` means deadline misses only; disk-stream `underruns` and SRC
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
  RTSan, these three locks go in the suppressions file, one reason each, as the
  spec already provides for.
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
