# SIANN Command Journal v1

Date: 2026-11-15

Status: Implemented (m5b-bridge-native-client)

Supersedes: [Command journal v0](command-journal-v0.md), the Ardour engine's
journal, which is historical. The bridge refuses a v0 journal
(`validate-journal`, `rollback`) with a message that names it.

## Purpose

`siann.command_journal.v1` is what the Node bridge (`src/bridge/runner.js`)
writes after it runs a `siann.command.v0` file against the native
`siann-engine`: which session bundle it changed, and for every plan it applied
the plan hash, the revisions, the stable IDs the plan touched (the applied
revision's diff) and the document hashes before and after. It is the
bridge's record, not the engine's history. The engine keeps its own
write-ahead journal in the bundle (`journal.ndjson`, `siann.journal_record.v1`;
architecture spec, "Journal as write-ahead log"), so v1 holds no snapshots: a
rollback names a revision and the engine inverts it from its history.

It is written to the command file's `journalPath` (resolved against the command
file's directory) when the run ends, also when it fails.

## How a command file runs

One engine process per run. `create_session` checks the rate `engine.status`
reports (48000 without a device) against the file's `sampleRate`
(`sample_rate_mismatch` before anything is created), then calls
`session.create {path: sessionDir, name: sessionName}`; `open_session` calls
`session.open`. `import_audio` imports its file with `media.import` (the job
followed through `job.status`; its `media.add` revision is the engine's, outside
the plan). The `create_audio_track` and `import_audio` ops between two other ops
become the steps of one plan: `track.add {trackId, name, channels}` and
`clip.place {clipId, trackId, mediaId, position: {domain: "audio", value},
sourceStart, length}`, the manifest's times (seconds, `mm:ss` or `hh:mm:ss`)
converted to frames at the session rate. The plan is submitted, its hash as the
engine reports it checked against the Node hash (`src/hash/plan-hash.js`;
`plan_hash_mismatch` otherwise, before approval), approved and applied, which is
one batch of the journal. A placement on a track name the session and the file
do not hold is `unknown_track`, on a name more than one track has
`ambiguous_track`, both before the file is imported. `save_session` is
`session.save`, `render` is `render.start` with the finished
`renders/<name>.wav` copied to `outputPath`, `observe_session` is
`session.inspect`, and `rollback_plan {revision}` is
`plan.rollback {revision}`.

The file carries only what siann-engine honours; the rest of the Ardour
runner's v0 fields are refused, never dropped:

- `render` writes what `render.start {name, start?, frames?}` writes (spec,
  Jobs v0): 32-bit float WAV at the session rate, unnormalised. Its
  `sampleRate` (optional) must be the session rate, its `bitDepth` (optional)
  `"float32"` and its `normalize` (optional) `false`; any other value is
  `render_format_unsupported`, checked before anything runs where the file
  creates the session and before `render.start` where it opens one.
  `workflow import-pack` refuses a manifest preview with another `bitDepth`,
  `normalize` or `sampleRate` the same way and writes only `outputPath` and
  `sampleRate`.
- `create_audio_track` takes `name`, `count` and `outputChannels` (or
  `channels`), which becomes `track.add`'s `channels` (1 for mono, else 2).
  `inputChannels` is `unsupported_field`: a native track has no input routing
  in the plan step.
- `snapshotRetention` on the file is `unsupported_field`: the session history
  lives in the bundle and v1 holds no snapshots. A manifest's
  `snapshotRetention` and tracks' `inputChannels` are still accepted in a
  manifest, so existing manifests load, but nothing reads them: `workflow
  import-pack` does not write them to the command file and the DAWproject
  exporter ignores them.

## Shape

```json
{
  "schemaVersion": "siann.command_journal.v1",
  "journalId": "journal",
  "status": "applied",
  "risk": "normal",
  "commandFile": "/tmp/siann-import-pack-demo/import-pack.command.json",
  "bundle": "/tmp/siann-import-pack-demo/Session",
  "batches": [
    {
      "batchId": "batch_0001",
      "status": "applied",
      "risk": "normal",
      "planHash": "sha256:...",
      "baseRevision": "r3",
      "appliedRevision": "r4",
      "touchedIds": ["root:root", "track:trk_1", "clip:clp_1"],
      "preState": { "revision": "r3", "documentHash": "sha256:..." },
      "postState": { "revision": "r4", "documentHash": "sha256:..." },
      "entries": [
        { "entryId": "entry_0001", "op": "track.add", "status": "applied",
          "command": { "op": "track.add", "trackId": "trk_1", "name": "FX Risers", "channels": 2 },
          "name": "FX Risers" },
        { "entryId": "entry_0002", "op": "clip.place", "status": "applied",
          "command": { "op": "clip.place", "clipId": "clp_1", "trackId": "trk_1", "mediaId": "med_1",
                       "position": { "domain": "audio", "value": "384000" }, "sourceStart": "0", "length": "24000" },
          "path": "/tmp/siann-import-pack-demo/audio/riser.wav", "regionName": "Riser 01" }
      ]
    }
  ],
  "media": [
    { "path": "/tmp/siann-import-pack-demo/audio/riser.wav", "mediaId": "med_1", "revision": "r2",
      "contentHash": "sha256:...", "frames": "24000", "existing": false }
  ]
}
```

## Fields

- `schemaVersion`: `siann.command_journal.v1`.
- `journalId`: the journal file's base name.
- `status`: `applied` when every op ran, `failed` otherwise; a failed run also
  has `error: {code, message, op, index, step?, data?}` (`index` is the op's
  position in `commands`; `step` and `data` as the engine sent them).
- `risk`: the command file's `batchRisk` (`low`, `normal`, `high`; default
  `normal`), repeated in every batch.
- `commandFile`: the command file, absolute.
- `bundle`: the session bundle the run created or opened, absolute; `null` only
  when the run failed before one was served and nothing was applied.
- `batches`: one per plan, in order.
  - `status`: `applied`, or `failed` for the plan the run stopped at.
  - `planHash`: the plan's `sha256:` hash (`siann.plan.v1`, [Plan v1](plan-v1.md)),
    equal to the Node hash of the plan the engine returned.
  - `baseRevision`: the plan's base, the head when it was submitted.
  - `appliedRevision`: the plan revision `plan.apply` committed; what a rollback
    names.
  - `touchedIds`: the engine-assigned stable IDs the plan touched (ADR-0011),
    the `diff` of the revision `plan.apply` returned (siann-protocol item 8,
    published like `command.execute`), kept as the engine sent it:
    `"<entityType>:<id>"` for every entity the revision added, removed or
    changed against its parent, sorted by entity type and id. A `track.add`
    also names `root:root`, whose `trackOrder` it changes. It covers the plan's
    revision only, not the run's `media.add` revisions (`media`). `null` on a
    batch that failed before `plan.apply` answered.
  - `preState`, `postState`: `session.inspect` before `plan.submit` and after
    `plan.apply`: `{revision, documentHash}`. `preState.documentHash` is the
    hash after the run's media imports, which commit outside the plan; it is the
    hash a rollback of this batch returns the document to, when nothing else
    changed since.
  - `entries`: the plan's steps in order, each with `command` (the step as
    submitted) and what the bridge knew of it (`name`; `path`, `regionName`).
- `media`: every `media.import` of the run: the file, the engine's `mediaId`,
  the revision of its `media.add` (the head for content the session already
  held, `existing: true`), `contentHash` and `frames`.

## Validation

`siann validate-journal <journal> [--json]` reads the file and checks it with
`validateJournal` (`src/bridge/runner.js`), the check `rollback` makes too. A
valid journal exits 0 and prints `{ok: true, journal: {path, journalId,
status, risk, entryCount, bundle, planHash, appliedRevision}}` (`planHash` and
`appliedRevision` of the last applied batch). A file it refuses exits 1 and
prints `{ok: false, status: "failed", error: {code, message}}` on stdout with
`--json`; without it the text form ends with `error: <code>: <message>`. No
journal file is a usage error (exit 1, usage on stderr). The codes:

| Code | When |
|---|---|
| `journal_unreadable` | the file does not exist or cannot be read |
| `journal_not_json` | the file is not JSON |
| `journal_v0_unsupported` | `schemaVersion` is `siann.command_journal.v0`, the Ardour engine's journal |
| `invalid_schema_version` | any other `schemaVersion` than `siann.command_journal.v1` |
| `invalid_journal_id` | `journalId` is missing or not a non-empty string |
| `invalid_batches` | `batches` is not an array |
| `invalid_bundle` | `bundle` is not a non-empty string while a batch is applied, or neither a string nor `null` |
| `invalid_batch_status` | a batch's `status` is not `applied`, `failed` or `rolled_back` |
| `invalid_batch_risk` | a batch's `risk` is not `low`, `normal` or `high` |
| `invalid_batch_entries` | a batch's `entries` is not an array |
| `invalid_plan_hash` | a batch's `planHash` is present and not `sha256:` and 64 hex digits |
| `invalid_touched_ids` | a batch's `touchedIds` is present and not an array of `"<entityType>:<id>"` refs |
| `invalid_document_hash` | a `preState` or `postState` `documentHash` is present and not a `sha256:` hash |

## Rollback

`siann rollback <journal> [--run]` writes a command file that opens `bundle`
and rolls back every applied batch's `appliedRevision`, newest first
(`rollback_plan`, that is `plan.rollback {revision}`), then observes the
session. It runs in a new engine process, where the plan store is empty, which
is why it names the revision and not the plan hash (siann-protocol item 14).
Only the document changes: the imported media, its peaks and the renders stay
in the bundle. A batch whose entities changed since is `rollback_conflict` with
the entities, and nothing is rolled back.
