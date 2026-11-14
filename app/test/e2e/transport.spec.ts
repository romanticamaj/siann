// The transport bar and the project cursor end to end (m5-ui-transport; UI
// redesign spec 3.1, 3.2, 5.3, 7 P1-2): Cubase's transport keys with the
// laptop fallback, none of them while a text field has focus; the cursor and
// the position display at display rate with zero React commits (profiling
// bundle); a click in the ruler's lower half locates, stopped or playing;
// Shift+P types a position; the period key exchanges Bars+Beats and Seconds;
// auto-scroll pages the view while playing, not while a clip drag is held,
// and F turns it off; Ctrl+Z and Ctrl+Shift+Z undo and redo, a refusal is a
// toast; and with no audio device the transport is disabled with the reason.
//
// The bundle comes from support/seed.ts (siann-cli); the app runs the real
// siann-engine on the fake device under SIANN_SHELL_TEST=1. Requests the
// renderer sent are read from window.__siannClient.sent(); commits and clip
// positions from a second protocol client. Waits are condition polls, never
// sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchApp, seedBundle } from './support/seed';

const RATE = 48000;
const TRACK = 'trk_a';
const CLIP = 'clp_a';
const MOD = 'ControlOrMeta';
const TRANSPORT_METHODS = /^transport\./;

interface View {
  readonly framesPerPixel: number;
  readonly scrollFrames: string;
  readonly rulerHeight: number;
  readonly width: number;
  readonly height?: number;
}

interface Rect {
  readonly clipId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-transport-'));
});

test.afterEach(async () => {
  engine?.close();
  engine = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(options: { engineArgs?: readonly string[]; env?: Record<string, string>; clips?: boolean } = {}): Promise<void> {
  const sessionDir = seedBundle(
    scratch,
    [
      { id: TRACK, name: 'Alpha' },
      { id: 'trk_b', name: 'Beta' },
    ],
    options.clips === false ? [] : [{ id: CLIP, trackId: TRACK, at: 0 }],
  );
  app = await launchApp({
    sessionDir,
    userData: path.join(scratch, 'user-data'),
    languages: ['en-US'],
    extraEngineArgs: options.engineArgs,
    env: options.env,
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  engine = await engineClient(page);
}

// The timeline's test hooks (the CSP allows no eval in the page).
async function hook<T>(name: string): Promise<T> {
  return page.evaluate((called) => {
    const hooks = (window as unknown as { __siannTimeline?: Record<string, () => unknown> }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
    return hooks[called]!();
  }, name) as Promise<T>;
}

const view = () => hook<View>('view');
const cursorX = async () => (await hook<number | null>('cursorX')) ?? -1;

async function rect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await hook<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  return (await hook<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
}

async function box(testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await page.getByTestId(testId).boundingBox();
  if (!found) throw new Error(`${testId} is not laid out`);
  return found;
}

// The requests the renderer sent, oldest first.
async function sent(): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient?: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient;
    if (!client) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return client.sent().map((r) => ({ method: r.method, params: r.params }));
  });
}

async function sentOf(method: string): Promise<Array<Record<string, unknown>>> {
  return (await sent()).filter((r) => r.method === method).map((r) => r.params);
}

async function transportRequests(): Promise<number> {
  return (await sent()).filter((r) => TRANSPORT_METHODS.test(r.method)).length;
}

const playButton = () => page.getByTestId('transport-play');
const primary = () => page.getByTestId('position-primary');
const secondary = () => page.getByTestId('position-secondary');

// The realtime playing flag as the start/stop button shows it.
async function expectPlaying(playing: boolean): Promise<void> {
  await expect(playButton()).toHaveAttribute('aria-pressed', String(playing));
}

// Clicks an empty spot of the canvas (below the lanes), which focuses the
// project zone and selects nothing.
async function focusProject(): Promise<void> {
  const canvas = await box('timeline-canvas');
  await page.mouse.click(canvas.x + 20, canvas.y + canvas.height - 10);
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

async function locate(frames: number, display: string): Promise<void> {
  await engine!.call('transport.locate', { frames: String(frames) });
  await expect(primary()).toHaveText(display);
}

// React commits at the root, or under one <Counted id> (profiling bundle).
async function commits(id?: string): Promise<number> {
  return page.evaluate((counted) => {
    const w = window as unknown as { __siannCommits?: number; __siannCommitsBy?: Record<string, number> };
    return (counted === null ? w.__siannCommits : w.__siannCommitsBy?.[counted]) ?? 0;
  }, id ?? null);
}

// Over `count` animation frames counted in the page: how many of them wrote
// the position display (window.__siannTransport.displayWrites) and drew the
// overlay (the timeline's overlayDraws).
async function perAnimationFrame(count: number): Promise<{ frames: number; writes: number; draws: number }> {
  return page.evaluate(
    (wanted) =>
      new Promise<{ frames: number; writes: number; draws: number }>((resolve, reject) => {
        const w = window as unknown as {
          __siannTransport?: { displayWrites(): number };
          __siannTimeline?: { overlayDraws(): number };
        };
        const transport = w.__siannTransport;
        const timeline = w.__siannTimeline;
        if (!transport || !timeline) {
          reject(new Error('window.__siannTransport / __siannTimeline is missing (SIANN_SHELL_TEST=1)'));
          return;
        }
        const writes = transport.displayWrites();
        const draws = timeline.overlayDraws();
        let frames = 0;
        const step = () => {
          frames += 1;
          if (frames < wanted) requestAnimationFrame(step);
          else resolve({ frames, writes: transport.displayWrites() - writes, draws: timeline.overlayDraws() - draws });
        };
        requestAnimationFrame(step);
      }),
    count,
  );
}

async function revisions(): Promise<number> {
  return (await engine!.call('session.inspect')).revisions as number;
}

async function clipPosition(): Promise<string> {
  const fetched = (await engine!.call('session.fetch', { refs: [`clip:${CLIP}`] })) as {
    entities: Array<{ entity: { position: { value: string } } }>;
  };
  return fetched.entities[0]!.entity.position.value;
}

test('Space starts and stops, numpad Enter starts, Num 0 stops, Num . and the comma go to the start; none fires in a text field', async () => {
  test.setTimeout(120_000);
  await launch();
  await focusProject();
  await expect(primary()).toHaveText('1.1.000');
  await expectPlaying(false);

  await page.keyboard.press('Space');
  await expectPlaying(true);
  const from = await cursorX();
  await expect.poll(cursorX).toBeGreaterThan(from);
  await page.keyboard.press('Space');
  await expectPlaying(false);
  await page.keyboard.press('NumpadEnter');
  await expectPlaying(true);
  await page.keyboard.press('Numpad0');
  await expectPlaying(false);
  await expect(primary()).not.toHaveText('1.1.000');
  await page.keyboard.press('NumpadDecimal');
  await expect(primary()).toHaveText('1.1.000');
  await locate(2 * RATE, '2.1.000');
  await page.keyboard.press('Comma');
  await expect(primary()).toHaveText('1.1.000');

  // The rename field has the focus: each key types, nothing is sent and nothing moves.
  await locate(2 * RATE, '2.1.000');
  const before = await transportRequests();
  for (const key of ['Space', 'Numpad0', 'NumpadDecimal', 'Comma', 'NumpadEnter']) {
    await page.getByTestId(`track-name-${TRACK}`).dblclick();
    const field = page.getByTestId(`track-rename-${TRACK}`);
    await expect(field).toBeFocused();
    await field.press(key);
    if (await field.isVisible()) await field.press('Escape');
    await expect(field).toBeHidden();
  }
  expect(await transportRequests()).toBe(before);
  await expectPlaying(false);
  await expect(primary()).toHaveText('2.1.000');

  // Space with a button focused plays and does not press the button: M stays as clicked.
  const mute = page.getByTestId(`mute-${TRACK}`);
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect(mute).toBeFocused();
  await page.keyboard.press('Space');
  await expectPlaying(true);
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expectPlaying(false);
});

// Each callback of the fake device misses its deadline here
// (--fake-callback-nanos 20 ms against a 256-frame buffer), so the xrun count
// rises on every engine.status poll and the status bar commits once a
// second: the count is taken under the transport bar and the timeline
// (Counted), which no status answer reaches, not at the root.
test('the cursor and the position display run at display rate with zero React commits (profiling bundle)', async () => {
  test.setTimeout(120_000);
  await launch({ env: { SIANN_SHELL_PROFILING: '1' }, engineArgs: ['--fake-callback-nanos', '20000000'] });
  // The counters move on a commit: a mute click re-renders the strip (root),
  // the period key the transport bar's formats.
  const first = await commits();
  const mute = page.getByTestId(`mute-${TRACK}`);
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(commits).toBeGreaterThan(first);
  await focusProject();
  const firstTransport = await commits('transport');
  await page.keyboard.press('Period');
  await expect.poll(() => commits('transport')).toBeGreaterThan(firstTransport);
  await page.keyboard.press('Period');

  await page.keyboard.press('Space');
  await expectPlaying(true);
  // Let the commits the play causes (the playing flag) settle.
  const startDraws = await hook<number>('overlayDraws');
  await expect.poll(() => hook<number>('overlayDraws')).toBeGreaterThan(startDraws + 10);
  const before = { transport: await commits('transport'), timeline: await commits('timeline'), root: await commits() };
  const xruns = await page.getByTestId('xruns').textContent();
  const text = await primary().textContent();
  const secondText = await secondary().textContent();
  const x = await cursorX();
  // Longer than the status bar's 1 s engine.status poll.
  const draws = await hook<number>('overlayDraws');
  await expect.poll(() => hook<number>('overlayDraws'), { timeout: 20_000 }).toBeGreaterThan(draws + 120);
  await expect(primary()).not.toHaveText(text ?? '');
  await expect(secondary()).not.toHaveText(secondText ?? '');
  expect(await cursorX()).not.toBe(x);
  // The status bar did commit (new xruns); the transport bar and the timeline did not.
  await expect(page.getByTestId('xruns')).not.toHaveText(xruns ?? '');
  expect(await commits()).toBeGreaterThan(before.root);
  expect(await commits('transport')).toBe(before.transport);
  expect(await commits('timeline')).toBe(before.timeline);
  // Display rate: the realtime channel ticks slower than the display, and
  // the display and the cursor still move on most animation frames (the
  // extrapolating clock), still without a commit.
  const rate = await perAnimationFrame(90);
  expect(rate.writes, JSON.stringify(rate)).toBeGreaterThanOrEqual(rate.frames * 0.75);
  expect(rate.draws, JSON.stringify(rate)).toBeGreaterThanOrEqual(rate.frames * 0.75);
  expect(await commits('transport')).toBe(before.transport);
  expect(await commits('timeline')).toBe(before.timeline);
  await page.keyboard.press('Space');
  await expectPlaying(false);
});

test('a click in the ruler\'s lower half locates once, stopped and playing; the cursor and the display follow', async () => {
  test.setTimeout(120_000);
  await launch();
  const canvas = await box('timeline-canvas');
  const v = await view();
  const lower = canvas.y + v.rulerHeight * 0.75;

  for (const playing of [false, true]) {
    await locate(0, '1.1.000');
    if (playing) {
      await engine!.call('transport.play');
      await expectPlaying(true);
    }
    const x = 300;
    const before = (await sentOf('transport.locate')).length;
    await page.mouse.click(canvas.x + x, lower);
    await expect.poll(async () => (await sentOf('transport.locate')).length).toBe(before + 1);
    const frames = Number((await sentOf('transport.locate'))[before]!.frames);
    const expected = Number(v.scrollFrames) + x * v.framesPerPixel;
    expect(Math.abs(frames - expected)).toBeLessThanOrEqual(2 * v.framesPerPixel);
    expect((await view()).framesPerPixel).toBe(v.framesPerPixel);
    if (!playing) {
      await expect.poll(async () => Math.abs((await cursorX()) - x)).toBeLessThanOrEqual(2);
      await expect(primary()).not.toHaveText('1.1.000');
    } else {
      // Playing on from there.
      await expect.poll(cursorX).toBeGreaterThanOrEqual(x - 2);
      await engine!.call('transport.stop');
      await expectPlaying(false);
    }
  }
});

test('Shift+Alt-click in the event display locates once, on a clip too, without selecting it', async () => {
  await launch();
  const canvas = await box('timeline-canvas');
  const v = await view();
  const clip = await rect(CLIP);
  const x = clip.x + Math.min(40, clip.width / 2);
  const before = (await sentOf('transport.locate')).length;
  await page.keyboard.down('Shift');
  await page.keyboard.down('Alt');
  await page.mouse.click(canvas.x + x, canvas.y + clip.y + clip.height / 2);
  await page.keyboard.up('Alt');
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await sentOf('transport.locate')).length).toBe(before + 1);
  const frames = Number((await sentOf('transport.locate'))[before]!.frames);
  expect(Math.abs(frames - (Number(v.scrollFrames) + x * v.framesPerPixel))).toBeLessThanOrEqual(2 * v.framesPerPixel);
  await expect.poll(async () => Math.abs((await cursorX()) - x)).toBeLessThanOrEqual(2);
  // Not selected: no outline.
  expect(await hook<number>('selectionOutline')).toBe(0);
});

test('Shift+P types a position in the primary format; Enter locates, Escape cancels, invalid text sends nothing', async () => {
  await launch();
  await focusProject();
  await page.keyboard.press('Shift+KeyP');
  const field = page.getByTestId('position-field');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('1.1.000');
  await field.fill('3.1.000');
  await field.press('Enter');
  await expect(field).toBeHidden();
  await expect.poll(() => sentOf('transport.locate')).toEqual([{ frames: '192000' }]);
  await expect(primary()).toHaveText('3.1.000');

  // Escape cancels.
  await focusProject();
  await page.keyboard.press('Shift+KeyP');
  await expect(field).toHaveValue('3.1.000');
  await field.fill('5');
  await field.press('Escape');
  await expect(field).toBeHidden();
  // Invalid text sends nothing and keeps the field open.
  await focusProject();
  await page.keyboard.press('Shift+KeyP');
  await field.fill('abc');
  await field.press('Enter');
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.press('Escape');
  await expect(field).toBeHidden();
  expect(await sentOf('transport.locate')).toEqual([{ frames: '192000' }]);
  await expect(primary()).toHaveText('3.1.000');
});

test('the period key exchanges the primary and the secondary format', async () => {
  await launch();
  await locate(4 * RATE, '3.1.000');
  await expect(secondary()).toHaveText('0:04.000');
  // The tempo at the cursor (a new session's 120 BPM).
  await expect(page.getByTestId('transport-tempo')).toHaveText('120.000');
  await focusProject();
  await page.keyboard.press('Period');
  await expect(primary()).toHaveText('0:04.000');
  await expect(secondary()).toHaveText('3.1.000');
  // Shift+P now reads seconds.
  await page.keyboard.press('Shift+KeyP');
  const field = page.getByTestId('position-field');
  await expect(field).toHaveValue('0:04.000');
  await field.fill('2');
  await field.press('Enter');
  await expect(primary()).toHaveText('0:02.000');
  await page.keyboard.press('Period');
  await expect(primary()).toHaveText('2.1.000');
  await expect(secondary()).toHaveText('0:02.000');
});

test('a right-click on the position display opens the time format menu; choosing a format makes it primary', async () => {
  await launch();
  await locate(4 * RATE, '3.1.000');
  await page.getByTestId('position-display').click({ button: 'right' });
  const menu = page.getByTestId('time-format-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('time-format-bars')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('time-format-seconds')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('time-format-seconds').click();
  await expect(menu).toBeHidden();
  await expect(primary()).toHaveText('0:04.000');
  await expect(secondary()).toHaveText('3.1.000');
  // Escape closes it without a change.
  await page.getByTestId('position-display').click({ button: 'right' });
  await expect(page.getByTestId('time-format-seconds')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(primary()).toHaveText('0:04.000');
  // Back to Bars+Beats; nothing was sent for it.
  await page.getByTestId('position-display').click({ button: 'right' });
  await page.getByTestId('time-format-bars').click();
  await expect(primary()).toHaveText('3.1.000');
  expect(await transportRequests()).toBe(0);
});

test('auto-scroll pages the view while playing, F turns it off, and a held clip drag suspends it', async () => {
  test.setTimeout(150_000);
  await launch();
  const autoScroll = page.getByTestId('auto-scroll');
  await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
  await focusProject();
  const start = await view();
  // 4 s is off-screen at this zoom.
  expect(start.width * start.framesPerPixel).toBeLessThan(4 * RATE);
  expect(start.scrollFrames).toBe('0');

  // On: playback pages the view; the cursor stays in it.
  await locate(0, '1.1.000');
  await page.keyboard.press('Space');
  await expectPlaying(true);
  await expect.poll(async () => Number((await view()).scrollFrames), { timeout: 20_000 }).toBeGreaterThanOrEqual(start.width * start.framesPerPixel);
  const paged = await view();
  const inView = await cursorX();
  expect(inView).toBeGreaterThanOrEqual(0);
  expect(inView).toBeLessThanOrEqual(paged.width);
  await page.keyboard.press('Space');
  await expectPlaying(false);

  // F turns it off: the cursor leaves the view and the view stays.
  await page.keyboard.press('KeyF');
  await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
  const still = await view();
  await page.keyboard.press('Space');
  await expectPlaying(true);
  await expect.poll(cursorX, { timeout: 20_000 }).toBeGreaterThan(still.width);
  expect((await view()).scrollFrames).toBe(still.scrollFrames);
  await page.keyboard.press('Space');
  await expectPlaying(false);

  // On again, from the start with the clip in view; a clip drag held: no page turn.
  await page.keyboard.press('KeyF');
  await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+KeyF');
  await expect.poll(async () => (await view()).scrollFrames).toBe('0');
  await locate(0, '1.1.000');
  const held = await view();
  const target = await rect(CLIP);
  const canvas = await box('timeline-canvas');
  const grab = { x: canvas.x + target.x + target.width / 2, y: canvas.y + target.y + target.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 30, grab.y, { steps: 3 });
  await engine!.call('transport.play');
  await expectPlaying(true);
  await expect.poll(cursorX, { timeout: 20_000 }).toBeGreaterThan(held.width);
  expect((await view()).scrollFrames).toBe('0');
  await page.mouse.up();
  await expect.poll(async () => (await view()).scrollFrames, { timeout: 20_000 }).not.toBe('0');
  await engine!.call('transport.stop');
  await expectPlaying(false);
});

test('Ctrl+Z and Ctrl+Shift+Z undo and redo a clip move; nothing to undo is a toast', async () => {
  test.setTimeout(120_000);
  await launch();
  // A clip move on the canvas.
  const start = await clipPosition();
  const target = await rect(CLIP);
  const canvas = await box('timeline-canvas');
  const grab = { x: canvas.x + target.x + target.width / 2, y: canvas.y + target.y + target.height / 2 };
  let before = await revisions();
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(revisions).toBe(before + 1);
  const moved = await clipPosition();
  expect(moved).not.toBe(start);

  // Undo: one revision, the clip back; redo: one more, moved again.
  await focusProject();
  before = await revisions();
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(revisions).toBe(before + 1);
  expect(await clipPosition()).toBe(start);
  await expect.poll(async () => (await rect(CLIP)).x).toBe(target.x);
  await page.keyboard.press(`${MOD}+Shift+KeyZ`);
  await expect.poll(revisions).toBe(before + 2);
  expect(await clipPosition()).toBe(moved);
  expect(await sentOf('session.redo')).toHaveLength(1);
  expect(await sentOf('session.undo')).toHaveLength(1);
  // The top bar's undo and redo buttons do the same.
  await page.getByTestId('undo').click();
  await expect.poll(revisions).toBe(before + 3);
  expect(await clipPosition()).toBe(start);
  await page.getByTestId('redo').click();
  await expect.poll(revisions).toBe(before + 4);
  expect(await clipPosition()).toBe(moved);
  expect(await sentOf('session.undo')).toHaveLength(2);
  expect(await sentOf('session.redo')).toHaveLength(2);
  await expect(page.getByTestId('toast')).toHaveCount(0);

  // A fresh session (the engine replays a bundle's commits into its undo
  // history, so a new, empty one): the engine refuses, the toast says so.
  engine?.close();
  engine = undefined;
  await app!.close();
  app = await launchApp({ sessionDir: path.join(scratch, 'fresh'), userData: path.join(scratch, 'user-fresh'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await focusProject();
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(async () => (await sentOf('session.undo')).length).toBe(1);
  await expect(page.getByTestId('toast-message')).toContainText('nothing_to_undo');
  const toasts = await page.evaluate(() =>
    (window as unknown as { __siannToasts?: { getSnapshot(): Array<{ text: string }> } }).__siannToasts!.getSnapshot().map((t) => t.text),
  );
  expect(toasts.filter((text) => text.startsWith('nothing_to_undo: '))).toHaveLength(1);
});

test('with no audio device the transport is disabled, its tooltip gives the reason, and Space sends nothing', async () => {
  // Every open of the fake device fails (as shell.spec.ts does), on every build.
  await launch({ engineArgs: ['--fake-open-failures', '1000'] });
  const reason = new RegExp(`^[a-z_]+: ${en['transport.noDevice'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  for (const id of ['transport-play', 'transport-stop', 'transport-to-start']) {
    const button = page.getByTestId(id);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', reason);
  }
  // Undo and redo need no device.
  await expect(page.getByTestId('undo')).toBeEnabled();
  await expect(page.getByTestId('redo')).toBeEnabled();
  await focusProject();
  const polls = (await sentOf('engine.status')).length;
  await page.keyboard.press('Space');
  await page.keyboard.press('NumpadEnter');
  await page.keyboard.press('Comma');
  // A key sends at once; the status bar's next engine.status poll comes after.
  await expect.poll(async () => (await sentOf('engine.status')).length).toBeGreaterThan(polls);
  expect(await transportRequests()).toBe(0);
  await expectPlaying(false);
});

test('a device that opens after a few failed attempts enables the transport once engine.status reports it', async () => {
  test.setTimeout(90_000);
  await launch({ engineArgs: ['--fake-open-failures', '2'] });
  await expect(playButton()).toBeEnabled({ timeout: 30_000 });
  await expect(playButton()).toHaveAttribute('title', en['transport.startStop']);
  await focusProject();
  await page.keyboard.press('Space');
  await expectPlaying(true);
  await page.keyboard.press('Space');
  await expectPlaying(false);
});
