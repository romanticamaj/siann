// The marker track end to end (m5b-ui-markers; UI redesign 3.0, 3.1, 3.2
// "Marker track" and "How markers are drawn", 3.6, 4.2, UR-9). The app runs
// the real siann-engine on the fake device under SIANN_SHELL_TEST=1 on a
// bundle seeded with siann-cli; waits are Playwright condition waits.
//
// - Insert adds a position marker at the project cursor, Alt-click one on the
//   marker track (snapped) and a Ctrl-drag on its empty space a cycle marker:
//   each one command.execute (counted on the wire through
//   window.__siannClient) and one revision, undone by one Ctrl+Z.
// - A drag moves a marker (snapped; Ctrl unsnapped), an edge drag resizes a
//   cycle marker (marker.move with length), a click selects, a double-click
//   on the name renames in place and Delete removes the selected marker: one
//   revision and one undo each.
// - Shift+3 and Num 3 go to position marker 3 while a cycle marker 3 exists
//   elsewhere; Shift+1 / Shift+2 stay the locators; Shift+N / Shift+B step
//   through both kinds; a double-click on a cycle marker outside its name
//   sends one session.set_locators and the locator display shows it.
// - Snap type Events: a clip drag lands on a position marker and on a cycle
//   marker's start and end.
// - Markers survive save and reopen; a second connection's marker.add, an
//   applied plan's marker step and a pending plan's marker ghosts (flag and
//   range, numbered by step; a moved or removed marker dimmed) show.
// - Against capabilities without features.markers, or without the marker
//   commands, no marker-head, no marker-track or marker part, the 20 px row
//   kept, and a press and the keys send nothing.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { snapperFor } from '../../src/renderer/timeline/snap';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, hash8, launchApp, seedBundle, selectPlan, type Agent } from './support/seed';
import { chooseSnapType } from './support/toolbar';

const RATE = 48000;
// The ruler (40 px) and the marker row (20 px) above the lanes: a point in the row.
const ROW_Y = 50;
const FIXTURES = path.resolve(__dirname, '..', 'unit', 'fixtures');

interface View {
  readonly framesPerPixel: number;
  readonly scrollFrames: string;
}

interface Shape {
  readonly kind: 'position' | 'cycle';
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly position: string;
  readonly length?: string;
  readonly label: { readonly x: number; readonly y: number; readonly width: number };
}

interface Request {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Part {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

let scratch = '';
let sessionDir = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

test.describe.configure({ mode: 'serial' });

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  engine = await engineClient(page);
  // G twice: 400 frames per pixel, so a second is 120 px and the first five are in view.
  await expect.poll(async () => (await hook<View>('view')).framesPerPixel).toBe(100);
  await focusProject();
  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await hook<View>('view')).framesPerPixel).toBe(400);
}

async function relaunch(env: Record<string, string> = {}): Promise<void> {
  engine?.close();
  engine = undefined;
  await app!.close();
  app = undefined;
  await launch(env);
}

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-markers-'));
  // One clip of one second at 0.5 s; at the default zoom (100 frames per
  // pixel) a second is 480 px, so the first four seconds are in view.
  sessionDir = seedBundle(scratch, [{ id: 'trk_a', name: 'Keys' }], [{ id: 'clp_1', trackId: 'trk_a', at: 0.5 }]);
  await launch();
});

test.afterAll(async () => {
  engine?.close();
  await app?.close().catch(() => undefined);
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function hook<T>(name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ name: called, args: values }) => {
      const hooks = (window as unknown as { __siannTimeline?: Record<string, (...a: unknown[]) => unknown> }).__siannTimeline;
      if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return hooks[called]!(...values);
    },
    { name, args },
  ) as Promise<T>;
}

const view = () => hook<View>('view');
const shapes = () => hook<Shape[]>('markers');

async function canvas(): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await page.getByTestId('timeline-canvas').boundingBox();
  if (!found) throw new Error('the timeline canvas is not laid out');
  return found;
}

// A window point from canvas coordinates.
async function at(x: number, y = ROW_Y): Promise<{ x: number; y: number }> {
  const box = await canvas();
  return { x: box.x + x, y: box.y + y };
}

// The canvas x of a frame at the current view.
async function xOf(frame: number | bigint): Promise<number> {
  const v = await view();
  return (Number(frame) - Number(v.scrollFrames)) / v.framesPerPixel;
}

async function frameAt(x: number): Promise<bigint> {
  const v = await view();
  const frame = BigInt(v.scrollFrames) + BigInt(Math.round(x * v.framesPerPixel));
  return frame < 0n ? 0n : frame;
}

async function sent(): Promise<Request[]> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient?: { sent(): Request[] } }).__siannClient;
    if (!client) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return client.sent().map((r) => ({ method: r.method, params: r.params }));
  });
}

async function answeredExecutes(): Promise<Array<Array<Record<string, unknown>>>> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient: { answered(): Array<{ method: string; params: { commands?: Array<Record<string, unknown>> }; code: string | null }> } }).__siannClient;
    return client
      .answered()
      .filter((r) => r.method === 'command.execute' && r.code === null)
      .map((r) => r.params.commands ?? []);
  });
}

async function executes(): Promise<number> {
  return (await sent()).filter((r) => r.method === 'command.execute').length;
}

async function head(): Promise<{ revision: string; documentHash: string }> {
  const sync = await engine!.call('session.inspect');
  return { revision: sync.revision as string, documentHash: sync.documentHash as string };
}

const next = (revision: string) => `r${Number(/^r(\d+)$/.exec(revision)![1]) + 1}`;

async function painted(): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// One gesture: exactly one more command.execute answered, exactly one new
// revision; then one Ctrl+Z restores the document as it was.
async function oneEdit(name: string, act: () => Promise<void>, undo = true): Promise<Array<Record<string, unknown>>> {
  const before = await head();
  const wired = await executes();
  const answered = (await answeredExecutes()).length;
  await act();
  await expect(page.getByTestId('revision'), name).toHaveText(next(before.revision));
  expect((await head()).revision, `${name}: one revision`).toBe(next(before.revision));
  expect(await executes(), `${name}: one command.execute`).toBe(wired + 1);
  await expect.poll(async () => (await answeredExecutes()).length, { message: `${name}: answered` }).toBe(answered + 1);
  const commands = (await answeredExecutes()).at(-1)!;
  if (undo) {
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await head()).documentHash, { message: `${name}: one undo` }).toBe(before.documentHash);
    // The renderer has the undo's revision before the next gesture begins on it.
    await expect(page.getByTestId('revision')).toHaveText((await head()).revision);
    await painted();
  }
  return commands;
}

// Nothing is sent: no command.execute and the same revision after a round trip.
async function nothingSent(name: string, act: () => Promise<void>): Promise<void> {
  const before = await head();
  const count = await executes();
  await act();
  await painted();
  await engine!.call('session.inspect');
  expect(await executes(), `${name}: no command.execute`).toBe(count);
  expect((await head()).revision, name).toBe(before.revision);
}

async function addMarkers(commands: Array<Record<string, unknown>>): Promise<void> {
  const before = (await shapes()).length;
  await engine!.call('command.execute', { commands });
  await expect.poll(async () => (await shapes()).length).toBe(before + commands.filter((c) => c.op === 'marker.add').length);
}

async function clearMarkers(): Promise<void> {
  const ids = (await shapes()).map((s) => s.id);
  if (ids.length > 0) await engine!.call('command.execute', { commands: ids.map((markerId) => ({ op: 'marker.remove', markerId })) });
  await expect.poll(async () => (await shapes()).length).toBe(0);
}

async function shape(id: string): Promise<Shape> {
  await expect.poll(async () => (await shapes()).some((s) => s.id === id)).toBe(true);
  return (await shapes()).find((s) => s.id === id)!;
}

async function cursorAt(frame: number | bigint): Promise<void> {
  const x = await xOf(frame);
  await expect.poll(async () => Math.abs(((await hook<number | null>('cursorX')) ?? -1000) - x)).toBeLessThan(1.5);
}

async function focusProject(): Promise<void> {
  const box = await canvas();
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 10);
}

async function drag(from: { x: number; y: number }, dx: number, modifier?: 'ControlOrMeta'): Promise<void> {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y, { steps: 4 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

const grid = async () => snapperFor({ on: true, grid: 'adapt' }, (await view()).framesPerPixel, [], RATE);

test('the marker head and the marker track are in the window; the 20 px row lines the headers up with the lanes', async () => {
  await expect(page.locator('[data-part="marker-head"]')).toHaveCount(1);
  await expect(page.locator('[data-part="marker-head"]')).toHaveText('Markers');
  await expect.poll(async () => (await hook<Part[]>('parts')).filter((p) => p.id === 'marker-track').map((p) => [p.x, p.y, p.h])).toEqual([[0, 40, 20]]);
  const head = (await page.locator('[data-part="marker-head"]').boundingBox())!;
  expect(Math.round(head.height)).toBe(20);
  const box = await canvas();
  expect(Math.round(head.y)).toBe(Math.round(box.y + 40));
});

test('Insert, Alt-click and Ctrl-drag each add a marker in one command.execute and one revision, undone by one Ctrl+Z', async () => {
  test.setTimeout(120_000);
  await clearMarkers();
  // Insert at the project cursor (1.25 s), unsnapped.
  await engine!.call('transport.locate', { frames: String(60000) });
  await cursorAt(60000);
  await focusProject();
  const inserted = await oneEdit('Insert', () => page.keyboard.press('Insert'));
  expect(inserted).toEqual([{ op: 'marker.add', markerId: expect.stringMatching(/^mk_[0-9a-f]{16}$/), position: '60000' }]);
  // Alt-click on the marker track: snapped to the grid.
  const x = Math.round(await xOf(2.2 * RATE));
  const snap = await grid();
  const clicked = await oneEdit('Alt-click', async () => {
    const p = await at(x);
    await page.keyboard.down('Alt');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Alt');
  });
  expect(clicked).toEqual([{ op: 'marker.add', markerId: expect.stringMatching(/^mk_/), position: String(snap(await frameAt(x))) }]);
  // A Ctrl-drag on empty space: a cycle marker between the two snapped ends.
  const x0 = Math.round(await xOf(2.6 * RATE));
  const x1 = Math.round(await xOf(3.4 * RATE));
  const drawn = await oneEdit('Ctrl-drag', async () => drag(await at(x0), x1 - x0, 'ControlOrMeta'));
  const a = snap(await frameAt(x0));
  const b = snap(await frameAt(x1));
  expect(drawn).toEqual([{ op: 'marker.add', markerId: expect.stringMatching(/^mk_/), position: String(a), length: String(b - a) }]);
  await expect.poll(async () => (await shapes()).length).toBe(0);
});

test('drag, Ctrl-drag, edge drag, click, double-click on the name and Delete: one revision and one undo each', async () => {
  test.setTimeout(150_000);
  await clearMarkers();
  await addMarkers([
    { op: 'marker.add', markerId: 'mk_p', position: String(RATE), name: 'Verse' },
    { op: 'marker.add', markerId: 'mk_c', position: String(2 * RATE), length: String(RATE), name: 'Loop' },
  ]);
  const flag = await at(await xOf(RATE) + 1);
  const snap = await grid();
  const v = await view();
  const moved = await oneEdit('a drag', () => drag(flag, 30));
  expect(moved).toEqual([{ op: 'marker.move', markerId: 'mk_p', position: String(snap(BigInt(RATE) + BigInt(Math.round(30 * v.framesPerPixel)))) }]);
  const free = await oneEdit('a Ctrl-drag', () => drag(flag, 33, 'ControlOrMeta'));
  expect(free).toEqual([{ op: 'marker.move', markerId: 'mk_p', position: String(RATE + Math.round(33 * v.framesPerPixel)) }]);
  // The cycle marker's right edge, 20 px right: marker.move with the length.
  const edge = await at(await xOf(3 * RATE));
  const resized = await oneEdit('an edge drag', () => drag(edge, 20));
  const end = snap(BigInt(3 * RATE) + BigInt(Math.round(20 * v.framesPerPixel)));
  expect(resized).toEqual([{ op: 'marker.move', markerId: 'mk_c', position: String(2 * RATE), length: String(end - BigInt(2 * RATE)) }]);
  // A click selects (nothing sent); Delete removes the selected marker.
  await nothingSent('a click', async () => page.mouse.click(flag.x, flag.y));
  expect(await hook<string | null>('selectedMarker')).toBe('mk_p');
  const removed = await oneEdit('Delete', () => page.keyboard.press('Delete'));
  expect(removed).toEqual([{ op: 'marker.remove', markerId: 'mk_p' }]);
  // A double-click on the name: the field in place, Enter renames.
  const loop = await shape('mk_c');
  const name = await at(loop.label.x + loop.label.width / 2, loop.label.y);
  await page.mouse.dblclick(name.x, name.y);
  const field = page.getByTestId('marker-rename');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Loop');
  const renamed = await oneEdit('rename', async () => {
    await field.fill('Chorus loop');
    await field.press('Enter');
  });
  expect(renamed).toEqual([{ op: 'marker.rename', markerId: 'mk_c', name: 'Chorus loop' }]);
  await expect(field).toHaveCount(0);
  // Escape cancels.
  await page.mouse.dblclick(name.x, name.y);
  await expect(page.getByTestId('marker-rename')).toBeFocused();
  await nothingSent('Escape', async () => {
    await page.getByTestId('marker-rename').fill('Nope');
    await page.getByTestId('marker-rename').press('Escape');
  });
  await expect(page.getByTestId('marker-rename')).toHaveCount(0);
});

test('Shift+3 and Num 3 go to position marker 3, not the cycle marker 3; Shift+1 / Shift+2 the locators; Shift+N / Shift+B; a double-click sets the locators', async () => {
  test.setTimeout(150_000);
  await clearMarkers();
  await addMarkers([
    { op: 'marker.add', markerId: 'mk_1', position: String(RATE / 4), name: 'One' },
    { op: 'marker.add', markerId: 'mk_2', position: String(RATE), name: 'Two' },
    { op: 'marker.add', markerId: 'mk_3', position: String(2 * RATE), name: 'Three' },
    { op: 'marker.add', markerId: 'mk_c3', position: String(3 * RATE), length: String(RATE / 2), name: 'Cycle', number: 3 },
  ]);
  await engine!.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(RATE / 2), right: String(RATE + RATE / 2) }] });
  await focusProject();
  await page.keyboard.press('Shift+Digit3');
  await cursorAt(2 * RATE);
  await engine!.call('transport.locate', { frames: '0' });
  await cursorAt(0);
  await page.keyboard.press('Numpad3');
  await cursorAt(2 * RATE);
  // The locators keep Shift+1 and Shift+2.
  await page.keyboard.press('Shift+Digit1');
  await cursorAt(RATE / 2);
  await page.keyboard.press('Shift+Digit2');
  await cursorAt(RATE + RATE / 2);
  // Shift+N and Shift+B: both kinds in position order.
  await page.keyboard.press('Shift+KeyN');
  await cursorAt(2 * RATE);
  await page.keyboard.press('Shift+KeyN');
  await cursorAt(3 * RATE);
  await page.keyboard.press('Shift+KeyB');
  await cursorAt(2 * RATE);
  await page.keyboard.press('Shift+KeyB');
  await cursorAt(RATE);
  // A key for a number no position marker has sends no locate.
  const locates = (await sent()).filter((r) => r.method === 'transport.locate').length;
  await page.keyboard.press('Shift+Digit7');
  await painted();
  expect((await sent()).filter((r) => r.method === 'transport.locate').length).toBe(locates);
  // A double-click on the cycle marker outside its name: one session.set_locators to its range.
  const cycle = await shape('mk_c3');
  const body = await at((await xOf(3 * RATE + RATE / 2)) - 4);
  expect(body.x - (await canvas()).x).toBeGreaterThan(cycle.label.x + cycle.label.width);
  const before = (await sent()).filter((r) => r.method === 'command.execute').length;
  await page.mouse.dblclick(body.x, body.y);
  await expect(page.getByTestId('display-locators-value')).toHaveText('2.3 – 2.4');
  const after = (await sent()).filter((r) => r.method === 'command.execute').slice(before);
  expect(after.map((r) => r.params.commands)).toEqual([[{ op: 'session.set_locators', left: String(3 * RATE), right: String(3 * RATE + RATE / 2) }]]);
});

test('snap type Events: a clip drag lands on a position marker and on the start and the end of a cycle marker', async () => {
  test.setTimeout(150_000);
  await clearMarkers();
  await addMarkers([
    { op: 'marker.add', markerId: 'mk_p', position: '61000', name: 'P' },
    { op: 'marker.add', markerId: 'mk_c', position: '133000', length: '100000', name: 'C' },
  ]);
  await chooseSnapType(page, 'events');
  const clips = await hook<Array<{ clipId: string; x: number; y: number; width: number; height: number; position: string }>>('clips');
  const clip = clips.find((c) => c.clipId === 'clp_1')!;
  const v = await view();
  const grab = { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 };
  const fetchPosition = async () => {
    const { entities } = (await engine!.call('session.fetch', { refs: ['clip:clp_1'] })) as { entities: Array<{ entity?: { position: { value: string } } }> };
    return entities[0]!.entity!.position.value;
  };
  // Its start (24000) dragged to 4 px short of the position marker: it lands on 61000.
  const to = async (target: number, from: number) => Math.round((target - from) / v.framesPerPixel) - 4;
  // Each drag begins once the renderer has the last one's revision.
  const synced = async () => {
    await expect(page.getByTestId('revision')).toHaveText((await head()).revision);
    await painted();
  };
  await drag(await at(grab.x, grab.y), await to(61000, Number(await fetchPosition())));
  await expect.poll(fetchPosition).toBe('61000');
  await synced();
  await drag(await at(grab.x + (61000 - 24000) / v.framesPerPixel, grab.y), await to(133000, 61000));
  await expect.poll(fetchPosition).toBe('133000');
  await synced();
  // Its end (start + 48000) onto the cycle marker's end (233000): the start at 185000.
  await drag(await at(grab.x + (133000 - 24000) / v.framesPerPixel, grab.y), Math.round((233000 - 48000 - 133000) / v.framesPerPixel) + 3);
  await expect.poll(fetchPosition).toBe('185000');
  await synced();
  await chooseSnapType(page, 'grid');
  await engine!.call('command.execute', { commands: [{ op: 'clip.move', clipId: 'clp_1', position: { domain: 'audio', value: '24000' } }] });
});

test('markers come back after save and reopen; a second connection\'s marker and an applied plan\'s marker show', async () => {
  test.setTimeout(180_000);
  await clearMarkers();
  await addMarkers([
    { op: 'marker.add', markerId: 'mk_s', position: String(RATE), name: 'Saved' },
    { op: 'marker.add', markerId: 'mk_sc', position: String(2 * RATE), length: String(RATE), name: 'Saved loop' },
  ]);
  await engine!.call('session.save');
  await relaunch();
  await expect.poll(async () => (await shapes()).map((s) => [s.id, s.kind, s.name, s.position]).sort()).toEqual([
    ['mk_s', 'position', 'Saved', String(RATE)],
    ['mk_sc', 'cycle', 'Saved loop', String(2 * RATE)],
  ]);
  // Another connection's marker.add.
  const other = await engineClient(page);
  await other.call('command.execute', { commands: [{ op: 'marker.add', markerId: 'mk_o', position: String(3 * RATE), name: 'Other' }] });
  other.close();
  await expect.poll(async () => (await shapes()).some((s) => s.id === 'mk_o' && s.name === 'Other')).toBe(true);
  // An applied plan's marker step.
  const agent: Agent = await agentFor(app!);
  const applied = (await agent.tool('submit_plan', { steps: [{ op: 'marker.add', markerId: 'mk_plan', position: String(RATE / 2), name: 'Planned' }] })).hash as string;
  await selectPlan(page, applied);
  await expect(page.getByTestId('step-text-0')).toContainText('Planned');
  await page.getByTestId('plan-approve-apply').click();
  await expect(page.getByTestId(`plan-state-${hash8(applied)}`)).toHaveAttribute('data-state', 'applied');
  await expect.poll(async () => (await shapes()).some((s) => s.id === 'mk_plan')).toBe(true);
});

test('a pending plan\'s marker steps: a ghost flag and a ghost range numbered by step, a moved or removed marker dimmed', async () => {
  test.setTimeout(150_000);
  const agent: Agent = await agentFor(app!);
  const pending = (await agent.tool('submit_plan', {
    steps: [
      { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -3000 },
      { op: 'marker.add', markerId: 'mk_g', position: String(3 * RATE + RATE / 2), name: 'Ghost' },
      { op: 'marker.add', markerId: 'mk_gr', position: String(RATE / 4), length: String(RATE / 4), name: 'Range' },
      { op: 'marker.move', markerId: 'mk_s', position: String(RATE + RATE / 4) },
      { op: 'marker.remove', markerId: 'mk_o' },
    ],
  })).hash as string;
  await selectPlan(page, pending);
  const ghosts = async () => (await hook<Array<{ kind: string; step: number; markerId?: string; length?: string | null }>>('ghosts')).filter((g) => g.kind.startsWith('marker-')).map((g) => [g.kind, g.step, g.markerId]);
  await expect.poll(ghosts).toEqual([
    ['marker-add', 2, 'mk_g'],
    ['marker-add', 3, 'mk_gr'],
    ['marker-move', 4, 'mk_s'],
    ['marker-remove', 5, 'mk_o'],
  ]);
  const parts = await hook<Part[]>('parts');
  const ids = parts.map((p) => p.id);
  for (const id of ['marker-ghost-add', 'marker-ghost-add-2', 'marker-ghost-move', 'marker-ghost-remove']) expect(ids, id).toContain(id);
  const flag = parts.find((p) => p.id === 'marker-ghost-add')!;
  expect(Math.round(flag.x)).toBe(Math.round(await xOf(3 * RATE + RATE / 2)));
  const range = parts.find((p) => p.id === 'marker-ghost-add-2')!;
  expect(Math.round(range.w)).toBe(Math.round(RATE / 4 / (await view()).framesPerPixel));
  // The marker steps read as step text in the Plans tab and count as edits.
  await expect(page.getByTestId('step-text-1')).toContainText('Ghost');
  await expect(page.locator('[data-plan-chip="edit"], .sum').first()).toContainText('4');
  await page.getByTestId('plan-reject').click();
  await page.getByTestId('plan-reject').click();
});

for (const [name, file] of [
  ['capabilities without features.markers', 'capabilities-no-markers.json'],
  ['capabilities without the marker commands', 'capabilities-markers-no-commands.json'],
] as const) {
  test(`${name}: no marker head, track or marker part; the 20 px row stays; a press and the keys send nothing`, async () => {
    test.setTimeout(150_000);
    await relaunch({ SIANN_TEST_CAPABILITIES: path.join(FIXTURES, file) });
    await expect(page.locator('[data-part="marker-head"]')).toHaveCount(0);
    expect((await hook<Part[]>('parts')).filter((p) => p.id.startsWith('marker'))).toEqual([]);
    expect(await shapes()).toEqual([]);
    // The row's box is still there: the first header starts 20 px below the head, level with its lane.
    const list = page.getByTestId('track-list');
    const corner = (await list.locator('.corner').boundingBox())!;
    const header = (await page.getByTestId('track-header-trk_a').boundingBox())!;
    expect(Math.round(header.y - (corner.y + corner.height))).toBe(20);
    const lanes = await hook<Part[]>('parts');
    const lane = lanes.find((p) => p.id === 'lane-1')!;
    expect(Math.round(lane.y)).toBe(60);
    expect(Math.round(header.y)).toBe(Math.round((await canvas()).y + lane.y));
    await focusProject();
    await nothingSent('a press, an Alt-click, a Ctrl-drag and the keys', async () => {
      const p = await at(200);
      await page.mouse.click(p.x, p.y);
      await page.keyboard.down('Alt');
      await page.mouse.click(p.x, p.y);
      await page.keyboard.up('Alt');
      await drag(p, 80, 'ControlOrMeta');
      await page.keyboard.press('Insert');
    });
    const locates = (await sent()).filter((r) => r.method === 'transport.locate').length;
    for (const key of ['Shift+Digit3', 'Numpad3', 'Shift+KeyN', 'Shift+KeyB']) await page.keyboard.press(key);
    await painted();
    expect((await sent()).filter((r) => r.method === 'transport.locate').length).toBe(locates);
  });
}
