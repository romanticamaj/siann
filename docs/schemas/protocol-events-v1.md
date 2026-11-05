# SIANN Protocol Events v1

Date: 2026-11-04

Status: Implemented in `native/libs/protocol` (m3-events-sync)

## Purpose

Protocol v0 (architecture spec, "siann-protocol") defines the request envelope,
the token handshake and the stable error codes. This document adds what a client
needs to keep a live read model of the session: the event stream with sequence
numbers, gap detection with `session.sync`, on-demand `session.fetch`, the binary
meter channel, and the build's source location (AGPL section 13, ADR-0017).

All JSON is the in-house strict JSON, serialized as RFC 8785 (JCS) canonical
text. 64-bit integers (`seq`, epochs, sample positions) are decimal strings, like
the journal's `seq`, because JSON numbers lose precision above 2^53.

## Handshake additions

The first text frame on the command socket is still `{type: "auth", token}`. Two
additions:

- `events: true` in the auth frame subscribes the connection to the event stream.
  Without it the connection gets responses only, exactly as in v0.
- The reply carries the stream position and the build:

```json
{
  "type": "auth", "ok": true,
  "sessionId": "ses_...", "revision": "r12", "documentHash": "sha256:...",
  "seq": "41",
  "meters": {"epoch": "3", "entities": ["master", "track:trk_1"]},
  "about": {
    "name": "siann-engine", "version": "0.1.0",
    "source": {"url": "https://github.com/romanticamaj/siann", "commit": "<40 hex>", "dirty": false},
    "license": "GPL-2.0-or-later"
  }
}
```

`seq` is the sequence number of the last event published before the connection
subscribed; every event this connection receives has a larger `seq`. A client
that reconnects with a `lastSeq` smaller than `seq` missed events and syncs.

`meters` is the newest `meters.legend` payload published at or before `seq`
(`null` before the engine published a graph with meters). It is in every auth
reply, with or without `events: true`, because a client that opens the realtime
channel needs it to decode frames; a newer legend arrives as a `meters.legend`
event with a larger `seq`.

## Event envelope

```json
{"schema": "siann.event.v1", "seq": "42", "sessionId": "ses_...", "revision": "r13", "type": "session.changed", ...payload}
```

- `seq`: one counter per session and server process, shared by every event type,
  starting at `"1"`, increasing by one per published event. It is not the journal
  `seq`.
- `revision`: the head revision id when the event was published.
- Payload fields sit next to the envelope fields and never reuse their names.

### Delivery and gaps

Events go to each subscribed connection through a bounded outbox
(`events.outboxCapacity`, default 1024). The outbox is flushed into the socket
while the socket's buffered amount is at most `events.highWaterBytes` (default
1 MiB). A full outbox drops the new event for that connection and counts it; the
server never blocks and keeps no replay buffer. The client sees the hole as a
`seq` gap:

1. Track `lastSeq`. Ignore events with `seq <= lastSeq`.
2. An event with `seq > lastSeq + 1` is a gap: call `session.sync` (all chunks),
   replace the read model, set `lastSeq` to the sync's `seq`, and continue with
   the next event.

### `session.changed`

Published after every commit, undo and redo, once the revision is durable and
published (never from the journal's pre-publish hook).

```json
{
  "type": "session.changed", "revision": "r13",
  "parents": ["r12"], "cause": "command", "actor": "protocol", "time": "2026-11-04T00:00:00Z",
  "documentHash": "sha256:...",
  "changedIds": [{"ref": "track:trk_1", "change": "added"}, {"ref": "root:root", "change": "modified"}]
}
```

`changedIds` is the revision's diff against its parent, sorted by entity type and
id; `change` is `added`, `removed` or `modified`. A client fetches the added and
modified entities with `session.fetch` at the event's `revision` (so later commits
do not leak into the step) and drops the removed ones. When that revision is no
longer kept (`revision_unavailable`), the client syncs instead.

### `meters.legend`

Published when the engine publishes a graph with meters:

```json
{"type": "meters.legend", "epoch": "3", "entities": ["master", "track:trk_1"]}
```

`entities[i]` is the entity behind `entityIndex == i` in meter frames of that
`epoch`. The engine keeps the newest legend as part of the stream position, so a
client never depends on having been connected when it was published: the auth
reply and `session.sync` carry it as `meters`. A client keeps the legend of the
auth reply, replaces it with each `meters.legend` event and with the `meters` of
a sync. Frames of an epoch whose legend the client does not hold are ignored
(between a graph publication and the event, the publisher may already send
frames of the new epoch).

### `proposal.changed` (m3-mcp)

Published after a commit onto a proposal branch through the protocol
(`plan.propose`), once the revision is durable:

```json
{"type": "proposal.changed", "branch": "p1", "revision": "r7", "changedIds": [{"ref": "track:trk_2", "change": "added"}]}
```

Here the payload's `revision` is the branch revision; it replaces the envelope's
head revision, because main's head did not move. `changedIds` is the branch
revision's diff against its parent, as in `session.changed`.

### `proposal.closed` (m3-mcp)

Published when a branch is merged (`merged: true`, `revision` the branch-merge
revision on main, preceded by its `session.changed`) or discarded (`merged: false`,
no `revision`):

```json
{"type": "proposal.closed", "branch": "p1", "merged": true, "revision": "r8"}
```

### `session.opened` (m3-mcp)

Published when `session.open` switched the server to another bundle:

```json
{"type": "session.opened", "sessionId": "ses_...", "revision": "r3", "documentHash": "sha256:..."}
```

The envelope already carries the new `sessionId`; `seq` keeps counting across the
switch, so a subscriber sees no gap. Every later request names the new
`sessionId` (the old one is `session_mismatch`), and the client replaces its read
model with a `session.sync` of the new session.

## Methods

### `session.sync`

Params `{cursor?: string}`. Without a cursor the server pins the head document
and revision for this connection and answers the first chunk; with the `next`
cursor of the previous chunk it answers the following chunk from the pinned
document, so every chunk of one sync reports the same revision even when commits
happen in between.

```json
{
  "revision": "r13", "seq": "42", "documentHash": "sha256:...", "entities": 32,
  "meters": {"epoch": "3", "entities": ["master", "track:trk_1"]},
  "chunk": {"root": {...}, "media": [...], "tracks": [...], "clips": [...]},
  "next": "sync_1:4"
}
```

- Entities are listed root, media, tracks, clips, each table in id order, which is
  the order of `Document::toJson()`. A chunk holds at most `syncChunkEntities`
  entities (server option, default 500); `entities` is the total.
- Entity JSON is the hashed form, so a client recomputes entity and document
  hashes from the chunks. Concatenating the chunks gives
  `{schemaVersion: "siann.session_document.v1", root, media, tracks, clips}`.
- `next` is `null` on the last chunk. A cursor that does not belong to the
  connection's current sync (stale, forged, or after a newer sync started) is
  `sync_cursor_invalid`; a cursor that is not a string is `invalid_params`.
- `seq` is the last published event's `seq` at the time the sync was pinned, and
  `meters` the meter legend at that `seq` (as in the auth reply), so a sync after a
  gap also restores a `meters.legend` event the gap swallowed.

### `session.fetch`

Params `{refs: ["<type>:<id>", ...], revision?: "rN"}` (`refs` non-empty; `type`
is `root`, `media`, `track` or `clip`; the root is `root:root`). Result at
`revision`, or at the head without it:

```json
{"revision": "r13", "documentHash": "sha256:...",
 "entities": [{"ref": "track:trk_1", "entity": {...}}, {"ref": "clip:clp_9", "missing": true}]}
```

A ref that is not of that form, or a `revision` that is not a string, is
`invalid_params`. A revision the history does not hold is `revision_unavailable`
(M1 keeps every revision; later history pruning may not).

### `session.undo`, `session.redo`

Params `{}`. Result `{revision: {...}}` as for `command.execute`. Both publish
`session.changed`. Errors `nothing_to_undo` and `nothing_to_redo` pass through.

### `engine.about`

Params `{}`. Result: the `about` object of the handshake reply.

## Build and source (ADR-0017, point 4)

`native/cmake/SiannBuildInfo.cmake` writes a header at build time (not configure
time) from `git rev-parse HEAD` and `git status --porcelain` of the source tree;
the header is rewritten only when its content changes. Cache variables override
it for builds from a tarball: `SIANN_SOURCE_COMMIT` (40 hex characters) and
`SIANN_SOURCE_URL` (default `https://github.com/romanticamaj/siann`). Without git
and without an override the commit is 40 zeros. `license` is `AGPL-3.0-or-later`
when the build includes JUCE (`SIANN_WITH_JUCE`) and `GPL-2.0-or-later` otherwise.

## Realtime channel

Meters and the playhead travel on a separate WebSocket, path `/v1/realtime`, so
they have their own send buffer and never queue behind commands or events.

- The client authenticates with the same first text frame `{type: "auth", token}`.
  There is no text reply: on success, binary frames start to arrive. A wrong token,
  a frame before authentication that is not an auth frame, or any text frame after
  it closes the socket with 1008. The server sends only binary frames on this
  socket and never sends binary frames on the command socket.
- The engine's publisher ticks at a fixed rate and sends one frame per tick with
  the newest reading of every metered entity (latest wins; nothing is queued).
  When the socket's buffered amount is above `realtime.congestionBytes` (default
  64 KiB), the frame is dropped for that connection and counted; the next tick
  sends newer values, never an old frame.

### Frame layout (little-endian)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"SMTR"` |
| 4 | 1 | u8 version, `1` |
| 5 | 8 | u64 epoch (the graph's, see `meters.legend`) |
| 13 | 8 | i64 engineTimestampMicros (engine steady clock; the UI interpolates) |
| 21 | 8 | i64 playheadSamples (timeline position of the newest meter block) |
| 29 | 1 | u8 playing (0 or 1) |
| 30 | 2 | u16 entryCount |
| 32 | ... | entries |

Each entry: u16 entityIndex, u8 channels (the engine meters at most 2 today), then `channels` f32 peak
values, then `channels` f32 RMS values (linear gain). An entry is
`3 + 8 * channels` bytes. A frame whose length differs from the sum is malformed.
`fixtures/protocol/meter-frames.json` holds byte-exact frames generated from this
table by `scripts/generate-protocol-fixtures.js`, independent of the C++ encoder.
