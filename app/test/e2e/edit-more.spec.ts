// The rest of Cubase's editing end to end (m5b-ui-edit-more; UI redesign spec
// 3.2 "Tools", "Clip handles", "Editing" and "Snap types", 3.6): the Glue and
// Erase tools on 4 and 5 (a glue after a split restores the clip, a refused
// glue is a toast, Alt-click glues the run, a click on a selected clip glues
// the selection's runs), cut, copy and paste at the cursor and at the origin,
// Ctrl+K and the repeat handle, the nudges of the key-command table, the info
// line's editing, the snap types Events and Magnetic Cursor on a drag, the
// rubber band and Ctrl+Shift+A, and an engine without clip.remove.
//
// Every edit is asserted as in edit-basics.spec.ts: exactly one new revision
// (the engine's head through a second protocol client), the resulting
// entities, and one session.undo restoring the previous documentHash. Mod is
// Playwright's ControlOrMeta (edit-basics-mod-keys.test.ts checks this file
// too). Bundles are prepared with siann-cli (SIANN_CLI_EXE); the app runs the
// real siann-engine (SIANN_ENGINE_EXE) on the fake device under
// SIANN_SHELL_TEST=1. Waits are Playwright condition waits, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { exeFromEnv, launchApp } from './support/seed';
import { chooseGrid, chooseSnapType } from './support/toolbar';

const RATE = 48000;
// The media: four seconds of square wave.
const MEDIA_FRAMES = RATE * 4;
const BAR = 96000;
// The title strip and the box's insets of draw()'s clip() (geometry.ts).
const TITLE = 13;

interface SeedClip {
  readonly clipId: string;
  readonly trackId: string;
  readonly position: number;
  readonly sourceStart?: number;
  readonly length: number;
}

let scratch = '';
let bundle = '';
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
async function launchWith(clips: readonly SeedClip[], env: Record<string, string> = {}): Promise<void> {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-edit-more-'));
  const sessionDir = path.join(scratch, 'sessions');
  bundle = path.join(sessionDir, 'Untitled.siann');
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
  await start(sessionDir, clips.length, env);
}

async function start(sessionDir: string, clipCount: number, env: Record<string, string> = {}, tools = true): Promise<void> {
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  if (tools) await expect(page.getByTestId('tool-glue')).toBeVisible();
  else await expect(page.getByTestId('tool-select')).toBeVisible();
  await expect(page.getByTestId('undo')).toBeVisible();
  await expect(page.getByTestId('clip-count')).toHaveText(String(clipCount));
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
  readonly position: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface View {
  readonly framesPerPixel: number;
  readonly scrollFrames: string;
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

async function at(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await canvas();
  return { x: box.x + x, y: box.y + y };
}

async function middle(clipId: string, dx = 0): Promise<{ x: number; y: number }> {
  const r = await rect(clipId);
  return at(r.x + r.width / 2 + dx, r.y + r.height / 2);
}

// The repeat handle of a clip (draw()'s disc on the right border, half way
// down below the title strip), one pixel inside the box.
async function repeatHandle(clipId: string): Promise<{ x: number; y: number }> {
  const r = await rect(clipId);
  const top = r.y + 3;
  const height = r.height - 7;
  return at(r.x + r.width - 1 - 1.5, top + TITLE + (height - TITLE) / 2);
}

async function focusProject(): Promise<void> {
  const box = await canvas();
  await page.mouse.click(box.x + 20, box.y + box.height - 10);
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

async function click(point: { x: number; y: number }, modifiers: Array<'Alt' | 'Shift'> = []): Promise<void> {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(point.x, point.y);
  for (const key of modifiers) await page.keyboard.up(key);
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
  const sync = (await engine!.call('session.sync')) as { chunk: { clips?: ClipJson[] }; next: string | null };
  expect(sync.next).toBeNull();
  return sync.chunk.clips ?? [];
}

const on = async (trackId: string) => (await clips()).filter((c) => c.trackId === trackId).sort((a, b) => Number(a.position.value) - Number(b.position.value));

async function fetchClip(clipId: string): Promise<ClipJson | null> {
  const { entities } = (await engine!.call('session.fetch', { refs: [`clip:${clipId}`] })) as {
    entities: Array<{ entity?: ClipJson; missing?: boolean }>;
  };
  return entities[0]?.missing ? null : (entities[0]?.entity ?? null);
}

async function painted(): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// One operation: exactly one new revision, then `check`, then one
// session.undo from the test's client restores the previous documentHash.
async function operation(name: string, act: () => Promise<void>, check: () => Promise<void>, undo = true): Promise<void> {
  const before = await head();
  const next = `r${number(before.revision) + 1}`;
  await act();
  await expect(page.getByTestId('revision'), name).toHaveText(next);
  expect((await head()).revision, `${name}: exactly one revision`).toBe(next);
  await check();
  if (!undo) return;
  await engine!.call('session.undo');
  const undone = await head();
  expect(undone.revision).toBe(`r${number(before.revision) + 2}`);
  expect(undone.documentHash, `${name}: one undo restores the document`).toBe(before.documentHash);
  await expect(page.getByTestId('revision')).toHaveText(undone.revision);
  await expect(page.getByTestId('timeline-error')).toHaveText('');
  await painted();
}

async function tool(digit: 1 | 3 | 4 | 5, testid: string, name: string): Promise<void> {
  await focusProject();
  await page.keyboard.press(`Digit${digit}`);
  await expect(page.getByTestId(testid)).toHaveAttribute('aria-pressed', 'true');
  expect(await hook<string>('tool')).toBe(name);
}

async function select(...ids: string[]): Promise<void> {
  await click(await middle(ids[0]!));
  for (const id of ids.slice(1)) await click(await middle(id), ['Shift']);
  await expect.poll(selected).toEqual(ids);
}

async function locate(frames: number): Promise<void> {
  await engine!.call('transport.locate', { frames: String(frames) });
  const v = await view();
  await expect.poll(() => hook<number | null>('cursorX')).toBe((frames - Number(v.scrollFrames)) / v.framesPerPixel);
}

async function setSnap(on: boolean, grid?: 'bar' | 'beat' | 'adapt'): Promise<void> {
  if (grid) await chooseGrid(page, grid);
  if ((await hook<{ on: boolean }>('snap')).on !== on) {
    await focusProject();
    await page.keyboard.press('KeyJ');
  }
  await expect.poll(async () => (await hook<{ on: boolean }>('snap')).on).toBe(on);
}

// The view starts at 100 frames per pixel: every clip below lies in the first
// 600 px of the event display. Three continuous pieces of med_sq on trk_a (a
// split clip), and two on trk_b with a gap between them.
const PIECES: readonly SeedClip[] = [
  { clipId: 'clp_p1', trackId: 'trk_a', position: 6000, sourceStart: 0, length: 12000 },
  { clipId: 'clp_p2', trackId: 'trk_a', position: 18000, sourceStart: 12000, length: 12000 },
  { clipId: 'clp_p3', trackId: 'trk_a', position: 30000, sourceStart: 24000, length: 12000 },
  { clipId: 'clp_q1', trackId: 'trk_b', position: 6000, sourceStart: 0, length: 12000 },
  { clipId: 'clp_q2', trackId: 'trk_b', position: 30000, sourceStart: 18000, length: 12000 },
];

test('keys 4 and 5 choose Glue and Erase; tool-4 and tool-5 are in the window; a glue after a split restores the document', async () => {
  test.setTimeout(150_000);
  await launchWith([{ clipId: 'clp_g', trackId: 'trk_a', position: 12000, length: 36000 }]);
  await expect(page.locator('[data-part="tool-4"]')).toHaveCount(1);
  await expect(page.locator('[data-part="tool-5"]')).toHaveCount(1);
  await expect(page.locator('[data-part="tool-4"]')).toHaveAttribute('data-testid', 'tool-glue');
  await tool(4, 'tool-glue', 'glue');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'false');
  await tool(5, 'tool-erase', 'erase');
  await tool(3, 'tool-split', 'split');
  // A click with the Split tool splits; then the Glue tool joins the pieces again.
  const presplit = await head();
  const r = await rect('clp_g');
  await click(await at(r.x + r.width / 2, r.y + r.height / 2));
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  const split = await head();
  expect(number(split.revision)).toBe(number(presplit.revision) + 1);
  await tool(4, 'tool-glue', 'glue');
  await operation(
    'glue after a split',
    async () => click(await middle('clp_g', -10)),
    async () => {
      const all = await clips();
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe('clp_g');
      expect(all[0]!.length).toBe('36000');
      expect((await head()).documentHash, 'the glue gives back the document before the split').toBe(presplit.documentHash);
    },
  );
  expect((await head()).documentHash).toBe(split.documentHash);
});

test('a refused glue shows a toast and sends nothing; Alt-click glues the run; a click on a selected clip glues the selection\'s runs', async () => {
  test.setTimeout(150_000);
  await launchWith(PIECES);
  await tool(4, 'tool-glue', 'glue');
  // clp_q1 and clp_q2 have a gap between them.
  const before = await head();
  await click(await middle('clp_q1'));
  await expect(page.getByTestId('toast-message').last()).toHaveText(/glue/i);
  expect((await head()).revision, 'no revision').toBe(before.revision);
  await expect(page.getByTestId('revision')).toHaveText(before.revision);

  await operation(
    'Alt-click glue',
    async () => click(await middle('clp_p1'), ['Alt']),
    async () => {
      const a = await on('trk_a');
      expect(a.map((c) => [c.id, c.position.value, c.sourceStart, c.length])).toEqual([['clp_p1', '6000', '0', '36000']]);
    },
  );
  await expect.poll(async () => (await hook<Rect[]>('clips')).length).toBe(5);

  // Select p1 and p2 (not p3) and the two trk_b pieces: a click on a selected clip glues p1+p2, the rest are refused singletons.
  await tool(1, 'tool-select', 'select');
  await select('clp_p1', 'clp_p2', 'clp_q1');
  // The project zone has the focus from the clicks: 4 without a click elsewhere, which would clear the selection.
  await page.keyboard.press('Digit4');
  await expect(page.getByTestId('tool-glue')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(selected).toEqual(['clp_p1', 'clp_p2', 'clp_q1']);
  await operation(
    'glue of a selection',
    async () => click(await middle('clp_p2')),
    async () => {
      const a = await on('trk_a');
      expect(a.map((c) => [c.id, c.length])).toEqual([
        ['clp_p1', '24000'],
        ['clp_p3', '12000'],
      ]);
      expect(await on('trk_b')).toHaveLength(2);
    },
  );
});

test('Erase removes the clicked clip; Ctrl+X cuts the selection', async () => {
  test.setTimeout(150_000);
  await launchWith(PIECES);
  await tool(5, 'tool-erase', 'erase');
  await operation(
    'erase',
    async () => click(await middle('clp_q2')),
    async () => expect(await fetchClip('clp_q2')).toBeNull(),
  );
  await tool(1, 'tool-select', 'select');
  await expect.poll(async () => (await hook<Rect[]>('clips')).length).toBe(5);
  await select('clp_p1', 'clp_q1');
  await operation(
    'Ctrl+X',
    async () => page.keyboard.press('ControlOrMeta+KeyX'),
    async () => {
      expect(await fetchClip('clp_p1')).toBeNull();
      expect(await fetchClip('clp_q1')).toBeNull();
      expect(await clips()).toHaveLength(3);
    },
  );
});

test('Ctrl+C then Ctrl+V pastes at the cursor with relative positions and tracks; Alt+V at the origin', async () => {
  test.setTimeout(150_000);
  await launchWith(PIECES);
  await select('clp_p1', 'clp_q2');
  const copied = await head();
  await page.keyboard.press('ControlOrMeta+KeyC');
  await painted();
  expect((await head()).revision, 'a copy sends nothing').toBe(copied.revision);
  await locate(2 * BAR);
  await operation(
    'Ctrl+V',
    async () => page.keyboard.press('ControlOrMeta+KeyV'),
    async () => {
      const all = await clips();
      expect(all).toHaveLength(7);
      const added = all.filter((c) => !PIECES.some((p) => p.clipId === c.id));
      expect(added.map((c) => [c.trackId, c.position.value, c.sourceStart, c.length]).sort()).toEqual(
        [
          ['trk_a', String(2 * BAR), '0', '12000'],
          ['trk_b', String(2 * BAR + 24000), '18000', '12000'],
        ].sort(),
      );
    },
  );
  await operation(
    'Alt+V',
    async () => page.keyboard.press('Alt+KeyV'),
    async () => {
      const added = (await clips()).filter((c) => !PIECES.some((p) => p.clipId === c.id));
      expect(added.map((c) => [c.trackId, c.position.value]).sort()).toEqual(
        [
          ['trk_a', '6000'],
          ['trk_b', '30000'],
        ].sort(),
      );
    },
  );
});

test('Ctrl+K asks for a count and repeats the selection; dragging the repeat handle repeats a clip', async () => {
  test.setTimeout(150_000);
  await launchWith([{ clipId: 'clp_r', trackId: 'trk_a', position: 12000, length: 12000 }]);
  await select('clp_r');
  await page.keyboard.press('ControlOrMeta+KeyK');
  const dialog = page.getByTestId('repeat-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('repeat-count')).toBeFocused();
  // Cancel sends nothing.
  const before = await head();
  await page.getByTestId('repeat-cancel').click();
  await expect(dialog).toBeHidden();
  expect((await head()).revision).toBe(before.revision);
  await focusProject();
  await select('clp_r');
  await operation(
    'Ctrl+K, 3',
    async () => {
      await page.keyboard.press('ControlOrMeta+KeyK');
      await expect(dialog).toBeVisible();
      await page.getByTestId('repeat-count').fill('3');
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
    },
    async () => {
      expect((await on('trk_a')).map((c) => c.position.value)).toEqual(['12000', '24000', '36000', '48000']);
    },
  );
  await expect.poll(async () => (await hook<Rect[]>('clips')).length).toBe(1);
  await select('clp_r');
  const width = (await rect('clp_r')).width;
  await operation(
    'repeat handle',
    async () => drag(await repeatHandle('clp_r'), width * 2 + 2, 0),
    async () => {
      expect((await on('trk_a')).map((c) => c.position.value)).toEqual(['12000', '24000', '36000']);
    },
  );
});

test('Ctrl+Left and Ctrl+Right nudge by the grid step; the Alt arrows nudge the start and the end', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_n', trackId: 'trk_a', position: 24000, sourceStart: 48000, length: 48000 },
    { clipId: 'clp_m', trackId: 'trk_b', position: 30000, length: 12000 },
  ]);
  await setSnap(true, 'beat');
  // A beat at 120 BPM: 24000 frames.
  const step = 24000;
  await select('clp_n', 'clp_m');
  await operation(
    'Ctrl+Right',
    async () => page.keyboard.press('ControlOrMeta+ArrowRight'),
    async () => {
      expect((await fetchClip('clp_n'))!.position.value).toBe(String(24000 + step));
      expect((await fetchClip('clp_m'))!.position.value).toBe(String(30000 + step));
    },
  );
  await operation(
    'Ctrl+Left',
    async () => page.keyboard.press('ControlOrMeta+ArrowLeft'),
    async () => {
      expect((await fetchClip('clp_n'))!.position.value).toBe(String(24000 - step));
      expect((await fetchClip('clp_m'))!.position.value).toBe(String(30000 - step));
    },
  );
  await select('clp_n');
  const nudges: Array<[string, string, (c: ClipJson) => void]> = [
    ['Alt+ArrowLeft', 'start left', (c) => expect([c.position.value, c.sourceStart, c.length]).toEqual([String(24000 - step), String(48000 - step), String(48000 + step)])],
    ['Alt+Shift+ArrowRight', 'start right', (c) => expect([c.position.value, c.sourceStart, c.length]).toEqual([String(24000 + step), String(48000 + step), String(48000 - step)])],
    ['Alt+Shift+ArrowLeft', 'end left', (c) => expect([c.position.value, c.sourceStart, c.length]).toEqual(['24000', '48000', String(48000 - step)])],
    ['Alt+ArrowRight', 'end right', (c) => expect([c.position.value, c.sourceStart, c.length]).toEqual(['24000', '48000', String(48000 + step)])],
  ];
  for (const [key, name, check] of nudges) {
    await operation(name, async () => page.keyboard.press(key), async () => check((await fetchClip('clp_n'))!));
  }
});

test('the info line edits the selection: relative with Enter, absolute with Ctrl+Enter, on two clips', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_i', trackId: 'trk_a', position: 24000, length: 24000 },
    { clipId: 'clp_j', trackId: 'trk_b', position: 48000, length: 12000 },
  ]);
  // The primary clip, the info line's, is the last clicked: clp_i.
  await select('clp_j', 'clp_i');
  await expect(page.getByTestId('info-start')).toHaveText('1.2.1.0');
  // End stays read-only.
  await page.getByTestId('info-end').click();
  await expect(page.getByTestId('info-end-input')).toHaveCount(0);
  await operation(
    'info line start, relative',
    async () => {
      await page.getByTestId('info-start').click();
      const input = page.getByTestId('info-start-input');
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('1.2.1.0');
      await input.fill('2.1.1.0');
      await input.press('Enter');
      await expect(input).toHaveCount(0);
    },
    async () => {
      expect((await fetchClip('clp_i'))!.position.value).toBe(String(BAR));
      expect((await fetchClip('clp_j'))!.position.value).toBe(String(BAR + 24000));
      await expect(page.getByTestId('info-start')).toHaveText('2.1.1.0');
    },
  );
  await expect(page.getByTestId('info-start')).toHaveText('1.2.1.0');
  await operation(
    'info line volume, absolute',
    async () => {
      await page.getByTestId('info-volume').click();
      const input = page.getByTestId('info-volume-input');
      await input.fill('-6');
      await input.press('ControlOrMeta+Enter');
    },
    async () => {
      expect((await fetchClip('clp_i'))!.gainMilliDb).toBe(-6000);
      expect((await fetchClip('clp_j'))!.gainMilliDb).toBe(-6000);
    },
  );
  await operation(
    'info line length, absolute',
    async () => {
      await page.getByTestId('info-length').click();
      const input = page.getByTestId('info-length-input');
      await input.fill('0.0.3.0');
      await input.press('ControlOrMeta+Enter');
    },
    async () => {
      expect((await fetchClip('clp_i'))!.length).toBe('18000');
      expect((await fetchClip('clp_j'))!.length).toBe('18000');
    },
  );
  // Escape cancels: nothing is sent.
  const before = await head();
  await page.getByTestId('info-offset').click();
  await page.getByTestId('info-offset-input').fill('1');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('info-offset-input')).toHaveCount(0);
  expect((await head()).revision).toBe(before.revision);
});

test('the snap types: Events snaps a dragged clip to another clip\'s edge, Magnetic Cursor to the project cursor', async () => {
  test.setTimeout(150_000);
  await launchWith([
    { clipId: 'clp_drag', trackId: 'trk_a', position: 0, length: 12000 },
    { clipId: 'clp_edge', trackId: 'trk_b', position: 40000, length: 12000 },
  ]);
  await setSnap(true);
  await chooseSnapType(page, 'events');
  await expect(page.getByTestId('snap-toggle').locator('em')).toHaveText('Events');
  expect((await hook<{ type: string }>('snap')).type).toBe('events');
  const fpp = (await view()).framesPerPixel;
  await operation(
    'Events',
    // 3 px short of clp_edge's start: inside the 8 px tolerance.
    async () => drag(await middle('clp_drag'), 40000 / fpp - 3, 0),
    async () => expect((await fetchClip('clp_drag'))!.position.value).toBe('40000'),
  );
  await chooseSnapType(page, 'cursor');
  await locate(50000);
  await operation(
    'Magnetic Cursor',
    async () => drag(await middle('clp_drag'), 50000 / fpp + 4, 0),
    async () => expect((await fetchClip('clp_drag'))!.position.value).toBe('50000'),
  );
});

test('a drag on empty space draws a rubber band that selects the clips it touches; Ctrl+Shift+A selects none; neither sends anything', async () => {
  test.setTimeout(120_000);
  await launchWith(PIECES);
  const before = await head();
  const p1 = await rect('clp_p1');
  const q1 = await rect('clp_q1');
  const p3 = await rect('clp_p3');
  // From empty space left of the clips, down over trk_a and trk_b to the middle of clp_p2.
  const from = await at(Math.max(2, p1.x - 6), p1.y + 2);
  const p2 = await rect('clp_p2');
  await drag(from, p2.x + p2.width / 2 - (from.x - (await canvas()).x), q1.y + q1.height / 2 - p1.y);
  await expect.poll(async () => [...(await selected())].sort()).toEqual(['clp_p1', 'clp_p2', 'clp_q1']);
  expect(p3.x).toBeGreaterThan(p2.x);
  // Shift adds: a band over clp_p3 alone.
  await page.keyboard.down('Shift');
  await drag(await at(p3.x + p3.width / 2, p3.y + 2), 4, p3.height / 3);
  await page.keyboard.up('Shift');
  await expect.poll(async () => [...(await selected())].sort()).toEqual(['clp_p1', 'clp_p2', 'clp_p3', 'clp_q1']);
  await page.keyboard.press('ControlOrMeta+Shift+KeyA');
  await expect.poll(selected).toEqual([]);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', '');
  expect((await head()).revision, 'selection only').toBe(before.revision);
});

test('an engine without clip.remove leaves the Glue and Erase boxes empty, in their place', async () => {
  test.setTimeout(150_000);
  await launchWith(PIECES);
  const tools = page.locator('[data-part="tools"]');
  const full = await tools.boundingBox();
  const capabilities = (await engine!.call('engine.capabilities')) as { commands: string[] };
  const reduced = { ...capabilities, commands: capabilities.commands.filter((c) => c !== 'clip.remove') };
  const file = path.join(scratch, 'capabilities-without-clip-remove.json');
  fs.writeFileSync(file, JSON.stringify(reduced));
  engine!.close();
  engine = undefined;
  await app!.close();
  await start(path.dirname(bundle), PIECES.length, { SIANN_TEST_CAPABILITIES: file }, false);
  // The new window's locators.
  const relaunched = page.locator('[data-part="tools"]');
  await expect(page.getByTestId('tool-split')).toBeVisible();
  for (const id of ['tool-4', 'tool-5']) await expect(page.locator(`[data-part="${id}"]`)).toHaveCount(0);
  for (const id of ['tool-glue', 'tool-erase']) await expect(page.getByTestId(id)).toHaveCount(0);
  const empty = relaunched.locator('.tool-empty');
  await expect(empty).toHaveCount(2);
  for (const box of await empty.all()) {
    await expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(await box.getAttribute('role')).toBeNull();
    expect(await box.getAttribute('tabindex')).toBeNull();
    // The box keeps a tool's space (--tool-w), empty.
    expect((await box.boundingBox())!.width).toBeGreaterThan(0);
    expect(await box.textContent()).toBe('');
  }
  // The tool group keeps its nine boxes and its row.
  await expect(relaunched.locator(':scope > *')).toHaveCount(9);
  const reducedBox = await relaunched.boundingBox();
  expect(Math.abs(reducedBox!.y - full!.y)).toBeLessThanOrEqual(1);
  // 4 and 5 do nothing; a click with the arrow still selects.
  await focusProject();
  await page.keyboard.press('Digit4');
  expect(await hook<string>('tool')).toBe('select');
});
