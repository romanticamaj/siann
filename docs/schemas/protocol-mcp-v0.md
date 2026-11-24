# SIANN Protocol MCP v0

Status: implemented with m3-mcp (native `siann-protocol`, `McpAdapter`).

## Purpose

Agents reach the engine through the Model Context Protocol on the same server
as the UI's WebSocket protocol (architecture spec, "siann-protocol", Protocol v0
items 14 to 16). Every MCP tool is a one-to-one wrapper of a protocol method:
same params, same result, same error codes. There is no second API.

## Transport (Streamable HTTP, JSON responses only)

- `POST /v0/mcp` on the protocol server, `Authorization: Bearer <mcp token>`
  (`ProtocolServer::mcpToken()`: per launch, 32 random bytes as lowercase hex,
  never equal to the UI token). The MCP token carries the MCP scope and opens
  nothing else: in a WebSocket or realtime auth frame it is `invalid_token`, on
  plain HTTP it is `401`. The UI token (`ProtocolServer::token()`) on `/v0/mcp`
  is `401`. The launcher hands agents the MCP token only. Without it: `401` with the HTTP error body
  `{ok: false, error: {code: "unauthenticated", message}}`. A request with an
  `Origin` header not in the allow list: `403 origin_not_allowed`.
- The body is one JSON-RPC 2.0 request or notification (no batches).
- A request gets `200`, `Content-Type: application/json`, exactly one JSON-RPC
  response. No SSE stream in v0; `GET /v0/mcp` (any method but `POST` and
  `DELETE`) is `405`.
- A notification (no `id`) gets `202` with an empty body.
- `initialize` assigns a session: the response carries the header
  `Mcp-Session-Id: mcp_<32 hex>`. Every later request must send it: missing is
  `400`, unknown is `404` (the client initializes again). Both carry a JSON-RPC
  error body with `id: null`.
- `DELETE /v0/mcp` with the session header (m5b-engine-plan-metadata) ends the
  session: `204` with an empty body, after which the header is unknown (`404`).
  Without the header it is `400`, with an unknown one `404`; the bearer token and
  the Origin are checked as for `POST`.

### Agents (m5b-engine-plan-metadata)

Every session is an agent (spec, Protocol v0 item 29): `engine.status` lists it
in `agents` and `agent.changed` announces it ([Protocol events v1](protocol-events-v1.md)).

- `initialize` reads `params.clientInfo.name` as the agent's name, sanitised:
  control and display-unsafe characters ([Plan v1](plan-v1.md), "Metadata")
  removed, leading and trailing spaces trimmed, cut to 64
  UTF-8 bytes at a character boundary. Without `clientInfo`, or with a name that
  is not a string or is empty after that, the name is `"MCP client"`. The name is
  the `actor` of every plan the session submits: `{kind: "mcp", name}`
  ([Plan v1](plan-v1.md), "Metadata").
- The agent is connected from `initialize` until `DELETE /v0/mcp` or until no
  request with its session header has arrived for `ServerOptions::agentIdleMs`
  (default 300,000 ms, `engine.capabilities` `limits.agentIdleMs`). Any request
  counts, `ping` and notifications included; after an idle spell the next one
  connects it again (the session was not ended). An idle agent is not ended.
- After every tool call the engine executed, the agent's `lastAction` is the
  tool's name and `lastActionAt` the server's time. Its arguments are never
  recorded.
- At most `limits.agentsRetained` (32) agents are kept. A new `initialize` past
  that forgets the oldest disconnected agent, or, when every one is connected,
  the oldest agent, whose session ends (`404` afterwards).

### Methods

| Method | Result |
|---|---|
| `initialize` | `{protocolVersion: "2025-06-18", capabilities: {tools: {}}, serverInfo: {name, version}}` (`name`, `version` from BuildInfo) |
| `notifications/initialized` | `202`, empty |
| `ping` | `{}` |
| `tools/list` | `{tools: [{name, description, inputSchema}]}` in the table order below |
| `tools/call` | `{name, arguments}`, see below |

JSON-RPC errors: malformed JSON `-32700`, a bad envelope (not an object,
`jsonrpc` not `"2.0"`, bad `id`, non-object `params`) `-32600`, unknown method
`-32601`, unknown tool or non-object `arguments` `-32602`, a command-thread
answer later than `mcpRequestTimeout` (default 30 s) `-32000` with
`data: {code: "request_timeout"}`, a full inbox `-32000` with
`data: {code: "queue_full"}`. A full inbox queued nothing. A timed-out call may
still run on the command thread; its answer is cached, so a retry with the same
`id` returns it instead of running the call again.

### Tool calls

A tool call becomes the protocol request

```json
{"requestId": "<Mcp-Session-Id>/<jsonrpc id as canonical JSON>", "sessionId": "<the server's current sessionId>",
 "method": "<the tool's method>", "params": <arguments>}
```

so a retry with the same JSON-RPC `id` returns the original answer from the
server's idempotency cache (byte-identical response), and ids of two MCP
sessions never collide. A string id `"7"` and a number id `7` are different
requests.

Success:

```json
{"jsonrpc": "2.0", "id": 7, "result": {"content": [{"type": "text", "text": "<result as canonical JSON>"}],
 "structuredContent": <result>, "isError": false}}
```

A protocol error (the method ran and failed, or the scope denied it):

```json
{"jsonrpc": "2.0", "id": 7, "result": {"content": [{"type": "text", "text": "<error as canonical JSON>"}],
 "structuredContent": {"error": {"code": "plan_stale", "message": "...", "data": {"plan": "sha256:...",
 "changedEntities": [{"ref": "track:t1", "change": "modified"}]}}}, "isError": true}}
```

The error object is the protocol's `{code, message, step?, data?}`.

## Scopes

`ServerOptions::mcpScope` is `propose` (default) or `trusted`, set by the engine
host that launches the server (the `siann-engine` executable,
native/apps/engine, m0-electron-shell, takes `--mcp-trusted`). A tool whose scope is `trusted` called under
`propose` answers `isError` with code `scope_denied`, executes nothing and is not
cached (retry with the same id after the grant). The server checks the scope on
the command thread against the credential the request came with, not in the
adapter.

A tool call queued before a `session.open` that ran first in the same pump
answers `isError` with `session_mismatch`. It is not cached: a retry with the
same JSON-RPC `id` runs against the session served now.

| Tool | Method | Scope | Arguments |
|---|---|---|---|
| `list_commands` | `command.list` | propose | `{}` |
| `describe_capabilities` | `engine.capabilities` | propose | `{}` |
| `inspect_session` | `session.inspect` | propose | `{}` |
| `submit_plan` | `plan.submit` | propose | `{steps: [command], readSet?: ["<type>:<id>"], baseRevision?, title?, intent?, request?}` |
| `plan_status` | `plan.status` | propose | `{plan: "sha256:..."}` |
| `approve_plan` | `plan.approve` | trusted | `{plan, steps?: [index]}` |
| `reject_plan` | `plan.reject` | propose | `{plan, note?}` |
| `apply_plan` | `plan.apply` | trusted | `{plan}` |
| `rollback_plan` | `plan.rollback` | trusted | `{plan}` or `{revision}` (exactly one; a revision for a plan an earlier engine process applied) |
| `propose_plan` | `plan.propose` | propose | `{plan}` |
| `audition` | `audition.hear` | propose | `{side: "main" \| "<branch>"}` |
| `merge_proposal` | `proposal.merge` | trusted | `{branch}` |
| `discard_proposal` | `proposal.discard` | propose | `{branch}` |
| `execute` | `command.execute` | trusted | `{commands: [command]}` |
| `job_status` | `job.status` | propose | `{jobId}` |
| `render` | `render.start` | propose | `{name, start?, frames?}` |
| `open_session` | `session.open` | trusted | `{path}` |
| `save_session` | `session.save` | propose | `{}` |
| `play` | `transport.play` | propose | `{}` |
| `stop` | `transport.stop` | propose | `{}` |
| `locate` | `transport.locate` | propose | `{frames: "<decimal>"}` |
| `set_cycle` | `transport.set_cycle` | propose | `{enabled}` |
| `set_click` | `transport.set_click` | propose | `{enabled, gainMilliDb?}` |
| `set_punch` | `transport.set_punch` | propose | `{in, out}` |
| `set_preroll` | `transport.set_preroll` | propose | `{enabled, bars?}` |
| `set_count_in` | `transport.set_count_in` | propose | `{enabled, bars?}` |
| `engine_status` | `engine.status` | propose | `{}` |
| `list_devices` | `engine.devices` | propose | `{}` |
| `select_device` | `engine.select_device` | trusted | `{id, inputId?}` |
| `record_arm` | `record.arm` | trusted | `{trackId, armed}` |
| `record` | `transport.record` | trusted | `{enabled}` |
| `create_session` | `session.create` | trusted | `{path, name?}` |
| `import_media` | `media.import` | trusted | `{path, clientImportId}` |
| `list_plans` | `plan.list` | propose | `{}` |
| `preview_plan` | `plan.preview` | propose | `{plan}` |
| `undo` | `session.undo` | trusted | `{}` |
| `redo` | `session.redo` | trusted | `{}` |
| `next_request` | `agent.next_request` | propose | `{waitMs?}` |
| `answer_request` | `agent.answer_request` | propose | `{request, plan}`, `{request, message}` or `{request, decline: true, message?}` |

`next_request` and `answer_request` (m5b-engine-agent-requests, spec Protocol v0
item 32, human gate `agent-request-shape`) are the agent's side of a request the
user sent it from the UI (`agent.request`, [Protocol engine v0](protocol-engine-v0.md),
"Agent requests"). A request executes nothing; the agent answers it with a plan
the user then reviews, with a message, or declines it, so both tools are propose.
The UI token calling `agent.next_request` or `agent.answer_request` is
`scope_denied`, and no tool wraps the user's side (`agent.request`,
`agent.cancel_request`, `agent.requests`): a `tools/call` naming one is the unknown
tool `-32602`, under either scope, and the server answers `scope_denied` should an
MCP credential's request reach one.

- `next_request` is a long poll. It answers `{request}` at once with the agent's
  oldest `pending` request, now `taken`. With none the command thread parks the
  call (it never blocks) and answers it when a request is queued for this agent,
  or with `{request: null}` once `min(waitMs, limits.agentRequestWaitMs)` has
  passed (`ServerOptions::agentRequestWaitMs`, default 25,000 ms, clamped to at
  most `mcpRequestTimeout` minus 1 s, so the call is answered before the
  transport's `request_timeout`). `waitMs` is a non-negative integer; `0` answers
  at once. A second call from the same agent answers the first one with `{request:
  null}`. While parked the agent stays connected (no idle expiry); `DELETE
  /v0/mcp` answers it with `{request: null}`. A retry with the same JSON-RPC `id`
  returns the same request (the idempotency cache); an empty answer is not cached
  and is not an action (no `lastAction`, no `agent.changed`).
- `answer_request` takes exactly one form (`invalid_params` otherwise): `plan`, the
  hash of a plan this agent submitted in the served session (another client's plan
  is `invalid_params`, an unknown one `not_found`), answers it with the plan;
  `message` answers it with text; `decline: true`, with an optional `message`,
  declines it. `message` is 1 to 4,000 characters (code points) without a control
  character other than tab, LF and CR and without a bidi formatting character or
  U+2028/U+2029 (`invalid_request_text`). A request that is closed, or addressed to
  another agent, is `request_not_open`; an unknown one `not_found`.
- `submit_plan {..., request}` links the plan to an open request addressed to this
  agent, which then counts as `answered` with the plan; the link is not part of the
  plan (the hash is the same without it, [Plan v1](plan-v1.md)). A closed request or
  another agent's is `request_not_open`, an unknown one `not_found`; nothing is
  stored then.

The eight from `play` to `select_device` (m5-engine-sessions-devices and m5-ui-engine-loop-click, Protocol v0
items 18, 22 and 26) wrap the transport and device methods of
[Protocol engine v0](protocol-engine-v0.md) with the same params, results and error
codes (`no_device` included). `select_device` is trusted because it changes the
device the served session plays on for every client. The locators are set with the
command `session.set_locators` through `execute` (trusted) or a plan, and the
master gain (m5b-engine-master) with the command `master.set_gain` the same way; no
tool is dedicated to either. Buses and sends (m5b-engine-buses-sends) likewise go
through `execute` or a plan with their commands, and `list_commands` returns
`command.list`'s `{commands, cascades}` unchanged. Markers (m5b-engine-markers)
are the same: `marker.add`, `marker.move`, `marker.rename` and `marker.remove`
run through `execute` (trusted) or a plan step (`submit_plan`, propose), and
`list_commands` lists them; no tool is dedicated to them.

`engine_status` carries `load {average, peak}` (m5b-engine-load-loudness, Protocol
v0 item 31) like the method it wraps. No tool wraps `meter.reset_loudness`, by
decision: it restarts the integrated value of the user's loudness meter, a display
aid, not session state, and nothing a plan needs; an agent reads loudness from a
render, not from the live meter. The adapter lists the method in `kNotMcp`
("Methods without a tool"), and a tool call naming it is refused like any unknown tool.

`record_arm` and `record` (m5b-engine-record, Protocol v0 item 28) wrap the
recording methods of [Protocol engine v0](protocol-engine-v0.md) in the trusted
scope: recording writes to the user's disk and commits a revision. No tool wraps
`record.recover_take`: accepting or trashing a take a crash left is the user's
decision about files on their disk, and the UI offers it from `pendingTakes`
(below). The propose scope's tools are unchanged, but `stop` and
`locate` end a running recording and commit it, and a propose agent cannot start
one, so while a recording runs both are `scope_denied` under `propose` and run
nothing. Stopped, they work as before; under `trusted` (and from the UI) they end
the recording as the UI's stop does.

`set_punch`, `set_preroll` and `set_count_in` (m5b-engine-punch-count-in, Protocol
v0 item 34) wrap `transport.set_punch`, `transport.set_preroll` and
`transport.set_count_in` one to one in the propose scope: they set engine state that
shapes the next recording and start nothing (a change during a recording affects
the next one), so a propose agent can prepare a punch-in that only `record`, which
stays trusted, starts. Each returns the transport result, with `punch`, `preroll`
and `countIn`.

`submit_plan`'s `title` (at most 200 UTF-8 bytes, one line) and `intent` (at
most 2,000 UTF-8 bytes) are the plan's metadata (m5b-engine-plan-metadata,
[Plan v1](plan-v1.md)); the input schema lists them with `maxLength` 200 and
2000, but the engine counts bytes and answers a longer or malformed value
`invalid_plan_metadata`. An `actor` in the arguments is `invalid_params`: the
engine records `{kind: "mcp", name}` from the session's `clientInfo.name`.

`create_session` and `import_media` (m5b-engine-project-media, Protocol v0 item 27)
wrap `session.create` and `media.import` of [Protocol engine v0](protocol-engine-v0.md).
Both read or write paths on the user's disk, so the propose scope never gets them;
the import's job is polled with `job_status`.

`list_plans`, `preview_plan`, `undo` and `redo` (m5b-protocol-parity) wrap
`plan.list`, `plan.preview` ([Protocol events v1](protocol-events-v1.md), Methods;
wire examples in [plan-v1.md](plan-v1.md)), `session.undo` and `session.redo` one
to one. The two plan reads are propose: they change nothing, and an agent
previewing its own plan sees the diff the reviewer will see. `undo` and `redo`
move main's head, so they are trusted; under `propose` they are `scope_denied`,
run nothing and are not cached.

### Trust model: agents read each other's plans, and change only their own

Several agents can share one served session (each MCP session is an agent,
"Agents" above), and none of them is trusted with another's work. The rule, on
the command thread with the agent the request's `Mcp-Session-Id` names:

- Reading is across agents, by design: `inspect_session` already shows the whole
  session to a propose caller, and agents that work on one session coordinate by
  seeing each other's proposals. `list_plans`, `plan_status` and `preview_plan`
  return every plan in the session, whoever its `actor` is.
- Changing a plan's lifecycle is the actor's. Under `propose`, `reject_plan`
  rejects only a plan this agent submitted first (the agent the plan's `actor`
  was set from; an identical resubmission by another agent returns the stored
  plan and does not make it the actor, and the sub-plan of a partial approval
  keeps its parent's agent). `discard_proposal` discards only a branch this
  agent proposed or the proposal of a plan it is the actor of. Any other plan or
  branch, a UI-submitted one included, is `not_plan_actor` (a stable code; an
  unknown plan or branch is still `not_found`, checked first), and nothing
  changes. A plan whose agent is gone (ended, or forgotten past
  `limits.agentsRetained`; a new `initialize` is a new agent), or
  one the session held when it was opened, has no MCP actor here: only the UI and a
  trusted caller reject it.
- `trusted` callers and the UI keep full reach: they reject any plan and discard
  any proposal (they approve, apply and merge anyway).
- `propose_plan` and `audition` are not limited to the actor. `propose_plan`
  branches a plan the user has already approved, and the plan's agent can still
  discard that branch; `audition` changes only what the user hears, like `play`
  and `stop`, and leaves no trace in any plan (see the maintainer note below).

### Methods without a tool

Every method of `engine.capabilities` `methods` is a tool's method above or a row
of this table, never both: `kNotMcp` beside the tool table in
`native/libs/protocol/src/mcp_adapter.cpp`, in its order, checked by the native
`protocol_parity_test` and by `test/protocol-parity.test.js`. An MCP request for
one of them is `-32602` (unknown tool).

| Method | Reason |
|---|---|
| `engine.about` | its content is the `about` object of `describe_capabilities` |
| `gesture.begin` | a pointer lease of a UI, not an agent's verb; agents change values through commands and plans |
| `gesture.update` | a pointer lease of a UI, not an agent's verb; agents change values through commands and plans |
| `gesture.hold` | a pointer lease of a UI, not an agent's verb; agents change values through commands and plans |
| `gesture.end` | a pointer lease of a UI, not an agent's verb; agents change values through commands and plans |
| `gesture.cancel` | a pointer lease of a UI, not an agent's verb; agents change values through commands and plans |
| `plugin.registry` | approving what code loads is the user's decision (Protocol v0 item 21) |
| `plugin.approve` | approving what code loads is the user's decision (Protocol v0 item 21) |
| `plugin.open_editor` | a plugin editor needs a desktop window |
| `plugin.close_editor` | a plugin editor needs a desktop window |
| `plugin.instantiate` | agents reach plugins through plan steps (`plugin.insert` and the plugin commands) |
| `plugin.set_parameter` | a live parameter of a running instance, not journaled; no command sets a plugin parameter, so agents have no path to plugin parameters in v0 |
| `session.sync` | read-model replication for UI clients; `inspect_session` serves agents |
| `session.fetch` | read-model replication for UI clients; `inspect_session` serves agents |
| `record.recover_take` | accepting or trashing a take a crash left is the user's decision about files on their disk; the UI offers it from `pendingTakes` |
| `meter.reset_loudness` | restarts the integrated value of the user's loudness meter: a display aid, not session state, and nothing a plan needs; an agent measures loudness from a render |
| `agent.request` | the user's side of an agent request (Protocol v0 item 32); the agent takes it with `next_request` |
| `agent.cancel_request` | the user's side of an agent request (Protocol v0 item 32); the agent takes it with `next_request` |
| `agent.requests` | the user's side of an agent request (Protocol v0 item 32); the agent takes it with `next_request` |

Maintainer note: `propose_plan` and `audition` under `propose` let an agent
change what the user hears without changing main. If that is unwanted, flip
their rows to `trusted`.

## Example

```text
POST /v0/mcp                      Authorization: Bearer <mcp token>
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}
-> 200  Mcp-Session-Id: mcp_4f...
{"id":1,"jsonrpc":"2.0","result":{"capabilities":{"tools":{}},"protocolVersion":"2025-06-18","serverInfo":{"name":"siann-engine","version":"0.1.0"}}}

POST /v0/mcp                      Mcp-Session-Id: mcp_4f...
{"jsonrpc":"2.0","method":"notifications/initialized"}
-> 202

POST /v0/mcp                      Mcp-Session-Id: mcp_4f...
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"submit_plan","arguments":{"steps":[{"op":"track.add","trackId":"trk_1","name":"Drums","channels":2}]}}}
-> 200
{"id":2,"jsonrpc":"2.0","result":{"content":[{"text":"{\"baseRevision\":\"r1\",...}","type":"text"}],"isError":false,"structuredContent":{"baseRevision":"r1","hash":"sha256:...","state":"validated",...}}}

POST /v0/mcp                      Mcp-Session-Id: mcp_4f...   (propose scope)
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"approve_plan","arguments":{"plan":"sha256:..."}}}
-> 200
{"id":3,"jsonrpc":"2.0","result":{"content":[{"text":"{\"code\":\"scope_denied\",...}","type":"text"}],"isError":true,"structuredContent":{"error":{"code":"scope_denied","message":"approve_plan needs the trusted scope"}}}}
```
