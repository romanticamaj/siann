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
import { agentFor, hash8, launchApp, seedBundle, type Agent } from './support/seed';

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
  expect(new Set(added.filter((m) => !['plan.list', 'plan.status', 'session.inspect', 'session.fetch'].includes(m)))).toEqual(new Set(['plan.preview']));
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
  for (const id of ['lane-ghost', 'clip-ghost-new', 'clip-ghost-move', 'clip-ghost-trim', 'clip-ghost-remove', 'locator-band-ghost']) expect(parts, id).toContain(id);
});

test('hovering a step outlines its ghosts and scrolls them into view; .go by keyboard opens the MixConsole and pins the step; no request', async () => {
  const before = await methods();
  // The placed clip (step 2, at 3 s) out of view: zoom in and scroll right.
  const canvas = page.getByTestId('timeline-canvas');
  await canvas.hover();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('KeyH');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 600);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await timeline<Array<{ id: string; x: number }>>('parts')).find((p) => p.id === 'clip-ghost-new')?.x ?? -1e9).toBeLessThan(-50);
  const far = await timeline<{ scrollFrames: string }>('view');
  await step(1).hover();
  await expect.poll(() => timeline<number | null>('ghostOutline')).toBe(2);
  await expect.poll(async () => (await timeline<{ scrollFrames: string }>('view')).scrollFrames).not.toBe(far.scrollFrames);
  const shown = (await timeline<Array<{ id: string; x: number; w: number }>>('parts')).find((p) => p.id === 'clip-ghost-new')!;
  const width = (await timeline<{ width: number }>('view')).width;
  expect(shown.x).toBeGreaterThanOrEqual(-1);
  expect(shown.x + shown.w).toBeLessThanOrEqual(width + 1);
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
  expect((await methods()).slice(before.length).filter((m) => m !== 'plan.list' && m !== 'plan.status')).toEqual([]);
});

test('a click on a ghost cap or a ghost clip pins its step and shows its row on the Plans tab', async () => {
  // The right zone hidden first.
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) === 'true') await page.getByTestId('zone-button-right').click();
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'false');
  await page.getByTestId('mixer-strip-trk_a').locator('[data-part-of="cap-ghost"]').click({ force: true });
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'true');
  await expect(step(2)).toHaveAttribute('aria-current', 'step');
  await expect(step(2)).toBeInViewport();
  // A ghost clip on the canvas: the placed one (step 2).
  await page.keyboard.press('Shift+KeyF');
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
  await expect(pill.locator('b')).toHaveText('Add track Pad');
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
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(stale));
  await expect.poll(async () => (await ghosts()).length).toBe(1);
  await engine.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -4000 }] });
  await expect(page.getByTestId(`plan-stale-${hash8(stale)}`)).toBeVisible();
  await noGhosts();
  // Applied.
  const applied = await submit([{ op: 'track.set_pan', trackId: 'trk_b', pan: 1000 }]);
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(applied));
  await expect.poll(async () => (await ghosts()).length).toBe(1);
  await page.getByTestId('plan-approve-apply').click();
  await expect(page.getByTestId(`plan-state-${hash8(applied)}`)).toHaveAttribute('data-state', 'applied');
  await noGhosts();
});
