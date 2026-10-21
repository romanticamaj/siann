# Import Pack Plan v1

`siann.import_pack_plan.v1` is the reviewable plan produced by
`siann workflow import-pack <manifest> --plan <file>`. It wraps a
`siann.command.v0` batch with a summary, human-readable steps, a review state,
and an integrity hash that binds approval to the exact command batch.

v1 changes one thing from v0: the integrity hash is defined as RFC 8785 JSON
Canonicalization Scheme (JCS) and the plan says so in
`integrity.canonicalization`. For every value a v0 plan could carry, the v0
hash (sorted-key `JSON.stringify`) and the JCS hash are identical, so v0 plans
remain readable and are verified with JCS. Values JCS cannot represent (NaN,
infinities, lone surrogates, non-JSON types) are now rejected instead of being
hashed silently.

## Shape

```json
{
  "schemaVersion": "siann.import_pack_plan.v1",
  "workflow": "import-pack",
  "manifestFile": "/abs/path/manifest.json",
  "summary": {
    "sessionName": "ImportPackDemo",
    "sessionDir": "/abs/path/Session",
    "trackCount": 2,
    "assetCount": 2,
    "previewOutputPath": "/abs/path/preview.wav",
    "risk": "normal",
    "journalPath": "/abs/path/journal.json",
    "commandCount": 8
  },
  "steps": [{ "kind": "create_session" }],
  "review": {
    "required": true,
    "state": "pending",
    "instructions": "Review this plan before running workflow apply-plan."
  },
  "integrity": {
    "canonicalization": "jcs-rfc8785",
    "commandHash": "sha256:<64 lowercase hex>"
  },
  "command": { "schemaVersion": "siann.command.v0", "commands": [] }
}
```

## Integrity Rules

- `integrity.commandHash` is `sha256` over the UTF-8 bytes of
  `JCS(command)`, written as `sha256:<64 lowercase hex>`. Only `command` is
  hashed; `summary`, `steps`, `review` and approval fields are not.
- Approval copies the current hash into `review.commandHash`. Apply refuses a
  plan whose recomputed hash differs from the approved hash.
- A v1 plan whose `integrity.canonicalization` is not `jcs-rfc8785` is not
  approvable or applicable (`unsupported_canonicalization`).
- A command that cannot be canonicalized is reported as
  `command_not_canonicalizable`.
- Consumers accept `siann.import_pack_plan.v0` and
  `siann.import_pack_plan.v1` and reject every other version.

## Canonicalization

The implementation is `src/hash/jcs.js`:

- Object keys sorted by UTF-16 code units, no insignificant whitespace.
- ECMAScript number serialization; `-0` becomes `0`; NaN and infinities are
  rejected.
- ECMAScript JSON string escaping; lone surrogates are rejected.
- Object properties whose value is `undefined` are omitted, matching a JSON
  file round trip. Every other non-JSON value is rejected.

`fixtures/jcs/cases.json` (`siann.jcs_fixtures.v1`) holds the shared
fixtures: JSON text inputs, the exact expected canonical output, the expected
hash, and inputs that must be rejected. The expected outputs come from RFC 8785,
not from this implementation. The future C++ engine must pass the same file.
