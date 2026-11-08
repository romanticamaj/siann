# Protocol plugins v0

The plugin methods of the native protocol server (architecture spec, "siann-protocol", Protocol v0 items 18 and 19; "Commands and jobs", Jobs v0, plugins; m4-plugin-node). They reach the engine through `ServerOptions::pluginPort` (`protocol::PluginPort`, implemented by the engine host). Without a port they answer `not_supported`. Every method runs on the command thread, honours `expectedRevision` and the idempotency cache, and is listed in `engine.capabilities`' `methods`. None is an MCP tool yet ([Protocol MCP v0](protocol-mcp-v0.md) is unchanged).

## Session document

A plugin insert is a `plugin_slot` entity (`siann.entity.plugin_slot.v1`):

```json
{"schema": "siann.entity.plugin_slot.v1", "id": "slt_1", "trackId": "trk_1", "format": "clap",
 "uid": "org.siann.test-plugin", "name": "SIANN Test Plugin", "path": "/Library/Audio/Plug-Ins/CLAP/x.clap",
 "stateBlob": "sha256:<64 hex>", "bypass": false}
```

`stateBlob` is `null` or the hash of a file in `<bundle>/blobs/<hex>`. A track lists its slots in order in `inserts`; the field (and the document's `pluginSlots` table) is omitted when empty, so documents without plugins keep their hashes. Commands: `plugin.insert {trackId, index, slotId, descriptor: {format, uid, name?, path?}, stateBlob}` (index clamps to the end), `plugin.remove {slotId}`, `plugin.set_bypass {slotId, bypass}`; `track.remove` removes the track's slots.

## plugin.instantiate

Params `{trackId, index, descriptor: {format, path?, uid?, name?}, stateBlob?}`. `index` is a non-negative integer, `format` one of `clap`, `vst3`, `au`, `lv2`, and the descriptor needs a `path` or a `uid`; anything else is `invalid_params`. An unknown track is `not_found`.

A job that runs inside the request: the engine instantiates the plugin, the server writes its default state durably to `<bundle>/blobs/<sha256 hex>` (or keeps the `stateBlob` it was given, which must already be in the bundle), and commits `plugin.insert` with the next free slot id `slt_<n>`; `session.changed` follows the response. The instance enters the engine's instance table, so the next compile reuses it.

```json
{"jobId": "job_3", "kind": "plugin.instantiate", "state": "done",
 "result": {"revision": "r7", "slotId": "slt_1",
            "descriptor": {"format": "clap", "uid": "org.siann.test-plugin", "name": "SIANN Test Plugin", "path": "..."},
            "stateBlob": "sha256:...", "latencyFrames": 64, "tailFrames": 0,
            "capabilities": {"sampleAccurateParameters": true, "midiInput": false, "midiOutput": false,
                             "sidechain": false, "variableLatency": true, "editor": false}}}
```

A plugin that does not load answers `{jobId, kind, state: "failed", error: {code, message}}` with the PluginError code (`plugin_not_found`, `plugin_load_failed`, `no_plugin_host` for `vst3` and `au` in a core-only build) and commits nothing. `job.status {jobId}` returns the same object.

## plugin.open_editor, plugin.close_editor

Params `{slotId}`. Result `{slotId, editorOpen, nativeHandle}`, `nativeHandle` the editor's top-level window as a decimal string (`"0"` when closed). On Windows the window is owned by the engine's `--owner-window`. Errors: `not_found` (no such slot), `plugin_missing` (the slot's plugin did not load), `editor_failed` (no editor, or a CLAP plugin on the desktop target until it gets a window), `no_plugin_host`.

## engine.status plugins[]

With a plugin port, `engine.status` adds one entry per slot of the heard document:

```json
{"slotId": "slt_1", "trackId": "trk_1", "format": "clap", "uid": "...", "state": "running",
 "capabilities": {...}, "latencyFrames": 64, "tailFrames": 0, "callbacks": "4096", "xruns": "0",
 "maxCallbackMicros": 85.2, "unmeasuredCallbacks": "0", "midiOutputOverflows": "0"}
```

Counters run since the instance was created, from its `PluginNode`'s own callback timer; counters are decimal strings and `maxCallbackMicros` a number. `error {code, message}` is there when something went wrong: a `missing` plugin's reason, or `state_missing` for a `running` plugin whose blob was not in the bundle (it loaded with its default state). A missing plugin's `capabilities`, `latencyFrames`, `tailFrames` and counters are `null`; it passes audio through and its slot keeps its `stateBlob`.

## engine.capabilities

`features.plugins` is `false` without a port, otherwise `{formats: ["clap", ...], flags: ["sampleAccurateParameters", "midiInput", "midiOutput", "sidechain", "variableLatency", "editor"]}`.

## render.start

With a port and plugin slots in the document, the request instantiates one instance per slot from its state blob before the job is queued; the offline-render thread drives those, never the live graph's. A slot whose plugin does not load renders dry. After the job ends, the command thread destroys the set on its next pump.
