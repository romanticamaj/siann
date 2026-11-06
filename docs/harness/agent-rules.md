# Agent rules for the milestone harness

Every subagent started by `.claude/workflows/siann-milestone.js` reads this file first. It overrides agent defaults. `CLAUDE.md` and `AGENTS.md` still apply.

## Sources of truth

- Architecture spec: `docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md`. When code and spec disagree, either the code is wrong or the spec changes in the same branch (a `docs:` commit first, explaining why).
- Milestone manifests: `.claude/milestones/<M>.json` (`siann.milestone.v1`). A feature is finished when every acceptance item has a test that fails without the change.
- Decisions: `docs/adr/`. Never reverse an ADR without the maintainer.

## Branches and worktrees

- One branch per feature: `ms/<M>/<feature-id>`, from `origin/main`. Fix rounds commit to the same branch.
- Implementation agents run in their own worktree. **Before returning, run `git checkout --detach`** so the next agent can check out the branch elsewhere.
- Reviewers never edit. To inspect a branch, use `git worktree add --detach <scratch dir> <branch>` and remove the worktree when done.
- Do not touch the maintainer's main checkout (`D:\projects\siann`) except to read.

## TDD order

1. Write the failing tests for the acceptance items, build, and see them fail for the right reason. Commit (`test: ...`).
2. Implement until they pass. Commit (`feat: ...` / `fix: ...`).
3. Refactor with the tests green.

Fixture expectations come from outside the code under test (RFCs, published vectors, separate generators in `scripts/`). Tests are deterministic: no wall-clock sleeps as synchronization, no real devices in CI (use `ManualAudioDevice` or paced `FakeAudioDevice`).

## Checks

```sh
node scripts/check-all.js --gcc             # Node tests + native dev build/tests + g++ -Werror syntax check
node scripts/check-all.js --gcc --desktop   # also the JUCE desktop preset (when touching host_desktop)
node scripts/check-all.js --gcc --app       # also the Electron shell in app/ (when touching app/ or apps/engine)
node scripts/check-all.js --only native     # one step
```

On Windows the native step goes through `native/tools/msvc-env.cmd`; the gcc step uses WSL `g++` and needs the dev build's `_deps` (run the native step first). All presets treat warnings as errors.

GCC catches what MSVC does not. Known traps:

- `-Wshadow`: a member, alias or enumerator with the same name as a parameter or local.
- `-Winterference-size`: do not use `std::hardware_destructive_interference_size`; use the project constant.
- Nested structs with default member initializers used in `noexcept` traits inside the enclosing class: put such `static_assert`s in a function body, not at class scope.
- `-Wdangling-reference` false positives on functions returning references: bind to a pointer instead.

## Realtime rules (audio thread)

No allocation, no locks, no blocking I/O, no logging, no exceptions on the audio thread. One exception, accepted 2026-11-07 (ADR-0018): the locks JUCE's own VST3 and AU hosting wrappers take inside `processBlock`, listed in the architecture spec under "Locks inside a hosted plugin's `processBlock`". It covers nothing in SIANN's code (`JucePluginInstance::process` takes no lock) and the engine's xrun counter must report the wait it can cause. Do not add a lock anywhere else and cite this exception. Communication only through the bounded preallocated queues in `siann-realtime`. Prove it in tests by linking `siann_rt_alloc_guard`. Follow revision 3.1 of the spec: one graph transition in flight, duck-and-swap, retirement acknowledged by the butler, generations on locate. Change a plugin parameter with `setParameter`, never with `setState`; a `setState` during playback holds that plugin out of processing (input passes through dry) until it returns.

## Windows working tree

- Files are CRLF in the working tree (`core.autocrlf=true`). Scripted edits must keep CRLF; prefer the Edit tool.
- Write long Python or shell scripts to a scratch file and run it; long heredocs in Git Bash break.
- Git Bash `tar` cannot take `C:` paths; `cd` first.

## Commits

Conventional Commit subjects (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `build:`, `ci:`). End every commit message with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Never commit provider keys, signing material, local audio assets or rendered stems.

## Landing (land agents only)

1. `git fetch origin && git rebase origin/main`, rerun `node scripts/check-all.js --gcc`.
2. `gh auth switch -u romanticamaj` (the default account `ulovemusic2023` gets 403 on this repo).
3. `git push -u origin <branch>`; `gh pr create --base main` with this body:
   - Summary (2 to 4 bullets)
   - Acceptance checklist copied from the manifest, each ticked with the test that covers it
   - Verification: check-all result, reviewer rounds, follow-ups (minor findings)
   - Final lines: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
4. Wait for CI (`gh pr checks --watch`). macOS runners can queue for 10+ minutes. On red: reproduce, add a failing test where possible, fix, push. A second red run is a stop condition.
5. `gh pr merge --merge --delete-branch`.
6. **Always** `gh auth switch -u ulovemusic2023` afterwards, also on failure.

## Stop conditions

Return `status: blocked` with a precise reason instead of guessing when:

- CI is red twice on the same branch.
- An acceptance item needs hardware, an account, a long run or a judgement call from the maintainer (human gates in the manifest).
- The spec contradicts itself or an ADR, and the fix is not obvious.
- A dependency, licence or new third-party library would be added that no ADR covers.
- You would need to store a secret or change repository settings.
