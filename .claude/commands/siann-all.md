---
description: Run every remaining SIANN milestone through the siann-milestone workflow, in order, stopping only at human gates
argument-hint: "[start milestone, e.g. M3] [--only M2,M3]"
---

# Run all remaining milestones

The maintainer invoked this command: that is the explicit opt-in to run the `siann-milestone` Workflow, once per milestone, as many times as this procedure needs. Arguments: `$ARGUMENTS`.

Read `docs/harness/runbook.md` and `docs/harness/agent-rules.md` first.

## Order

`M2 → M3 → M0 → M4 → M5 → M6a → M6b → M6c → M7`

Start from the milestone given in the arguments, or from the first one whose manifest (`.claude/milestones/<M>.json`) is not `done`. With `--only`, run just the listed milestones in this order. Skip milestones whose status is `done`.

## Per milestone

1. **Prerequisites.** Check the manifest's `prerequisites` against main (merged features count; an earlier milestone in `exit_pending` is enough unless the prerequisite names its exit criterion). If one is not met, stop and report it.
2. **Up-front human gates.** Gates that block the build must be settled before starting:
   - M0 `plugin-set`, M4 `real-plugins`: ask the maintainer which plugins to use (AskUserQuestion), record the answer in the manifest on a `docs:` branch, and land it.
   - M5 `framework-choice`: present a short React vs Svelte comparison and ask.
   - M0 `apple-signing`: build the M0 features first with `features` excluding `m0-macos-bundle`, then ask. Never create, download or store certificates, keys or GitHub secrets without the maintainer's explicit yes in this conversation, and only with them present.
   Gates that only affect the exit check (long runs, hardware, hands-on) do not block: continue and collect them.
3. **Run.** First confirm the latest CI run on main is green yourself (`gh run list --branch main --limit 1`, then `gh run watch <id> --exit-status` in a background command if it is still running). Then call the Workflow tool with `{name: "siann-milestone", args: {milestone: "<M>", checked: true}}` and wait for its notification. Do not poll. `checked: true` makes preflight only read the manifest; subagents cannot reliably wait out a long CI run.
4. **Failures.** If features `failed`, read each reason. When the reason is a fixable code or test problem, rerun once with `{milestone, features: [failed ids and their skipped dependants], maxRounds: 3}`. If they fail again, or the reason is a decision, a stop condition from the agent rules, or red CI twice, stop the whole run and report.
5. **Exit.** Exit criteria marked `met` are recorded by the workflow. Collect `needs_human` ones in the pending list with the exact command or steps the maintainer must perform. A milestone with only human exit items left counts as `exit_pending` and the run continues.
6. **Report** in one short message (Traditional Chinese): merged PRs, failures, pending human items, next milestone. Then continue with the next milestone without waiting.

## Stop the whole run when

- Preflight fails and the cause is not a quick fix you can land through a PR.
- A plan check returns `needsHuman` (ask the question, then continue after the answer).
- Step 4 gives up on a feature that later milestones depend on.
- A kill criterion in a manifest triggers.
- Any action would store a secret, change repository settings, spend money, or reverse an ADR.

## At the end

Give the maintainer a final summary: milestones done, milestones in `exit_pending` with every pending human check (commands, hardware, expected result), open problems. Update the project memory notes with the new state.
