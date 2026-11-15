# Import Pack Workflow

This example turns a small asset manifest into a reviewable SIANN plan, applies
the reviewed plan through the bridge, renders a preview, and leaves rollback
metadata in the generated journal.

```sh
node scripts/create-demo-import-pack.js --out /tmp/siann-import-pack-demo --json
node bin/siann.js workflow import-pack /tmp/siann-import-pack-demo/manifest.json \
  --plan /tmp/siann-import-pack-demo/plan.json \
  --json
node bin/siann.js workflow validate-plan /tmp/siann-import-pack-demo/plan.json --json
node bin/siann.js workflow approve-plan /tmp/siann-import-pack-demo/plan.json \
  --out /tmp/siann-import-pack-demo/approved-plan.json \
  --approved-by "$USER" \
  --json
node bin/siann.js workflow apply-plan /tmp/siann-import-pack-demo/approved-plan.json \
  --out /tmp/siann-import-pack-demo/import-pack.command.json \
  --run \
  --json
node bin/siann.js validate-journal /tmp/siann-import-pack-demo/journal.json --json
node bin/siann.js rollback /tmp/siann-import-pack-demo/journal.json \
  --out /tmp/siann-import-pack-demo/rollback.command.json \
  --run \
  --json
```

The generated plan contains the session summary, track and asset placement
steps, preview render target, review state, command hash, and command batch to
apply. Pending plans cannot be applied directly; approve the plan first so the
bridge can verify that the command hash has not changed. Applying the approved
plan creates a session under `/tmp/siann-import-pack-demo/Session`, places a
riser and impact on separate tracks, renders `/tmp/siann-import-pack-demo/preview.wav`,
and records the plan revision in the journal. The rollback command opens the
bundle again and rolls that revision back (`plan.rollback {revision}`); the
imported media stays in the bundle.

For extracted DAW test packs with `_DAW/` BGM files, `_DAW/placement.md`, and
`_SpliceSFX/` sound effects, generate a multi-track manifest before the same
plan/apply flow:

```sh
node scripts/create-daw-manifest.js /tmp/siann-user-daw-source \
  --out /tmp/siann-user-daw-multitrack-demo/manifest.json \
  --session-dir /tmp/siann-user-daw-multitrack-demo/Session \
  --preview /tmp/siann-user-daw-multitrack-demo/preview.wav \
  --journal /tmp/siann-user-daw-multitrack-demo/journal.json \
  --json
```

The generated layout creates one track per BGM bed and one track per SFX cue so
the timeline is easier to inspect visually in the SIANN app or, after DAWproject export, another DAW. BGM
rows in `placement.md` provide `sourceStart` and `duration`, which the engine
uses to trim imported regions instead of always placing whole source files.
