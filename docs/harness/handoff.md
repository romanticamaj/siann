# Session handoff

The state of the work at the end of a session, so the next session can pick it up. Update this file at every handoff. The newest entry goes on top.

---

## 2026-11-19: M5b paused after wave 4 (main `543ad1c2`)

### The goal being worked on

GitHub #83: a SIANN that opens, works, and is operated like Cubase. Criteria A to I, as the maintainer set them with `/goal`:

| | Criterion | State at this handoff |
|---|---|---|
| A | One command or installer opens the app on Windows; the Mac is verified by siann-macos | Windows done (`m5b-package-windows`). Mac **not verified** (human gate `macos-run`). |
| B | New/open project, import audio (drag-and-drop or Media tab), create tracks, save and reopen | Done (#149 project, #158 media, M5b engine project/media). |
| C | Editing: bars-and-beats ruler, grid/snap, zoom/scroll, move/copy/split/glue/trim, fades, clip volume, Ctrl+D, undo/redo, markers, cycle range saved | **Missing: fades UI (`m5b-ui-fades`), markers (`m5b-engine-markers`, `m5b-ui-markers`).** Everything else merged (#154 edit-more and earlier M5 work). |
| D | Transport: play, stop, record, cycle, click, count-in, cursor and position, numpad and laptop keys | Done (M5, #152 punch/count-in, #162 Ctrl+Shift+R). |
| E | MixConsole: faders to +6 dB, pan, M/S, meters with peak hold and clip, inserts, sends, master fader | **Missing: sends and buses UI (`m5b-ui-sends-buses`).** Inserts and master merged (#153). |
| F | Recording: input, arm, monitor, record to a clip | Code done (#147, #152, #162). **Not tried on real hardware** (human gate `audio-hardware`). |
| G | AI plans: ghost changes on the event display and MixConsole, A/B audition, approve, partial approve, reject, merge | Done (#150 ghosts, #151 plan metadata, #155 audition, #160 "ask the agent" box). |
| H | Default Cubase key commands; en, zh-Hant, zh-Hans | Locales done. **Key command audit not started (`m5b-ui-keymap`).** |
| I | Cubase user walkthrough e2e passes; screenshot tour in three locales | **Not started (`m5b-cubase-walkthrough`).** |

The maintainer's stop conditions still hold. Stop and wait for the maintainer on:
- secrets or certificates
- spending money
- repo settings
- reversing an ADR
- UI screenshot review
- hardware tests that need them

Anything else that blocks goes to Fable first, recorded as "Decided by Fable, delegated by the maintainer, <date>" in UI redesign spec 10.11.

### How to resume

1. `git pull` in `D:/projects/siann`, which must be on `main`. Workflows read the manifests from the main checkout.
2. Set the goal again with `/goal` (the text is in the table above, or in the last session's prompt), then run the remaining M5b features in dependency order:

```
Workflow scriptPath=.claude/workflows/siann-milestone.js
  args {"milestone":"M5b","features":["m5b-engine-markers","m5b-ui-fades","m5b-ui-notepad"],"checked":true}
# after those merge:
  args {"milestone":"M5b","features":["m5b-ui-markers","m5b-ui-sends-buses","m5b-ui-editor-channel"],"checked":true}
# after those merge:
  args {"milestone":"M5b","features":["m5b-ui-keymap"],"checked":true}
# then:
  args {"milestone":"M5b","features":["m5b-cubase-walkthrough"],"checked":true}
```

Dependencies, from `.claude/milestones/M5b.json`:

| Feature | Wave | Depends on (all merged unless marked) |
|---|---|---|
| `m5b-engine-markers` | 3 | none |
| `m5b-ui-fades` | 4 | engine-clip-fades, ui-edit-more, ui-ghosts |
| `m5b-ui-notepad` | 4 | engine-track-notes |
| `m5b-ui-markers` | 5 | **engine-markers**, ui-edit-more, ui-ghosts |
| `m5b-ui-sends-buses` | 5 | engine-buses-sends, ui-inserts-master, ui-recording, ui-ghosts |
| `m5b-ui-editor-channel` | 5 | ui-edit-more, **ui-fades** |
| `m5b-ui-keymap` | 6 | every UI feature above |
| `m5b-cubase-walkthrough` | 7 | **ui-keymap**, package-windows |

`m5b-engine-markers` has an old local branch and worktree (`D:/wt-markers`, commit f98fcb7) that predate track notes. Its plan said to land after #132, which has now merged. Start it again from `origin/main` rather than reusing that branch, which conflicts in about 15 files.

### How this session worked (keep doing it)

- **Merging:** the main session merges, never a subagent. Use `gh auth switch -u romanticamaj && gh pr merge N --merge --delete-branch; gh auth switch -u ulovemusic2023`. Main is branch-protected: "CI ok" is required and enforce_admins is on.
- **The plan phase stops on any `needsHuman`.** Run only the features whose plans are ready. Send the blocked ones to Fable for a docs PR, which records the decisions in spec 10.11 and changes the manifest and spec. Merge that PR, pull main, then rerun.
- **When a workflow reports "failed" with findings**, start a single landing agent on the branch. Give it:
  - the findings
  - "merge origin/main"
  - "check-all --changed until green"
  - "push, PR, don't merge"
- **macOS runner shortage:** a macOS job "cancelled" with no steps never got a runner. Run `gh run rerun <run> --failed`. Do not count it as a red run.
- **Local `check-all`:** run one at a time on this PC. Two or more at once run out of memory (MSVC C1060). Use `-j 2` for native-heavy branches. `VSLANG=1033` must be set.
- **Screenshots:** they go to `D:/siann-ui-proposal/<milestone>/<feature>/`. Send the maintainer the zh-Hant ones after each phase.
- **Flaky e2e tests:** the cause so far has always been a test reading state too early. Fix it by waiting on the real condition (`expect.poll`, `data-viewport`), never by adding retries.

### Open issues (not yet fixed)

1. `app/test/e2e/ghosts.spec.ts:407` fails on this PC: 28 content draws against a limit of 27. It also fails on unmodified main locally, but passes on CI.
2. `app/test/e2e/media.spec.ts:164` ("two files dropped on a track…") failed once on macOS CI (PR #161) and passed on rerun.
3. The `resize()` helper in `i18n-fit.spec.ts` has a latent race on main (fixed for the Media block in #162). Other callers should also wait for `data-viewport`.
4. On the start view the session name is hidden but the branch chip still shows. They should hide together (follow-up from #155).
5. Recording: no test yet for `track.set_monitor` mid-recording. Whole-output dip on stop or locate while monitoring. The monitor input is limited to 64 channels (follow-ups from #147).
6. About 280 worktrees exist under `D:/wt-*`, `D:/land-*` and `.claude/worktrees/`. Clean them up (`git worktree prune`, then remove merged ones) when convenient.

### Waiting on the maintainer

- **M5 UI screenshot review** (`ui-redesign-review`): the three-locale tour is in `D:/siann-ui-proposal/port/cleanup/tour-{en,zh-Hant,zh-Hans}/`.
- **M5b Phase 2 review** (`phase2-tour-review`): ghosts and audition, in `D:/siann-ui-proposal/m5b/ghosts/` and `.../audition/`.
- **Using the app** (`ux-review`): list required changes.
- **Chinese terms** (`zh-glossary`, `zh-glossary-m5b`): check them against Cubase's Chinese interface.
- **Hardware:**
  - `installer-hands-on`: install on a clean Windows machine.
  - `audio-hardware`: record on a real interface.
  - `macos-run`: npm run app plus the walkthrough on the Mac, through siann-macos.
- **Surge XT on the Mac** for M4's `--compat` exit (still owed).

### Merged in this session (M5 port and M5b, #133 to #162)

- **M5 component port:**
  - #133 tasks
  - #135 arrange canvas
  - #136 mixer strip
  - #137 Plans tab
  - #138 Inspector
  - #140 track list
  - #141 toolbar
  - #142 cleanup (token debt at zero)
  - #134 and #139: e2e flake fixes
- **M5b spec decisions by Fable:** #143, #145.
- **M5b features:**
  - #144 protocol parity
  - #146 signature
  - #147 monitoring (with the MonitorInputNode overflow fix)
  - #148 MCP agents may reject only their own plans
  - #149 project and Studio Setup (with the realtime playhead fix)
  - #150 ghosts
  - #151 plan metadata
  - #152 punch/count-in
  - #153 inserts and master
  - #154 edit-more
  - #155 audition
  - #156 CLI coverage
  - #157 nightly quality
  - #158 media
  - #159 meter
  - #160 composer
  - #161 xruns flake
  - #162 recording UI
  - #132 track notes
- Earlier M5b engine work merged before this session: package-windows, project-media, record, master, plan-metadata, clip-fades, native client, buses/sends, load-loudness, agent requests.
