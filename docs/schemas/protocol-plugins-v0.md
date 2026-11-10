# Protocol plugins v0

The plugin methods of the native protocol server (architecture spec, "siann-protocol", Protocol v0 items 18, 19, 20 and 21; "Commands and jobs", Jobs v0, plugins; m4-plugin-node). They reach the engine through `ServerOptions::pluginPort` (`protocol::PluginPort`, implemented by the engine host). Without a port they answer `not_supported`. Every method runs on the command thread, honours `expectedRevision` and the idempotency cache, and is listed in `engine.capabilities`' `methods`. None is an MCP tool yet ([Protocol MCP v0](protocol-mcp-v0.md) is unchanged).

## Session document

A plugin insert is a `plugin_slot` entity (`siann.entity.plugin_slot.v1`):

```json
{"schema": "siann.entity.plugin_slot.v1", "id": "slt_1", "trackId": "trk_1", "format": "clap",
 "uid": "org.siann.test-plugin", "name": "SIANN Test Plugin", "path": "/Library/Audio/Plug-Ins/CLAP/x.clap",
 "stateBlob": "sha256:<64 hex>", "bypass": false}
```

`stateBlob` is `null` or the hash of a file in `<bundle>/blobs/<hex>`. A track lists its slots in order in `inserts`; the field (and the document's `pluginSlots` table) is omitted when empty, so documents without plugins keep their hashes. Commands: `plugin.insert {trackId, index, slotId, descriptor: {format, uid, name?, path?}, stateBlob}` (index clamps to the end), `plugin.remove {slotId}`, `plugin.set_bypass {slotId, bypass}`; `track.remove` removes the track's slots.

## plugin.instantiate

Params `{trackId, index, descriptor: {format, path?, uid?, name?}, stateBlob?}`. `index` is a non-negative integer, `format` one of `clap`, `vst3`, `au`, `lv2`, and the descriptor needs a `path` or a `uid`; anything else is `invalid_params`, and so is a UNC `path` (`\\server\share`, `//server/share`) or one inside the session bundle, refused before any plugin host is reached. An unknown track is `not_found`. The plugin comes from the registry (below): with a `path`, the registered install at that path, which must be approved; with a `uid` and no path, its one approved install.

A job that runs inside the request: the engine instantiates the plugin, the server writes its default state durably to `<bundle>/blobs/<sha256 hex>` (or keeps the `stateBlob` it was given, which must already be in the bundle), and commits `plugin.insert` with the next free slot id `slt_<n>`; `session.changed` follows the response. The instance enters the engine's instance table, so the next compile reuses it.

```json
{"jobId": "job_3", "kind": "plugin.instantiate", "state": "done",
 "result": {"revision": "r7", "slotId": "slt_1",
            "descriptor": {"format": "clap", "uid": "org.siann.test-plugin", "name": "SIANN Test Plugin", "path": "..."},
            "stateBlob": "sha256:...", "latencyFrames": 64, "tailFrames": 0,
            "capabilities": {"sampleAccurateParameters": true, "midiInput": false, "midiOutput": false,
                             "sidechain": false, "variableLatency": true, "editor": false}}}
```

A plugin that does not load answers `{jobId, kind, state: "failed", error: {code, message}}` with the PluginError code (`plugin_not_registered`, `plugin_not_approved`, `plugin_not_found`, `plugin_load_failed`, `no_plugin_host` for `vst3` and `au` in a core-only build) and commits nothing. `job.status {jobId}` returns the same object.

## plugin.registry, plugin.approve

A session never chooses what code loads (Protocol v0 item 21; m5-plugin-registry). The engine keeps a registry of plugin installs keyed by `{format, path}`, filled at launch from the platform's standard plugin directories and every `--plugin-dir <dir>` without running any plugin code, each install carrying the uid, name and approval the `--plugin-registry <file>` JSON file holds for its path. `uid` is `null` until the install has been probed.

`plugin.registry {}` returns every install:

```json
{"plugins": [{"format": "clap", "path": "C:/Program Files/Common Files/CLAP/x.clap", "uid": "org.siann.test-plugin",
              "name": "SIANN Test Plugin", "approved": true},
             {"format": "clap", "path": "C:/Program Files/Common Files/CLAP/y.clap", "uid": null, "name": "y", "approved": false}]}
```

`plugin.approve {format, path, approved}` sets the flag and returns the install's entry. `format` is one of `clap`, `vst3`, `au`, `lv2`, `path` a string and `approved` a boolean; anything else is `invalid_params`. A path the registry does not hold is `plugin_not_registered`. Approving an install whose uid is not known probes it first (`scanPath`, which runs its code: the user chose that by approving); a probe that fails answers its PluginError code (`plugin_not_found`, `plugin_load_failed`) and leaves the install unapproved. `approved: false` needs no probe. The file is written atomically on every change, and the flag takes effect at the next instantiate or relaunch. A library holding several plugins is one install, approved as the first plugin its probe lists.

Every load goes through the registry: the live instance table, `render.start`'s instances and `plugin.instantiate`. A slot resolves by `{format, uid}` to the approved installs with that uid. One is the one that loads; between several, the slot's `path` chooses, and without a match the slot is missing with `plugin_not_registered` naming the ambiguity. With none, the slot is missing with `plugin_not_approved` when an unapproved install of the uid (or at the slot's path) is registered, and `plugin_not_registered` otherwise. The slot's `path` is a hint and never opened by itself: a UNC or device hint (`unc_path`: `\\server\share`, `//server/share`, `\\?\...`, `\\.\...` or `\??\...` with either separator, and on Windows any root name that is not a drive letter), a hint inside the session bundle (`inside_bundle`) or a path that is no registered install's (`unregistered_path`) is ignored, and the `plugin_not_registered` message names that reason. The installs themselves follow the same rule: a library found inside the session bundle or on a share (through a `--plugin-dir` that holds the bundle, or a standard location such as a `CLAP_PATH` entry) is not registered, and `plugin.approve`, `plugin.instantiate` and every slot load refuse an install whose own path is refused with `plugin_not_registered`, before the library opens. A missing slot passes audio through and keeps its `stateBlob`.

Both methods run on the command thread, honour `expectedRevision` and the idempotency cache, are listed in `engine.capabilities`' `methods`, and answer `not_supported` without a port. `plugin.approve` is not an MCP tool, and neither is `plugin.registry`: an agent must not choose what code loads, so `tools/list` has no tool for them and an MCP request naming them is refused.

The `--plugin-registry` file:

```json
{"schema": "siann.plugin_registry.v0",
 "plugins": [{"format": "clap", "path": "...", "uid": "org.siann.test-plugin", "name": "SIANN Test Plugin", "approved": true}]}
```

A file that does not parse, or does not have this shape, is one diagnostic line and an empty registry; the next approval rewrites it.

A state blob names a file only as `sha256:` followed by 64 lowercase hex digits; any other value (`sha256:../../x`, uppercase hex, a bare hash) is `bad_state` for the slot and reads nothing outside `<bundle>/blobs`.

## plugin.open_editor, plugin.close_editor

Params `{slotId}`. Result `{slotId, editorOpen, nativeHandle}`, `nativeHandle` the editor's top-level window as a decimal string (`"0"` when closed). On Windows the window is owned by the engine's `--owner-window`. Errors: `not_found` (no such slot), `plugin_missing` (the slot's plugin did not load), `editor_failed` (no editor, or a CLAP plugin on the desktop target until it gets a window), `no_plugin_host`.

## plugin.set_parameter

The live parameter path for a hosted plugin (Protocol v0 item 20; m4-crash-recovery). Params `{slotId, paramId, value}`: `paramId` is a string, the `id` the instance's parameter list reports (for a CLAP plugin its decimal `clap_id`, not its index or name); `value` is a normalized number from 0 to 1. Result `{slotId, paramId, value}`.

```json
{"slotId": "slt_1", "paramId": "8890", "value": 1}
```

It mutates no document, commits no revision, is not journaled and sends no `session.changed`: the value lives in the instance until its state is next captured, so after a crash the relaunched engine has the last durable revision and never re-runs the change. A CLAP slot gets it through the control dispatcher (`controlInbox`, then `paramInbox`) as a parameter event at the start of its `PluginNode`'s next processed block, block-accurately; while the transport is stopped no block runs the plugin, and the value lands at the first one played. The node keeps the latest value of each parameter until then, with room for every parameter the instance listed when it was installed, so no number of parameters set while stopped drops one; a parameter the plugin added after install goes through `PluginControl::setParameter`, which CLAP also delivers by the next block. A VST3 or AU slot gets it through `PluginControl::setParameter` on the engine's main thread (JUCE's formats discard block events), never from the audio thread.

Errors: `invalid_params` (a missing or non-string `slotId` or `paramId`, a `value` that is not a number from 0 to 1), `not_found` (no such slot, or a `paramId` the instance does not list), `plugin_missing` (the slot's plugin did not load), `queue_full` (the command inbox is full), `not_supported` without a port.

## engine.status plugins[]

With a plugin port, `engine.status` adds one entry per slot of the heard document:

```json
{"slotId": "slt_1", "trackId": "trk_1", "format": "clap", "uid": "...", "state": "running",
 "capabilities": {...}, "latencyFrames": 64, "tailFrames": 0, "callbacks": "4096", "xruns": "0",
 "maxCallbackMicros": 85.2, "unmeasuredCallbacks": "0", "midiOutputOverflows": "0", "midiOutputSysex": "0"}
```

Counters run since the instance was created, from its `PluginNode`'s own callback timer; counters are decimal strings and `maxCallbackMicros` a number. `midiOutputOverflows` counts the blocks whose MIDI or note output went past the 2048 events an instance takes in one block (Steinberg's limit, for every format); the events past it are lost. `midiOutputSysex` counts the sysex events in the plugin's output one by one, whether or not the block's list took them (ADR-0018, Amendment 3): for a VST3 or AU, the sysex messages in the `juce::MidiBuffer` after `processBlock`, each of which JUCE's wrapper allocated for on the audio thread (`MidiMessage::createSysExMessage` for a VST3, `MidiDataConcatenator` for an AU), the accepted plugin-caused allocation; for a CLAP plugin, its `CLAP_EVENT_MIDI_SYSEX` pushes, which allocate nothing. A climbing `midiOutputSysex` on a VST3 or AU says that plugin allocates inside its block. Until MIDI tracks exist (M6b) the output is dropped after counting. `error {code, message}` is there when something went wrong: a `missing` plugin's reason, or `state_missing` for a `running` plugin whose blob was not in the bundle (it loaded with its default state). A missing plugin's `capabilities`, `latencyFrames`, `tailFrames` and counters are `null`; it passes audio through and its slot keeps its `stateBlob`.

## engine.capabilities

`features.plugins` is `false` without a port, otherwise `{formats: ["clap", ...], flags: ["sampleAccurateParameters", "midiInput", "midiOutput", "sidechain", "variableLatency", "editor"]}`.

## render.start

With a port and plugin slots in the document, the request instantiates one instance per slot from its state blob before the job is queued; the offline-render thread drives those, never the live graph's. A slot whose plugin does not load renders dry. After the job ends, the command thread destroys the set on its next pump.
