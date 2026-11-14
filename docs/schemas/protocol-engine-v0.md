# Protocol engine v0

The transport, status and device methods of the native protocol server, and what `session.open` and the bundle lock do in `siann-engine` (architecture spec, "siann-protocol", Protocol v0 items 16, 17, 18 and 22; "Process model"; "Session bundle"; m4-engine-device and m5-engine-sessions-devices). They reach the engine through `ServerOptions::transportPort` (`protocol::TransportPort`, implemented by `EngineHost` in `native/apps/engine`). Without a port they answer `not_supported`. Every method runs on the command thread, honours `expectedRevision` and the idempotency cache, and is listed in `engine.capabilities`' `methods`. Each is also an MCP tool ([Protocol MCP v0](protocol-mcp-v0.md)): `play`, `stop`, `locate`, `set_cycle`, `set_click`, `engine_status` and `list_devices` in the propose scope, `select_device` in the trusted scope. The recording methods (m5b-engine-record, Protocol v0 item 27) go through `ServerOptions::recordPort` (`protocol::RecordPort`, also implemented by `EngineHost`): see [Recording](#recording).

## Transport

| Method | Params | Result |
|---|---|---|
| `transport.play` | `{}` | `{playing, position, cycle, click}` |
| `transport.stop` | `{}` | `{playing, position, cycle, click}` |
| `transport.locate` | `{frames: "<decimal>"}` | `{playing, position, cycle, click}` |
| `transport.set_cycle` | `{enabled: bool}` | `{playing, position, cycle, click}` |
| `transport.set_click` | `{enabled: bool, gainMilliDb?: int}` | `{playing, position, cycle, click}` |

`position` is a decimal string of session frames, `cycle` a boolean and `click` `{enabled, gainMilliDb}`. A locate reports its target at once; the playhead reaches it when the butler is ready. Without a running device each answers `no_device` with the reason as the message. A `frames` that is missing or not a non-negative decimal string is `invalid_params`.

Since m5b-engine-record every transport result also carries `recording` (a boolean) and `armed` (the armed track ids, in id order), and `transport.stop` ends a recording and commits it before it stops (see [Recording](#recording)).

### Cycle and click (m5-ui-engine-loop-click, Protocol v0 item 26)

`transport.set_cycle` turns cycle playback on or off: while on and the heard document has a `locators` entity, playback wraps from `right` to `left` sample-accurately (architecture spec, "Realtime data flow", "Cycle"). With no locators it has no effect; a playhead already at or past `right` when cycle is enabled plays on. `transport.set_click` turns the metronome on or off: a click generated from the tempo map, added to the device output after the master meter and never part of a render. `gainMilliDb` is an integer in [-60000, 0] (default -12000); omitted, the current gain is kept. A non-boolean `enabled`, or a `gainMilliDb` that is not an integer in range, is `invalid_params`. Neither creates a revision.

The locators themselves are document data, set with the command `session.set_locators {left: "<decimal>", right: "<decimal>"}` through `command.execute` (or a plan, or MCP `execute`): `0 <= left < right <= 2^42`, otherwise `invalid_locators`; a value that is not a decimal string is `invalid_params`. The entity is `{schema: "siann.entity.locators.v1", id: "locators", left, right}`, ref `locators:locators`, absent until first set.

`transport.changed {cycle, click: {enabled, gainMilliDb}}` is published to every subscribed connection when either value actually changes, whoever asked ([Protocol events v1](protocol-events-v1.md)); repeating the current value publishes nothing.

The engine host keeps both flags across `engine.select_device`. The cycle flag is written into the bundle's checkpoint (`transport: {cycle}`) with every checkpoint write, and `session.open` takes the opened bundle's flag; the click state is not stored. `engine.capabilities` reports `features.locators: true` and `features.cycle`, `features.click` true when a transport port is present.

## engine.status

Params `{}`. Result:

```json
{"device": {"id": "fake", "sampleRate": 48000, "bufferFrames": 256, "inputLatencyFrames": 256, "outputLatencyFrames": 256,
            "input": {"id": "fake", "channels": 2, "latencyFrames": 256}},
 "playing": false, "cycle": false, "recording": false, "armed": [], "click": {"enabled": false, "gainMilliDb": -12000}, "xruns": "0", "maxCallbackMicros": 0.0, "unmeasuredCallbacks": "0", "underruns": "0", "srcUnderruns": "0",
 "plugins": []}
```

`device` is null when no device runs, and `deviceError {code, message}` then says why: `no_device`, `device_open_failed`, `device_lost`, `no_audio_backend` (a core-only build without `--device fake`), or a media code when the session's first graph could not be built (`media_missing`, `media_hash_mismatch`, `media_mismatch`, `unsupported_media`, `decode_failed`, `too_large`, `load_failed`). While that first graph could not be built the other methods still run: `proposal.merge` and `proposal.discard` act on the session directly, and only `audition.hear` answers `audition_unavailable`. `id` is `fake`, `<type>/<name>` or `default` (launched without `--device` and nothing selected since). The counters run from the device's start. `plugins` is in [Protocol plugins v0](protocol-plugins-v0.md). `device.input` (m5b-engine-record) is null while no input is open, otherwise the input's `id`, the channels the device opened and its input latency in frames; `recording` and `armed` are the record state's ([Recording](#recording)).

## engine.devices

Params `{}`. Result:

```json
{"devices": [{"id": "fake", "type": "fake", "name": "fake", "isDefault": false, "current": true, "inputChannels": 2, "outputChannels": 2},
             {"id": "Windows Audio/Speakers", "type": "Windows Audio", "name": "Speakers", "isDefault": true, "current": false, "inputChannels": null, "outputChannels": null},
             {"id": "Windows Audio/Microphone", "type": "Windows Audio", "name": "Microphone", "isDefault": false, "current": false, "inputChannels": null, "outputChannels": 0}]}
```

`fake` is listed by every build. A `SIANN_WITH_JUCE` build adds every output device `JuceAudioDevice::listOutputDevices()` reports, as `siann-cli devices` prints them, `id` being `<type>/<name>`, the form `--device` takes. `current` marks the device the engine runs or is trying to open: the entry whose `id` was selected (or given with `--device`), or the first `isDefault` entry when the engine was launched without `--device` and nothing was selected since. At most one entry is current.

`inputChannels` and `outputChannels` (m5b-engine-record) are integers where known and null otherwise: `fake` has 2 and 2, and the device the engine has open reports the channels it opened. A `SIANN_WITH_JUCE` build lists its output devices and then the input devices that are not also output devices (`outputChannels` 0, usable only as an `inputId`); it never creates a second driver instance to count channels (ASIO allows one).

## engine.select_device

Params `{id, inputId?}`. Result: `engine.status`'s `device` object, with `input`.

| Case | Answer | Afterwards |
|---|---|---|
| `id` missing or not a string | `invalid_params` | nothing changed |
| `id` not in `engine.devices` | `not_found` | the current device plays on |
| `inputId` present and not a string | `invalid_params` | nothing changed |
| `inputId` not in `engine.devices`, or an entry without inputs | `not_found` | the current device plays on |
| `inputId` of another backend type than `id` | `invalid_params` | the current device plays on |
| the open succeeds | the new `device` | stopped at the playhead, counters from zero |
| the open fails | `device_open_failed` (or the device's own code) | the old device is closed; `engine.status` shows `deviceError`; the main thread retries the named device under the device backoff, its count from zero |
| the session's first graph could not be built | the `deviceError` code (`media_missing`, ...) | the choice is kept and opened once a commit lets the graph build |

The host stops the transport and the graph driver, closes the running device and opens the new one on the main thread, the path a reopen after `device_lost` takes. A device another application holds is `device_open_failed`; `--fake-open-failures N` makes the fake device refuse its first N opens, counted across the launch's open, the reopens and every `engine.select_device` of `fake` (each selection makes a new handle to the same held device), so the tests drive this case.

`inputId` (m5b-engine-record) opens an input with the output: the same device (`fake` with `fake`) or, where the backend allows it, another one of the same JUCE type. Without `inputId` no input is opened, and the record methods answer `no_input`; playback is the same either way. The device reports the channels it opened (up to 32 are asked of an entry whose `inputChannels` is null), and capture, input metering and device-side SRC use those; an input that opened none, such as an output-only device named as its own `inputId`, is no input: `input` is null, its `engine.devices` entry then says `inputChannels` 0, and the record methods answer `no_input`. The host keeps the chosen input across reopens, the backoff and `session.open`. Armed tracks stay armed when the new input still covers their channels and are disarmed otherwise.

## Recording

m5b-engine-record, Protocol v0 item 27 (architecture spec, "Recording"). The methods go through `ServerOptions::recordPort`; without one they are `not_supported`. All run on the command thread, honour `expectedRevision` and the idempotency cache, and are listed in `engine.capabilities`' `methods`, which also lists `track.set_input` in `commands` and reports `features.recording` (true with a record port).

A track's input is document data, set with the command `track.set_input {trackId, input: {port, channels} | null}` through `command.execute`, a plan or MCP `execute`: `port` is the first device input channel (0-based), `channels` 1 or 2. The entity's JSON has `input` only while it is set.

| Method | Params | Result |
|---|---|---|
| `record.arm` | `{trackId, armed: bool}` | the record state `{recording, armed, takes}` |
| `transport.record` | `{enabled: bool}` | `{playing, position, cycle, click, recording, armed}` |
| `record.recover_take` | `{takeId, accept: bool}` | accepted `{revision}`, rejected `{takeId, trashed: true}` |

Errors:

| Code | When |
|---|---|
| `invalid_params` | a missing or mistyped param |
| `no_device` | `record.arm` with `armed: true` or `transport.record` with `enabled: true` while no device runs |
| `no_input` | arming or recording with no input open; arming a track without `input`, or whose `port + channels` exceeds the open input's channels |
| `not_found` | `record.arm` for a track main does not hold |
| `nothing_armed` | `transport.record {enabled: true}` with no armed track |
| `invalid_state` | arming or disarming while recording; a 17th armed track; recovering a take being recorded |
| `take_not_found` | `record.recover_take` for a take that is not pending, committed or trashed, or accepted after it was rejected |
| `take_has_no_audio` | `record.recover_take {accept: true}` for a take without a complete frame |

- Arming is engine state, never a revision. Disarming a track that is not armed changes nothing. `session.open` clears the armed set; every new head of main prunes it (a removed track, an input cleared or no longer covered by the open input, an undo that removed it). The prune happens before any record method reads the set, so a `transport.record` that follows a `track.remove` or `track.set_input` in the same batch of requests sees the new head, and `armed` in the results never lists a track the head no longer arms.
- `transport.record {enabled: true}` begins one take per armed track at the playhead and starts the transport; while recording it changes nothing. `{enabled: false}` ends the recording and commits it as one revision (a `media.add` and a `clip.place` per take with audio; a take with no frame moves to `trash/`), and playback continues; with nothing recording it changes nothing. `transport.stop` ends a recording the same way and stops. `transport.locate` ends it the same way (`endedBy` `stop`), then locates, and playback continues from the new position: a take is one contiguous run at one position, so nothing after a jump goes into it. A device that stops, a ring overflow and a write failure end it too, from the engine's tick. The revision is announced by `session.changed`; `session.undo` removes the clips and the media references and deletes no file.
- Takes are recorded at the session rate into `media/recording/<takeId>.wav` with the manifest `<takeId>.json` (`siann.take_manifest.v1`); a committed take's media is `med_<takeId>` and its clip `clp_<takeId>`.
- `record.recover_take` works on a pending take (one in `media/recording/` that is not being recorded, typically left by a crash): accepted, it is committed in the same revision shape; rejected, its files move to `trash/`. Both are idempotent: an accept repeated answers the revision that committed the take, a reject repeated answers `{takeId, trashed: true}` again.
- With cycle on, a recording records straight through the right locator (the wrap is suspended while capturing).

The record state:

```json
{"recording": true, "armed": ["trk_1"],
 "takes": [{"takeId": "take_3f2a...", "trackId": "trk_1", "startFrame": "96000", "durableFrames": "48000"}]}
```

`takes` are the takes of the current recording, or of the last one once it ended, when each also has `endedBy` (`stop`, `overflow`, `disk` or `device`) and `overflows` (a decimal string). `startFrame` is the timeline frame the take lands on (its first captured frame's position minus the record offset), null until that frame; `durableFrames` counts the frames the WAV header made durable (the writer checkpoints about once a second). `record.changed` carries the same object whenever it changes ([Protocol events v1](protocol-events-v1.md)); `session.sync` and the auth reply list the pending takes as `pendingTakes`.

MCP: `record_arm` and `record` wrap `record.arm` and `transport.record` in the trusted scope ([Protocol MCP v0](protocol-mcp-v0.md)); `record.recover_take` has no tool.

## session.open in siann-engine

`session.open {path}` (item 16) opens the bundle as a new `Session`, taking its lock, then rebinds the engine host to it: a new `PlaybackEngine` on the same device object (never recreated, only closed so that the new driver opens it again at the new session's rate, as at launch), a new `Auditioner` behind the same `AuditionPort`, and a new meter publisher, which sends a new `meters.legend`. Instances `plugin.instantiate` made that no `plugin.insert` committed are dropped. The cycle flag becomes the new bundle's (from its checkpoint, false when absent); the click state is kept. Then the old `Session` is destroyed, which releases its lock. The result is `{sessionId, revision, documentHash}`; the next `session.sync` carries them. Errors: `not_found` (no directory at `path`), `session_locked` (another live process holds the bundle, or this engine serves it already), any other `SessionError` code the open throws (`not_a_bundle`, ...); on every error the old session stays served.

## The bundle lock

`<bundle>/lock` holds `{"pid": <n>, "startedAt": "<ISO 8601 UTC>"}` while a `Session` is open on the bundle. `Session::create` and `Session::open` create it exclusively (`O_CREAT | O_EXCL`, `CREATE_NEW`) and the `Session`'s destructor removes it, so a second `Session` on the bundle, in any process, throws `SessionError` `session_locked`. A lock file that is empty, unparseable, or names a pid that is not a live process is taken over: removed, and the exclusive create tried once more. Consequences:

- `siann-engine --session <bundle>` on a bundle another engine serves exits 1 with `{ok: false, error: {code: "session_locked", ...}}` as the last stderr line and nothing on stdout (item 17).
- `siann-cli info`, `verify` and every other command that opens a bundle answer `session_locked` while an engine serves it.
- A crashed engine leaves the file; the next open takes it over because its pid is dead.
