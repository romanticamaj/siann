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
  response. No SSE stream in v0; `GET /v0/mcp` is `405`.
- A notification (no `id`) gets `202` with an empty body.
- `initialize` assigns a session: the response carries the header
  `Mcp-Session-Id: mcp_<32 hex>`. Every later request must send it: missing is
  `400`, unknown is `404` (the client initializes again). Both carry a JSON-RPC
  error body with `id: null`.

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
| `submit_plan` | `plan.submit` | propose | `{steps: [command], readSet?: ["<type>:<id>"], baseRevision?}` |
| `plan_status` | `plan.status` | propose | `{plan: "sha256:..."}` |
| `approve_plan` | `plan.approve` | trusted | `{plan, steps?: [index]}` |
| `reject_plan` | `plan.reject` | propose | `{plan, note?}` |
| `apply_plan` | `plan.apply` | trusted | `{plan}` |
| `rollback_plan` | `plan.rollback` | trusted | `{plan}` |
| `propose_plan` | `plan.propose` | propose | `{plan}` |
| `audition` | `audition.hear` | propose | `{side: "main" \| "<branch>"}` |
| `merge_proposal` | `proposal.merge` | trusted | `{branch}` |
| `discard_proposal` | `proposal.discard` | propose | `{branch}` |
| `execute` | `command.execute` | trusted | `{commands: [command]}` |
| `job_status` | `job.status` | propose | `{jobId}` |
| `render` | `render.start` | propose | `{name, start?, frames?}` |
| `open_session` | `session.open` | trusted | `{path}` |
| `save_session` | `session.save` | propose | `{}` |

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
