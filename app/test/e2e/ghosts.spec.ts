// Plan review in place (m5b-ui-ghosts; UI redesign 4.2, 5.2, P2-1, P2-2): an
// agent submits a plan covering every change kind of 4.2, and the window
// draws its ghosts where the changes land: the event display's content layer
// (a proposed lane, a placed, a moved, a trimmed and a removed clip, the
// locator band), the track headers, the MixConsole and the Inspector. The
// test hook window.__siannGhosts gives the ghost list the canvas and the
// zones draw from. Unticking a step removes exactly its ghosts; hovering a
// step outlines its ghosts and scrolls them into view; the .go button
// locates by keyboard (and opens the MixConsole for a strip ghost) and pins
// the step; clicking a ghost pins its step and shows its row on the Plans
// tab. The toolbar's pill names the plan and toggles the ghosts (as
// Ctrl+Alt+G does), and an applied, rejected or stale plan has neither. The
// review adds no protocol request: plan.preview and what the Plans tab sent
// before. The app runs the real siann-engine on the fake device under
// SIANN_SHELL_TEST=1; waits are Playwright condition waits.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, hash8, launchApp, seedBundle, selectPlan, type Agent } from './support/seed';

const RATE = 48000;
const audio = (seconds: number) => ({ domain: 'audio', value: String(Math.round(seconds * RATE)) });

// Every kind of 4.2: the step number is the 1-based index in the plan.
const STEPS: ReadonlyArray<Record<string, unknown>> = [
  /* 1 */ { op: 'track.add', trackId: 'trk_new', name: 'Pad', channels: 2 },
  /* 2 */ { op: 'clip.place', clipId: 'clp_new', trackId: 'trk_new', mediaId: 'med_seed', position: audio(3), sourceStart: '0', length: String(RATE) },
  /* 3 */ { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -6000 },
  /* 4 */ { op: 'clip.move', clipId: 'clp_1', position: audio(0.5) },
  /* 5 */ { op: 'clip.trim', clipId: 'clp_2', sourceStart: '0', length: String(RATE / 2) },
  /* 6 */ { op: 'clip.remove', clipId: 'clp_4' },
  /* 7 */ { op: 'track.remove', trackId: 'trk_c' },
  /* 8 */ { op: 'track.set_pan', trackId: 'trk_a', pan: -2000 },
  /* 9 */ { op: 'track.set_mute', trackId: 'trk_b', mute: false },
  /* 10 */ { op: 'track.set_solo', trackId: 'trk_a', solo: true },
  /* 11 */ { op: 'track.rename', trackId: 'trk_b', name: 'Bass DI' },
  /* 12 */ { op: 'session.set_locators', left: String(RATE), right: String(2 * RATE) },
];
// The ghosts the window draws for it, in step order (the cascade of step 7, trk_c's clip, under step 7).
const EXPECTED: ReadonlyArray<readonly [string, number]> = [
  ['track-add', 1], ['clip-place', 2], ['gain', 3], ['clip-move', 4], ['clip-trim', 5], ['clip-remove', 6],
  ['track-remove', 7], ['clip-remove', 7], ['pan', 8], ['mute', 9], ['solo', 10], ['rename', 11], ['locators', 12],
];

interface GhostEntry {
  readonly kind: string;
  readonly step: number;
}

let scratch: string;
let app: ElectronApplication;
let page: Page;
let agent: Agent;
let engine: EngineClient;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-ghosts-'));
  const sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_a', name: 'Keys', gain: -9000 },
      { id: 'trk_b', name: 'Bass', mute: true },
      { id: 'trk_c', name: 'FX' },
    ],
    [
      { id: 'clp_1', trackId: 'trk_a', at: 0 },
      { id: 'clp_2', trackId: 'trk_b', at: 2 },
      { id: 'clp_3', trackId: 'trk_c', at: 1 },
      { id: 'clp_4', trackId: 'trk_a', at: 6 },
    ],
  );
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText('4');
  agent = await agentFor(app);
  engine = await engineClient(page, { events: false });
});

test.afterAll(async () => {
  engine?.close();
  await app?.close().catch(() => undefined);
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function ghosts(): Promise<GhostEntry[]> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __siannGhosts?: { list(): GhostEntry[] } }).__siannGhosts;
    if (!hook) throw new Error('window.__siannGhosts is missing (SIANN_SHELL_TEST=1)');
    return hook.list().map((g) => ({ kind: g.kind, step: g.step }));
  });
}

async function timeline<T>(name: string, arg?: string): Promise<T> {
  return page.evaluate(
    ({ name: called, arg: value }) => (window as unknown as { __siannTimeline: Record<string, (a?: string) => unknown> }).__siannTimeline[called]!(value),
    { name, arg },
  ) as Promise<T>;
}

async function methods(): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string }> } }).__siannClient.sent().map((r) => r.method));
}

// The zoom slider set to `fpp` frames per pixel (a test-side change of its step, as the fidelity session does).
async function zoomTo(fpp: number): Promise<void> {
  await page.getByTestId('zoom-slider').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.step = 'any';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(Number(input.max) - Math.log2(value)));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, fpp);
  await expect.poll(async () => (await timeline<{ framesPerPixel: number }>('view')).framesPerPixel).toBe(fpp);
}

const pairs = (list: readonly GhostEntry[]) => list.map((g) => `${g.kind} ${g.step}`);
const step = (index: number) => page.getByTestId(`step-${index}`);

async function submit(steps: ReadonlyArray<Record<string, unknown>>): Promise<string> {
  const hash = (await agent.tool('submit_plan', { steps })).hash as string;
  await expect(page.locator(`[data-plan="${hash8(hash)}"]`)).toHaveCount(1);
  return hash;
}

let planHash = '';

test('a plan of every kind: the ghost list, and unticking a step removes exactly its ghosts', async () => {
  const before = await methods();
  planHash = await submit(STEPS);
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(planHash));
  await expect.poll(async () => pairs(await ghosts())).toEqual(EXPECTED.map(([kind, n]) => `${kind} ${n}`));
  for (const k of [3, 7, 12]) {
    await step(k - 1).getByRole('checkbox').click();
    await expect.poll(async () => pairs(await ghosts())).toEqual(EXPECTED.filter(([, n]) => n !== k).map(([kind, n]) => `${kind} ${n}`));
    await step(k - 1).getByRole('checkbox').click();
    await expect.poll(async () => pairs(await ghosts())).toEqual(EXPECTED.map(([kind, n]) => `${kind} ${n}`));
  }
  // The ticked steps and the list agree: every ghost's step is ticked.
  await step(1).getByRole('checkbox').click();
  await step(8).getByRole('checkbox').click();
  const ticked = await page.locator('[data-part-item="plan-step"] [role="checkbox"][aria-checked="true"]').count();
  expect(ticked).toBe(STEPS.length - 2);
  expect(new Set((await ghosts()).map((g) => g.step))).toEqual(new Set(EXPECTED.map(([, n]) => n).filter((n) => n !== 2 && n !== 9)));
  await step(1).getByRole('checkbox').click();
  await step(8).getByRole('checkbox').click();
  // The review asked plan.preview and nothing the Plans tab did not ask before.
  const added = (await methods()).slice(before.length);
  expect(new Set(added.filter((m) => !['plan.list', 'plan.status', 'session.inspect', 'session.fetch', 'engine.status'].includes(m)))).toEqual(new Set(['plan.preview']));
});

test('every ghost id is in the window, on the DOM and on the canvas', async () => {
  for (const id of ['proposal-pill', 'inspector-agent-changes']) {
    if (id === 'inspector-agent-changes') await page.getByTestId('track-header-trk_a').click({ position: { x: 30, y: 30 } });
    await expect(page.locator(`[data-part="${id}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-part-item="track"][data-part-key="ghost"]')).toHaveCount(1);
  await expect(page.locator('[data-part-item="strip"][data-part-key="ghost"]')).toHaveCount(1);
  const strip = page.getByTestId('mixer-strip-trk_a');
  for (const of of ['cap-ghost', 'gain-line-ghost', 'gain-step-ghost', 'pan-step-ghost', 'pan-knob-ghost', 'pan-value-ghost', 'solo-step-ghost']) {
    await expect(strip.locator(`[data-part-of="${of}"]`)).toHaveCount(1);
  }
  await expect(page.getByTestId('mixer-strip-trk_b').locator('[data-part-of="mute-step-ghost"]')).toHaveCount(1);
  const parts = (await timeline<Array<{ id: string }>>('parts')).map((p) => p.id);
  for (const id of ['lane-ghost', 'lane-ghost-remove', 'clip-ghost-new', 'clip-ghost-move', 'clip-ghost-trim', 'clip-ghost-remove', 'locator-band-ghost']) expect(parts, id).toContain(id);
  // The removed track's header dims and carries its step (7).
  await expect(page.getByTestId('track-header-trk_c')).toHaveClass(/\bghost-removed\b/);
  await expect(page.getByTestId('track-header-trk_c').locator('.r1 > .stepn')).toHaveText('7');
});

// The rectangle a node's text is drawn in (its range), not the box it is laid out in.
async function inkOf(locator: ReturnType<Page['getByTestId']>): Promise<{ left: number; right: number; top: number; bottom: number }> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

async function boxOf(locator: ReturnType<Page['getByTestId']>): Promise<{ left: number; right: number; top: number; bottom: number }> {
  const b = (await locator.boundingBox())!;
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
}

test('both values and both names have room: the header\'s gain clears its pan, the Inspector shows both values, the name tag one line', async () => {
  await page.getByTestId('track-header-trk_a').click({ position: { x: 30, y: 30 } });
  // The header's gain readout (Keys, step 3): all of it is drawn left of the pan readout.
  const gain = page.getByTestId('track-gain-trk_a');
  await expect(gain).toHaveText('-9.0 → -6.0');
  const pan = await inkOf(page.getByTestId('track-pan-trk_a'));
  expect((await inkOf(gain)).right).toBeLessThanOrEqual(pan.left);
  expect((await inkOf(gain)).right).toBeLessThanOrEqual((await boxOf(gain)).right + 0.5);
  // An untouched header keeps the shared rule's cell: Bass's pan readout stays where it was.
  const bassGain = await boxOf(page.getByTestId('track-gain-trk_b'));
  const fxGain = await boxOf(page.getByTestId('track-gain-trk_c'));
  expect(bassGain.right).toBeCloseTo(fxGain.right, 0);

  // The Inspector's Volume and Pan rows (Keys, steps 3 and 8): both values, inside the row and the zone.
  const zone = await boxOf(page.getByTestId('zone-left'));
  for (const [id, row, value] of [['inspector-volume-value', 'inspector-volume', '-9.0 → -6.0 dB'], ['inspector-pan-value', 'inspector-pan', 'C → L20']] as const) {
    const el = page.getByTestId(id);
    await expect(el).toHaveText(value);
    const ink = await inkOf(el);
    const rowBox = await boxOf(page.locator(`[data-part="${row}"]`));
    expect(ink.right, id).toBeLessThanOrEqual((await boxOf(el)).right + 0.5);
    expect(ink.right, id).toBeLessThanOrEqual(rowBox.right + 0.5);
    expect(ink.right, id).toBeLessThanOrEqual(zone.right);
    expect(ink.left, id).toBeGreaterThanOrEqual(rowBox.left);
  }
  // The Inspector's S carries the dashed ring of step 10.
  await expect(page.getByTestId('inspector-solo')).toHaveClass(/\bghost\b/);

  // The rename (Bass -> Bass DI, step 11) in the MixConsole: one line, inside the tag.
  const tag = page.getByTestId('strip-name-trk_b');
  await expect(tag).toHaveText('Bass → Bass DI');
  const tagBox = await boxOf(tag);
  const was = await boxOf(tag.locator('.ghost-was'));
  const now = await boxOf(tag.locator('.ghost-name'));
  expect(now.top).toBeCloseTo(was.top, 0);
  expect(now.bottom).toBeLessThanOrEqual(tagBox.bottom + 0.5);
  expect(now.right).toBeLessThanOrEqual(tagBox.right + 0.5);
  // In the header: the new name is drawn whole, and the old one is not cut away.
  const name = page.getByTestId('track-name-trk_b');
  const nameBox = await boxOf(name);
  const headerWas = name.locator('.ghost-was');
  const headerNow = name.locator('.ghost-name');
  expect(await headerNow.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect((await boxOf(headerNow)).right).toBeLessThanOrEqual(nameBox.right + 0.5);
  expect((await boxOf(headerWas)).right - (await boxOf(headerWas)).left).toBeGreaterThan(4);
});

test('Agent changes lists every pending step on the track, its clips\' too, with the ghosts shown or hidden', async () => {
  await page.getByTestId('track-header-trk_a').click({ position: { x: 30, y: 30 } });
  const section = page.locator('[data-part="inspector-agent-changes"]');
  const rows = async () => section.locator('[data-testid^="agent-pending-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  // Keys: its gain (3), its clips' move (4) and remove (6), its pan (8), its solo (10).
  const keys = ['agent-pending-3', 'agent-pending-4', 'agent-pending-6', 'agent-pending-8', 'agent-pending-10'];
  await expect.poll(rows).toEqual(keys);
  await page.locator('[data-part="proposal-pill"] .tog').click();
  await expect.poll(async () => (await ghosts()).length).toBe(0);
  await expect.poll(rows).toEqual(keys);
  await page.locator('[data-part="proposal-pill"] .tog').click();
  await expect.poll(async () => (await ghosts()).length).toBe(EXPECTED.length);
});

test('hovering a step outlines its ghosts and scrolls them into view; .go by keyboard opens the MixConsole and pins the step; no request', async () => {
  const before = await methods();
  // The placed clip (step 2, at 3 s) out of view: zoomed in to 16 frames per pixel, it lies past the right edge.
  await zoomTo(16);
  const width0 = (await timeline<{ width: number }>('view')).width;
  const outside = async () => {
    const part = (await timeline<Array<{ id: string; x: number; w: number }>>('parts')).find((p) => p.id === 'clip-ghost-new');
    return part !== undefined && (part.x + part.w < 0 || part.x > width0);
  };
  // Shift+wheel scrolls right until the ghost is behind the left edge.
  const area = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 60 && !(await outside()); i += 1) await page.mouse.wheel(0, 2000);
  await page.keyboard.up('Shift');
  await expect.poll(outside).toBe(true);
  const far = await timeline<{ scrollFrames: string }>('view');
  await step(1).hover();
  await expect.poll(() => timeline<number | null>('ghostOutline')).toBe(2);
  await expect.poll(async () => (await timeline<{ scrollFrames: string }>('view')).scrollFrames).not.toBe(far.scrollFrames);
  const shown = (await timeline<Array<{ id: string; x: number; w: number }>>('parts')).find((p) => p.id === 'clip-ghost-new')!;
  const width = (await timeline<{ width: number }>('view')).width;
  expect(shown.x).toBeGreaterThanOrEqual(-1);
  // A ghost wider than the view shows from its start; one that fits shows whole.
  expect(shown.x + Math.min(shown.w, width)).toBeLessThanOrEqual(width + 1);
  // The DOM ghosts of the hovered step carry the outline: the proposed strip for step 1.
  await step(0).hover();
  await expect(page.locator('[data-part-item="strip"][data-part-key="ghost"]')).toHaveAttribute('data-ghost-hot', 'true');

  // The lower zone hidden, .go on the gain step by keyboard: the MixConsole shows and the step stays pinned.
  if ((await page.getByTestId('zone-lower').getAttribute('data-visible')) === 'true') await page.getByTestId('zone-button-lower').click();
  await expect(page.getByTestId('zone-lower')).toHaveAttribute('data-visible', 'false');
  await page.mouse.move(5, 5);
  const go = step(2).locator('.go');
  await go.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('zone-lower')).toHaveAttribute('data-visible', 'true');
  await expect(step(2)).toHaveAttribute('aria-current', 'step');
  await expect(step(2)).toHaveClass(/\bhot\b/);
  await expect.poll(() => timeline<number | null>('ghostOutline')).toBe(3);
  await expect(page.getByTestId('mixer-strip-trk_a').locator('[data-part-of="cap-ghost"]')).toBeInViewport();
  // The pointer entering another row ends the pin.
  await step(5).hover();
  await expect(step(2)).not.toHaveAttribute('aria-current', 'step');
  expect((await methods()).slice(before.length).filter((m) => !['plan.list', 'plan.status', 'engine.status'].includes(m))).toEqual([]);
});

test('a click on a ghost cap or a ghost clip pins its step and shows its row on the Plans tab', async () => {
  // The right zone hidden first.
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) === 'true') await page.getByTestId('zone-button-right').click();
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'false');
  await page.getByTestId('mixer-strip-trk_a').locator('[data-part-of="cap-ghost"]').click({ force: true });
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'true');
  await expect(step(2)).toHaveAttribute('aria-current', 'step');
  await expect(step(2)).toBeInViewport();
  // A ghost clip on the canvas: the placed one (step 2), in view at 256 frames per pixel.
  await zoomTo(256);
  // Hovering its row brings it into view.
  await step(1).hover();
  type Part = { id: string; x: number; y: number; w: number; h: number };
  const placed = async () => (await timeline<Part[]>('parts')).find((p) => p.id === 'clip-ghost-new');
  await expect.poll(async () => (await placed())?.x ?? -1).toBeGreaterThanOrEqual(0);
  const ghost = (await placed())!;
  const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(box.x + ghost.x + ghost.w / 2, box.y + ghost.y + ghost.h / 2);
  await expect(step(1)).toHaveAttribute('aria-current', 'step');
  await expect(step(1)).toHaveClass(/\bhot\b/);
  expect(await timeline<string[]>('selectedClips')).toEqual([]);
});

test('the pill names the plan and toggles the ghosts, as Ctrl+Alt+G does', async () => {
  const pill = page.locator('[data-part="proposal-pill"]');
  await expect(pill.locator('b')).toContainText('Pad');
  await expect(pill).toContainText('12 steps');
  const tog = pill.locator('.tog');
  await expect(tog).toHaveAttribute('aria-pressed', 'true');
  await tog.click();
  await expect(tog).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await ghosts()).length).toBe(0);
  await expect(page.locator('[data-part-item="strip"][data-part-key="ghost"]')).toHaveCount(0);
  await page.getByTestId('timeline-canvas').hover();
  await page.keyboard.press('ControlOrMeta+Alt+KeyG');
  await expect(tog).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await ghosts()).length).toBe(EXPECTED.length);
});

test('while playing with ghosts on, only the cursor moves: the content layer is not redrawn', async () => {
  await expect.poll(async () => (await ghosts()).length).toBe(EXPECTED.length);
  await engine.call('transport.locate', { frames: '0' });
  const start = await timeline<number>('contentDraws');
  await engine.call('transport.play');
  await expect.poll(async () => (await timeline<number | null>('cursorX')) ?? 0).toBeGreaterThan(20);
  await engine.call('transport.stop');
  expect(await timeline<number>('contentDraws')).toBeLessThanOrEqual(start + 1);
});

test('the DOM ghosts fade in over 150 ms, and not at all with reduced motion', async () => {
  const strip = page.locator('[data-part-item="strip"][data-part-key="ghost"]');
  await expect(strip).toHaveCount(1);
  expect(await strip.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.15s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await strip.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('an applied, a rejected or a stale plan has no ghosts and no pill, and nothing follows the toolbar\'s refusal line', async () => {
  const noGhosts = async () => {
    await expect.poll(async () => (await ghosts()).length).toBe(0);
    await expect(page.locator('[data-part="proposal-pill"]')).toHaveCount(0);
    await expect(page.locator('[data-part-item="track"][data-part-key="ghost"]')).toHaveCount(0);
    const last = await page.locator('[data-part="toolbar"]').evaluate((el) => el.lastElementChild?.getAttribute('data-testid'));
    expect(last).toBe('timeline-error');
  };
  // Rejected.
  await page.getByTestId('plan-reject').click();
  await page.getByTestId('plan-reject').click();
  await expect(page.getByTestId(`plan-state-${hash8(planHash)}`)).toHaveAttribute('data-state', 'rejected');
  await noGhosts();
  // Stale: another client changes what the plan read.
  const stale = await submit([{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -3000 }]);
  await selectPlan(page, stale);
  await expect.poll(async () => (await ghosts()).length).toBe(1);
  await engine.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -4000 }] });
  await expect(page.getByTestId(`plan-stale-${hash8(stale)}`)).toBeVisible();
  await noGhosts();
  // Applied.
  const applied = await submit([{ op: 'track.set_pan', trackId: 'trk_b', pan: 1000 }]);
  await selectPlan(page, applied);
  await expect.poll(async () => (await ghosts()).length).toBe(1);
  await page.getByTestId('plan-approve-apply').click();
  await expect(page.getByTestId(`plan-state-${hash8(applied)}`)).toHaveAttribute('data-state', 'applied');
  await noGhosts();
});
