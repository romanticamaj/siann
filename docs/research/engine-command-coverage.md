# Engine Command Coverage

This matrix defines the SIANN v0 audio engine command surface. It is the
implementation checklist for extracting core DAW behavior behind the command
bridge while keeping Ardour session compatibility as a verification path.

Status values:

- `implemented`: available in the current batch runner or live runtime.
- `next`: required for the next core editing milestone.
- `planned`: required before a full Studio UI can cover normal DAW work.
- `deferred`: important, but not needed for the current import/edit/render loop.

Every mutating command must have observation evidence, journal entries,
rollback coverage, and at least one render or Ardour visual verification path.

## Runtime Requests

| Request | Status | Purpose | Verification |
| --- | --- | --- | --- |
| `runtime.start` | implemented | Negotiate protocol and capabilities. | Runtime client tests. |
| `session.create` | implemented | Create a SIANN-owned session. | Live runtime integration test. |
| `session.observe` | implemented | Return canonical UI/agent state plus observation hash. | Hash and replay tests. |
| `commands.apply` | implemented | Apply command batches with stale-plan protection. | Live import-pack test. |
| `render.preview` | implemented | Render a short review artifact. | WAV smoke test. |
| `session.save` | implemented | Persist the current session. | Live runtime integration test. |
| `session.rollback` | implemented | Restore a snapshot-backed rollback point. | Runtime rollback test. |
| `session.close` | implemented | Release a live session. | Live import-pack test. |
| `runtime.stop` | implemented | Stop the headless engine process. | Runtime client tests. |

## Batch Commands

| Command | Status | Purpose | Next coverage |
| --- | --- | --- | --- |
| `create_session` | implemented | Create an engine session from a command file. | Keep as compatibility fixture. |
| `open_session` | implemented | Reopen a saved or restored session for verification. | Keep limited to compatibility checks. |
| `restore_batch_snapshot` | implemented | Restore a journal snapshot in batch mode. | Keep parity with `session.rollback`. |
| `create_audio_track` | implemented | Create one or more audio tracks. | Add stable observed `trackId` assertions. |
| `import_audio` | implemented | Import audio, optionally trim source, and place on a track. | Assert source metadata and trim boundaries. |
| `place_audio` | implemented | Move an existing region to a target time or track. | Add multi-track move and stale hash tests. |
| `render` | implemented | Render a preview/export from batch mode. | Compare with live `render.preview`. |
| `save_session` | implemented | Save the batch session. | Keep as journal fixture. |
| `observe_session` | implemented | Emit canonical observed state. | Align with session observation v0 schema. |
| `rollback_plan` | implemented | Roll back a plan revision an earlier run applied (`plan.rollback {revision}`; m5b-bridge-native-client, command journal v1). | `rollback-workflow`, the engine-gated workflow test. |
| `rename_track` | next | Rename tracks without changing stable IDs. | Observe old/new names and rollback. |
| `delete_track` | next | Remove tracks and owned playlists where safe. | Reject non-empty deletion unless explicit. |
| `set_track_mute` | next | Mute or unmute tracks. | Render amplitude and observed mixer state. |
| `set_track_solo` | next | Solo or unsolo tracks. | Render routing and observed mixer state. |
| `set_track_gain` | next | Set track fader gain in dB. | Render amplitude delta and rollback. |
| `set_track_pan` | next | Set stereo pan position. | Render channel balance and observe panner state. |
| `rename_region` | next | Rename regions without changing stable IDs. | Observe region ID stability. |
| `move_region` | next | Canonical region move command; may wrap `place_audio`. | Prefer stable `regionId` over names. |
| `trim_region` | next | Edit existing region start/end after import. | Observe source offsets and duration. |
| `split_region` | next | Split one region into two regions. | Observe new IDs and render continuity. |
| `duplicate_region` | planned | Copy a region to another time or track. | Observe source sharing and rollback. |
| `set_region_gain` | planned | Apply clip gain. | Render amplitude delta. |
| `set_region_fade` | planned | Apply fade-in and fade-out durations/curves. | Render boundary samples. |
| `set_tempo` | planned | Define timeline tempo. | Time conversion tests. |
| `set_meter` | planned | Define time signature. | Bar/beat placement tests. |
| `add_bus` | planned | Create routing and submix buses. | Observe graph and render routing. |
| `set_send` | planned | Add or adjust sends. | Observe routing and render bus output. |
| `add_plugin` | deferred | Insert a plugin by stable plugin ID. | Plugin scan and offline render fixture. |
| `set_plugin_param` | deferred | Set automatable plugin parameters. | Observe automation state and render delta. |

## Milestone Order

1. Finish track and region editing commands through `rename_track`,
   `delete_track`, `move_region`, `trim_region`, and `split_region`.
2. Add mixer commands for mute, solo, gain, and pan.
3. Add timeline commands only after observation exposes tempo and meter.
4. Add bus, send, plugin, and automation commands after core edit/render
   behavior is stable.

