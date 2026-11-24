// Fade handles on clips and fade fields in the info line, end to end
// (m5b-ui-fades; UI redesign 3.2 "Clip handles", "How a fade is drawn" and
// "Info line", 3.0, 4.2, 4.3, 4.5 C5; 10.11, 23). The app runs the real
// siann-engine on the fake device under SIANN_SHELL_TEST=1, on a bundle seeded
// with siann-cli; waits are Playwright condition waits.
//
// - The hovered and the selected clip show both handles (the canvas hook
//   `fades`: each clip's handle boxes, its lengths and whether the handles
//   are drawn); a drag of a handle sends exactly one clip.set_fade (counted
//   on the wire, window.__siannClient) in one revision, its end on a grid
//   line, unsnapped with Ctrl; the two fades never exceed the clip; a click
//   without movement sends nothing.
// - The info line reads "<n> ms" and its two ids are in the window; a typed
//   value commits round(ms * rate / 1000) frames, clamped; a double-click on a
//   handle or inside the shaded area switches the curve with the same length;
//   on a side without a fade nothing is sent.
// - A resize below the fades shortens them in the same revision (the
//   engine's rule), the handles follow, and one undo restores clip and fades.
// - An agent's plan with a clip.set_fade step draws a 'fade' ghost with its
//   step; unticking removes it; the step row reads the catalog's wording.
// - While the proposal is heard (the edit guard) neither the handles nor the
//   fields send anything.
// - Against capabilities without features.clipFades, or without the command
//   clip.set_fade, nothing of it is hit-testable or in the DOM, and a drag at
//   the corner resizes as before.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { isolateName } from '../../src/renderer/plans/isolate';
import { snapperFor } from '../../src/renderer/timeline/snap';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, hash8, launchApp, seedBundle, selectPlan, type Agent } from './support/seed';

const RATE = 48000;
// The title strip and the box's insets of draw()'s clip() (geometry.ts).
const TITLE = 13;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Fade {
  readonly length: string;
  readonly curve: 'linear' | 'equal_power';
}

interface FadeDrawn {
  readonly clipId: string;
  readonly position: string;
  readonly length: string;
  readonly fadeIn: Fade | null;
  readonly fadeOut: Fade | null;
  readonly handles: { readonly fadeIn: Box; readonly fadeOut: Box } | null;
  readonly shown: boolean;
}

interface Rect extends Box {
  readonly clipId: string;
  readonly position: string;
  readonly length: string;
}

interface ClipJson {
  readonly id: string;
  readonly length: string;
  readonly fadeIn?: Fade;
  readonly fadeOut?: Fade;
}

let scratch = '';
let sessionDir = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;
let agent: Agent;

test.describe.configure({ mode: 'serial' });

async function start(env: Record<string, string> = {}): Promise<void> {
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  engine = await engineClient(page, { events: false });
}

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fades-'));
  sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_a', name: 'Keys' },
      { id: 'trk_b', name: 'Bass' },
    ],
    // Both in view between the track list's divider and the right zone at
    // the default zoom (100 frames per pixel: a clip is 480 px).
    [
      { id: 'clp_1', trackId: 'trk_a', at: 0.05 },
      { id: 'clp_2', trackId: 'trk_b', at: 0.15 },
    ],
  );
  await start();
  agent = await agentFor(app!);
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

const view = () => hook<{ framesPerPixel: number; scrollFrames: string }>('view');

async function canvas(): Promise<Box> {
  const found = await page.getByTestId('timeline-canvas').boundingBox();
  if (!found) throw new Error('the timeline canvas is not laid out');
  return found;
}

async function rect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await hook<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  return (await hook<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
}

async function fades(clipId: string): Promise<FadeDrawn> {
  await expect.poll(async () => (await hook<FadeDrawn[]>('fades')).some((f) => f.clipId === clipId)).toBe(true);
  return (await hook<FadeDrawn[]>('fades')).find((f) => f.clipId === clipId)!;
}

// A point on the window from canvas coordinates.
async function at(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await canvas();
  return { x: box.x + x, y: box.y + y };
}

// The handle's grab point: its tip column (a pixel left of it for the fade
// out, whose tip without a fade is the box's right edge, outside the box), a
// pixel below the triangle's top edge.
async function handle(clipId: string, side: 'fadeIn' | 'fadeOut'): Promise<{ x: number; y: number }> {
  const drawn = await fades(clipId);
  if (!drawn.handles) throw new Error(`${clipId} has no fade handles`);
  const box = drawn.handles[side];
  return at(box.x + box.width / 2 - (side === 'fadeOut' ? 1 : 0), box.y + 1);
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

async function head(): Promise<{ revision: string; documentHash: string }> {
  const sync = await engine!.call('session.inspect');
  return { revision: sync.revision as string, documentHash: sync.documentHash as string };
}

async function fetchClip(clipId: string): Promise<ClipJson> {
  const { entities } = (await engine!.call('session.fetch', { refs: [`clip:${clipId}`] })) as { entities: Array<{ entity?: ClipJson }> };
  return entities[0]!.entity!;
}

// The clip.set_fade commands the renderer sent, one entry per command.execute.
async function fadeExecutes(): Promise<Array<Array<Record<string, unknown>>>> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient: { sent(): Array<{ method: string; params: { commands?: Array<Record<string, unknown>> } }> } }).__siannClient;
    return client
      .sent()
      .filter((r) => r.method === 'command.execute' && (r.params.commands ?? []).some((c) => c.op === 'clip.set_fade'))
      .map((r) => r.params.commands ?? []);
  });
}

async function executes(): Promise<number> {
  return page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string }> } }).__siannClient.sent().filter((r) => r.method === 'command.execute').length);
}

const next = (revision: string) => `r${Number(/^r(\d+)$/.exec(revision)![1]) + 1}`;

// One edit: exactly one new revision, and exactly one more command.execute with clip.set_fade.
async function oneFadeEdit(name: string, act: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const before = await head();
  const wired = (await fadeExecutes()).length;
  await act();
  await expect(page.getByTestId('revision'), name).toHaveText(next(before.revision));
  expect((await head()).revision, `${name}: one revision`).toBe(next(before.revision));
  const after = await fadeExecutes();
  expect(after.length, `${name}: one clip.set_fade on the wire`).toBe(wired + 1);
  return after.at(-1)!;
}

async function painted(): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// Nothing is sent: no command.execute and the same revision after a round trip.
async function nothingSent(name: string, act: () => Promise<void>): Promise<void> {
  const before = await head();
  const sent = await executes();
  await act();
  await painted();
  await engine!.call('session.inspect');
  expect(await executes(), `${name}: no command.execute`).toBe(sent);
  expect((await head()).revision, name).toBe(before.revision);
}

test('hover and selection show both handles; a handle drag is one clip.set_fade on the grid, Ctrl unsnapped, clamped, a click sends nothing', async () => {
  test.setTimeout(120_000);
  const r = await rect('clp_1');
  // Hovered: both handles drawn on the overlay.
  expect((await fades('clp_1')).shown).toBe(false);
  const middle = await at(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.move(middle.x, middle.y);
  await expect.poll(async () => (await fades('clp_1')).shown).toBe(true);
  // Selected (and the pointer away): still drawn.
  await page.mouse.click(middle.x, middle.y);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_1');
  const away = await at(4, (await canvas()).height - 12);
  await page.mouse.move(away.x, away.y);
  await expect.poll(async () => (await fades('clp_1')).shown).toBe(true);
  const handles = (await fades('clp_1')).handles!;
  // Both at the upper corners: the triangles' tips on the box's left and right edges (no fade yet).
  expect(Math.abs(handles.fadeIn.x + handles.fadeIn.width / 2 - (r.x + 1))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(handles.fadeOut.x + handles.fadeOut.width / 2 - (r.x + r.width - 1))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(handles.fadeIn.y - (r.y + 3 + TITLE - 1))).toBeLessThanOrEqual(0.5);
  expect(handles.fadeIn.width).toBe(8);
  expect(handles.fadeIn.height).toBe(6);

  // A drag of the fade in handle right, snap on (the default grid): its end on
  // the nearest grid line. The distance is the least whose grid line lies
  // inside the clip, so the drag gives the fade a length.
  const v = await view();
  const grid = snapperFor({ on: true, grid: 'adapt' }, v.framesPerPixel, [], RATE);
  const position = BigInt(r.position);
  const inside = (dx: number) => {
    const at = grid(position + BigInt(Math.round(dx * v.framesPerPixel)));
    return at > position && at < position + BigInt(r.length) / 2n;
  };
  const dx = [...Array(40).keys()].map((i) => 20 + 10 * i).find(inside);
  expect(dx, 'a grid line inside the clip').toBeDefined();
  const commands = await oneFadeEdit('fade in drag', async () => drag(await handle('clp_1', 'fadeIn'), dx!));
  const end = grid(position + BigInt(Math.round(dx! * v.framesPerPixel)));
  expect(commands).toEqual([{ op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: String(end - position), curve: 'linear' } }]);
  expect((await fetchClip('clp_1')).fadeIn).toEqual({ length: String(end - position), curve: 'linear' });
  // The handle followed: its tip at the fade's real length.
  await expect.poll(async () => Math.round((await fades('clp_1')).handles!.fadeIn.x + 4)).toBe(Math.round(r.x + 1 + Number(end - position) / v.framesPerPixel));

  // Ctrl: unsnapped, 37 px more.
  const before = BigInt((await fetchClip('clp_1')).fadeIn!.length);
  await oneFadeEdit('fade in drag, Ctrl', async () => drag(await handle('clp_1', 'fadeIn'), 37, 'ControlOrMeta'));
  expect((await fetchClip('clp_1')).fadeIn!.length).toBe(String(before + BigInt(Math.round(37 * v.framesPerPixel))));

  // A fade out, then the fade in dragged past it: clamped to the clip less the fade out.
  await oneFadeEdit('fade out drag', async () => drag(await handle('clp_1', 'fadeOut'), -80, 'ControlOrMeta'));
  const out = (await fetchClip('clp_1')).fadeOut!;
  expect(out).toEqual({ length: String(Math.round(80 * v.framesPerPixel)), curve: 'linear' });
  await oneFadeEdit('fade in dragged past the fade out', async () => drag(await handle('clp_1', 'fadeIn'), 2000, 'ControlOrMeta'));
  const clamped = await fetchClip('clp_1');
  expect(BigInt(clamped.fadeIn!.length) + BigInt(clamped.fadeOut!.length)).toBe(BigInt(clamped.length));
  expect(clamped.fadeOut).toEqual(out);

  // A press and release on a handle without movement sends nothing.
  await nothingSent('a click on a handle', async () => {
    const h = await handle('clp_1', 'fadeOut');
    await page.mouse.click(h.x, h.y);
  });
});

test('the info line reads and edits the fades in ms; a double-click switches a curve; nothing on a side without a fade', async () => {
  test.setTimeout(120_000);
  const r = await rect('clp_2');
  await page.mouse.click(...Object.values(await at(r.x + r.width / 2, r.y + r.height / 2)) as [number, number]);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_2');
  // Both ids are in the window, label then b.num, "0 ms" without a fade.
  for (const id of ['info-fade-in', 'info-fade-out']) {
    await expect(page.locator(`[data-part="${id}"]`)).toHaveCount(1);
    await expect(page.getByTestId(id)).toHaveText('0 ms');
  }
  await expect(page.locator('[data-part="info-fade-in"]')).toHaveText(`${translator('en')('info.fadeIn')}0 ms`);
  // The first clip's fades read as ms, rounded half up.
  const one = await fetchClip('clp_1');
  const ms = (frames: string) => `${Math.floor((Number(frames) * 1000) / RATE + 0.5)} ms`;
  const r1 = await rect('clp_1');
  await page.mouse.click(...Object.values(await at(r1.x + r1.width / 2, r1.y + r1.height - 16)) as [number, number]);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_1');
  await expect(page.getByTestId('info-fade-in')).toHaveText(ms(one.fadeIn!.length));
  await expect(page.getByTestId('info-fade-out')).toHaveText(ms(one.fadeOut!.length));
  await page.mouse.click(...Object.values(await at(r.x + r.width / 2, r.y + r.height / 2)) as [number, number]);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_2');

  const type = async (id: string, text: string) => {
    await page.getByTestId(id).click();
    const input = page.getByTestId(`${id}-input`);
    await expect(input).toBeFocused();
    await input.fill(text);
    await input.press('Enter');
  };
  // 25 ms is round(25 * 48000 / 1000) = 1200 frames, a new side: linear.
  expect(await oneFadeEdit('typed fade out', () => type('info-fade-out', '25'))).toEqual([{ op: 'clip.set_fade', clipId: 'clp_2', fadeOut: { length: '1200', curve: 'linear' } }]);
  await expect(page.getByTestId('info-fade-out')).toHaveText('25 ms');
  // Over-long: clamped to the clip (no fade in).
  await oneFadeEdit('typed over-long fade out', () => type('info-fade-out', '5000 ms'));
  expect((await fetchClip('clp_2')).fadeOut!.length).toBe((await fetchClip('clp_2')).length);
  await oneFadeEdit('typed fade out', () => type('info-fade-out', '250'));
  expect((await fetchClip('clp_2')).fadeOut).toEqual({ length: '12000', curve: 'linear' });
  // The same value again sends nothing.
  await nothingSent('the value shown', () => type('info-fade-out', '250'));

  // A double-click on the handle: equal power, the same length.
  const toggled = await oneFadeEdit('double-click on the handle', async () => {
    const h = await handle('clp_2', 'fadeOut');
    await page.mouse.dblclick(h.x, h.y);
  });
  expect(toggled).toEqual([{ op: 'clip.set_fade', clipId: 'clp_2', fadeOut: { length: '12000', curve: 'equal_power' } }]);
  // A double-click inside the shaded area (20 px in from the right edge, under the title strip): back to linear.
  const back = await oneFadeEdit('double-click in the shaded area', async () => {
    const p = await at(r.x + r.width - 1 - 20, r.y + 3 + TITLE + 3);
    await page.mouse.dblclick(p.x, p.y);
  });
  expect(back).toEqual([{ op: 'clip.set_fade', clipId: 'clp_2', fadeOut: { length: '12000', curve: 'linear' } }]);
  // On the side without a fade nothing is sent.
  await nothingSent('double-click on a side without a fade', async () => {
    const h = await handle('clp_2', 'fadeIn');
    await page.mouse.dblclick(h.x, h.y);
  });
});

test('a resize below the fades shortens them in the same revision; the handles follow; one undo restores clip and fades', async () => {
  test.setTimeout(120_000);
  // A fade in of 200 ms (9600 frames) beside the fade out of 12000: 21600 of the clip's 48000.
  await page.getByTestId('info-fade-in').click();
  await page.getByTestId('info-fade-in-input').fill('200');
  await oneFadeEdit('typed fade in', () => page.getByTestId('info-fade-in-input').press('Enter'));
  const before = await head();
  const whole = await fetchClip('clp_2');
  expect(whole.fadeIn).toEqual({ length: '9600', curve: 'linear' });
  const r = await rect('clp_2');
  const v = await view();
  // The lower right corner dragged left with Ctrl (unsnapped) by about 33000 frames: about 15000 are left.
  const px = Math.round(33000 / v.framesPerPixel);
  const corner = await at(r.x + r.width - 3, r.y + r.height - 6);
  await drag(corner, -px, 'ControlOrMeta');
  await expect(page.getByTestId('revision')).toHaveText(next(before.revision));
  const trimmed = await fetchClip('clp_2');
  const length = 48000 - Math.round(px * v.framesPerPixel);
  expect(length).toBeLessThan(9600 + 12000);
  expect(trimmed.length).toBe(String(length));
  // The engine's rule: the fade in keeps its length first, the fade out takes the rest.
  expect(trimmed.fadeIn).toEqual({ length: '9600', curve: 'linear' });
  expect(trimmed.fadeOut).toEqual({ length: String(length - 9600), curve: 'linear' });
  // The handles follow: the fade out's tip at the new end less its new length.
  const after = await rect('clp_2');
  await expect.poll(async () => Math.round((await fades('clp_2')).handles!.fadeOut.x + 4)).toBe(Math.round(after.x + after.width - 1 - (length - 9600) / v.framesPerPixel));
  await expect(page.getByTestId('info-fade-out')).toHaveText(`${Math.floor(((length - 9600) * 1000) / RATE + 0.5)} ms`);
  // One undo restores the clip's length and both fades.
  await engine!.call('session.undo');
  const undone = await head();
  expect(undone.documentHash).toBe(before.documentHash);
  expect(await fetchClip('clp_2')).toEqual(whole);
  await expect(page.getByTestId('revision')).toHaveText(undone.revision);
  await expect(page.getByTestId('info-fade-out')).toHaveText('250 ms');
});

let planHash = '';

test('a plan with a clip.set_fade step: a fade ghost with its step; unticked, none; the step row\'s wording', async () => {
  test.setTimeout(120_000);
  const steps = [
    { op: 'track.set_gain', trackId: 'trk_b', gainMilliDb: -3000 },
    { op: 'clip.set_fade', clipId: 'clp_2', fadeIn: { length: '4800', curve: 'equal_power' } },
  ];
  planHash = (await agent.tool('submit_plan', { steps })).hash as string;
  await selectPlan(page, planHash);
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(planHash));
  const fadeGhosts = async () => (await hook<Array<{ kind: string; step: number; clipId?: string }>>('ghosts')).filter((g) => g.kind === 'fade').map((g) => [g.step, g.clipId]);
  await expect.poll(fadeGhosts).toEqual([[2, 'clp_2']]);
  const en = translator('en');
  await expect(page.getByTestId('step-text-1')).toHaveText(en('step.setFadeIn', { clip: en('step.clipOn', { track: isolateName('Bass') }), length: '100 ms' }));
  await page.getByTestId('step-1').getByRole('checkbox').click();
  await expect.poll(fadeGhosts).toEqual([]);
  await page.getByTestId('step-1').getByRole('checkbox').click();
  await expect.poll(fadeGhosts).toEqual([[2, 'clp_2']]);
});

test('while the proposal is heard neither a handle drag nor a fade field sends anything (the edit guard)', async () => {
  test.setTimeout(120_000);
  await page.getByTestId('plan-audition').click();
  await expect.poll(async () => (await engine!.call('session.inspect')).heard as string).not.toBe('main');
  await expect(page.getByTestId('hear-proposal')).toHaveAttribute('aria-pressed', 'true');
  // The fade ghost is solid while heard.
  await expect.poll(async () => (await hook<Array<{ kind: string; mode?: string }>>('ghosts')).filter((g) => g.kind === 'fade').map((g) => g.mode)).toEqual(['solid']);
  await nothingSent('a handle drag while heard', async () => drag(await handle('clp_2', 'fadeOut'), -40));
  await nothingSent('a typed fade while heard', async () => {
    await page.getByTestId('info-fade-out').click();
    const input = page.getByTestId('info-fade-out-input');
    if ((await input.count()) > 0) {
      await input.fill('60');
      await input.press('Enter');
    }
  });
  await nothingSent('a double-click while heard', async () => {
    const h = await handle('clp_2', 'fadeOut');
    await page.mouse.dblclick(h.x, h.y);
  });
  await engine!.call('audition.hear', { side: 'main' });
  await expect(page.getByTestId('hear-main')).toHaveAttribute('aria-pressed', 'true');
});

async function relaunchWithout(change: (caps: Record<string, unknown>) => Record<string, unknown>, name: string): Promise<void> {
  const capabilities = (await engine!.call('engine.capabilities')) as Record<string, unknown>;
  const file = path.join(scratch, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(change(capabilities)));
  engine!.close();
  engine = undefined;
  await app!.close();
  await start({ SIANN_TEST_CAPABILITIES: file });
}

for (const [name, change] of [
  ['capabilities-without-clip-fades', (caps: Record<string, unknown>) => ({ ...caps, features: { ...(caps.features as object), clipFades: false } })],
  ['capabilities-without-set-fade', (caps: Record<string, unknown>) => ({ ...caps, commands: (caps.commands as string[]).filter((c) => c !== 'clip.set_fade') })],
] as const) {
  test(`${name}: no handle is hit-testable, no fade field or box is in the DOM, and a drag at the corner resizes`, async () => {
    test.setTimeout(150_000);
    await relaunchWithout(change, name);
    const r = await rect('clp_1');
    const corner = { x: r.x + 2, y: r.y + 3 + TITLE };
    // The hit test at both upper corners: the edges, not a fade part.
    expect((await hook<{ part: string } | null>('hitAt', corner.x, corner.y))?.part).toBe('left');
    expect((await hook<{ part: string } | null>('hitAt', r.x + r.width - 2, corner.y))?.part).toBe('right');
    const drawn = await fades('clp_1');
    expect(drawn.handles).toBeNull();
    // Selected: no fade field and no box in their place.
    await page.mouse.click(...Object.values(await at(r.x + r.width / 2, r.y + r.height - 16)) as [number, number]);
    await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_1');
    for (const id of ['info-fade-in', 'info-fade-out']) await expect(page.locator(`[data-part="${id}"]`)).toHaveCount(0);
    await expect(page.locator('.infoline [class*="hold-"]')).toHaveCount(0);
    await expect(page.locator('.infoline > *').last()).toHaveAttribute('data-part', 'info-volume');
    // A drag at the upper left corner resizes the clip as before: one command.execute of clip.trim and clip.move.
    const length = (await fetchClip('clp_1')).length;
    const v = await view();
    const sent = await executes();
    await drag(await at(corner.x, corner.y), 48, 'ControlOrMeta');
    await expect.poll(async () => (await fetchClip('clp_1')).length).toBe(String(Number(length) - Math.round(48 * v.framesPerPixel)));
    expect(await executes()).toBe(sent + 1);
    const ops = await page.evaluate(() => {
      const last = (window as unknown as { __siannClient: { sent(): Array<{ method: string; params: { commands?: Array<{ op: string }> } }> } }).__siannClient.sent().filter((r) => r.method === 'command.execute').at(-1);
      return (last?.params.commands ?? []).map((c) => c.op);
    });
    expect(ops).toEqual(['clip.trim', 'clip.move']);
    expect((await fadeExecutes()).length).toBe(0);
  });
}
