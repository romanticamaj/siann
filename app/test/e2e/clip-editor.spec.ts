// The lower zone's Editor tab, end to end (m5b-ui-editor-channel; UI redesign
// 2.1, 3.2, 3.6, 5.2, UR-18). The app runs the real siann-engine on the fake
// device under SIANN_SHELL_TEST=1, on a bundle seeded with siann-cli; waits
// are Playwright condition waits. (editor.spec.ts is the plugin editor's.)
//
// - A double-click on a clip's body shows the lower zone on the Editor tab
//   with that clip; Return with the project zone focused and a clip selected
//   does the same and does not move the focus into the zone; with no clip
//   Return enters the zone.
// - A double-click on a fade handle or in a fade's shaded area switches the
//   curve (one revision) and keeps the tab; on the volume control, a corner,
//   a 4 px edge and the repeat handle it does not open the editor.
// - No clip: the tab says so; several selected: the primary, the info line's.
// - Dragging an end of the range resizes the clip in one revision, one undo
//   restores it; Ctrl leaves the grid; the volume control is one revision and
//   one undo.
// - H and G with the lower zone focused zoom the editor, not the event display.
// - Opening the editor makes no request but /v0/peaks/<hash>, and no new
//   protocol method.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { clipBox, cornerHandles, gainBox, repeatHandle } from '../../src/renderer/timeline/geometry';
import { snapperFor } from '../../src/renderer/timeline/snap';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchApp, seedBundle } from './support/seed';

const RATE = 48000;
const MOD = 'ControlOrMeta';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Rect extends Box {
  readonly clipId: string;
  readonly position: string;
  readonly length: string;
}

interface EditorHooks {
  clipId: string | null;
  view: { framesPerPixel: number; scrollFrames: string; width: number };
  range: { start: number; end: number } | null;
  gain: Box | null;
}

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;
const requests: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-clip-editor-'));
  const sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_a', name: 'Keys' },
      { id: 'trk_b', name: 'Bass' },
    ],
    [
      { id: 'clp_1', trackId: 'trk_a', at: 0.05 },
      { id: 'clp_2', trackId: 'trk_b', at: 0.15 },
    ],
  );
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('request', (request) => requests.push(request.url()));
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  engine = await engineClient(page, { events: false });
});

test.afterAll(async () => {
  engine?.close();
  await app?.close().catch(() => undefined);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function timeline<T>(name: string): Promise<T> {
  return page.evaluate((called) => {
    const hooks = (window as unknown as { __siannTimeline?: Record<string, () => unknown> }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing');
    return hooks[called]!();
  }, name) as Promise<T>;
}

async function editor(): Promise<EditorHooks> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __siannEditor?: { clipId(): string | null; view(): EditorHooks['view']; range(): EditorHooks['range']; gain(): Box | null } }).__siannEditor;
    if (!hooks) return { clipId: null, view: { framesPerPixel: 0, scrollFrames: '0', width: 0 }, range: null, gain: null };
    return { clipId: hooks.clipId(), view: hooks.view(), range: hooks.range(), gain: hooks.gain() };
  });
}

async function rect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await timeline<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  return (await timeline<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
}

async function onCanvas(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

async function onEditor(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('editor').boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

async function revision(): Promise<number> {
  return Number(/^r(\d+)$/.exec((await page.getByTestId('revision').textContent()) ?? '')![1]);
}

async function fetchClip(clipId: string): Promise<{ length: string; sourceStart: string; gainMilliDb: number; fadeIn?: { curve: string } }> {
  const { entities } = (await engine!.call('session.fetch', { refs: [`clip:${clipId}`] })) as { entities: Array<{ entity?: { length: string; sourceStart: string; gainMilliDb: number; fadeIn?: { curve: string } } }> };
  return entities[0]!.entity!;
}

async function showMixConsole(): Promise<void> {
  await page.getByTestId('tab-lower-mixconsole').click();
  await expect(page.getByTestId('tab-lower-mixconsole')).toHaveAttribute('aria-selected', 'true');
}

async function selectNone(): Promise<void> {
  await page.getByTestId('zone-project').focus();
  await page.keyboard.press(`${MOD}+Shift+KeyA`);
  await expect(page.getByTestId('info-line')).not.toHaveAttribute('data-clip', /clp_/);
}

async function drag(from: { x: number; y: number }, dx: number, dy = 0, modifier?: string): Promise<void> {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

test('a double-click on a clip\'s body shows the Editor tab with that clip, without other requests', async () => {
  await showMixConsole();
  const sentBefore = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string }> } }).__siannClient.sent().map((r) => r.method));
  requests.length = 0;
  const r = await rect('clp_2');
  const body = await onCanvas(r.x + r.width / 2, r.y + r.height / 2 - 6);
  await page.mouse.dblclick(body.x, body.y);
  await expect(page.getByTestId('zone-lower')).toBeVisible();
  await expect(page.getByTestId('tab-lower-editor')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-clip', 'clp_2');
  await expect.poll(async () => (await editor()).clipId).toBe('clp_2');
  await expect.poll(async () => (await editor()).range !== null).toBe(true);
  // The editor added no request but the peaks of the media, and no protocol method the window had not sent.
  expect(requests.filter((url) => !/\/v0\/peaks\/[0-9a-f]{64}$/.test(url))).toEqual([]);
  const sentAfter = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string }> } }).__siannClient.sent().map((r) => r.method));
  const added = sentAfter.slice(sentBefore.length).filter((method) => !sentBefore.includes(method));
  expect(added).toEqual([]);
  expect(sentAfter.slice(sentBefore.length)).not.toContain('command.execute');
});

test('Return with the project zone focused and a clip selected opens the editor and keeps the focus; with no clip it enters the zone', async () => {
  await showMixConsole();
  const r = await rect('clp_1');
  const body = await onCanvas(r.x + r.width / 2, r.y + r.height / 2 - 6);
  await page.mouse.click(body.x, body.y);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_1');
  await page.getByTestId('zone-project').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tab-lower-editor')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-clip', 'clp_1');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('zone-project');
  // No clip: the tab says so, and Return enters the zone.
  await selectNone();
  await expect(page.getByTestId('editor-empty')).toHaveText('No clip selected');
  await page.getByTestId('zone-project').focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el !== null && el.dataset.testid !== 'zone-project' && el.closest('[data-zone="project"]') !== null;
  })).toBe(true);
});

test('double-clicks on a fade handle or area switch the curve and keep the tab; the volume control, a corner, an edge and the repeat handle do not open the editor', async () => {
  await showMixConsole();
  const r = await rect('clp_1');
  const box = clipBox(r);
  // Selected, so its handles (fades, repeat) are hit.
  const body = await onCanvas(r.x + r.width / 2, r.y + r.height / 2 - 6);
  await page.mouse.click(body.x, body.y);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_1');
  const tab = () => page.getByTestId('tab-lower-mixconsole');
  const places: Array<[string, { x: number; y: number }]> = [];
  const gain = gainBox(r)!;
  places.push(['the volume control', await onCanvas(gain.x + gain.width / 2, gain.y + gain.height / 2)]);
  const [corner] = cornerHandles(box);
  places.push(['a corner', await onCanvas(corner.x + 2, corner.y + corner.height - 2)]);
  places.push(['the 4 px edge', await onCanvas(box.x + 2, box.y + box.height / 2 - 6)]);
  const repeat = repeatHandle(box);
  places.push(['the repeat handle', await onCanvas(repeat.x, repeat.y)]);
  for (const [name, at] of places) {
    const before = await revision();
    await page.mouse.dblclick(at.x, at.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(tab(), name).toHaveAttribute('aria-selected', 'true');
    // A double-click that started a gesture may have committed one edit; undo it.
    if ((await revision()) !== before) await page.keyboard.press(`${MOD}+KeyZ`);
    await expect.poll(revision).toBe(before);
    await page.mouse.click(body.x, body.y);
  }
  // A fade, then double-clicks on its handle and inside its shaded area.
  const fades = (await timeline<Array<{ clipId: string; handles: { fadeIn: Box } | null }>>('fades')).find((f) => f.clipId === 'clp_1')!;
  expect(fades.handles).not.toBeNull();
  const handle = await onCanvas(fades.handles!.fadeIn.x + fades.handles!.fadeIn.width / 2, fades.handles!.fadeIn.y + 1);
  await drag(handle, 120);
  await expect.poll(async () => (await fetchClip('clp_1')).fadeIn !== undefined).toBe(true);
  const curve = (await fetchClip('clp_1')).fadeIn!.curve;
  // The window has the fade: its revision and the handle at the fade's end.
  const { revision: head } = (await engine!.call('session.inspect')) as { revision: string };
  await expect(page.getByTestId('revision')).toHaveText(head);
  type Drawn = { clipId: string; fadeIn: { length: string } | null; handles: { fadeIn: Box } | null };
  await expect.poll(async () => (await timeline<Drawn[]>('fades')).find((f) => f.clipId === 'clp_1')?.fadeIn !== null).toBe(true);
  let before = await revision();
  const moved = (await timeline<Drawn[]>('fades')).find((f) => f.clipId === 'clp_1')!;
  const tip = await onCanvas(moved.handles!.fadeIn.x + moved.handles!.fadeIn.width / 2, moved.handles!.fadeIn.y + 1);
  await page.mouse.dblclick(tip.x, tip.y);
  await expect.poll(revision).toBe(before + 1);
  await expect.poll(async () => (await fetchClip('clp_1')).fadeIn!.curve).not.toBe(curve);
  await expect(tab()).toHaveAttribute('aria-selected', 'true');
  before = await revision();
  // Inside the 120 px fade, right of the volume control, under the title strip: the shaded area.
  const area = await onCanvas(r.x + 60, r.y + 22);
  await page.mouse.dblclick(area.x, area.y);
  await expect.poll(revision).toBe(before + 1);
  await expect.poll(async () => (await fetchClip('clp_1')).fadeIn!.curve).toBe(curve);
  await expect(tab()).toHaveAttribute('aria-selected', 'true');
});

test('several clips selected: the editor shows the primary, the clip the info line reads', async () => {
  await showMixConsole();
  const one = await rect('clp_1');
  const two = await rect('clp_2');
  const a = await onCanvas(one.x + one.width / 2, one.y + one.height / 2 - 6);
  const b = await onCanvas(two.x + two.width / 2, two.y + two.height / 2 - 6);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  const primary = await page.getByTestId('info-line').getAttribute('data-clip');
  expect(primary).toMatch(/^clp_/);
  await page.getByTestId('tab-lower-editor').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-clip', primary!);
});

test('dragging the range\'s end resizes the clip in one revision, one undo restores it; Ctrl leaves the grid', async () => {
  const r = await rect('clp_2');
  const body = await onCanvas(r.x + r.width / 2, r.y + r.height / 2 - 6);
  await page.mouse.dblclick(body.x, body.y);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-clip', 'clp_2');
  await expect.poll(async () => (await editor()).range !== null).toBe(true);
  const original = await fetchClip('clp_2');
  const { range, view } = await editor();
  const end = await onEditor(range!.end - 1, 120);
  // Snapped (the default grid): the end lands on a grid line.
  let before = await revision();
  await drag(end, -60);
  await expect.poll(revision).toBe(before + 1);
  const position = BigInt(r.position);
  const grid = snapperFor({ on: true, grid: 'adapt' }, view.framesPerPixel, [], RATE, false, BigInt(view.scrollFrames));
  const snapped = await fetchClip('clp_2');
  expect(BigInt(snapped.length)).toBeLessThan(BigInt(original.length));
  expect(grid(position + BigInt(snapped.length))).toBe(position + BigInt(snapped.length));
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(async () => (await fetchClip('clp_2')).length).toBe(original.length);
  // Ctrl: unsnapped, the drag's frames exactly.
  const { revision: head } = (await engine!.call('session.inspect')) as { revision: string };
  await expect(page.getByTestId('revision')).toHaveText(head);
  before = await revision();
  await drag(end, -60, 0, MOD);
  await expect.poll(revision).toBe(before + 1);
  const free = BigInt((await fetchClip('clp_2')).length);
  expect(Number(BigInt(original.length) - free)).toBeGreaterThanOrEqual(Math.round(58 * view.framesPerPixel));
  expect(Number(BigInt(original.length) - free)).toBeLessThanOrEqual(Math.round(62 * view.framesPerPixel));
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(async () => (await fetchClip('clp_2')).length).toBe(original.length);
});

test('the volume control sets the clip\'s gain in one revision; one undo restores it', async () => {
  await expect(page.getByTestId('editor')).toHaveAttribute('data-clip', 'clp_2');
  const { gain } = await editor();
  expect(gain).not.toBeNull();
  const at = await onEditor(gain!.x + gain!.width / 2, gain!.y + gain!.height / 2);
  const before = await revision();
  await drag(at, 0, -20);
  await expect.poll(revision).toBe(before + 1);
  expect((await fetchClip('clp_2')).gainMilliDb).toBe(2000);
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(async () => (await fetchClip('clp_2')).gainMilliDb).toBe(0);
});

test('H and G with the lower zone focused zoom the editor, not the event display', async () => {
  await expect(page.getByTestId('editor')).toHaveAttribute('data-clip', 'clp_2');
  await page.getByTestId('zone-lower').focus();
  await expect(page.getByTestId('zone-lower')).toHaveAttribute('data-focused', 'true');
  const display = (await timeline<{ framesPerPixel: number }>('view')).framesPerPixel;
  const before = (await editor()).view.framesPerPixel;
  await page.keyboard.press('KeyH');
  await expect.poll(async () => (await editor()).view.framesPerPixel).toBe(Math.round(before / 2));
  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await editor()).view.framesPerPixel).toBe(Math.round(before / 2) * 4);
  expect((await timeline<{ framesPerPixel: number }>('view')).framesPerPixel).toBe(display);
  // On the MixConsole tab H does nothing there.
  await showMixConsole();
  await page.getByTestId('zone-lower').focus();
  await page.keyboard.press('KeyH');
  expect((await timeline<{ framesPerPixel: number }>('view')).framesPerPixel).toBe(display);
});
