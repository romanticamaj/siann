// The performance scenario (m5b-nightly-quality, acceptance item 6; UI redesign
// spec 5.6): a generated 64-track, 2,000-clip session on the real siann-engine
// and the fake device, playing with the meters running. It measures the
// main-thread work per frame (the renderer's performance.measure frame marks,
// summed per animation frame, read through window.__siannFrames), the JS heap
// (performance.memory) and the cold start from the engine's ready line (the
// time the main process read it, window.siannTest.engineReadyAt) to the first
// painted session, and writes perf-report.json (support/perf-report.ts) to
// SIANN_PERF_OUT. Report only at first: it fails on a crash or a missing
// measurement, never on a budget.
//
// Runs only under SIANN_PERF=1 (the nightly workflow's perf job; locally the
// runbook's command): playwright.config.ts leaves the file out of the electron
// project otherwise, and the test skips itself as well.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertComplete, buildPerfReport, SCENARIO } from './support/perf-report';
import { APP_DIR, launchApp, seedLargeBundle } from './support/seed';

const PERF = process.env.SIANN_PERF === '1';
// Frames of playback to measure: ten seconds at 60 Hz.
const FRAMES = 600;

let scratch = '';
let app: ElectronApplication | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() : 'unknown';
}

// The recorder's hooks (the CSP allows no eval in the page).
async function frames<T>(name: 'samples' | 'coldStartMs' | 'clear', page: Page): Promise<T> {
  return page.evaluate((called) => {
    const hooks = (window as unknown as { __siannFrames?: Record<string, () => unknown> }).__siannFrames;
    if (!hooks) throw new Error('window.__siannFrames is missing (SIANN_SHELL_TEST=1)');
    return hooks[called]!();
  }, name) as Promise<T>;
}

test('64 tracks, 2,000 clips playing with meters: frame work, JS heap and cold start against UI redesign 5.6', async () => {
  test.skip(!PERF, 'the performance scenario runs under SIANN_PERF=1 (nightly)');
  test.setTimeout(300_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-perf-'));
  const sessionDir = seedLargeBundle(scratch, SCENARIO.tracks, SCENARIO.clips);

  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  const page = await app.firstWindow();
  let crashed = false;
  page.on('crash', () => {
    crashed = true;
  });

  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
  await expect(page.getByTestId('clip-count')).toHaveText(String(SCENARIO.clips), { timeout: 60_000 });
  const play = page.getByTestId('transport-play');
  await expect(play).toBeEnabled({ timeout: 60_000 });

  // Cold start: taken by the renderer once the first content frame drew clips.
  let coldStartMs: number | null = null;
  await expect
    .poll(async () => (coldStartMs = await frames<number | null>('coldStartMs', page)), { timeout: 60_000 })
    .not.toBeNull()
    .catch(() => undefined);

  // Playing, meters running: the frames from the first meter frame on. The
  // meters' animation frame (and so the frame marks) runs on an idle window
  // too, so the window starts only once the transport reports playing (the
  // play button's aria-pressed follows the realtime channel's playing flag)
  // and the track meters drew a meter frame that arrived after the click
  // (data-frames is the realtime client's meter frame count when drawn). The
  // report gets the playing state at both ends and the meter frames inside:
  // without them the frames are a missing measurement (support/perf-report.ts).
  const meters = page.getByTestId('track-meters');
  const meterFramesDrawn = async () => Number((await meters.getAttribute('data-frames')) ?? '0');
  const beforePlay = await meterFramesDrawn();
  await play.click();
  let playingAtStart = false;
  await expect(play)
    .toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 })
    .then(() => (playingAtStart = true))
    .catch(() => undefined);
  await expect
    .poll(meterFramesDrawn, { timeout: 60_000 })
    .toBeGreaterThan(beforePlay)
    .catch(() => undefined);
  const windowStart = await meterFramesDrawn();
  playingAtStart = playingAtStart && windowStart > beforePlay && (await play.getAttribute('aria-pressed')) === 'true';
  await frames('clear', page);
  if (playingAtStart) {
    await expect
      .poll(async () => (await frames<number[]>('samples', page)).length, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(FRAMES)
      .catch(() => undefined);
  }
  const frameWorkMs = await frames<number[]>('samples', page);
  const playingAtEnd = (await play.getAttribute('aria-pressed')) === 'true';
  const meterFrames = (await meterFramesDrawn()) - windowStart;
  const heapBytes = await page.evaluate(() => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
  });
  await page.getByTestId('transport-stop').click().catch(() => undefined);

  const report = buildPerfReport({
    commit: commit(),
    platform: `${process.platform}-${process.arch}`,
    scenario: SCENARIO,
    frameWorkMs,
    heapBytes,
    coldStartMs,
    playback: { playingAtStart, playingAtEnd, meterFrames },
  });
  const out = process.env.SIANN_PERF_OUT || path.join(APP_DIR, 'test-results', 'perf');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'perf-report.json');
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  await test.info().attach('perf-report.json', { path: file, contentType: 'application/json' });
  console.log(`window: playing ${playingAtStart} -> ${playingAtEnd}, ${meterFrames} meter frames, ${frameWorkMs.length} frames`);
  for (const row of report.budgets) {
    console.log(`${row.name}: ${row.value ?? 'missing'} ${row.unit} (budget ${row.budget}; within: ${row.withinBudget})`);
  }

  expect(crashed, 'the renderer did not crash').toBe(false);
  assertComplete(report);
});
