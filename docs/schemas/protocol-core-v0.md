# Protocol core v0

The session, command, plan, proposal, audition and job methods of the native protocol server (architecture spec, "siann-protocol", Protocol v0 items 8, 14 and 16, and "Commands and jobs", Jobs v0). The envelope, the stable codes and the idempotency cache are the spec's items 2, 3 and 5; every method here runs on the command thread, honours `expectedRevision` (`revision_mismatch` when main's head differs, nothing executed) and the idempotency cache, and is listed in `engine.capabilities`' `methods`. Each is also an MCP tool with the same params, result and errors ([Protocol MCP v0](protocol-mcp-v0.md)). The other methods are in [Protocol engine v0](protocol-engine-v0.md) (transport, status, devices, recording, `session.open`, `session.create`, `media.import`), [Protocol events v1](protocol-events-v1.md) (sync, fetch, undo, redo, about, `plan.list`, `plan.preview`), [Protocol gestures v0](protocol-gestures-v0.md) and [Protocol plugins v0](protocol-plugins-v0.md) (the plugin methods and `render.start`).

Every error below is besides the envelope codes any request can get (`bad_request`, `session_mismatch`, `revision_mismatch`, `unknown_method`, `queue_full`, `internal_error`, and `scope_denied` over MCP). A missing or mistyped param is `invalid_params`. Codes passed through from the command layer keep their `step` and `data` as the spec's item 2 says.

## Session and command methods

| Method | Params | Result | Errors |
|---|---|---|---|
| `session.inspect` | `{}` (ignored) | `{revision, documentHash, revisions, branches, heard?}`: main's head revision id, its `sha256:` document hash, the number of revisions in the history, the open proposal branches, and, when an audition port is present, what is heard (`"main"` or a branch) | none of its own |
| `session.save` | `{}` | `{revision, path}`: the checkpoint of main's head is written (`Session::checkpoint`); `path` is the bundle's `session.json` | the `SessionError` code of a failed write |
| `command.execute` | `{commands: [command, ...]}`, the commands in their journal JSON form (`op` plus fields) | `{revision: {id, parents, documentHash, cause, actor, time, diff, target?}}`: the list commits as one revision, all or nothing, published as `session.changed`; `diff` holds `"<type>:<id>"` strings | `invalid_params` without `step` for a missing, non-array or empty `commands`; the `CommandError` code of a command that does not parse or fails validation, with `step` (its index), nothing committed; `track_recording` while recording ([Protocol engine v0](protocol-engine-v0.md), Recording) |
| `command.list` | `{}` | `{commands}`: the names of the registered commands (`command::commandNames()`) | none of its own |

## Plan methods

The plan object, its hash and its lifecycle are [Plan v1](plan-v1.md); `plan.list` and `plan.preview` are in [Protocol events v1](protocol-events-v1.md), Methods. `plan` is the plan's `sha256:` hash. A plan the store does not hold is `not_found`.

| Method | Params | Result | Errors |
|---|---|---|---|
| `plan.submit` | `{steps, readSet?: ["<type>:<id>"], baseRevision?}` (default base: main's head) | the `siann.plan.v1` object with its lifecycle fields, `state: "validated"` | `invalid_params` (`steps` missing or empty, a `readSet` entry that is not `"<type>:<id>"`); `not_found` (no revision `baseRevision`); a step that fails at the base with its `CommandError` code and `step`; `invalid_plan`, `invalid_entity_set`, `plan_not_canonicalizable` (Plan v1, Hash) |
| `plan.status` | `{plan}` | the plan object plus `stale: [{ref, change}]` (empty when fresh) and `proposalBranch` while it is proposed | `not_found` |
| `plan.approve` | `{plan, steps?}`; `steps` are step indexes for a partial approval | the approved plan, or with `steps` the approved sub-plan | `not_found`; `invalid_state` (the plan is not `validated`); `plan_stale` with `data: {plan, changedEntities}`; `invalid_params` (`steps` not non-negative integers, empty, repeated, out of range, or every step) |
| `plan.reject` | `{plan, note?}` | the rejected plan | `not_found`; `invalid_state` (a plan that is not `validated` or `approved`, or is proposed on a branch) |
| `plan.apply` | `{plan}` | `{revision}` as `command.execute` answers it, published the same way | `not_found`; `invalid_state` (not `approved`, or proposed on a branch that is not merged or discarded); `plan_stale` with `data`; a step's `CommandError` code with `step`; `track_recording` |
| `plan.rollback` | `{plan}` | `{revision}`: the inverse revision | `not_found`; `plan_not_applied`; `rollback_conflict` with `data: {entities}`; `track_recording` |
| `plan.propose` | `{plan}` | `{branch, revision}`: the proposal branch and the plan's revision on it; `proposal.changed` follows | `not_found`; `invalid_state` (not `approved`, or already proposed) |

## Proposal and audition methods

| Method | Params | Result | Errors |
|---|---|---|---|
| `proposal.merge` | `{branch}` | `{revision}`: the branch-merge revision, main's new head; `proposal.closed {merged: true}` follows. Through the audition port when one is present | `not_found` (no open branch `branch`); `branch_conflict` with `data: {entities}`; `empty_transaction` (a branch with no commits); `track_recording` |
| `proposal.discard` | `{branch}` | `{}`; `proposal.closed {merged: false}` follows | `not_found` (no open branch `branch`) |
| `audition.hear` | `{side: "main" \| "<branch>"}` | `{heard}`: `"main"` or the branch now heard | `audition_unavailable` (no audition port); `audition_not_found` (no open branch `side`); `audition_budget_exceeded` with `data: {resource, needed, budget}` |

## Job methods

| Method | Params | Result | Errors |
|---|---|---|---|
| `job.status` | `{jobId}` | `{jobId, kind, state, progress?, result?, error?}`: `state` is `queued`, `running`, `done` or `failed`; a render's `result` is `{path, frames, sampleRate, channels, contentHash}`, an import's is in [Protocol engine v0](protocol-engine-v0.md), `media.import`; `error` is `{code, message}` of a failed job | `not_found` (no job `jobId`) |
