# Protocol engine v0

The transport, status and device methods of the native protocol server, and what `session.open` and the bundle lock do in `siann-engine` (architecture spec, "siann-protocol", Protocol v0 items 16, 17, 18 and 22; "Process model"; "Session bundle"; m4-engine-device and m5-engine-sessions-devices). They reach the engine through `ServerOptions::transportPort` (`protocol::TransportPort`, implemented by `EngineHost` in `native/apps/engine`). Without a port they answer `not_supported`. Every method runs on the command thread, honours `expectedRevision` and the idempotency cache, and is listed in `engine.capabilities`' `methods`. Each is also an MCP tool ([Protocol MCP v0](protocol-mcp-v0.md)): `play`, `stop`, `locate`, `engine_status` and `list_devices` in the propose scope, `select_device` in the trusted scope.

## Transport

| Method | Params | Result |
|---|---|---|
| `transport.play` | `{}` | `{playing, position}` |
| `transport.stop` | `{}` | `{playing, position}` |
| `transport.locate` | `{frames: "<decimal>"}` | `{playing, position}` |

`position` is a decimal string of session frames. A locate reports its target at once; the playhead reaches it when the butler is ready. Without a running device each answers `no_device` with the reason as the message. A `frames` that is missing or not a non-negative decimal string is `invalid_params`.

## engine.status

Params `{}`. Result:

```json
{"device": {"id": "fake", "sampleRate": 48000, "bufferFrames": 256, "inputLatencyFrames": 256, "outputLatencyFrames": 256},
 "playing": false, "xruns": "0", "maxCallbackMicros": 0.0, "unmeasuredCallbacks": "0", "underruns": "0", "srcUnderruns": "0",
 "plugins": []}
```

`device` is null when no device runs, and `deviceError {code, message}` then says why: `no_device`, `device_open_failed`, `device_lost`, `no_audio_backend` (a core-only build without `--device fake`), or a media code when the session's first graph could not be built (`media_missing`, `media_hash_mismatch`, `media_mismatch`, `unsupported_media`, `decode_failed`, `too_large`, `load_failed`). `id` is `fake`, `<type>/<name>` or `default` (launched without `--device` and nothing selected since). The counters run from the device's start. `plugins` is in [Protocol plugins v0](protocol-plugins-v0.md).

## engine.devices

Params `{}`. Result:

```json
{"devices": [{"id": "fake", "type": "fake", "name": "fake", "isDefault": false, "current": true},
             {"id": "Windows Audio/Speakers", "type": "Windows Audio", "name": "Speakers", "isDefault": true, "current": false}]}
```

`fake` is listed by every build. A `SIANN_WITH_JUCE` build adds every output device `JuceAudioDevice::listOutputDevices()` reports, as `siann-cli devices` prints them, `id` being `<type>/<name>`, the form `--device` takes. `current` marks the device the engine runs or is trying to open: the entry whose `id` was selected (or given with `--device`), or the first `isDefault` entry when the engine was launched without `--device` and nothing was selected since. At most one entry is current.

## engine.select_device

Params `{id}`. Result: `engine.status`'s `device` object, or null while the session's first graph could not be built.

| Case | Answer | Afterwards |
|---|---|---|
| `id` missing or not a string | `invalid_params` | nothing changed |
| `id` not in `engine.devices` | `not_found` | the current device plays on |
| the open succeeds | the new `device` | stopped at the playhead, counters from zero |
| the open fails | `device_open_failed` (or the device's own code) | the old device is closed; `engine.status` shows `deviceError`; the main thread retries the named device under the device backoff, its count from zero |
| the session's first graph could not be built | the `deviceError` code (`media_missing`, ...) | the choice is kept and opened once a commit lets the graph build |

The host stops the transport and the graph driver, closes the running device and opens the new one on the main thread, the path a reopen after `device_lost` takes. A device another application holds is `device_open_failed`; `--fake-open-failures N` makes the fake device refuse its first N opens, so the tests drive this case.

## session.open in siann-engine

`session.open {path}` (item 16) opens the bundle as a new `Session`, taking its lock, then rebinds the engine host to it: a new `PlaybackEngine` on the same device object (the device is never closed or recreated; the new driver opens it again at the new session's rate, as at launch), a new `Auditioner` behind the same `AuditionPort`, and a new meter publisher, which sends a new `meters.legend`. Instances `plugin.instantiate` made that no `plugin.insert` committed are dropped. Then the old `Session` is destroyed, which releases its lock. The result is `{sessionId, revision, documentHash}`; the next `session.sync` carries them. Errors: `not_found` (no directory at `path`), `session_locked` (another live process holds the bundle, or this engine serves it already), any other `SessionError` code the open throws (`not_a_bundle`, ...); on every error the old session stays served.

## The bundle lock

`<bundle>/lock` holds `{"pid": <n>, "startedAt": "<ISO 8601 UTC>"}` while a `Session` is open on the bundle. `Session::create` and `Session::open` create it exclusively (`O_CREAT | O_EXCL`, `CREATE_NEW`) and the `Session`'s destructor removes it, so a second `Session` on the bundle, in any process, throws `SessionError` `session_locked`. A lock file that is empty, unparseable, or names a pid that is not a live process is taken over: removed, and the exclusive create tried once more. Consequences:

- `siann-engine --session <bundle>` on a bundle another engine serves exits 1 with `{ok: false, error: {code: "session_locked", ...}}` as the last stderr line and nothing on stdout (item 17).
- `siann-cli info`, `verify` and every other command that opens a bundle answer `session_locked` while an engine serves it.
- A crashed engine leaves the file; the next open takes it over because its pid is dead.
