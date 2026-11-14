// The track list and the event display end to end (m5-ui-arrange; UI
// redesign spec 2.3, 3.2, 3.3, 5.2): a fixed track list beside a two-layer
// canvas that follows its box and the device pixel ratio; a bars-and-beats
// ruler; zoom and scroll by Cubase's keys, the wheel and the ruler's lower
// half, none of which scrolls or zooms the page; lane heights by the lower
// border of a header (Ctrl: all), kept per session id across a restart; a
// content layer that a moving cursor does not redraw; the read-only info
// line; the selection outline and the drag tooltip; dimming; the empty
// session's guidance in three locales; and the track list / event display
// boundary. Bundles are prepared with siann-cli (SIANN_CLI_EXE); the app runs
// the real siann-engine (SIANN_ENGINE_EXE) on the fake device under
// SIANN_SHELL_TEST=1, which exposes window.__siannTimeline. Commits are read
// back with a second protocol client. Waits are Playwright condition waits,
// never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import { engineClient } from './support/engine-client';
import { exeFromEnv, launchApp } from './support/seed';

const RATE = 48000;
const FRAMES = 48000;
const MOD = 'ControlOrMeta';

interface SeedTrack {
  readonly id: string;
  readonly name: string;
  readonly gain?: number;
  readonly pan?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
}

interface SeedClip {
  readonly clipId: string;
  readonly trackId: string;
  readonly position: number;
  readonly sourceStart?: number;
  readonly length?: number;
  readonly gain?: number;
}

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let sessionDir = '';

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

// A mono 16-bit PCM WAV, a square wave at half scale.
function squareWav(file: string): void {
  const data = Buffer.alloc(FRAMES * 4 * 2);
  for (let i = 0; i < FRAMES * 4; i += 1) data.writeInt16LE(Math.floor(i / 240) % 2 === 0 ? 16384 : -16384, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// A bundle with the tracks, media med_sq (4 s of square wave) and the clips.
function prepare(tracks: readonly SeedTrack[], clips: readonly SeedClip[] = [], root = scratch): void {
  sessionDir = path.join(root, 'sessions');
  const bundle = path.join(sessionDir, 'Untitled.siann');
  fs.mkdirSync(sessionDir, { recursive: true });
  cli('create', bundle, '--name', 'Arrange', '--rate', String(RATE));
  const exec = (command: Record<string, unknown>) => cli('exec', bundle, JSON.stringify(command));
  for (const track of tracks) {
    exec({ op: 'track.add', trackId: track.id, name: track.name, channels: 2 });
    if (track.gain) exec({ op: 'track.set_gain', trackId: track.id, gainMilliDb: track.gain });
    if (track.pan) exec({ op: 'track.set_pan', trackId: track.id, pan: track.pan });
    if (track.mute) exec({ op: 'track.set_mute', trackId: track.id, mute: true });
    if (track.solo) exec({ op: 'track.set_solo', trackId: track.id, solo: true });
  }
  if (clips.length > 0) {
    squareWav(path.join(root, 'square.wav'));
    cli('import', bundle, path.join(root, 'square.wav'), '--media-id', 'med_sq');
  }
  for (const clip of clips) {
    exec({
      op: 'clip.place',
      clipId: clip.clipId,
      trackId: clip.trackId,
      mediaId: 'med_sq',
      position: { domain: 'audio', value: String(clip.position) },
      sourceStart: String(clip.sourceStart ?? 0),
      length: String(clip.length ?? FRAMES),
    });
    if (clip.gain) exec({ op: 'clip.set_gain', clipId: clip.clipId, gainMilliDb: clip.gain });
  }
}

async function launch(options: { languages?: readonly string[]; userData?: string; dir?: string } = {}): Promise<void> {
  app = await launchApp({
    sessionDir: options.dir ?? sessionDir,
    userData: options.userData ?? path.join(scratch, 'user-data'),
    languages: options.languages ?? ['en-US'],
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
}

async function resize(size: { width: number; height: number }): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(width, height);
  }, size);
  await page.setViewportSize(size);
  await expect(page.getByTestId('shell')).toHaveAttribute('data-viewport', `${size.width}x${size.height}`);
}

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-arrange-'));
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

interface Rect {
  readonly clipId: string;
  readonly trackId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface View {
  readonly framesPerPixel: number;
  readonly scrollFrames: string;
  readonly rulerHeight: number;
  readonly laneHeight: number;
  readonly laneHeights?: Record<string, number>;
  readonly scrollY?: number;
  readonly width: number;
  readonly height?: number;
}

type HookName =
  | 'clips'
  | 'view'
  | 'lanes'
  | 'rulerLabels'
  | 'contentDraws'
  | 'overlayDraws'
  | 'cursorX'
  | 'selectionOutline'
  | 'dimmedLanes'
  | 'guidance'
  | 'peakColumns';

// The test hooks, read with page.evaluate (the CSP allows no eval in the page).
async function hook<T>(name: HookName, arg?: string): Promise<T> {
  return page.evaluate(
    ({ name: called, arg: value }) => {
      const hooks = (window as unknown as { __siannTimeline?: Record<string, (a?: string) => unknown> }).__siannTimeline;
      if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return hooks[called]!(value);
    },
    { name, arg },
  ) as Promise<T>;
}

const view = () => hook<View>('view');

async function rect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await hook<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  return (await hook<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
}

async function box(testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await page.getByTestId(testId).boundingBox();
  if (!found) throw new Error(`${testId} is not laid out`);
  return found;
}

// The frame under canvas x, as the canvas computes it.
function frameAt(x: number, v: View): number {
  return Number(v.scrollFrames) + Math.round(x * v.framesPerPixel);
}

function revisionNumber(text: string | null): number {
  const match = /^r(\d+)$/.exec(text ?? '');
  if (!match) throw new Error(`not a revision: ${text}`);
  return Number(match[1]);
}

async function revision(): Promise<number> {
  await expect(page.getByTestId('revision')).toHaveText(/^r\d+$/);
  return revisionNumber(await page.getByTestId('revision').textContent());
}

async function zoomFactor(): Promise<number> {
  return app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());
}

// Nothing scrolled or zoomed the page.
async function pageStill(what: string): Promise<void> {
  const state = await page.evaluate(() => ({
    scrollY: window.scrollY,
    scrollX: window.scrollX,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(state.scrollY, what).toBe(0);
  expect(state.scrollX, what).toBe(0);
  expect(state.scrollHeight, what).toBe(state.clientHeight);
  expect(await zoomFactor(), what).toBe(1);
}

// Clicks an empty spot of the canvas (below the lanes, left of the zoom
// slider), which focuses the project zone and selects nothing.
async function focusProject(): Promise<void> {
  const canvas = await box('timeline-canvas');
  await page.mouse.click(canvas.x + 20, canvas.y + canvas.height - 10);
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

// Every frame the renderer sends from a fresh page load on.
async function recordFrames(): Promise<string[]> {
  const frames: string[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => frames.push(String(frame.payload))));
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  return frames;
}

const ops = (frames: readonly string[], op: string) => frames.filter((f) => f.includes(`"op":"${op}"`));

test('the track list shows each track, clips are never under it, double-click renames and T or + adds a track', async () => {
  test.setTimeout(150_000);
  prepare(
    [
      { id: 'trk_a', name: 'Alpha', gain: -3500, pan: -3500 },
      { id: 'trk_b', name: 'Beta', pan: 4000 },
    ],
    [{ clipId: 'clp_sq', trackId: 'trk_a', position: 0 }],
  );
  await launch();
  const frames = await recordFrames();
  await expect(page.getByTestId('track-count')).toHaveText('2');
  const expected = [
    { id: 'trk_a', number: '1', name: 'Alpha', gain: '-3.5 dB', pan: 'L35' },
    { id: 'trk_b', number: '2', name: 'Beta', gain: '0.0 dB', pan: 'R40' },
  ];
  for (const row of expected) {
    const header = page.getByTestId(`track-header-${row.id}`);
    await expect(header).toBeVisible();
    await expect(page.getByTestId(`track-colour-${row.id}`)).toBeVisible();
    await expect(page.getByTestId(`track-number-${row.id}`)).toHaveText(row.number);
    await expect(page.getByTestId(`track-name-${row.id}`)).toHaveText(row.name);
    await expect(page.getByTestId(`track-mute-${row.id}`)).toHaveText('M');
    await expect(page.getByTestId(`track-solo-${row.id}`)).toHaveText('S');
    await expect(page.getByTestId(`track-gain-${row.id}`)).toHaveText(row.gain);
    await expect(page.getByTestId(`track-pan-${row.id}`)).toHaveText(row.pan);
    await expect(page.getByTestId(`track-meter-${row.id}`)).toBeVisible();
  }
  // The mini meters are one canvas for the column (UI spec 5.1), not one per
  // header, and it spans every header's meter cell.
  const trackList = page.getByTestId('track-list');
  await expect(trackList.locator('canvas')).toHaveCount(1);
  await expect(trackList.getByTestId('track-meters')).toBeVisible();
  const metersBox = await box('track-meters');
  for (const row of expected) {
    const cell = await box(`track-meter-${row.id}`);
    expect(cell.x + cell.width / 2).toBeGreaterThanOrEqual(metersBox.x);
    expect(cell.x + cell.width / 2).toBeLessThanOrEqual(metersBox.x + metersBox.width);
    expect(cell.y).toBeGreaterThanOrEqual(metersBox.y - 1);
    expect(cell.y + cell.height).toBeLessThanOrEqual(metersBox.y + metersBox.height + 1);
  }
  // Scroll so the clip starts left of the canvas: it is cut at the canvas's
  // edge, which is right of the track list, never drawn under it.
  const canvas = await box('timeline-canvas');
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + 100);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await rect('clp_sq')).x).toBeLessThan(0);
  const list = await box('track-list');
  expect((await box('timeline-canvas')).x).toBeGreaterThanOrEqual(list.x + list.width);
  await pageStill('Shift+wheel');

  // Double-click the name, type, Enter: one track.rename, one revision.
  const before = await revision();
  await page.getByTestId('track-name-trk_a').dblclick();
  const field = page.getByTestId('track-rename-trk_a');
  await expect(field).toBeFocused();
  await field.fill('Lead');
  await field.press('Enter');
  await expect(page.getByTestId('track-name-trk_a')).toHaveText('Lead');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  expect(ops(frames, 'track.rename')).toHaveLength(1);

  // T in the project zone, the + button and a double-click on empty space
  // (spec 3.3): one track.add each.
  await focusProject();
  await page.keyboard.press('KeyT');
  await expect(page.getByTestId('track-count')).toHaveText('3');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 2}`);
  await page.getByTestId('track-add').click();
  await expect(page.getByTestId('track-count')).toHaveText('4');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 3}`);
  const adds = ops(frames, 'track.add');
  expect(adds).toHaveLength(2);
  for (const add of adds) expect(add).toMatch(/"trackId":"trk_[0-9a-f]{16}"/);
  expect(adds.join(' ')).toContain('"channels":2');
  await expect(page.getByTestId('track-list').getByText('Audio 1', { exact: true })).toBeVisible();
  await expect(page.getByTestId('track-list').getByText('Audio 2', { exact: true })).toBeVisible();

  // Double-click on the empty space below the headers: one more track.add.
  // A double-click on a header (not its name) adds nothing.
  const body = await box('track-list-body');
  const headers = await box('track-header-trk_a');
  await page.getByTestId('track-header-trk_a').dblclick({ position: { x: headers.width - 30, y: 4 } });
  await expect(page.getByTestId('track-count')).toHaveText('4');
  await page.mouse.dblclick(body.x + body.width / 2, body.y + body.height - 10);
  await expect(page.getByTestId('track-count')).toHaveText('5');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 4}`);
  expect(ops(frames, 'track.add')).toHaveLength(3);
  await expect(page.getByTestId('track-list').getByText('Audio 3', { exact: true })).toBeVisible();

  // T typed in the rename field adds nothing.
  await page.getByTestId('track-name-trk_b').dblclick();
  await page.getByTestId('track-rename-trk_b').fill('');
  await page.getByTestId('track-rename-trk_b').press('KeyT');
  await expect(page.getByTestId('track-rename-trk_b')).toHaveValue('t');
  await page.getByTestId('track-rename-trk_b').press('Escape');
  await expect(page.getByTestId('track-name-trk_b')).toHaveText('Beta');
  await expect(page.getByTestId('track-count')).toHaveText('5');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 4}`);
  expect(ops(frames, 'track.add')).toHaveLength(3);
});

test('the canvas is the event display\'s box in device pixels after a resize and a boundary drag; the ruler is bars, then beats zoomed in', async () => {
  prepare([{ id: 'trk_a', name: 'Alpha' }], [{ clipId: 'clp_sq', trackId: 'trk_a', position: 0 }]);
  await launch();
  const check = async (what: string) => {
    await expect
      .poll(async () => {
        const display = await box('event-display');
        const canvas = await box('timeline-canvas');
        const content = await box('timeline-content');
        return [canvas, content].every(
          (b) => Math.abs(b.x - display.x) < 1 && Math.abs(b.y - display.y) < 1 && Math.abs(b.width - display.width) < 1 && Math.abs(b.height - display.height) < 1,
        );
      }, { message: what })
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          ['timeline-canvas', 'timeline-content'].every((id) => {
            const el = document.querySelector<HTMLCanvasElement>(`[data-testid="${id}"]`)!;
            const r = el.getBoundingClientRect();
            return el.width === Math.round(r.width * devicePixelRatio) && el.height === Math.round(r.height * devicePixelRatio);
          }),
        ),
      { message: `${what}: backing store` })
      .toBe(true);
    expect((await view()).width).toBe(Math.round((await box('event-display')).width));
  };
  await check('at start');
  await resize({ width: 1200, height: 800 });
  await check('after a resize');
  const divider = await box('separator-tracklist');
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 40);
  await page.mouse.down();
  await page.mouse.move(divider.x + 60, divider.y + 40, { steps: 5 });
  await page.mouse.up();
  await check('after the track list boundary moved');
  await pageStill('resize');

  // Zoomed out: bar numbers only; zoomed in: beats and subdivisions too.
  await focusProject();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('KeyG');
  await expect.poll(async () => (await hook<string[]>('rulerLabels')).every((l) => /^\d+$/.test(l))).toBe(true);
  expect((await hook<string[]>('rulerLabels')).slice(0, 2)).toEqual(['1', expect.stringMatching(/^\d+$/)]);
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('KeyH');
  await expect.poll(async () => (await hook<string[]>('rulerLabels')).some((l) => /^\d+\.\d+/.test(l))).toBe(true);
  await pageStill('H and G');
});

test('H, G, Ctrl+wheel and a drag in the ruler\'s lower half zoom about the pointer or cursor; Shift+H, Shift+G and Ctrl+Shift+wheel change heights; Shift+F; Shift+wheel', async () => {
  test.setTimeout(150_000);
  prepare(
    [
      { id: 'trk_a', name: 'Alpha' },
      { id: 'trk_b', name: 'Beta' },
    ],
    [
      { clipId: 'clp_1', trackId: 'trk_a', position: 0 },
      { clipId: 'clp_2', trackId: 'trk_b', position: 30 * RATE },
    ],
  );
  await launch();
  await focusProject();
  const canvas = await box('timeline-canvas');

  // Ctrl+wheel at the pointer.
  const px = 250;
  await page.mouse.move(canvas.x + px, canvas.y + 120);
  let before = await view();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await view()).framesPerPixel).not.toBe(before.framesPerPixel);
  let after = await view();
  expect(after.framesPerPixel).toBeLessThan(before.framesPerPixel);
  expect(Math.abs(frameAt(px, after) - frameAt(px, before))).toBeLessThanOrEqual(1);
  await pageStill('Ctrl+wheel');

  // H and G with the project cursor in view: about the cursor.
  const engine = await engineClient(page);
  await engine.call('transport.locate', { frames: String(Number(after.scrollFrames) + Math.round(100 * after.framesPerPixel)) });
  await expect.poll(async () => hook<number | null>('cursorX')).not.toBeNull();
  await expect.poll(async () => Math.round((await hook<number>('cursorX')) ?? -1)).toBe(100);
  for (const key of ['KeyH', 'KeyG']) {
    before = await view();
    await page.keyboard.press(key);
    await expect.poll(async () => (await view()).framesPerPixel).not.toBe(before.framesPerPixel);
    await expect.poll(async () => Math.abs((await hook<number>('cursorX')) - 100)).toBeLessThanOrEqual(1);
    await pageStill(key);
  }
  // The cursor out of view: about the view's centre.
  before = await view();
  await engine.call('transport.locate', { frames: String(Number(before.scrollFrames) + Math.round((before.width + 500) * before.framesPerPixel)) });
  await expect.poll(async () => (await hook<number>('cursorX')) > before.width).toBe(true);
  const centre = before.width / 2;
  await page.keyboard.press('KeyH');
  await expect.poll(async () => (await view()).framesPerPixel).not.toBe(before.framesPerPixel);
  after = await view();
  expect(Math.abs(frameAt(centre, after) - frameAt(centre, before))).toBeLessThanOrEqual(1);
  engine.close();

  // A vertical drag in the lower half of the ruler: down zooms in about the pointer.
  before = await view();
  const rulerY = canvas.y + before.rulerHeight * 0.75;
  await page.mouse.move(canvas.x + px, rulerY);
  await page.mouse.down();
  await page.mouse.move(canvas.x + px, rulerY + 40, { steps: 5 });
  await page.mouse.up();
  after = await view();
  expect(after.framesPerPixel).toBeLessThan(before.framesPerPixel);
  expect(Math.abs(frameAt(px, after) - frameAt(px, before))).toBeLessThanOrEqual(1);
  await pageStill('ruler drag');

  // Track heights: Shift+H, Shift+G, Ctrl+Shift+wheel; the zoom stays.
  const height = async () => (await view()).laneHeights?.trk_a ?? (await view()).laneHeight;
  before = await view();
  const h0 = await height();
  await page.keyboard.press('Shift+KeyH');
  await expect.poll(height).toBeGreaterThan(h0);
  const h1 = await height();
  expect((await view()).laneHeights?.trk_b).toBe(h1);
  await page.keyboard.press('Shift+KeyG');
  await expect.poll(height).toBeLessThan(h1);
  await page.mouse.move(canvas.x + px, canvas.y + 120);
  const h2 = await height();
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await expect.poll(height).toBeGreaterThan(h2);
  // A real mouse on Windows and Linux: Chromium turns a vertical wheel with
  // Shift held into deltaX (CDP does not apply that swap, so send it as such).
  const h3 = await height();
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.wheel(100, 0);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await expect.poll(height).toBeLessThan(h3);
  expect((await view()).framesPerPixel).toBe(before.framesPerPixel);
  expect((await view()).scrollFrames).toBe(before.scrollFrames);
  await pageStill('heights');

  // Shift+F: the whole session in the width.
  await page.keyboard.press('Shift+KeyF');
  await expect.poll(async () => (await view()).scrollFrames).toBe('0');
  const full = await view();
  // The clip rectangles are the next content frame's.
  const end = async () => (await rect('clp_2')).x + (await rect('clp_2')).width;
  await expect.poll(end).toBeLessThanOrEqual(full.width);
  expect(await end()).toBeGreaterThan(full.width / 2);
  await pageStill('Shift+F');

  // Shift+wheel: the horizontal scroll only.
  before = await view();
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await view()).scrollFrames).not.toBe(before.scrollFrames);
  after = await view();
  expect(after.framesPerPixel).toBe(before.framesPerPixel);
  expect(after.laneHeights).toEqual(before.laneHeights);
  expect(after.scrollY ?? 0).toBe(before.scrollY ?? 0);
  await pageStill('Shift+wheel');
});

// Heights are kept per session id (spec 2.3). The engine names a session
// anew each time it opens a bundle (protocol_server.cpp: "ses_" + random
// hex), so they survive a reload of the window on the same engine, and a
// session opened under another id starts from the defaults.
test('dragging a header\'s lower border sizes that lane, Ctrl-drag sizes all; heights stay with the session id', async () => {
  prepare([
    { id: 'trk_a', name: 'Alpha' },
    { id: 'trk_b', name: 'Beta' },
    { id: 'trk_c', name: 'Gamma' },
  ]);
  const userData = path.join(scratch, 'user-data');
  await launch({ userData });
  const drag = async (trackId: string, dy: number, ctrl = false) => {
    const handle = await box(`track-resize-${trackId}`);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    if (ctrl) await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
    if (ctrl) await page.keyboard.up('Control');
  };
  const heights = async () => {
    const v = await view();
    return ['trk_a', 'trk_b', 'trk_c'].map((id) => v.laneHeights?.[id] ?? v.laneHeight);
  };
  expect(await heights()).toEqual([53, 53, 53]);
  await drag('trk_b', 40);
  await expect.poll(heights).toEqual([53, 93, 53]);
  // The header follows its lane.
  expect(Math.round((await box('track-header-trk_b')).height)).toBe(93);
  await drag('trk_a', 20, true);
  await expect.poll(heights).toEqual([73, 73, 73]);
  await pageStill('height drag');

  const sessionId = await page.getByTestId('session-id').textContent();
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('session-id')).toHaveText(sessionId ?? '');
  await expect(page.getByTestId('track-count')).toHaveText('3');
  await expect.poll(heights).toEqual([73, 73, 73]);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('siann.layout.v1') ?? '{}') as { trackHeights?: Record<string, unknown> });
  expect(stored.trackHeights?.[sessionId ?? '']).toEqual({ trk_a: 73, trk_b: 73, trk_c: 73 });

  // Another bundle opened is another session id: the defaults.
  const otherScratch = path.join(scratch, 'other');
  fs.mkdirSync(otherScratch);
  const keep = sessionDir;
  prepare([
    { id: 'trk_a', name: 'Alpha' },
    { id: 'trk_b', name: 'Beta' },
    { id: 'trk_c', name: 'Gamma' },
  ], [], otherScratch);
  sessionDir = keep;
  const engine = await engineClient(page);
  await engine.call('session.open', { path: path.join(otherScratch, 'sessions', 'Untitled.siann') });
  engine.close();
  await expect(page.getByTestId('session-id')).not.toHaveText(sessionId ?? '');
  await expect.poll(heights).toEqual([53, 53, 53]);
});

test('while playing with no edits the content layer is not redrawn and the overlay is', async () => {
  prepare([{ id: 'trk_a', name: 'Alpha' }], [{ clipId: 'clp_sq', trackId: 'trk_a', position: 0 }]);
  await launch();
  await expect.poll(async () => (await hook<{ drawn: number }>('peakColumns', 'clp_sq')).drawn).toBeGreaterThan(0);
  const engine = await engineClient(page);
  await engine.call('transport.play');
  await expect.poll(async () => (await hook<number | null>('cursorX')) ?? 0).toBeGreaterThan(0);
  // The track's mini meter draws the engine's meter frames and lights while
  // the square wave plays (checked first: the clip is 4 s long).
  const meters = page.getByTestId('track-meters');
  await expect.poll(async () => Number((await meters.getAttribute('data-lit')) ?? '0')).toBeGreaterThan(0);
  const drawnFrames = async () => Number((await meters.getAttribute('data-frames')) ?? '0');
  const firstDrawn = await drawnFrames();
  expect(firstDrawn).toBeGreaterThan(0);
  await expect.poll(drawnFrames).toBeGreaterThan(firstDrawn);
  const content = await hook<number>('contentDraws');
  const overlay = await hook<number>('overlayDraws');
  await expect.poll(async () => hook<number>('overlayDraws'), { timeout: 20_000 }).toBeGreaterThan(overlay + 20);
  expect(await hook<number>('contentDraws')).toBe(content);
  await engine.call('transport.stop');
  engine.close();
});

test('the info line shows the selected clip read-only, and nothing with no selection', async () => {
  prepare([{ id: 'trk_a', name: 'Alpha' }], [{ clipId: 'clp_x', trackId: 'trk_a', position: 96000, sourceStart: 24000, length: 48000, gain: -3500 }]);
  await launch();
  const line = page.getByTestId('info-line');
  for (const field of ['start', 'end', 'length', 'offset', 'gain']) await expect(page.getByTestId(`info-${field}`)).toHaveText('');
  // The whole session in view, so the clip can be clicked.
  await focusProject();
  await page.keyboard.press('Shift+KeyF');
  await expect.poll(async () => (await view()).scrollFrames).toBe('0');
  await expect.poll(async () => (await rect('clp_x')).x + (await rect('clp_x')).width).toBeLessThanOrEqual((await view()).width);
  const target = await rect('clp_x');
  const canvas = await box('timeline-canvas');
  await page.mouse.click(canvas.x + target.x + target.width / 2, canvas.y + target.y + target.height / 2);
  // 120 BPM: a bar is 96000 frames, a beat 24000.
  await expect(page.getByTestId('info-start')).toHaveText('2.1.000');
  await expect(page.getByTestId('info-end')).toHaveText('2.3.000');
  await expect(page.getByTestId('info-length')).toHaveText('0.2.000');
  await expect(page.getByTestId('info-offset')).toHaveText('0.1.000');
  await expect(page.getByTestId('info-gain')).toHaveText('-3.5 dB');
  await expect(line).toHaveAttribute('data-clip', 'clp_x');
  expect(await line.locator('input, textarea, select, [contenteditable="true"]').count()).toBe(0);
  await focusProject();
  for (const field of ['start', 'end', 'length', 'offset', 'gain']) await expect(page.getByTestId(`info-${field}`)).toHaveText('');
  await expect(line).toHaveAttribute('data-clip', '');
});

test('a selected clip has a 2 px outline, a drag shows a tooltip, and move, trim, place and delete commit one revision each', async () => {
  test.setTimeout(120_000);
  prepare(
    [
      { id: 'trk_a', name: 'Alpha' },
      { id: 'trk_b', name: 'Beta' },
    ],
    [{ clipId: 'clp_sq', trackId: 'trk_a', position: 0 }],
  );
  await launch();
  const canvas = await box('timeline-canvas');
  let start = await rect('clp_sq');
  const mid = { x: canvas.x + start.x + start.width / 2, y: canvas.y + start.y + start.height / 2 };
  await page.mouse.click(mid.x, mid.y);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_sq');
  await expect.poll(() => hook<number>('selectionOutline')).toBe(2);

  // Move, with the tooltip mid-drag.
  let before = await revision();
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 60, mid.y, { steps: 6 });
  const tip = page.getByTestId('drag-tooltip');
  await expect(tip).toBeVisible();
  const fpp = (await view()).framesPerPixel;
  // 60 px at the zoom from frame 0: the new position and the delta in bars.beats.ticks.
  const ticks = Math.round((60 * fpp) / 12.5);
  const bbt = `1.${Math.floor(ticks / 1920) + 1}.${String(ticks % 1920).padStart(3, '0')}`;
  await expect(tip).toContainText(bbt);
  await expect(tip).toContainText('+');
  await page.mouse.up();
  await expect(tip).toBeHidden();
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);

  // Trim the right edge. The revision label updates with the document, the
  // clip rects on the canvas's next frame: wait for the moved clip to be drawn
  // before reading it (a slower frame, e.g. at a 150 % display scale, read the
  // pre-move rect here).
  const unmoved = start.x;
  await expect.poll(async () => (await rect('clp_sq')).x).toBeGreaterThan(unmoved);
  start = await rect('clp_sq');
  before = await revision();
  const edge = { x: canvas.x + start.x + start.width - 2, y: canvas.y + start.y + start.height / 2 };
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x - 40, edge.y, { steps: 5 });
  await expect(tip).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  await expect.poll(async () => (await rect('clp_sq')).width).toBeLessThan(start.width);

  // Place from the media pool on the second lane.
  before = await revision();
  await page.getByTestId('pool-med_sq').click();
  const v = await view();
  await page.mouse.click(canvas.x + 300, canvas.y + v.rulerHeight + (v.laneHeights?.trk_a ?? v.laneHeight) + 10);
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);

  // Delete the selected clip with the Delete key.
  before = await revision();
  start = await rect('clp_sq');
  await page.mouse.click(canvas.x + start.x + start.width / 2, canvas.y + start.y + start.height / 2);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_sq');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
});

test('muted and implicitly muted tracks are dimmed; an empty session shows guidance in three locales', async () => {
  test.setTimeout(150_000);
  prepare([
    { id: 'trk_a', name: 'Alpha', mute: true },
    { id: 'trk_b', name: 'Beta', solo: true },
    { id: 'trk_c', name: 'Gamma' },
  ]);
  await launch();
  await expect(page.getByTestId('track-count')).toHaveText('3');
  await expect(page.getByTestId('track-header-trk_a')).toHaveAttribute('data-dimmed', 'true');
  await expect(page.getByTestId('track-header-trk_c')).toHaveAttribute('data-dimmed', 'true');
  await expect(page.getByTestId('track-header-trk_b')).not.toHaveAttribute('data-dimmed', 'true');
  await expect.poll(async () => (await hook<string[]>('dimmedLanes')).sort()).toEqual(['trk_a', 'trk_c']);
  expect(await hook<string | null>('guidance')).toBeNull();
  await app!.close();
  app = undefined;

  for (const [language, catalog] of [
    ['en-US', en],
    ['zh-TW', zhHant],
    ['zh-CN', zhHans],
  ] as const) {
    const empty = path.join(scratch, `empty-${language}`);
    fs.mkdirSync(empty, { recursive: true });
    await launch({ dir: empty, languages: [language], userData: path.join(scratch, `user-${language}`) });
    await expect(page.getByTestId('track-count')).toHaveText('0');
    await expect.poll(() => hook<string | null>('guidance')).toBe(catalog['timeline.empty']);
    await app!.close();
    app = undefined;
  }
});

test('the track list boundary drags within 140-420, never collapses, takes the keys, restores 216 and is kept in siann.layout.v1 only', async () => {
  test.setTimeout(150_000);
  prepare([{ id: 'trk_a', name: 'Alpha' }]);
  const userData = path.join(scratch, 'user-data');
  await launch({ userData });
  const frames = await recordFrames();
  const width = async () => Math.round((await box('track-list')).width);
  const separator = page.getByTestId('separator-tracklist');
  await expect(separator).toHaveAttribute('role', 'separator');
  await expect(separator).toHaveAttribute('aria-valuemin', '140');
  await expect(separator).toHaveAttribute('aria-valuemax', '420');
  await expect(separator).toHaveAttribute('aria-valuenow', '216');
  expect(await width()).toBe(216);
  const dragBy = async (dx: number) => {
    const b = await box('separator-tracklist');
    await page.mouse.move(b.x + b.width / 2, b.y + 60);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + 60, { steps: 4 });
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + 60, { steps: 4 });
    await page.mouse.up();
  };
  await dragBy(500);
  await expect.poll(width).toBe(420);
  await dragBy(-1000);
  await expect.poll(width).toBe(140);
  await expect(page.getByTestId('track-name-trk_a')).toBeVisible();
  await expect(page.getByTestId('track-mute-trk_a')).toBeVisible();
  await expect(page.getByTestId('track-solo-trk_a')).toBeVisible();
  await separator.dblclick();
  await expect.poll(width).toBe(216);

  // Real key presses from the project zone reach it.
  for (let i = 0; i < 6 && (await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)) !== 'zone-project'; i += 1) {
    await page.keyboard.press('F6');
  }
  await page.keyboard.press('Enter');
  for (let i = 0; i < 40; i += 1) {
    const id = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid);
    if (id === 'separator-tracklist') break;
    await page.keyboard.press('Tab');
  }
  await expect(separator).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(224);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(width).toBe(192);
  await page.keyboard.press('Home');
  await expect.poll(width).toBe(140);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(140);
  await page.keyboard.press('End');
  await expect.poll(width).toBe(420);
  await page.keyboard.press('Enter');
  await expect.poll(width).toBe(216);
  // The keys were the boundary's: no zone toggled, no track added.
  await expect(page.getByTestId('track-count')).toHaveText('1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(232);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('siann.layout.v1') ?? '{}') as { trackList?: number });
  expect(stored.trackList).toBe(232);
  expect(frames.filter((f) => f.includes('trackList'))).toEqual([]);

  await app!.close();
  app = undefined;
  await launch({ userData });
  await expect.poll(width).toBe(232);
});
