// Editing by Cubase's gestures end to end (m5-ui-edit-basics; UI redesign
// spec 3.1, 3.2, 3.3 and P1-8): the Object Selection and Split tools on 1 and
// 3, Alt-click split, Alt-drag copy, Ctrl-drag constrain, Alt+X, Ctrl+D,
// resizing from the lower corners with Ctrl ignoring snap, the clip volume
// control, snap on J with grid Bar, Beat and Adapt to Zoom, Shift-click,
// Ctrl+A, L, N, B, Alt+S, M and S on the selected tracks, track selection,
// and Shift+Delete with its confirmation.
//
// Every operation is asserted the same way: exactly one new revision (the
// engine's head through a second protocol client), the resulting entities,
// and one session.undo from that client restoring the previous documentHash.
// Bundles are prepared with siann-cli (SIANN_CLI_EXE); the app runs the real
// siann-engine (SIANN_ENGINE_EXE) on the fake device under SIANN_SHELL_TEST=1.
// Waits are Playwright condition waits, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { exeFromEnv, launchApp } from './support/seed';

const RATE = 48000;
// The media: four seconds of square wave.
const MEDIA_FRAMES = RATE * 4;
const BAR = 96000;
const BEAT = 24000;

interface SeedClip {
  readonly clipId: string;
  readonly trackId: string;
  readonly position: number;
  readonly sourceStart?: number;
  readonly length: number;
}

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

function squareWav(file: string): void {
  const data = Buffer.alloc(MEDIA_FRAMES * 2);
  for (let i = 0; i < MEDIA_FRAMES; i += 1) data.writeInt16LE(Math.floor(i / 240) % 2 === 0 ? 16384 : -16384, i * 2);
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

// trk_a, trk_b and trk_c in that order, med_sq, and the clips.
async function launchWith(clips: readonly SeedClip[]): Promise<void> {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-edit-'));
  const sessionDir = path.join(scratch, 'sessions');
  const bundle = path.join(sessionDir, 'Untitled.siann');
  fs.mkdirSync(sessionDir, { recursive: true });
  cli('create', bundle, '--name', 'Edit', '--rate', String(RATE));
  const exec = (command: Record<string, unknown>) => cli('exec', bundle, JSON.stringify(command));
  for (const id of ['trk_a', 'trk_b', 'trk_c']) exec({ op: 'track.add', trackId: id, name: id.slice(4).toUpperCase(), channels: 2 });
  squareWav(path.join(scratch, 'square.wav'));
  cli('import', bundle, path.join(scratch, 'square.wav'), '--media-id', 'med_sq');
  for (const clip of clips) {
    exec({
      op: 'clip.place',
      clipId: clip.clipId,
      trackId: clip.trackId,
      mediaId: 'med_sq',
      position: { domain: 'audio', value: String(clip.position) },
      sourceStart: String(clip.sourceStart ?? 0),
      length: String(clip.length),
    });
  }
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText(String(clips.length));
  engine = await engineClient(page);
}

test.afterEach(async () => {
  engine?.close();
  engine = undefined;
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
  readonly width: number;
}

interface ClipJson {
  readonly id: string;
  readonly trackId: string;
  readonly position: { value: string };
  readonly sourceStart: string;
  readonly length: string;
  readonly gainMilliDb: number;
}

// The test hooks, read with page.evaluate (the CSP allows no eval in the page).
async function hook<T>(name: string, arg?: string): Promise<T> {
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
const selected = () => hook<string[]>('selectedClips');

async function rect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await hook<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  return (await hook<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
}

async function canvas(): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await page.getByTestId('timeline-canvas').boundingBox();
  if (!found) throw new Error('the timeline canvas is not laid out');
  return found;
}

// A canvas point in page coordinates.
async function at(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await canvas();
  return { x: box.x + x, y: box.y + y };
}

async function middle(clipId: string, dx = 0): Promise<{ x: number; y: number }> {
  const r = await rect(clipId);
  return at(r.x + r.width / 2 + dx, r.y + r.height / 2);
}

// An empty spot below the lanes: focuses the project zone and selects nothing.
async function focusProject(): Promise<void> {
  const box = await canvas();
  await page.mouse.click(box.x + 20, box.y + box.height - 10);
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

async function click(point: { x: number; y: number }): Promise<void> {
  await page.mouse.click(point.x, point.y);
}

async function drag(from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

function number(revision: string): number {
  const match = /^r(\d+)$/.exec(revision);
  if (!match) throw new Error(`not a revision: ${revision}`);
  return Number(match[1]);
}

async function head(): Promise<{ revision: string; documentHash: string }> {
  const sync = await engine!.call('session.inspect');
  return { revision: sync.revision as string, documentHash: sync.documentHash as string };
}

async function clips(): Promise<ClipJson[]> {
  const ids = (await hook<Rect[]>('clips')).map((r) => r.clipId);
  const { entities } = (await engine!.call('session.fetch', { refs: ids.map((id) => `clip:${id}`) })) as {
    entities: Array<{ entity?: ClipJson; missing?: boolean }>;
  };
  return entities.filter((e) => !e.missing).map((e) => e.entity!);
}

async function fetchClip(clipId: string): Promise<ClipJson | null> {
  const { entities } = (await engine!.call('session.fetch', { refs: [`clip:${clipId}`] })) as {
    entities: Array<{ entity?: ClipJson; missing?: boolean }>;
  };
  return entities[0]?.missing ? null : (entities[0]?.entity ?? null);
}

// One operation: exactly one new revision, then `check`, then one
// session.undo from the test's client restores the previous documentHash and
// the renderer follows it.
async function operation(name: string, act: () => Promise<void>, check: () => Promise<void>): Promise<void> {
  const before = await head();
  const next = `r${number(before.revision) + 1}`;
  await act();
  await expect(page.getByTestId('revision'), name).toHaveText(next);
  expect((await head()).revision, `${name}: exactly one revision`).toBe(next);
  await check();
  await engine!.call('session.undo');
  const undone = await head();
  expect(undone.revision).toBe(`r${number(before.revision) + 2}`);
  expect(undone.documentHash, `${name}: one undo restores the document`).toBe(before.documentHash);
  await expect(page.getByTestId('revision')).toHaveText(undone.revision);
  await expect(page.getByTestId('timeline-error')).toHaveText('');
}

async function snapState(): Promise<{ on: boolean; grid: string }> {
  return hook('snap');
}

async function setSnap(on: boolean, grid?: 'bar' | 'beat' | 'adapt'): Promise<void> {
  if (grid) await page.getByTestId('grid-type').selectOption(grid);
  if ((await snapState()).on !== on) {
    await focusProject();
    await page.keyboard.press('KeyJ');
  }
  await expect.poll(snapState).toEqual({ on, grid: grid ?? (await snapState()).grid });
}

test('keys 1 and 3 choose the tools; the Split tool and Alt-click split, Alt-drag copies, Ctrl-drag constrains the axis', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_off', trackId: 'trk_a', position: 12000, sourceStart: 24000, length: 48000 },
    { clipId: 'clp_b', trackId: 'trk_b', position: 12000, length: 24000 },
  ]);
  await focusProject();
  await page.keyboard.press('Digit3');
  await expect(page.getByTestId('tool-split')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'false');
  expect(await hook<string>('tool')).toBe('split');

  // The Split tool: a click splits the clip at the (snapped) frame under the pointer.
  const r = await rect('clp_off');
  await operation(
    'split tool',
    async () => click(await at(r.x + 180, r.y + r.height / 2)),
    async () => {
      const all = await clips();
      expect(all).toHaveLength(3);
      const left = all.find((c) => c.id === 'clp_off')!;
      const right = all.find((c) => c.id !== 'clp_off' && c.trackId === 'trk_a')!;
      expect(right.id).toMatch(/^clp_[0-9a-f]{16}$/);
      expect(Number(left.sourceStart)).toBe(24000);
      expect(Number(right.position.value)).toBe(12000 + Number(left.length));
      expect(Number(right.sourceStart)).toBe(Number(left.sourceStart) + Number(left.length));
      expect(Number(left.length) + Number(right.length)).toBe(48000);
    },
  );
  await expect.poll(async () => (await hook<Rect[]>('clips')).length).toBe(2);

  // 1: back to the selection tool; Alt-click splits there.
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tool-split')).toHaveAttribute('aria-pressed', 'false');
  await operation(
    'Alt-click',
    async () => {
      const point = await at(r.x + 300, r.y + r.height / 2);
      await page.keyboard.down('Alt');
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up('Alt');
    },
    async () => {
      const all = (await clips()).filter((c) => c.trackId === 'trk_a');
      expect(all).toHaveLength(2);
      const left = all.find((c) => c.id === 'clp_off')!;
      const right = all.find((c) => c.id !== 'clp_off')!;
      expect(Number(right.sourceStart)).toBe(Number(left.sourceStart) + Number(left.length));
    },
  );
  await expect.poll(async () => (await hook<Rect[]>('clips')).length).toBe(2);

  // Alt-drag copies: the original stays, a new clp_ id appears.
  await operation(
    'Alt-drag',
    async () => {
      await page.keyboard.down('Alt');
      await drag(await middle('clp_b'), 100, 0);
      await page.keyboard.up('Alt');
    },
    async () => {
      const all = await clips();
      expect(all).toHaveLength(3);
      expect((await fetchClip('clp_b'))!.position.value).toBe('12000');
      const copy = all.find((c) => c.id !== 'clp_b' && c.id !== 'clp_off')!;
      expect(copy.id).toMatch(/^clp_[0-9a-f]{16}$/);
      expect(copy.trackId).toBe('trk_b');
      expect(Number(copy.position.value)).toBeGreaterThan(12000);
    },
  );

  // After an Alt press-drag-release a plain key still reaches the renderer
  // (the Windows menu bar does not take the focus on the lone Alt).
  const snapBefore = (await snapState()).on;
  await page.keyboard.press('KeyJ');
  await expect.poll(async () => (await snapState()).on).toBe(!snapBefore);
  await page.keyboard.press('KeyJ');
  await expect.poll(async () => (await snapState()).on).toBe(snapBefore);

  // Ctrl-drag, mostly sideways: the track stays.
  await expect.poll(async () => (await hook<Rect[]>('clips')).length).toBe(2);
  await operation(
    'Ctrl-drag sideways',
    async () => {
      await page.keyboard.down('Control');
      await drag(await middle('clp_b'), 60, 20);
      await page.keyboard.up('Control');
    },
    async () => {
      const moved = (await fetchClip('clp_b'))!;
      expect(moved.trackId).toBe('trk_b');
      expect(Number(moved.position.value)).toBeGreaterThan(12000);
    },
  );
  // Ctrl-drag, mostly down: the position stays.
  const laneB = await rect('clp_b');
  await operation(
    'Ctrl-drag down',
    async () => {
      await page.keyboard.down('Control');
      await drag(await middle('clp_b'), 12, laneB.height);
      await page.keyboard.up('Control');
    },
    async () => {
      const moved = (await fetchClip('clp_b'))!;
      expect(moved.trackId).toBe('trk_c');
      expect(moved.position.value).toBe('12000');
    },
  );
});

test('Alt+X splits the selected clips at the cursor, or every clip under it; Ctrl+D duplicates the selection as one unit', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_a', trackId: 'trk_a', position: 12000, sourceStart: 24000, length: 48000 },
    { clipId: 'clp_b', trackId: 'trk_b', position: 12000, length: 24000 },
    { clipId: 'clp_c', trackId: 'trk_c', position: 30000, length: 24000 },
  ]);
  // The cursor at frame 24000, located by the test's client.
  await engine!.call('transport.locate', { frames: '24000' });
  await expect.poll(() => hook<number | null>('cursorX')).toBe(240);

  await click(await middle('clp_b'));
  await expect.poll(selected).toEqual(['clp_b']);
  await operation(
    'Alt+X with a selection',
    () => page.keyboard.press('Alt+KeyX'),
    async () => {
      const all = await clips();
      expect(all).toHaveLength(4);
      expect((await fetchClip('clp_a'))!.length).toBe('48000');
      expect((await fetchClip('clp_b'))!.length).toBe('12000');
      const right = all.find((c) => c.trackId === 'trk_b' && c.id !== 'clp_b')!;
      expect(right.position.value).toBe('24000');
      expect(right.sourceStart).toBe('12000');
    },
  );

  await focusProject();
  await expect.poll(selected).toEqual([]);
  await operation(
    'Alt+X with nothing selected',
    () => page.keyboard.press('Alt+KeyX'),
    async () => {
      const all = await clips();
      expect(all).toHaveLength(5);
      expect((await fetchClip('clp_a'))!.length).toBe('12000');
      expect((await fetchClip('clp_b'))!.length).toBe('12000');
      expect((await fetchClip('clp_c'))!.length).toBe('24000');
      const rightA = all.find((c) => c.trackId === 'trk_a' && c.id !== 'clp_a')!;
      expect(rightA.sourceStart).toBe('36000');
    },
  );

  // Two clips on two tracks: 12000-36000 and 30000-54000, a span of 42000.
  await click(await middle('clp_b'));
  const c = await middle('clp_c');
  await page.keyboard.down('Shift');
  await page.mouse.click(c.x, c.y);
  await page.keyboard.up('Shift');
  await expect.poll(selected).toEqual(['clp_b', 'clp_c']);
  await operation(
    'Ctrl+D',
    () => page.keyboard.press('ControlOrMeta+KeyD'),
    async () => {
      const all = await clips();
      expect(all).toHaveLength(5);
      const copies = all.filter((x) => !['clp_a', 'clp_b', 'clp_c'].includes(x.id));
      expect(copies.map((x) => [x.trackId, x.position.value]).sort()).toEqual([
        ['trk_b', '54000'],
        ['trk_c', '72000'],
      ]);
    },
  );
});

test('a clip resizes from its lower corners onto the grid, Ctrl ignores snap; the volume control is one clip.set_gain on release, Shift fine', async () => {
  test.setTimeout(150_000);
  await launchWith([{ clipId: 'clp_r', trackId: 'trk_a', position: 24000, sourceStart: 24000, length: 72000 }]);
  await focusProject();
  // 800 frames per pixel: a bar is 120 px.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('KeyG');
  await expect.poll(async () => (await view()).framesPerPixel).toBe(800);
  expect((await view()).scrollFrames).toBe('0');
  await setSnap(true, 'bar');
  // The clip as drawn at the new zoom (the content layer redraws on its next frame).
  await expect.poll(async () => (await rect('clp_r')).width).toBe(90);

  const r = await rect('clp_r');
  const lowerRight = await at(r.x + r.width - 2, r.y + r.height - 3);
  const lowerLeft = await at(r.x + 2, r.y + r.height - 3);
  await operation(
    'lower-right corner',
    () => drag(lowerRight, 100, 0),
    async () => {
      const clip = (await fetchClip('clp_r'))!;
      // The end lands on bar 3 (192000).
      expect(Number(clip.position.value) + Number(clip.length)).toBe(2 * BAR);
      expect(clip.sourceStart).toBe('24000');
    },
  );
  await operation(
    'lower-right corner with Ctrl',
    async () => {
      await page.keyboard.down('Control');
      await drag(lowerRight, 100, 0);
      await page.keyboard.up('Control');
    },
    async () => {
      const clip = (await fetchClip('clp_r'))!;
      expect(Number(clip.length)).toBe(72000 + 100 * 800);
      expect((Number(clip.position.value) + Number(clip.length)) % BAR).not.toBe(0);
    },
  );
  await operation(
    'lower-left corner',
    () => drag(lowerLeft, -20, 0),
    async () => {
      const clip = (await fetchClip('clp_r'))!;
      // The start lands on bar 1 (0); the audio stays where it was.
      expect(clip.position.value).toBe('0');
      expect(clip.sourceStart).toBe('0');
      expect(clip.length).toBe('96000');
    },
  );

  // The volume control just inside the lower-left corner: nothing is sent while held.
  const gainAt = await at(r.x + 12, r.y + r.height - 4);
  const tip = page.getByTestId('drag-tooltip');
  await operation(
    'clip volume',
    async () => {
      const before = await page.getByTestId('revision').textContent();
      await page.mouse.move(gainAt.x, gainAt.y);
      await page.mouse.down();
      await page.mouse.move(gainAt.x, gainAt.y - 10, { steps: 4 });
      await page.mouse.move(gainAt.x, gainAt.y - 20, { steps: 4 });
      await expect(tip).toBeVisible();
      await expect(tip).toContainText('+2.0 dB');
      await expect(tip).toContainText('(+2.0 dB)');
      expect((await head()).revision).toBe(before);
      await page.mouse.up();
    },
    async () => {
      expect((await fetchClip('clp_r'))!.gainMilliDb).toBe(2000);
      await expect(tip).toBeHidden();
    },
  );
  await operation(
    'clip volume with Shift',
    async () => {
      await page.keyboard.down('Shift');
      await drag(gainAt, 0, -20);
      await page.keyboard.up('Shift');
    },
    async () => {
      expect((await fetchClip('clp_r'))!.gainMilliDb).toBe(200);
    },
  );
});

test('J toggles snap; grid Bar and Beat put a dragged clip on their lines; Adapt to Zoom changes the step with the zoom', async () => {
  test.setTimeout(150_000);
  await launchWith([{ clipId: 'clp_s', trackId: 'trk_a', position: 0, length: 24000 }]);
  // Snap is on by default, grid Adapt to Zoom (UI redesign spec 4.5 C10).
  expect(await snapState()).toEqual({ on: true, grid: 'adapt' });
  await focusProject();
  await page.keyboard.press('KeyJ');
  await expect.poll(snapState).toEqual({ on: false, grid: 'adapt' });
  await expect(page.getByTestId('snap-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('KeyJ');
  await expect.poll(snapState).toEqual({ on: true, grid: 'adapt' });
  await expect(page.getByTestId('snap-toggle')).toHaveAttribute('aria-pressed', 'true');

  const dropAt = async (dx: number, expected: (position: number) => void) =>
    operation(
      `drag ${dx} px`,
      async () => drag(await middle('clp_s'), dx, 0),
      async () => expected(Number((await fetchClip('clp_s'))!.position.value)),
    );
  expect((await view()).framesPerPixel).toBe(100);
  await setSnap(true, 'bar');
  await dropAt(500, (position) => expect(position).toBe(BAR));
  await setSnap(true, 'beat');
  await dropAt(130, (position) => expect(position).toBe(BEAT));
  // Adapt to Zoom: 1/64 notes (1500 frames) at 100 frames per pixel, 1/32 notes at 200.
  await setSnap(true, 'adapt');
  await dropAt(17, (position) => expect(position).toBe(1500));
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await view()).framesPerPixel).toBe(200);
  await expect.poll(async () => (await rect('clp_s')).width).toBe(120);
  await dropAt(17, (position) => expect(position).toBe(3000));
});

test('Shift-click adds, Ctrl+A selects all, L, N and B move the cursor, Alt+S fits the selection and sends nothing', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_1', trackId: 'trk_a', position: 6000, length: 24000 },
    { clipId: 'clp_2', trackId: 'trk_b', position: 30000, length: 24000 },
    { clipId: 'clp_3', trackId: 'trk_c', position: 54000, length: 24000 },
  ]);
  // Record what the renderer sends from a fresh page load on.
  const frames: string[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => frames.push(String(frame.payload))));
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');

  const one = await middle('clp_1');
  await page.mouse.click(one.x, one.y);
  const three = await at((await rect('clp_3')).x + 10, (await rect('clp_3')).y + 20);
  await page.keyboard.down('Shift');
  await page.mouse.click(three.x, three.y);
  await page.keyboard.up('Shift');
  await expect.poll(selected).toEqual(['clp_1', 'clp_3']);
  await page.keyboard.press('ControlOrMeta+KeyA');
  await expect.poll(async () => (await selected()).sort()).toEqual(['clp_1', 'clp_2', 'clp_3']);

  // L: the selection's start.
  const two = await middle('clp_2');
  await page.mouse.click(two.x, two.y);
  await expect.poll(selected).toEqual(['clp_2']);
  await page.keyboard.press('KeyL');
  await expect.poll(() => hook<number | null>('cursorX')).toBe(300);
  // Tracks A and C selected: N and B step between their clips only.
  await page.getByTestId('track-header-trk_a').click({ position: { x: 4, y: 4 } });
  await page.getByTestId('track-header-trk_c').click({ position: { x: 4, y: 4 }, modifiers: ['ControlOrMeta'] });
  await focusProject();
  await page.keyboard.press('KeyN');
  await expect.poll(() => hook<number | null>('cursorX')).toBe(540);
  await page.keyboard.press('KeyB');
  await expect.poll(() => hook<number | null>('cursorX')).toBe(60);

  // Alt+S: the whole selection in view, and no request.
  await page.keyboard.press('ControlOrMeta+KeyA');
  await expect.poll(async () => (await selected()).length).toBe(3);
  const sentBefore = frames.length;
  const before = await view();
  await page.keyboard.press('Alt+KeyS');
  await expect.poll(async () => (await view()).framesPerPixel).not.toBe(before.framesPerPixel);
  const fitted = await view();
  const x = (frame: number) => (frame - Number(fitted.scrollFrames)) / fitted.framesPerPixel;
  expect(x(6000)).toBeGreaterThanOrEqual(0);
  expect(x(78000)).toBeLessThanOrEqual(fitted.width);
  expect(x(78000) - x(6000)).toBeGreaterThan(fitted.width * 0.8);
  const sent = frames.slice(sentBefore).filter((f) => !f.includes('"engine.status"'));
  expect(sent, 'Alt+S sends nothing').toEqual([]);
});

test('M and S toggle the selected tracks; Ctrl-click and Shift-click select tracks; Shift+Delete removes them after a confirmation', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_b', trackId: 'trk_b', position: 0, length: 24000 },
    { clipId: 'clp_c', trackId: 'trk_c', position: 0, length: 24000 },
  ]);
  const header = (id: string) => page.getByTestId(`track-header-${id}`);
  await header('trk_a').click({ position: { x: 4, y: 4 } });
  await expect(header('trk_a')).toHaveAttribute('aria-selected', 'true');
  await header('trk_b').click({ position: { x: 4, y: 4 }, modifiers: ['ControlOrMeta'] });
  await expect(header('trk_a')).toHaveAttribute('aria-selected', 'true');
  await expect(header('trk_b')).toHaveAttribute('aria-selected', 'true');
  // Shift-click: the range from the primary (trk_b) to trk_c.
  await header('trk_c').click({ position: { x: 4, y: 4 }, modifiers: ['Shift'] });
  await expect(header('trk_a')).toHaveAttribute('aria-selected', 'false');
  await expect(header('trk_b')).toHaveAttribute('aria-selected', 'true');
  await expect(header('trk_c')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');

  const track = async (id: string) =>
    ((await engine!.call('session.fetch', { refs: [`track:${id}`] })) as { entities: Array<{ entity?: { mute: boolean; solo: boolean }; missing?: boolean }> })
      .entities[0]!;
  await operation(
    'M',
    () => page.keyboard.press('KeyM'),
    async () => {
      expect((await track('trk_b')).entity!.mute).toBe(true);
      expect((await track('trk_c')).entity!.mute).toBe(true);
      expect((await track('trk_a')).entity!.mute).toBe(false);
      await expect(page.getByTestId('track-mute-trk_b')).toHaveAttribute('aria-pressed', 'true');
    },
  );
  await operation(
    'S',
    () => page.keyboard.press('KeyS'),
    async () => {
      expect((await track('trk_b')).entity!.solo).toBe(true);
      expect((await track('trk_c')).entity!.solo).toBe(true);
    },
  );

  // Shift+Delete asks first; Cancel sends nothing.
  const dialog = page.getByTestId('confirm-dialog');
  const unchanged = (await head()).revision;
  await page.keyboard.press('Shift+Delete');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'alertdialog');
  await expect(dialog).toContainText('2');
  await page.getByTestId('confirm-cancel').click();
  await expect(dialog).toBeHidden();
  expect((await head()).revision).toBe(unchanged);
  await expect(page.getByTestId('track-count')).toHaveText('3');

  await focusProject();
  await operation(
    'Shift+Delete, confirmed',
    async () => {
      await page.keyboard.press('Shift+Delete');
      await expect(dialog).toBeVisible();
      await page.getByTestId('confirm-ok').click();
    },
    async () => {
      await expect(page.getByTestId('track-count')).toHaveText('1');
      expect((await track('trk_b')).missing).toBe(true);
      expect(await fetchClip('clp_c')).toBeNull();
    },
  );
  // The one undo brought the tracks and their clips back.
  await expect(page.getByTestId('track-count')).toHaveText('3');
  expect((await track('trk_c')).missing).toBeFalsy();
  expect(await fetchClip('clp_b')).not.toBeNull();
  expect(await fetchClip('clp_c')).not.toBeNull();
});
