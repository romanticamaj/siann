# Milestone follow-ups

Findings from reviews that did not block a merge. A milestone's `prerequisites`
point here; its first run takes the listed section into its features.

## Before M5: the shell (from PR #47)

- Two app instances can share one session: there is no `requestSingleInstanceLock`
  and no session lock. Fix before any UI can write to a session.
- No ready timeout: a launch that neither writes a ready line nor exits waits
  forever (`supervisor.ts`).
- A kill failure leaves a live child counted as gone: `failLaunch` never ends its
  stdin, and a failed SIGTERM never tries SIGKILL.
- `main.ts` has no permission handler: `getUserMedia` and notifications are granted
  in the renderer.
- The default menu exposes `toggledevtools` and reload. Check the packaged build.
- Untested: ready during stop, start twice, stderr trim, ready-line strictness, CRLF,
  and the window-open and navigation guards.
- `supervisor-process.test.ts`: stop the supervisor in `finally`, as a give-up
  regression still hangs the runner.
- The bounded quit wait on a wedged engine has unit and process tests but no e2e.

## Before M4: plugin hosting (from PR #48)

- The >31-channel guard is untested.
- Nothing checks mechanically that no SIANN lock is taken on the plugin paths.
- Per-instance process timing is not measured.
- Consolidate bench's `TimedDevice` with the shared callback timer.
- ADR-0018 condition 1 ("never both at once") has no test yet.
- ADR-0018 condition 4 depends on the engine running a device, which no feature
  owns. `m4-crash-recovery` implies it; give it an owner.
- `startInBackground` now registers every engine launch with LaunchServices about
  110 ms after spawn. Its startup cost is unmeasured. The shipping `LSUIElement`
  bundle stays UIElement until an editor opens.
- Under an X server with no window manager, opening an editor kills the engine with
  a BadAtom error. CI runs openbox. Decide whether the engine should survive this.
- Local builds: MSVC's localized `/showIncludes` is not parsed, so a changed commit
  header does not rebuild `about.cpp`. Set `CMAKE_CL_SHOWINCLUDES_PREFIX` or configure
  under an English code page.

## Before M6b: recording (from PR #46)

1. Make an early end unmissable: add `endedBy: "seconds" | "overflow" | "interrupt"`
   next to `overflows` in the `record` result.
2. Record `overflows` and `endedBy` in the take manifest as an optional field, and
   surface it as a protocol event when recording reaches the protocol.
3. After an overflow, start a new take at the next block, so the rest of the
   performance is captured with a known gap.
4. Add an end-to-end CLI overflow test with a test-only `--ring-frames`, and cover
   the `--fake-speed` ring scaling.
5. Put `overflows` in the ready file, so the kill tests say "overflowed" instead of
   failing at `REQUIRE(child.running())`.
6. Stop the writer thread stalling: write the ready file without a flush, and move
   the periodic fsync off the drain loop.

## Where tests run

- GitHub Actions is the required gate. It has no audio device and no third-party
  plugin.
- The maintainer's Windows machine runs real VST3s (`SIANN_TEST_VST3`) and Docker
  for Linux. A shell from Git Bash hides Windows error dialogs; to see what CI sees,
  start the process with `SetErrorMode(0)`.
- A Claude session on the maintainer's Mac (`siann-macos`) builds and tests on
  request, without commit or push rights.
- A self-hosted GitHub runner is not used: the repository is public, so a pull
  request could run code on the maintainer's machine.
