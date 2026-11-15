# SIANN Command Journal v0

Date: 2026-07-06

Status: Historical. Superseded by [Command journal v1](command-journal-v1.md)
(m5b-bridge-native-client): the Ardour engine it describes is gone, and the
bridge refuses a v0 journal.

## Purpose

`siann.command_journal.v0` records how a command batch changed an engine session. It is the audit and rollback contract between the command bridge, agent runtime, and future UI.

The journal is not an agent plan. It is emitted by the bridge after validation and execution, using observed engine state and engine-assigned IDs.

## Envelope

```json
{
  "schemaVersion": "siann.command_journal.v0",
  "journalId": "jrnl_20260706_0001",
  "session": {
    "sessionId": "sess_01",
    "name": "CommandSession",
    "sampleRate": 48000
  },
  "createdAt": "2026-07-06T09:45:00Z",
  "bridge": {
    "name": "ardour-session-utils",
    "version": "spike",
    "engineVersion": "9.7.113"
  },
  "batches": []
}
```

Required top-level fields:

- `schemaVersion`: must be `siann.command_journal.v0`.
- `journalId`: stable ID for this journal file.
- `session`: session identity known to the bridge.
- `createdAt`: UTC timestamp.
- `bridge`: command bridge implementation identity.
- `batches`: ordered command batches.

## Session Utility Output Path

During the C++ session utility spike, command files may include a root `journalPath` field:

```json
{
  "schemaVersion": "siann.command.v0",
  "journalPath": "/tmp/siann-command/journal.json",
  "batchRisk": "normal",
  "riskApproval": {
    "confirmed": false
  },
  "snapshotRetention": {
    "maxCount": 20
  },
  "commands": []
}
```

When `journalPath` is present, `ardour9-siann_command` writes a journal after the command batch succeeds. If it is absent, the runner preserves the original result-only behavior.

The current spike writes a gzip-compressed tar archive before the first mutation after `create_session` or `open_session`. Snapshot files are stored next to the journal under `snapshots/` and are named from the journal basename, for example `journal-42_batch_0001_before.tar.gz`.

`snapshotRetention.maxCount` is optional. When present and greater than zero, the runner keeps only the newest matching snapshot archives in the snapshot directory. Omit it, or set `0`, to disable pruning.

`batchRisk` is optional and defaults to `normal`. Supported values are `low`, `normal`, and `high`. High-risk batches must include `riskApproval.confirmed: true`; otherwise the bridge rejects the batch before executing commands.

## Snapshot Restore Command

The C++ session utility spike supports restoring the batch snapshot with:

```json
{
  "op": "restore_batch_snapshot",
  "sessionDir": "/tmp/siann-command/Session",
  "sessionName": "Session",
  "snapshotPath": "/tmp/siann-command/snapshots/journal-42_batch_0001_before.tar.gz"
}
```

The restore command unloads any active session, replaces `sessionDir` from the snapshot archive, and returns without opening the restored session. Follow it with `open_session` and `observe_session` when verification is needed.

## Batch Record

A batch is the smallest user-visible rollback unit.

```json
{
  "batchId": "batch_0001",
  "reason": "import-pack-arrange",
  "risk": "normal",
  "startedAt": "2026-07-06T09:45:01Z",
  "completedAt": "2026-07-06T09:45:04Z",
  "status": "applied",
  "preState": {
    "observationHash": "sha256:...",
    "snapshot": {
      "kind": "session_archive",
      "path": ".siann/snapshots/journal-42_batch_0001_before.tar.gz",
      "sha256": "..."
    }
  },
  "postState": {
    "observationHash": "sha256:..."
  },
  "entries": []
}
```

`status` values:

- `applied`: all commands completed and the post-state was recorded.
- `failed`: execution stopped; rollback may be required.
- `rolled_back`: the batch was restored to its pre-state.

`risk` values:

- `low`: observation-only or reversible metadata changes.
- `normal`: ordinary import, placement, track creation, or render operations.
- `high`: destructive edits, plugin changes, routing changes, or anything with uncertain inverse semantics.

The emitted batch `risk` value is copied from the validated command-file `batchRisk`.

## Entry Record

Each entry records one validated command.

```json
{
  "entryId": "entry_0001",
  "op": "place_audio",
  "commandSchemaVersion": "siann.command.v0",
  "command": {
    "op": "place_audio",
    "regionId": "220",
    "trackId": "74",
    "start": "00:03.000"
  },
  "status": "applied",
  "startedAt": "2026-07-06T09:45:02Z",
  "completedAt": "2026-07-06T09:45:02Z",
  "touched": {
    "tracks": ["74"],
    "playlists": ["137", "207"],
    "regions": ["220"],
    "sources": ["142"]
  },
  "preState": {
    "observationHash": "sha256:..."
  },
  "postState": {
    "observationHash": "sha256:..."
  },
  "rollback": {
    "kind": "restore_batch_snapshot",
    "batchId": "batch_0001"
  }
}
```

The bridge must populate `touched` from observed engine IDs, not from agent-supplied names. Empty arrays are allowed; missing ID categories are omitted.

`error` is present only when the entry status is `failed`. Failed batches still include applied entries before the failure and the failed entry that stopped execution.

```json
{
  "entryId": "entry_0003",
  "op": "not_a_real_operation",
  "commandSchemaVersion": "siann.command.v0",
  "command": {
    "op": "not_a_real_operation"
  },
  "status": "failed",
  "touched": {},
  "preState": {
    "observationHash": "sha256:..."
  },
  "postState": {
    "observationHash": "sha256:..."
  },
  "rollback": {
    "kind": "restore_batch_snapshot",
    "batchId": "batch_0001"
  },
  "error": {
    "message": "unsupported operation: not_a_real_operation"
  }
}
```

## Rollback Actions

Initial supported rollback action:

- `restore_batch_snapshot`: restore the session archive captured before the batch.

Future rollback actions:

- `remove_created_region`: delete a region created by the command.
- `move_region`: restore a region to a previous playlist and position.
- `delete_created_track`: remove a track created by the command.
- `restore_property`: restore a scalar property such as gain, mute, or lock state.

Fine-grained rollback actions must be generated by the bridge from pre/post observations. Agents may request rollback, but must not author inverse commands directly.

## Observation Hashing

Observation hashes must be computed from canonical observation JSON:

- UTF-8 encoded.
- Object keys sorted recursively.
- No absolute temporary paths.
- No volatile timestamps.
- Deterministic source identifiers such as `fileName` are allowed when stable IDs are unavailable.

Hash format is `sha256:<hex>`.

## Verification Artifacts

Entries or batches may include `artifacts`:

```json
{
  "artifacts": [
    {
      "kind": "render",
      "path": "renders/batch_0001.wav",
      "sha256": "0b4f64cbfd80f16247972f4bf3f5960635dc653d88054550ba3b47f0847ed4ae"
    },
    {
      "kind": "observation",
      "path": "observations/batch_0001_after.json",
      "sha256": "..."
    }
  ]
}
```

Artifacts are optional for fast commands and required for replay fixtures.

## Rejection Rules

The bridge must reject journaled mutation when:

- The command references ambiguous names instead of stable IDs.
- The command precondition token does not match the current observation hash.
- A required pre-batch snapshot cannot be created.
- A command succeeds but the post-state observation cannot be recorded.
- Rollback metadata cannot be derived for the batch risk level.
