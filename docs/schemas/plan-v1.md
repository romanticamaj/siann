# Plan v1

`siann.plan.v1` is the engine-side plan: a list of commands reviewed against one
base revision, with the entities it reads and writes and their hashes at that
revision. The rules are in the architecture spec, sections "Plans" and
"Canonical JSON and hashes"; this page is the short reference.

## Shape

```json
{
  "schema": "siann.plan.v1",
  "baseRevision": "r3",
  "steps": [
    {"op": "track.add", "trackId": "trk_4", "name": "Bass", "channels": 2},
    {"op": "track.set_gain", "trackId": "trk_1", "gainMilliDb": -600}
  ],
  "readSet": [
    {"type": "track", "id": "trk_2", "hash": "sha256:..."}
  ],
  "writeSet": [
    {"type": "root", "id": "root", "hash": "sha256:..."},
    {"type": "track", "id": "trk_1", "hash": "sha256:..."},
    {"type": "track", "id": "trk_4", "hash": null}
  ],
  "parentPlan": "sha256:...",
  "hash": "sha256:...",
  "state": "validated",
  "approvedBy": "user",
  "approvedAt": "2026-11-04T12:00:00Z",
  "rejectedBy": "user",
  "rejectedAt": "2026-11-04T12:00:00Z",
  "rejectionNote": "partially approved as sha256:...",
  "appliedRevision": "r7",
  "title": "Lower the drums",
  "intent": "The drums mask the vocal; lower them by 6 dB.",
  "actor": {"kind": "mcp", "name": "mix-assistant"}
}
```

- `steps` are command objects exactly as `prepare` accepts them. 64-bit values are
  decimal strings.
- `readSet` and `writeSet` entries are sorted by `(type, id)` as byte strings,
  without duplicates. `hash` is `null` when the entity does not exist at
  `baseRevision`.
- The engine computes `writeSet` (declared effects of the steps at
  `baseRevision`) and resolves `readSet` hashes; the submitter only names the
  entities it read.
- `parentPlan` is set on sub-plans made by partial approval.
- `state` is one of `draft`, `validated`, `approved`, `rejected`, `applied`,
  `rolled_back`.
- `title`, `intent` and `actor` are the plan's metadata (below).

## Metadata (m5b-engine-plan-metadata)

Optional fields beside the lifecycle fields, outside the hash (UI redesign E-7;
the architecture spec, "Plans", decisions of 2026-11-15):

| Field | Shape | Limit (checked by `plan.submit`) |
|---|---|---|
| `title` | string | 1 to 200 UTF-8 bytes, one line: no control character (U+0000 to U+001F, U+007F to U+009F) and no display-unsafe character (below) |
| `intent` | string | 1 to 2,000 UTF-8 bytes; tab, LF and CR are the only control characters allowed; no display-unsafe character (below) |
| `actor` | `{kind: "mcp" \| "ui", name}` | set by the server, never by the request |

- Display-unsafe characters, refused in both `title` and `intent` so that a plan
  cannot be shown in the review as text other than what it says: the bidi
  formatting characters U+061C (ALM), U+200E (LRM), U+200F (RLM), U+202A to
  U+202E (LRE, RLE, PDF, LRO, RLO) and U+2066 to U+2069 (LRI, RLI, FSI, PDI), and
  the line and paragraph separators U+2028 and U+2029. The intent refuses the
  separators too rather than reading them as newlines: LF (with CR) is the one
  line break, and renderers disagree on whether U+2028 and U+2029 break a line.
  The text is decoded as UTF-8 and checked by code point; text that is not
  well-formed UTF-8 (a stray continuation byte, a truncated or overlong
  sequence, a surrogate, anything past U+10FFFF) is refused as well. CJK,
  right-to-left letters, emoji and the zero-width joiner of emoji sequences are
  allowed. The UI also renders a plan's text with `dir="auto"` and
  `unicode-bidi: isolate`.
- The limits are counted in bytes, not characters: a title of 67 characters of
  three bytes each (201 bytes) is refused. A refused title or intent is
  `invalid_plan_metadata` (also a non-string or empty one) and nothing is stored.
- `actor.kind` is the credential's: `mcp` for the MCP token, `ui` for the UI
  token. `actor.name` is the MCP client's `initialize` `clientInfo.name`
  (`protocol-mcp-v0.md`) or the UI's auth frame `client.name`
  (`protocol-events-v1.md`, "Handshake additions"), sanitised: control characters
  and the display-unsafe characters above removed (bytes that are not well-formed
  UTF-8 too), leading and trailing spaces trimmed, cut to 64 UTF-8 bytes at a
  character boundary. An absent, non-string or then empty name is `"MCP client"`
  for MCP and `"SIANN"` for the UI.
- `plan.submit` takes `title?` and `intent?`; any other param besides `steps`,
  `readSet` and `baseRevision` (an `actor`, a `kind`, a `name`) is
  `invalid_params`.
- Fixed at submission: an identical resubmission (same hash) returns the stored
  plan unchanged, whatever title, intent or actor it carries. Partial approval
  copies the parent's `title`, `intent` and `actor` onto the sub-plan. Approval,
  the staleness check, apply, rollback and propose never read them.
- `Plan::fromJson` and `checkPlan` (Node) check the shape only: strings for
  `title` and `intent`, exactly `{kind, name}` with a known kind and a string name
  for `actor` (`invalid_plan` otherwise).

## Hash

`planHash = sha256(JCS(plan))` without `hash`, `state`, `approvedBy`, `approvedAt`,
`rejectedBy`, `rejectedAt`, `rejectionNote`, `appliedRevision`, `title`, `intent`
and `actor`, so a plan with and without a title, by whoever, has one hash. Node
(`src/hash/plan-hash.js`) and C++ (`siann::command::planHash`) pass the shared
fixtures in `fixtures/plan/plan-hash.json`, generated by
`scripts/generate-plan-fixtures.js`.

Error codes: `plan_not_canonicalizable` (NaN, infinities, lone surrogates and
other values JCS rejects), `invalid_entity_set` (malformed, unsorted or duplicate
set entries), `invalid_plan` (anything else malformed, including unknown fields).

## Lifecycle errors

`plan_stale` (with `changedEntities`: `"<type>:<id>"` and `added`, `removed` or
`modified`), `invalid_state`, `not_found`, `invalid_params`, and at submission
`invalid_plan_metadata`. Plans live in engine
memory in M3 and are not stored in the session bundle.

A plan applied by an earlier engine process is rolled back by its revision:
`plan.rollback {revision}` (siann-protocol item 14; m5b-bridge-native-client)
instead of `{plan}`, exactly one of the two (`invalid_params` otherwise). The
revision must be a `plan` or `branch-merge` revision on main's first-parent
chain (`not_found` otherwise, `not_a_plan` for any other cause), and it rolls
back through the history as `{plan}` does (`rollback_conflict` unchanged). When
the store holds a plan applied at that revision, that plan becomes `rolled_back`
and `plan.changed` is published. The Node bridge's `siann rollback` uses it with
the `appliedRevision` its journal recorded ([Command journal v1](command-journal-v1.md)).

## Protocol methods (m5-plan-review)

The plan methods of Protocol v0 item 14 (`plan.submit`, `plan.status`,
`plan.approve`, `plan.reject`, `plan.apply`, `plan.rollback`, `plan.propose`) are
joined by two read-only methods for the plan review UI (spec, Protocol v0 item 25).
Both run on the command thread, honour `expectedRevision`, are listed in
`engine.capabilities` `methods` and are not MCP tools in v0.

### `plan.list`

```json
{"method": "plan.list", "params": {}}
-> {"plans": [{"schema": "siann.plan.v1", "hash": "sha256:...", "state": "validated",
               "baseRevision": "r2", "steps": [...], "readSet": [...], "writeSet": [...],
               "stale": [], "proposalBranch": "p1"}]}
```

Every plan of the session in submission order (the order the plan store first
stored them; a partial approval's sub-plan comes after the plans before it). Each
entry is what `plan.status` returns for that plan: the plan with its lifecycle
fields, `stale` (`[{ref, change}]`, empty when fresh) and `proposalBranch` while
the plan is proposed.

### `plan.preview`

```json
{"method": "plan.preview", "params": {"plan": "sha256:..."}}
-> {"revision": "r3", "documentHash": "sha256:...", "stale": [],
    "entities": [{"ref": "root:root", "before": {...}, "after": {...}},
                 {"ref": "track:trk_1", "before": {"gainMilliDb": 0, ...}, "after": {"gainMilliDb": -600, ...}},
                 {"ref": "track:trk_n", "before": null, "after": {...}}]}
```

What `plan.apply` would produce now: `prepareTransaction(steps)` at main's head
document, never committed. `revision` and `documentHash` name the head. `entities`
is the union of the writeSet refs and the refs whose entity differs between the
head and the prepared document, sorted by `(type, id)` as byte strings; `before` is
the entity JSON at the head and `after` in the prepared document, `null` where the
entity is absent. A writeSet entity the steps leave unchanged appears with equal
`before` and `after`. A step that fails at the head answers that step's error
(`not_found`, `invalid_gain`, ...) with `step`, as `command.execute` does; the
plan's state never changes. Any state previews, always against the head: an
applied plan's effects are already there, so one that added an entity answers
`already_exists` (the renderer shows "applied at `appliedRevision`" for applied
and rolled-back plans instead of previewing them). Errors: `not_found` (no such
plan), `invalid_params` (no `plan`).

A step that sets a fade (m5b-engine-clip-fades) previews the clip without the
fade fields before and with them after; a side set to length `"0"` disappears
from `after`:

```json
{"op": "clip.set_fade", "clipId": "clp_1", "fadeIn": {"length": "480", "curve": "linear"}}
-> {"ref": "clip:clp_1", "before": {"length": "48000", "gainMilliDb": 0, ...},
    "after": {"length": "48000", "gainMilliDb": 0, "fadeIn": {"length": "480", "curve": "linear"}, ...}}
```

A `track.set_notes` step (m5b-engine-track-notes) previews the track without
`notes` before and with them after; `notes: ""` removes the field from `after`.

### Events

`plan.changed` and `audition.changed` (`protocol-events-v1.md`) tell a client when
to re-read a plan and which side is heard. Since m5b-engine-plan-metadata
`plan.changed` also carries the plan's `title`, `intent`, `actor` and
`rejectionNote`, and `plan.status` and `plan.list` return them as part of the
plan.
