# Milestone runbook

How to run one milestone of the native engine with the harness. One milestone per run; check the result before starting the next.

## Pieces

| Piece | Path | Role |
|---|---|---|
| Manifests | `.claude/milestones/<M>.json` | Features, waves, acceptance, exit criteria, human gates |
| Workflow | `.claude/workflows/siann-milestone.js` | Preflight → Plan (Fable spec check) → Build (Opus TDD + verifier + Fable spec review, fix loop) → Land → Exit |
| Agent rules | `docs/harness/agent-rules.md` | What every subagent must follow |
| Local checks | `scripts/check-all.js` | One command for Node, native, desktop, app (Electron shell) and GCC checks |
| Manifest tests | `test/milestones.test.js` | Keeps manifests and the workflow consistent |

## Recommended order

M2 → M3 → M0 → M4 → M5 → M6a → M6b → M6c → M7. M0 waits for the M3 protocol server because the renderer connects through it; M6a–M6c can be reordered.

## Before each run

1. `git checkout main && git pull`, working tree clean.
2. The latest CI run on main is green (preflight waits for it; the local `node scripts/check-all.js --gcc` is optional).
3. In Claude Code `/config`, raise **Dynamic workflow size** (a milestone uses roughly 5 to 8 agents per feature; M2 with 7 features needs about 50).
4. Read the manifest's `humanGates` and `prerequisites`; settle what you can up front.

## Run everything

`/siann-all` runs every remaining milestone in order and stops only at human gates, failures it cannot fix, or anything touching secrets. `/siann-all M3` starts at M3; `/siann-all --only M2,M3` runs just those. The steps are in `.claude/commands/siann-all.md`.

## Run one milestone

Type in Claude Code:

```
用 siann-milestone workflow 跑 M2
```

Options (pass as workflow args):

- `features: ["m2-transport"]` — only these features (no exit check).
- `maxRounds: 3` — more fix rounds per feature (default 2).
- `land: false` — verify but do not open PRs; branches stay local.

Progress: `/workflows`. Each feature lands as its own PR, merged only after CI is green on Windows, macOS and Linux.

## When it stops

| Stop | Meaning | What you do |
|---|---|---|
| `preflight` | main is red, dirty tree or prerequisite missing | Fix or tell Claude to fix, rerun |
| `plan` / `needsHuman` | Fable found a decision that is yours | Answer the question; Claude updates the manifest or spec; rerun |
| feature `failed` | findings left after the fix rounds, or CI red twice | Read the reason and branch; rerun with `features: [id]` after deciding |
| feature `skipped` | a dependency failed | Rerun after the dependency lands |
| exit `needs_human` | hardware, long run or judgement | Do the check, report back, Claude records evidence |

## After each run

1. Read the summary: merged PRs, failed features, exit criteria.
2. Do the human gates (devices, long runs, macOS hands-on, accounts). Since M4,
   validate the installed third-party plugins with pluginval at strictness 5:
   `SIANN_PLUGINVAL=<pluginval v1.0.4> node scripts/pluginval.js --compat`, with
   one variable per plugin (`SIANN_PLUGIN_TDR_NOVA`, `SIANN_PLUGIN_SLICKEQ`,
   `SIANN_PLUGIN_SURGE_XT_VST3`, and when authorised `SIANN_PLUGIN_SD3`,
   `SIANN_PLUGIN_UAD_1176`, `SIANN_PLUGIN_HALION_SONIC`; on macOS
   `SIANN_PLUGIN_TDR_NOVA_AU`, `SIANN_PLUGIN_SURGE_XT_AU`). An unset variable is a
   `SKIP`; a missing path or a pluginval failure is a `FAIL` (exit 1). See
   `native/README.md`, "pluginval".
3. Ask Claude to record the results; the manifest status becomes `done` when every exit criterion is met.
4. Start the next milestone.

## Human gates by milestone

| Milestone | Gates |
|---|---|
| M2 | Exit runs on your audio interface (xrun bench at 256 samples). The 10-minute record + kill runs on the fake device in the `long-tests` workflow (`siann_cli_tests "[long]"`, scheduled or `workflow_dispatch`); trigger it once after merge and check it is green |
| M3 | — |
| M0 | Apple Developer ID and notarization key (asked before storing secrets), macOS hands-on (since M4 the editor opens through the protocol: `command.execute` `track.add`, `plugin.instantiate`, then `plugin.open_editor`; the engine's `--open-editor` flag and the shell's `SIANN_OPEN_EDITOR` are gone), choice of test plugins |
| M4 | Choice of third-party plugins; exit: `node scripts/pluginval.js --compat` on Windows (install pluginval and Surge XT first; SD3, UAD 1176 and HALion Sonic when authorised), and on the Mac the `SIANN_TEST_AU` run plus the AU half of `--compat` |
| M5 | React or Svelte, UX review |
| M6b | One-hour 16-track recording run |
| M6c | Reference machines for the 64-track criterion |
| M7 | Raspberry Pi class board |
