# Protocol engine v0

The transport, status and device methods of the native protocol server, and what `session.open` and the bundle lock do in `siann-engine` (architecture spec, "siann-protocol", Protocol v0 items 16, 17, 18 and 22; "Process model"; "Session bundle"; m4-engine-device and m5-engine-sessions-devices). They reach the engine through `ServerOptions::transportPort` (`protocol::TransportPort`, implemented by `EngineHost` in `native/apps/engine`). Without a port they answer `not_supported`. Every method runs on the command thread, honours `expectedRevision` and the idempotency cache, and is listed in `engine.capabilities`' `methods`. Each is also an MCP tool ([Protocol MCP v0](protocol-mcp-v0.md)): `play`, `stop`, `locate`, `set_cycle`, `set_click`, `engine_status` and `list_devices` in the propose scope, `select_device` in the trusted scope. The recording methods (m5b-engine-record, Protocol v0 item 28) go through `ServerOptions::recordPort` (`protocol::RecordPort`, also implemented by `EngineHost`): see [Recording](#recording).

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

### Master gain (m5b-engine-master, UI redesign E-11)

The master gain is document data, set with the command `master.set_gain {gainMilliDb}` through `command.execute` (or a plan, or MCP `execute`); it is not a transport method and needs no port. `gainMilliDb` is an integer in the track gain's range, `-144000..24000`, or `-2147483648` (minus infinity), otherwise `invalid_gain`; a value that is not an integer, or an extra field, is `invalid_params`. The entity is `{schema: "siann.entity.master.v1", id: "master", gainMilliDb}`, ref `master:master`, present only while the gain is not 0 dB: `master.set_gain 0` removes it, so the document hashes as it did before the first set, and `plan.preview` shows `before: null` on the first set and `after: null` on the set back to 0. The command declares exactly `{master:master}`, so it never makes a rename or tempo plan stale. Setting 0 while the entity is absent is a revision with an empty diff, as `track.set_gain` to the value already set is.

The gain applies to the sum of the tracks, before the master meter (meter key `master`), the click and device-side SRC (architecture spec, "Master path"); an offline render applies the same gain, so offline and realtime renders agree. The master gain is also a gesture target, `{ref: "master:master", param: "gain"}` ([Protocol gestures v0](protocol-gestures-v0.md)). `engine.capabilities` lists `master.set_gain` in `commands` and reports `features.masterGain: true`.

### Clip fades (m5b-engine-clip-fades, UI redesign UR-6, Protocol v0 item 30)

Fades are document data, set with the command `clip.set_fade {clipId, fadeIn?, fadeOut?}` through `command.execute`, a plan or MCP `execute`; there is no method and no MCP tool of its own. Each side is `{length, curve}`: `length` in media frames as a decimal string, `"0"` removing the side; `curve` `"linear"` or `"equal_power"`. At least one side is given; an omitted side is unchanged. A missing side, a bad curve, a length that is not a non-negative decimal string, or an extra field is `invalid_params`; `fadeIn.length + fadeOut.length` above the clip's `length` is `invalid_fade`; an unknown clip `not_found`. The command declares exactly `{clip:<id>}` and is one revision.

```json
{"method": "command.execute", "params": {"command": {"op": "clip.set_fade", "clipId": "clp_1",
  "fadeIn": {"length": "480", "curve": "linear"}, "fadeOut": {"length": "960", "curve": "equal_power"}}}}
```

The clip entity carries `fadeIn` and `fadeOut` only while their length is not 0, so a clip without fades hashes as before. `clip.trim` to a length shorter than the two fades shortens them in the same revision (the fade in keeps its length first, the fade out takes the rest; a side shortened to 0 is removed). Offline and realtime renders apply the same gain curve (architecture spec, "siann-graph and siann-engine"). `engine.capabilities` lists `clip.set_fade` in `commands` and reports `features.clipFades: true`.

## engine.status

Params `{}`. Result:

```json
{"device": {"id": "fake", "sampleRate": 48000, "bufferFrames": 256, "inputLatencyFrames": 256, "outputLatencyFrames": 256,
            "input": {"id": "fake", "channels": 2, "latencyFrames": 256}},
 "playing": false, "cycle": false, "recording": false, "armed": [], "monitorRoundTripFrames": 512, "click": {"enabled": false, "gainMilliDb": -12000}, "xruns": "0", "maxCallbackMicros": 0.0, "unmeasuredCallbacks": "0", "underruns": "0", "srcUnderruns": "0",
 "load": {"average": 0.12, "peak": 0.31},
 "plugins": [],
 "agents": [{"id": "agt_3f2a9c1d0b7e6a54", "name": "mix-assistant", "transport": "mcp", "connected": true,
             "lastAction": "submit_plan", "lastActionAt": "2026-11-15T10:00:05Z"}]}
```

`device` is null when no device runs, and `deviceError {code, message}` then says why: `no_device`, `device_open_failed`, `device_lost`, `no_audio_backend` (a core-only build without `--device fake`), or a media code when the session's first graph could not be built (`media_missing`, `media_hash_mismatch`, `media_mismatch`, `unsupported_media`, `decode_failed`, `too_large`, `load_failed`). While that first graph could not be built the other methods still run: `proposal.merge` and `proposal.discard` act on the session directly, and only `audition.hear` answers `audition_unavailable`. `id` is `fake`, `<type>/<name>` or `default` (launched without `--device` and nothing selected since). The counters run from the device's start. `plugins` is in [Protocol plugins v0](protocol-plugins-v0.md). `device.input` (m5b-engine-record) is null while no input is open, otherwise the input's `id`, the channels the device opened and its input latency in frames; `recording` and `armed` are the record state's ([Recording](#recording)). `monitorRoundTripFrames` (m5b-engine-monitoring) is what a monitored input takes from the device input to the device output, in session frames, or null while no input is open ([Monitoring](#monitoring)).

`agents` (m5b-engine-plan-metadata, Protocol v0 item 29) lists the MCP sessions in the order they initialized, each `{id, name, transport: "mcp", connected, lastAction, lastActionAt}`: `id` is `agt_<hex>`, never the `Mcp-Session-Id`; `name` the sanitised `clientInfo.name` (`"MCP client"` without one); `connected` is true from `initialize` until `DELETE /v0/mcp` or `limits.agentIdleMs` without a request (the next request connects it again); `lastAction` is the name of the tool last executed for it and `lastActionAt` the server's ISO time then, both null before its first tool call. Arguments are never recorded. At most `limits.agentsRetained` (32) are kept ([Protocol MCP v0](protocol-mcp-v0.md), Agents). Every change is announced by `agent.changed` ([Protocol events v1](protocol-events-v1.md)). `engine.capabilities` reports `features.agents` true when a transport port is present (the condition of `engine.status`), and `features.planMetadata: true`.

`load` (m5b-engine-load-loudness, Protocol v0 item 31) is `{average, peak}`, JSON numbers: `average` is the fraction of the device period the audio callback used over the last full window of one second of device frames (the sum of the callbacks' durations over the sum of their periods), `peak` the largest single callback's fraction in that window. Both can exceed 1 when callbacks miss their deadline. They are measured on the audio thread with the two steady-clock reads that time `xruns`, restart with the device's start, and are `0` while no device runs and before the first window is full. `engine.capabilities` reports `features.load` true when a transport port is present.

## Loudness (m5b-engine-load-loudness, Protocol v0 item 31)

| Method | Params | Result |
|---|---|---|
| `meter.reset_loudness` | `{}` | `{}` |

The engine meters the master output per ITU-R BS.1770-4 (gating as in EBU R128): momentary (400 ms), short-term (3 s) and integrated loudness in LUFS, after the master gain and before the click (architecture spec, "Master path"). The values travel on the realtime socket as the `"SLUD"` frame ([Protocol events v1](protocol-events-v1.md), "Loudness frame"). `meter.reset_loudness` restarts the integrated value; a locate or a stop does not, and the meter keeps its state across a graph swap and `engine.select_device`. It is engine state: no revision, no event, honours `expectedRevision` and the idempotency cache, and runs without a device (it is not `no_device`). Without a transport port it is `not_supported`. It is not an MCP tool ([Protocol MCP v0](protocol-mcp-v0.md)). `engine.capabilities` lists it in `methods` and reports `features.loudness` true when a transport port is present.

## Plans: title, intent and actor (m5b-engine-plan-metadata)

`plan.submit {steps, readSet?, baseRevision?, title?, intent?}` (spec, Protocol v0 item 14; [Plan v1](plan-v1.md), "Metadata"). Any other param is `invalid_params`, an `actor` too: the engine sets the plan's `actor` `{kind, name}` from the credential (`mcp` for the MCP token, `ui` for the UI token) and the client's name (`clientInfo.name`, or the auth frame's `client.name`, default `"SIANN"`).

| Case | Answer |
|---|---|
| `title` not a string, empty, over 200 UTF-8 bytes, with a control character (LF and CR included), or with a display-unsafe character ([Plan v1](plan-v1.md), "Metadata": bidi formatting, U+2028, U+2029) | `invalid_plan_metadata` |
| `intent` not a string, empty, over 2,000 UTF-8 bytes, with a control character other than tab, LF and CR, or with a display-unsafe character | `invalid_plan_metadata` |
| an `actor`, or any param not listed above | `invalid_params` |

On a refusal nothing is stored and no `plan.changed` goes out. `invalid_plan_metadata` is a new stable code. `plan.status`, `plan.list` and `plan.changed` carry `title`, `intent`, `actor` and `rejectionNote` when the plan has them.

`plan.submit` also takes `request` (m5b-engine-agent-requests, below): the id of an open agent request the plan answers. It is not part of the plan and not hashed. From the UI credential it is `invalid_params`; a closed request, or one addressed to another agent, is `request_not_open`, an unknown one `not_found`; nothing is stored then.

## Agent requests (m5b-engine-agent-requests)

A request from the user to an agent that is connected over MCP (spec, Protocol v0 item 32; human gate `agent-request-shape`, decided by the maintainer 2026-11-15). SIANN has no agent runtime: the engine holds the request until the agent takes it with the MCP tool `next_request` and answers it with `answer_request` or `submit_plan {request}` ([Protocol MCP v0](protocol-mcp-v0.md)). A request executes nothing: its text and context are data for the agent, and the only way its outcome reaches the document is a plan the user approves. Requests are engine state on the command thread: not a revision, not in the bundle or the journal, dropped when the engine restarts.

The request object:

```json
{"id": "arq_5c1e9a0b3d2f4e67", "agentId": "agt_3f2a9c1d0b7e6a54", "text": "Lower the drums",
 "context": {"selection": {"tracks": ["trk_1"], "clips": ["clp_4"]},
             "locators": {"schema": "siann.entity.locators.v1", "id": "locators", "left": "0", "right": "192000"},
             "cursor": "96000", "headRevision": "r3"},
 "state": "pending", "createdAt": "2026-11-15T10:01:00Z"}
```

`state` is `pending` or `taken` (open), or `answered`, `declined`, `cancelled` or `expired` (closed, final). `plan` (a plan hash) and `message` appear once an answer set them. `context` is stamped by the engine when it queues the request: only `selection` comes from the UI; `locators` is the head document's locators entity as `session.fetch` returns it (null when none is set), `cursor` the transport position in session frames as a decimal string (null without a transport port), `headRevision` main's head.

| Method | Credential | Params | Result |
|---|---|---|---|
| `agent.request` | UI | `{agentId, text, selection?: {tracks?: [id], clips?: [id]}}` | `{request}`, `pending` |
| `agent.cancel_request` | UI | `{request}` | `{request}`, `cancelled` |
| `agent.requests` | UI | `{}` | `{requests}`: the open ones oldest first, then the last `limits.agentRequestsClosedRetained` (16) closed ones in the order they closed |
| `agent.next_request` | MCP (`next_request`) | `{waitMs?}` | `{request}` (now `taken`) or `{request: null}` |
| `agent.answer_request` | MCP (`answer_request`) | `{request, plan}`, `{request, message}` or `{request, decline: true, message?}` | `{request}`, `answered` or `declined` |

The other credential is `scope_denied` for each (not cached). The codes:

| Case | Answer |
|---|---|
| `text` (or a `message`) empty, over 4,000 characters (Unicode code points, so at most 16,000 UTF-8 bytes; unlike a plan's title and intent, which count bytes), with a control character other than tab, LF and CR, or with a display-unsafe character (bidi formatting, U+2028, U+2029; `siann/model/display_text.hpp`) | `invalid_request_text` |
| a missing or non-string `agentId`, `text` or `request`; a selection that is not `{tracks?, clips?}`, a list over 256 ids, or an id that is not `[A-Za-z0-9_-]{1,64}`; an unknown param; `answer_request` with no form or two, `decline` other than `true`, or a plan another client submitted | `invalid_params` |
| `agentId` unknown, or the agent not connected | `agent_not_connected` |
| the agent already has `limits.agentRequestsPerAgent` (16) open requests, `pending` or `taken` | `agent_busy` (nothing is queued) |
| an unknown request id, or an unknown plan hash | `not_found` |
| cancelling or answering a closed request, or answering one addressed to another agent | `request_not_open` |

Open requests expire when their agent disconnects (`DELETE /v0/mcp`, or idle past `limits.agentIdleMs`; a later reconnect does not revive them), when the agent is forgotten (`limits.agentsRetained`), and when `session.open` or `session.create` serves another session. Every state change publishes `agent.request_changed` ([Protocol events v1](protocol-events-v1.md)). `engine.capabilities` lists the five methods, `features.agentRequests` (true when `features.agents` is) and `limits.agentRequestsPerAgent` (16), `agentRequestTextChars` (4000), `agentRequestWaitMs` (25,000 by default, at most `mcpRequestTimeout` minus 1 s) and `agentRequestsClosedRetained` (16). New stable codes: `agent_not_connected`, `agent_busy`, `invalid_request_text`, `request_not_open`.

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

m5b-engine-record, Protocol v0 item 28 (architecture spec, "Recording"). The methods go through `ServerOptions::recordPort`; without one they are `not_supported`. All run on the command thread, honour `expectedRevision` and the idempotency cache, and are listed in `engine.capabilities`' `methods`, which also lists `track.set_input` in `commands` and reports `features.recording` (true with a record port).

A track's input is document data, set with the command `track.set_input {trackId, input: {port, channels} | null}` through `command.execute`, a plan or MCP `execute`: `port` is the first device input channel (0-based), `channels` 1 or 2. The entity's JSON has `input` only while it is set.

| Method | Params | Result |
|---|---|---|
| `record.arm` | `{trackId, armed: bool}` | the record state `{recording, armed, takes}` |
| `transport.record` | `{enabled: bool}` | `{playing, position, cycle, click, recording, armed}` |
| `record.recover_take` | `{takeId, accept: bool, trackId?}` | accepted `{revision}`, rejected `{takeId, trashed: true}` |

Errors:

| Code | When |
|---|---|
| `invalid_params` | a missing or mistyped param |
| `no_device` | `record.arm` with `armed: true` or `transport.record` with `enabled: true` while no device runs |
| `no_input` | arming or recording with no input open; arming a track without `input`, or whose `port + channels` exceeds the open input's channels |
| `not_found` | `record.arm` for a track main does not hold; `record.recover_take` with a `trackId` main does not hold |
| `nothing_armed` | `transport.record {enabled: true}` with no armed track |
| `invalid_state` | arming or disarming while recording; a 17th armed track; recovering a take being recorded |
| `take_not_found` | `record.recover_take` for a take that is not pending, committed or trashed, or accepted after it was rejected |
| `take_has_no_audio` | `record.recover_take {accept: true}` for a take without a complete frame |
| `track_recording` | while recording, any request that would make a new head of main that removes a track being recorded or changes its `input` (set, cleared or re-routed): `command.execute`, `plan.apply`, `proposal.merge`, `plan.rollback`, `session.undo`, `session.redo`, MCP `execute` and the other tools over them. Nothing is committed; end the recording first |

- Arming is engine state, never a revision. Disarming a track that is not armed changes nothing. `session.open` clears the armed set; every new head of main prunes it (a removed track, an input cleared or no longer covered by the open input, an undo that removed it). The prune happens before any record method reads the set, so a `transport.record` that follows a `track.remove` or `track.set_input` in the same batch of requests sees the new head, and `armed` in the results never lists a track the head no longer arms.
- `transport.record {enabled: true}` begins one take per armed track at the playhead and starts the transport; while recording it changes nothing. `{enabled: false}` ends the recording and commits it as one revision (a `media.add` and a `clip.place` per take with audio; a take with no frame moves to `trash/`), and playback continues; with nothing recording it changes nothing. `transport.stop` ends a recording the same way and stops. `transport.locate` ends it the same way (`endedBy` `stop`), then locates, and playback continues from the new position: a take is one contiguous run at one position, so nothing after a jump goes into it. A device that stops, a ring overflow and a write failure end it too, from the engine's tick. The revision is announced by `session.changed`; `session.undo` removes the clips and the media references and deletes no file.
- Takes are recorded at the session rate into `media/recording/<takeId>.wav` with the manifest `<takeId>.json` (`siann.take_manifest.v1`); a committed take's media is `med_<takeId>` and its clip `clp_<takeId>`.
- While recording, the tracks being recorded keep existing and keep the input their takes began with: a new head of main that would remove one or change its `input` is refused with `track_recording`, whichever method makes it (commands, plans, merges, rollbacks, undo, redo). Every other change goes through, a track being recorded can be renamed, mixed or have clips edited. A proposal branch is not main and may remove it; merging that branch while recording is refused.
- If a track being recorded is gone anyway when the recording ends (no known path allows it), the other takes still commit as one revision and that track's take stays pending with its `trackId`, for `record.recover_take`.
- `record.recover_take` works on a pending take (one in `media/recording/` that is not being recorded, typically left by a crash): accepted, it is committed in the same revision shape; rejected, its files move to `trash/`. Accepted with `trackId`, its clip goes on that track of main's head (`not_found` when there is none). Accepted without `trackId`, it goes on its own track, or, when its own track is gone, on a new track `trk_<takeId>` (named after the take, with its channels, added last) in the same revision. Both are idempotent: an accept repeated answers the revision that committed the take, wherever it went, a reject repeated answers `{takeId, trashed: true}` again.
- With cycle on, a recording records straight through the right locator (the wrap is suspended while capturing).

The record state:

```json
{"recording": true, "armed": ["trk_1"],
 "takes": [{"takeId": "take_3f2a...", "trackId": "trk_1", "startFrame": "96000", "durableFrames": "48000"}]}
```

`takes` are the takes of the current recording, or of the last one once it ended, when each also has `endedBy` (`stop`, `overflow`, `disk` or `device`) and `overflows` (a decimal string). `startFrame` is the timeline frame the take lands on (its first captured frame's position minus the record offset), null until that frame; `durableFrames` counts the frames the WAV header made durable (the writer checkpoints about once a second). `record.changed` carries the same object whenever it changes ([Protocol events v1](protocol-events-v1.md)); `session.sync` and the auth reply list the pending takes as `pendingTakes`.

MCP: `record_arm` and `record` wrap `record.arm` and `transport.record` in the trusted scope ([Protocol MCP v0](protocol-mcp-v0.md)); `record.recover_take` has no tool: accepting or trashing a take is the user's decision about files on their disk (Protocol MCP v0, "Methods without a tool"). `transport.stop` and `transport.locate` end a running recording, so while one runs an MCP request with the propose scope for either (`stop`, `locate`) is `scope_denied` and reaches no port; stopped, they run as before. The UI's token and a trusted MCP credential are not limited.

## Monitoring

m5b-engine-monitoring, Protocol v0 item 33 (architecture spec, "Recording" and "Latency model"). A track's monitoring mode is document data, set with the command `track.set_monitor {trackId, monitor: "off" | "auto" | "input"}` through `command.execute`, a plan or MCP `execute` (no tool of its own). The entity's JSON has `monitor` only while it is not `off`. Another value, a missing or an extra field is `invalid_params`; an unknown track `not_found`. Recording does not guard it: the mode of a track being recorded can change.

- `input` passes the track's input (`Track.input`, through the open input) through the track's strip, its inserts, fader and meter, to its output (the master or a bus) and its sends, whether the transport plays or not. `auto` passes it while the transport is stopped on an armed track and while the track records, and plays the track's clips otherwise. `off` never passes it. A track without an input, or whose input the open input does not cover, monitors silence.
- Monitored input takes the low-latency path: it skips the delay that lines the track up with latent inserts on other tracks at the input its output or a send feeds (the master or a bus). A bus's own output carries other tracks and keeps its compensation, so a track monitored through a bus hears the bus chain's later compensation. Switching back to the clips never plays the monitored input a second time: the compensated path is silent for its length, then the clips fade in. `engine.status`' `monitorRoundTripFrames` is the device's input and output latencies, through device-side SRC the output SRC latency and the FIFO that carries the resampled input to the graph's blocks, and the largest monitored path's latency (the track's inserts, the buses after it and the master path), in session frames.
- A mode change goes through the same graph transition as any structural change (the output ducks and rises around the swap); arming and recording switch `auto` on the audio thread, with a short crossfade and no new graph.
- While the transport is stopped and a track monitors, the graph runs: the realtime channel's frames carry the meters, so the monitored track's meter reads its input.
- `engine.capabilities` lists `track.set_monitor` in `commands` and reports `features.monitoring` (true with a record port whose engine records input).

## session.open in siann-engine

`session.open {path}` (item 16) opens the bundle as a new `Session`, taking its lock, then rebinds the engine host to it: a new `PlaybackEngine` on the same device object (never recreated, only closed so that the new driver opens it again at the new session's rate, as at launch), a new `Auditioner` behind the same `AuditionPort`, and a new meter publisher, which sends a new `meters.legend`. Instances `plugin.instantiate` made that no `plugin.insert` committed are dropped. The cycle flag becomes the new bundle's (from its checkpoint, false when absent); the click state is kept. Then the old `Session` is destroyed, which releases its lock. The result is `{sessionId, revision, documentHash}`; the next `session.sync` carries them. Errors: `not_found` (no directory at `path`), `session_locked` (another live process holds the bundle, or this engine serves it already), any other `SessionError` code the open throws (`not_a_bundle`, ...); on every error the old session stays served.

## session.create

`session.create {path, name?}` (item 27, m5b-engine-project-media) creates an empty bundle and serves it. It goes through `ServerOptions::createSession(path, name, sampleRate)`; `siann-engine` creates the `Session` (taking the new bundle's lock), rebinds the engine host exactly as `session.open` does, then destroys the old `Session`, which releases the old bundle's lock. Without the callback the method is `not_supported`.

| Field | Rule |
|---|---|
| `path` | UTF-8, absolute, must not exist. A relative path or a UNC path (`\\server\share\x`, `\\?\UNC\server\share\x`) is `invalid_params`; an existing file, directory (empty or not) or bundle is `already_exists`; a missing parent directory is `not_found`. Nothing is created on any refusal. |
| `name` | optional string; `root.name`. Default: the path's stem (`Song` for `.../Song.siann`). A name given with a control or display-unsafe character ("Names" below) is `invalid_name` and nothing is created; the stem is stripped of them instead (`Untitled` when nothing is left). |

The session's sample rate is the rate the output device runs at (`engine.status` `device.sampleRate`), 48000 when no device runs or the server has no transport port. Queued and running `media.import` jobs are cancelled first (they end `failed` with `cancelled`). The result is `{sessionId, revision, documentHash}` (revision `r1`); subscribed connections receive `session.opened`, requests naming the old `sessionId` get `session_mismatch`, as after `session.open`.

## media.import

`media.import {path, clientImportId}` (architecture spec, "Commands and jobs", Jobs v0, import) queues a job and answers `{jobId, kind: "media.import", state: "queued"}`.

| Field | Rule |
|---|---|
| `path` | UTF-8, absolute, not UNC (`invalid_params` otherwise, and no job). A WAV (PCM 8 to 32 bit, float 32 or 64 bit, RIFF or RF64) or FLAC file. |
| `clientImportId` | string, 1 to 128 bytes, chosen by the client (`invalid_params` when missing or not a string). A repeated value for the served session answers the first job's `{jobId, kind, state}` and starts nothing. |

The worker decodes the file, converts it to the session rate when it differs (32-bit float WAV), writes `media/<sha256>.<ext>` and its peak pyramid `peaks/<sha256>.peaks` ([Protocol peaks v0](protocol-peaks-v0.md)), then the command thread commits `media.add` with a server-chosen `mediaId` (`med_<n>`, above every `med_<n>` in the history) and `name` (the file's base name without its control and display-unsafe characters, "Names" below, at most 255 UTF-8 bytes; `audio` when nothing is left) as one revision, published as `session.changed`. The job is `done` only after that commit.

`job.status {jobId}` for an import:

| State | Fields |
|---|---|
| `queued` | `{jobId, kind: "media.import", state}` |
| `running` | adds `progress: {framesDone, framesTotal}`, decimal strings counting source frames |
| `done` | `result: {mediaId, revision, contentHash, name, frames, sampleRate, channels, converted, existing?, originalHash?}`; `frames` a decimal string; `originalHash` (the source file's `sha256:`) when `converted` |
| `failed` | `error: {code, message}` |

Content the head document already holds (same `contentHash`) ends `done` with the existing entity's `mediaId`, `existing: true`, `revision` the head, and no new revision. Failure codes: `not_found` (no file at `path`), `unsupported_media`, `decode_failed` (truncated or damaged, a WAV data chunk shorter than its header says included), `too_large`, `io_error` (writing the bundle failed), `cancelled` (`session.open`, `session.create` or the server stopping), or the `CommandError` code of a refused `media.add`. A failed or cancelled import commits nothing and removes the files it created; files the bundle held before are kept.

`engine.capabilities` reports `features.mediaImport: {formats: ["wav", "flac"]}`, lists `session.create` and `media.import` in `methods` and `media.rename` in `commands`. MCP: `create_session` and `import_media`, trusted scope only ([Protocol MCP v0](protocol-mcp-v0.md)).

## Names

Every name the document stores, `root.name`, a track's, a bus's, a media's and a plugin slot's `name` (and a marker's when markers land), is well-formed UTF-8 without a control character (U+0000 to U+001F, U+007F to U+009F) and without a display-unsafe character: the bidi formatting characters U+061C, U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069, and U+2028 and U+2029 (the set [Plan v1](plan-v1.md), "Metadata", refuses in plan titles; architecture spec, "siann-model", names). An RLO or an isolate in a track name could otherwise make a plan step read as other text.

| Where | Answer |
|---|---|
| `track.add`, `track.rename`, `bus.add`, `bus.rename`, `media.add`, `media.rename`, `session.rename` `name`; `plugin.insert` `descriptor.name` (through `command.execute`, a plan or MCP `execute`) | `invalid_name`; nothing is applied, and in a transaction or plan the error carries the step |
| `session.create` `name` | `invalid_name`; nothing is created |
| a name the engine derives: `media.import` (the file name), `session.create` without `name` (the folder name), `plugin.instantiate` (the name the plugin reports) | stripped of those characters, never refused |
| a bundle whose checkpoint or journal holds such a name | `session.open` fails with `invalid_document` (`invalid_name: ...`); the document is not repaired, since stripping would change the hashes the journal is checked against |

`invalid_name` is a new stable code. A media name's length (1 to 255 bytes) stays `invalid_params`. The Studio UI also isolates each name it interpolates into a sentence (U+2068 FSI ... U+2069 PDI).

## The bundle lock

`<bundle>/lock` holds `{"pid": <n>, "startedAt": "<ISO 8601 UTC>"}` while a `Session` is open on the bundle. `Session::create` and `Session::open` create it exclusively (`O_CREAT | O_EXCL`, `CREATE_NEW`) and the `Session`'s destructor removes it, so a second `Session` on the bundle, in any process, throws `SessionError` `session_locked`. A lock file that is empty, unparseable, or names a pid that is not a live process is taken over: removed, and the exclusive create tried once more. Consequences:

- `siann-engine --session <bundle>` on a bundle another engine serves exits 1 with `{ok: false, error: {code: "session_locked", ...}}` as the last stderr line and nothing on stdout (item 17).
- `siann-cli info`, `verify` and every other command that opens a bundle answer `session_locked` while an engine serves it.
- A crashed engine leaves the file; the next open takes it over because its pid is dead.

### Buses and sends (m5b-engine-buses-sends, UR-10)

Buses and sends are document data, changed with commands through `command.execute`, a plan or MCP `execute`; no method or port is dedicated to them. The entities (architecture spec, "siann-model", M5b bus and send) are `{schema: "siann.entity.bus.v1", id, name, channels: 2, gainMilliDb, pan, mute, solo, inserts?, output?}` (ref `bus:<id>`) and `{schema: "siann.entity.send.v1", id, trackId, busId, levelMilliDb, pre, enabled}` (ref `send:<id>`); the root gains `busOrder` and a track `sends` and `output`, all omitted while empty, so the document format is `siann.session_document.v3` and every earlier bundle reads unchanged.

| Command | Params | Declares |
|---|---|---|
| `bus.add` | `{busId, name, index?}` | `root`, the bus |
| `bus.remove` | `{busId}` | `root`, the bus, its sends and slots, the tracks losing a send, the tracks and buses rerouted to the master |
| `bus.rename`, `bus.set_gain`, `bus.set_pan`, `bus.set_mute`, `bus.set_solo` | `{busId, name \| gainMilliDb \| pan \| mute \| solo}` | the bus |
| `bus.set_output` | `{busId, output: {busId} \| null}` | the bus |
| `send.add` | `{sendId, trackId, busId, levelMilliDb?, pre?, enabled?, index?}` | the send, its track |
| `send.remove` | `{sendId}` | the send, its track |
| `send.set_level`, `send.set_pre`, `send.set_enabled` | `{sendId, levelMilliDb \| pre \| enabled}` | the send |
| `track.set_output` | `{trackId, output: {busId} \| null}` | the track |

An unknown track, bus or send is `not_found`, a used id `already_exists`, another field `invalid_params`, a gain or level out of range `invalid_gain` and a pan `invalid_pan`. A `bus.set_output` that would make a bus reach itself, directly or through a chain of buses, is `routing_cycle` and changes nothing. `plugin.insert` and `plugin.instantiate` take exactly one of `trackId` or `busId` ([Protocol plugins v0](protocol-plugins-v0.md)).

`command.list {}` answers `{commands, cascades}`: `commands` is the sorted string array of `command::commandNames()`, as before, and `cascades` maps a command to the sorted entity types it may remove or change besides its target, `{"bus.remove": ["bus", "plugin_slot", "root", "send", "track"], "track.remove": ["clip", "plugin_slot", "root", "send"]}`; a command without cascades is absent. `engine.capabilities` lists the fourteen commands in `commands` and reports `features.buses: true` and `features.sends: true`.

A bus meters under the key `bus:<id>` ([Protocol events v1](protocol-events-v1.md), `meters.legend`). Bus gain and send level are gesture targets ([Protocol gestures v0](protocol-gestures-v0.md)).
