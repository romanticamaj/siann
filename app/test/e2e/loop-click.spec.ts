// Locators, cycle and metronome end to end (m5-ui-loop-click; UI redesign
// spec 3.0, 3.1, 3.2, 7 P1-7): the ruler's upper half draws, moves and
// adjusts the locator range and sends one session.set_locators on release;
// Ctrl-click and Alt-click, Ctrl+Num 1 and Ctrl+Num 2 set one locator by the
// rules of 3.2 and the renderer never sends a pair the engine refuses; Ctrl+Z
// restores the previous range; a click on the range, the cycle button, Num /
// and the slash key toggle cycle; P and Alt+P; Num 1 / Num 2 and Shift+1 /
// Shift+2 locate; the metronome button and C toggle the click and a
// right-click sets its level; everything follows the engine, also when
// another connection, an undo or an applied plan changes it; without a device
// the cycle and click controls are disabled and their keys send nothing while
// the band stays editable; reopening the session keeps the range; and against
// an engine whose capabilities lack the methods (SIANN_TEST_CAPABILITIES,
// under SIANN_SHELL_TEST=1 only) none of the controls exists, every other
// part of the transport keeps its box and nothing is sent.
//
// The bundle comes from support/seed.ts (siann-cli); the app runs the real
// siann-engine on the fake device under SIANN_SHELL_TEST=1. Requests the
// renderer sent and the engine's answers are read from window.__siannClient;
// the engine's state from a second protocol client. Waits are condition
// polls, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { RULER_UPPER } from '../../src/renderer/timeline/geometry';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, launchApp, seedBundle } from './support/seed';

const RATE = 48000;
const MOD = 'ControlOrMeta';
const LOOP_METHODS = ['transport.set_cycle', 'transport.set_click'];

interface View {
  readonly framesPerPixel: number;
  readonly scrollFrames: string;
  readonly rulerHeight: number;
  readonly width: number;
}

interface Band {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cycle: boolean;
  readonly left: string;
  readonly right: string;
}

interface Rect {
  readonly clipId: string;
  readonly position: string;
  readonly length: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Request {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly code?: string | null;
}

let scratch = '';
let sessionDir = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-loop-click-'));
  sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_a', name: 'Alpha' },
      { id: 'trk_b', name: 'Beta' },
    ],
    [
      { id: 'clp_a', trackId: 'trk_a', at: 2 },
      { id: 'clp_b', trackId: 'trk_b', at: 6 },
    ],
  );
});

test.afterEach(async () => {
  engine?.close();
  engine = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(options: { engineArgs?: readonly string[]; env?: Record<string, string>; userData?: string } = {}): Promise<void> {
  app = await launchApp({
    sessionDir,
    userData: options.userData ?? path.join(scratch, 'user-data'),
    languages: ['en-US'],
    extraEngineArgs: options.engineArgs,
    env: options.env,
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  engine = await engineClient(page);
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  // Zoom Full (Shift+F): both clips, and every position the tests use, in view.
  const before = (await view()).framesPerPixel;
  await focusProject();
  await page.keyboard.press('Shift+KeyF');
  await expect.poll(async () => (await view()).framesPerPixel).not.toBe(before);
}

async function relaunch(options: Parameters<typeof launch>[0] = {}): Promise<void> {
  engine?.close();
  engine = undefined;
  await app!.close();
  app = undefined;
  await launch(options);
}

// The timeline's test hooks (the CSP allows no eval in the page).
async function hook<T>(name: string): Promise<T> {
  return page.evaluate((called) => {
    const hooks = (window as unknown as { __siannTimeline?: Record<string, () => unknown> }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
    return hooks[called]!();
  }, name) as Promise<T>;
}

const band = () => hook<Band | null>('locatorBand');
const view = () => hook<View>('view');

async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await page.getByTestId('timeline-canvas').boundingBox();
  if (!found) throw new Error('the canvas is not laid out');
  return found;
}

async function sent(): Promise<Request[]> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient?: { sent(): Request[] } }).__siannClient;
    if (!client) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return client.sent().map((r) => ({ method: r.method, params: r.params }));
  });
}

async function answered(): Promise<Request[]> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient?: { answered(): Request[] } }).__siannClient;
    return client!.answered().map((r) => ({ method: r.method, params: r.params, code: r.code }));
  });
}

const isSetLocators = (r: Request) =>
  r.method === 'command.execute' && ((r.params.commands as Array<{ op?: string }> | undefined) ?? []).some((c) => c.op === 'session.set_locators');

async function setLocatorsSent(): Promise<number> {
  return (await sent()).filter(isSetLocators).length;
}

async function loopRequests(): Promise<number> {
  return (await sent()).filter((r) => LOOP_METHODS.includes(r.method) || isSetLocators(r)).length;
}

// No session.set_locators the engine answered invalid_locators (spec 3.2:
// the renderer never sends a pair it knows the engine refuses).
async function expectNoInvalidLocators(): Promise<void> {
  const refused = (await answered()).filter((r) => isSetLocators(r) && r.code !== null);
  expect(refused).toEqual([]);
}

async function revisions(): Promise<number> {
  return (await engine!.call('session.inspect')).revisions as number;
}

async function locators(): Promise<{ left: string; right: string } | null> {
  const fetched = (await engine!.call('session.fetch', { refs: ['locators:locators'] })) as {
    entities: Array<{ entity?: { left: string; right: string }; missing?: true }>;
  };
  const entity = fetched.entities[0]?.entity;
  return entity ? { left: entity.left, right: entity.right } : null;
}

async function status(): Promise<{ cycle: boolean; click: { enabled: boolean; gainMilliDb: number }; playing: boolean }> {
  return (await engine!.call('engine.status')) as never;
}

// The frame under canvas x at the current view (geometry.ts xToFrame).
async function frameAt(x: number): Promise<bigint> {
  const v = await view();
  const frame = BigInt(v.scrollFrames) + BigInt(Math.round(x * v.framesPerPixel));
  return frame < 0n ? 0n : frame;
}

// The band shows what the engine holds: a gesture starts on the committed
// range, not on one whose session.changed has not arrived yet.
async function inStep(): Promise<void> {
  await expect
    .poll(async () => {
      const [drawn, held] = [await band(), await locators()];
      return drawn === null ? held === null : held !== null && drawn.left === held.left && drawn.right === held.right;
    })
    .toBe(true);
}

// A press, a move and a release in the ruler's upper half, canvas x; with
// `sync` (the default) once the band is in step with the engine.
async function upperDrag(from: number, to: number, modifiers: readonly string[] = [], sync = true): Promise<void> {
  if (sync) await inStep();
  const box = await canvasBox();
  const y = box.y + RULER_UPPER / 2;
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(box.x + from, y);
  await page.mouse.down();
  if (to !== from) await page.mouse.move(box.x + to, y, { steps: 5 });
  await page.mouse.up();
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
}

async function setByEngine(left: number, right: number): Promise<Band> {
  await engine!.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(left), right: String(right) }] });
  await expect.poll(async () => (await band())?.left).toBe(String(left));
  return (await band())!;
}

// An empty spot of the canvas (below the lanes) focuses the project zone and selects nothing.
async function focusProject(): Promise<void> {
  const box = await canvasBox();
  await page.mouse.click(box.x + 20, box.y + box.height - 10);
}

async function snapOff(): Promise<void> {
  const toggle = page.getByTestId('snap-toggle');
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

async function clickClip(clipId: string, modifiers: readonly string[] = []): Promise<Rect> {
  await expect.poll(async () => (await hook<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  const rect = (await hook<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
  const box = await canvasBox();
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(box.x + rect.x + rect.width / 2, box.y + rect.y + rect.height / 2);
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  return rect;
}

async function cursorAt(frame: number): Promise<void> {
  const v = await view();
  const x = (frame - Number(v.scrollFrames)) / v.framesPerPixel;
  await expect.poll(async () => Math.abs(((await hook<number | null>('cursorX')) ?? -1000) - x)).toBeLessThan(1.5);
}

test('drawing, Ctrl-click, Alt-click, moving, adjusting, Ctrl+Num 1 / 2 and Ctrl+Z edit the locators; nothing refused is sent', async () => {
  await launch();
  await snapOff();
  // No locators yet: no display, its cell empty at --display-locators-empty-w; no band.
  await expect(page.getByTestId('display-locators')).toHaveCount(0);
  await expect(page.locator('.transport-locators-empty')).toHaveCount(1);
  expect(await band()).toBeNull();
  const start = await revisions();

  // With none set, Ctrl-click (the left locator) sends nothing.
  await upperDrag(150, 150, [MOD]);
  // Draw from x 100 to x 300: one session.set_locators on release, one revision.
  await upperDrag(100, 300);
  await expect.poll(setLocatorsSent).toBe(1);
  await expect.poll(revisions).toBe(start + 1);
  const drawn = { left: (await frameAt(100)).toString(), right: (await frameAt(300)).toString() };
  expect(await locators()).toEqual(drawn);
  await expect.poll(async () => (await band())?.right).toBe(drawn.right);
  await expect(page.getByTestId('display-locators')).toBeVisible();
  await expect(page.locator('.transport-locators-empty')).toHaveCount(0);

  // Ctrl-click sets the left locator, Alt-click the right one.
  await upperDrag(150, 150, [MOD]);
  await expect.poll(async () => (await locators())?.left).toBe((await frameAt(150)).toString());
  await upperDrag(350, 350, ['Alt']);
  await expect.poll(async () => (await locators())?.right).toBe((await frameAt(350)).toString());
  // An Alt-click before the left locator, a Ctrl-click after the right one: nothing.
  const count = await setLocatorsSent();
  await upperDrag(120, 120, ['Alt']);
  await upperDrag(400, 400, [MOD]);
  expect(await setLocatorsSent()).toBe(count);

  // Drag the range by 50 px: moved, its length kept.
  const before = (await locators())!;
  await upperDrag(250, 300);
  const length = BigInt(before.right) - BigInt(before.left);
  await expect.poll(async () => (await locators())?.left).toBe((await frameAt(200)).toString());
  const moved = (await locators())!;
  expect(BigInt(moved.right) - BigInt(moved.left)).toBe(length);
  // Drag the right end out to x 500, then past the left end: it stops one pixel before it.
  await upperDrag(400, 500);
  await expect.poll(async () => (await locators())?.right).toBe((await frameAt(500)).toString());
  await upperDrag(500, 50);
  const v = await view();
  await expect.poll(async () => (await locators())?.right).toBe((BigInt((await locators())!.left) + BigInt(Math.round(v.framesPerPixel))).toString());

  // Ctrl+Num 1 / Ctrl+Num 2: the locators to the project cursor.
  await focusProject();
  await engine!.call('transport.locate', { frames: String(4 * RATE) });
  await cursorAt(4 * RATE);
  await page.keyboard.press(`${MOD}+Numpad2`);
  await expect.poll(async () => (await locators())?.right).toBe(String(4 * RATE));
  await engine!.call('transport.locate', { frames: String(3 * RATE) });
  await cursorAt(3 * RATE);
  await page.keyboard.press(`${MOD}+Numpad1`);
  await expect.poll(async () => (await locators())?.left).toBe(String(3 * RATE));
  await expect(page.getByTestId('display-locators-value')).toHaveText('2.3 – 3.1');

  // Ctrl+Z restores the previous range, and undoing the first one removes the locators.
  const edits = (await revisions()) - start;
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(async () => (await locators())?.left).not.toBe(String(3 * RATE));
  await expect.poll(async () => (await band())?.left).toBe((await locators())!.left);
  for (let i = 1; i < edits; i += 1) await page.keyboard.press(`${MOD}+KeyZ`);
  await expect.poll(locators).toBeNull();
  await expect.poll(band).toBeNull();
  await expect(page.getByTestId('display-locators')).toHaveCount(0);
  await expect(page.locator('.transport-locators-empty')).toHaveCount(1);
  await expectNoInvalidLocators();
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('Alt-click with no locators gives the range from 0, and a zero-length draw sends nothing', async () => {
  await launch();
  await snapOff();
  await upperDrag(200, 200);
  await upperDrag(300, 301);
  expect(await setLocatorsSent()).toBe(0);
  await upperDrag(250, 250, ['Alt']);
  await expect.poll(locators).toEqual({ left: '0', right: (await frameAt(250)).toString() });
  await expectNoInvalidLocators();
});

test('the range, the cycle button, Num / and / toggle cycle; P and Alt+P; Num 1 / 2 and Shift+1 / 2 locate', async () => {
  await launch();
  const drawn = await setByEngine(RATE, 3 * RATE);
  const cycleButton = page.getByTestId('transport-cycle');
  await expect(cycleButton).toHaveAttribute('aria-pressed', 'false');
  expect(drawn.cycle).toBe(false);

  // A click on the range: cycle on (the engine's state; band and button follow it).
  await upperDrag(drawn.x + drawn.width / 2, drawn.x + drawn.width / 2);
  await expect.poll(async () => (await status()).cycle).toBe(true);
  await expect(cycleButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await band())?.cycle).toBe(true);
  // The button: off. Num /: on. The slash key: off.
  await cycleButton.click();
  await expect.poll(async () => (await status()).cycle).toBe(false);
  await expect.poll(async () => (await band())?.cycle).toBe(false);
  await focusProject();
  await page.keyboard.press('NumpadDivide');
  await expect.poll(async () => (await status()).cycle).toBe(true);
  await expect(cycleButton).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Slash');
  await expect.poll(async () => (await status()).cycle).toBe(false);
  await expect(cycleButton).toHaveAttribute('aria-pressed', 'false');

  // Num 1 / Num 2 and Shift+1 / Shift+2 move the cursor to the locators.
  await page.keyboard.press('Numpad2');
  await cursorAt(3 * RATE);
  await page.keyboard.press('Numpad1');
  await cursorAt(RATE);
  await page.keyboard.press('Shift+Digit2');
  await cursorAt(3 * RATE);
  await page.keyboard.press('Shift+Digit1');
  await cursorAt(RATE);

  // P: the locators to the selection.
  const a = await clickClip('clp_a');
  await page.keyboard.press('KeyP');
  await expect.poll(locators).toEqual({ left: a.position, right: (BigInt(a.position) + BigInt(a.length)).toString() });
  // Alt+P: Loop Selection, playing from the left locator with cycle on.
  const b = await clickClip('clp_b');
  const from = (await sent()).length;
  await page.keyboard.press('Alt+KeyP');
  await expect.poll(async () => (await status()).playing).toBe(true);
  expect((await status()).cycle).toBe(true);
  expect(await locators()).toEqual({ left: b.position, right: (BigInt(b.position) + BigInt(b.length)).toString() });
  const order = (await sent())
    .slice(from)
    .filter((r) => isSetLocators(r) || /^transport\./.test(r.method))
    .map((r) => (isSetLocators(r) ? 'session.set_locators' : r.method));
  expect(order).toEqual(['session.set_locators', 'transport.set_cycle', 'transport.locate', 'transport.play']);
  expect((await sent()).find((r) => r.method === 'transport.locate' && r.params.frames === b.position)).toBeTruthy();
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect.poll(async () => (await status()).playing).toBe(false);
  await expectNoInvalidLocators();
});

test('the metronome button and C toggle the click, and a right-click sets its level', async () => {
  await launch();
  const metronome = page.getByTestId('transport-metronome');
  await expect(metronome).toHaveAttribute('aria-pressed', 'false');
  await metronome.click();
  await expect.poll(async () => (await status()).click.enabled).toBe(true);
  await expect(metronome).toHaveAttribute('aria-pressed', 'true');
  await focusProject();
  await page.keyboard.press('KeyC');
  await expect.poll(async () => (await status()).click.enabled).toBe(false);
  await expect(metronome).toHaveAttribute('aria-pressed', 'false');

  // The level: right-click, one step down from -12 dB, sent when released.
  const gain = (await status()).click.gainMilliDb;
  await metronome.click({ button: 'right' });
  const level = page.getByTestId('click-level-input');
  await expect(level).toBeFocused();
  await expect(level).toHaveValue(String(gain / 1000));
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await status()).click.gainMilliDb).toBe(gain - 1000);
  await expect(page.getByTestId('click-level-value')).toHaveText(`${gain / 1000 - 1} dB`);
  // The on / off state is kept; Escape closes it.
  expect((await status()).click.enabled).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('click-level')).toHaveCount(0);
});

test('the band and both buttons follow another connection, an undo and an applied plan', async () => {
  await launch();
  const other = await engineClient(page);
  try {
    await other.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(RATE), right: String(5 * RATE) }] });
    await expect.poll(async () => (await band())?.right).toBe(String(5 * RATE));
    await expect(page.getByTestId('display-locators-value')).toHaveText('1.3 – 3.3');
    await other.call('transport.set_cycle', { enabled: true });
    await expect(page.getByTestId('transport-cycle')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await band())?.cycle).toBe(true);
    await other.call('transport.set_click', { enabled: true, gainMilliDb: -6000 });
    await expect(page.getByTestId('transport-metronome')).toHaveAttribute('aria-pressed', 'true');
    await other.call('transport.set_cycle', { enabled: false });
    await expect(page.getByTestId('transport-cycle')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await band())?.cycle).toBe(false);
    await other.call('transport.set_click', { enabled: false });
    await expect(page.getByTestId('transport-metronome')).toHaveAttribute('aria-pressed', 'false');
    // Another range, then the other connection's undo brings the first back.
    await other.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(2 * RATE), right: String(6 * RATE) }] });
    await expect.poll(async () => (await band())?.left).toBe(String(2 * RATE));
    await other.call('session.undo');
    await expect.poll(async () => (await band())?.left).toBe(String(RATE));
    // An agent's plan, approved and applied.
    const agent = await agentFor(app!);
    const plan = await agent.tool('submit_plan', { steps: [{ op: 'session.set_locators', left: String(4 * RATE), right: String(8 * RATE) }] });
    await other.call('plan.approve', { plan: plan.hash as string });
    await other.call('plan.apply', { plan: plan.hash as string });
    await expect.poll(async () => (await band())?.left).toBe(String(4 * RATE));
    await expect(page.getByTestId('display-locators-value')).toHaveText('3.1 – 5.1');
  } finally {
    other.close();
  }
});

test('without a device cycle and the metronome are disabled with the reason and their keys send nothing; the band stays editable and P works', async () => {
  // Every open of the fake device fails (as transport.spec.ts does).
  await launch({ engineArgs: ['--fake-open-failures', '1000'] });
  await snapOff();
  const reasons: Array<[string, string]> = [
    ['transport-cycle', en['transport.noDeviceCycle']],
    ['transport-metronome', en['transport.noDeviceClick']],
  ];
  for (const [id, text] of reasons) {
    const button = page.getByTestId(id);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', new RegExp(`^[a-z_]+: ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  }
  // The band: drawn and edited without a device.
  await upperDrag(100, 300);
  await expect.poll(locators).not.toBeNull();
  // The band shows the document's range (after the release the drag's preview
  // is gone until session.changed brings the commit: never optimistic).
  const committed = (await locators())!;
  await expect.poll(async () => (await band())?.left).toBe(committed.left);
  const drawn = (await band())!;
  // A click on the range, the keys and Alt+P send nothing.
  const polls = (await sent()).filter((r) => r.method === 'engine.status').length;
  await upperDrag(drawn.x + drawn.width / 2, drawn.x + drawn.width / 2);
  await focusProject();
  for (const key of ['NumpadDivide', 'Slash', 'KeyC', 'Numpad1', 'Shift+Digit2']) await page.keyboard.press(key);
  await clickClip('clp_a');
  await page.keyboard.press('Alt+KeyP');
  await expect.poll(async () => (await sent()).filter((r) => r.method === 'engine.status').length).toBeGreaterThan(polls);
  expect((await sent()).filter((r) => /^transport\./.test(r.method))).toEqual([]);
  // P needs no device.
  const a = (await hook<Rect[]>('clips')).find((r) => r.clipId === 'clp_a')!;
  await page.keyboard.press('KeyP');
  await expect.poll(locators).toEqual({ left: a.position, right: (BigInt(a.position) + BigInt(a.length)).toString() });
  await expectNoInvalidLocators();
});

test('reopening the session shows the same locator range', async () => {
  await launch();
  await snapOff();
  await upperDrag(120, 280);
  await expect.poll(locators).not.toBeNull();
  const range = (await locators())!;
  await relaunch();
  await expect.poll(async () => (await band())?.left).toBe(range.left);
  expect((await band())!.right).toBe(range.right);
  await expect(page.getByTestId('display-locators')).toBeVisible();
});

test('against an engine whose capabilities lack the methods none of the controls exists, their space stays and nothing is sent', async () => {
  await launch();
  const parts = ['transport-to-start', 'transport-stop', 'transport-play', 'position-display', 'transport-tempo', 'undo', 'redo', 'session-name', 'plans-button'];
  const boxes = async () => {
    const out: Record<string, unknown> = {};
    for (const id of parts) out[id] = await page.getByTestId(id).boundingBox();
    return out;
  };
  const full = await boxes();
  // The engine's own answer without E-1's methods, features and command.
  const capabilities = (await engine!.call('engine.capabilities')) as { methods: string[]; commands: string[]; features: Record<string, unknown> };
  const reduced = {
    ...capabilities,
    methods: capabilities.methods.filter((m) => !LOOP_METHODS.includes(m)),
    commands: capabilities.commands.filter((c) => c !== 'session.set_locators'),
    features: Object.fromEntries(Object.entries(capabilities.features).filter(([name]) => !['locators', 'cycle', 'click'].includes(name))),
  };
  const file = path.join(scratch, 'capabilities-without-loop-click.json');
  fs.writeFileSync(file, JSON.stringify(reduced));
  // A range the session holds: the band would show it.
  await engine!.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(RATE), right: String(3 * RATE) }] });
  await relaunch({ env: { SIANN_TEST_CAPABILITIES: file } });
  await expect(page.getByTestId('transport-play')).toBeVisible();
  for (const id of ['transport-cycle', 'transport-click', 'transport-metronome', 'display-locators']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator(`[data-part="${id}"]`)).toHaveCount(0);
  }
  expect(await band()).toBeNull();
  // The other parts keep their boxes: the empty ones hold the space.
  expect(await boxes()).toEqual(full);
  const holds = page.locator('.transport-hold, .transport-locators-empty');
  await expect(holds).toHaveCount(3);
  for (const hold of await holds.all()) {
    await expect(hold).toHaveAttribute('aria-hidden', 'true');
    expect(await hold.getAttribute('role')).toBeNull();
    expect(await hold.getAttribute('tabindex')).toBeNull();
    expect(await hold.getAttribute('data-part')).toBeNull();
  }
  // No gesture or key sends any of them.
  await upperDrag(100, 300, [], false);
  await upperDrag(200, 200, [], false);
  await upperDrag(250, 250, ['Alt'], false);
  await focusProject();
  for (const key of ['NumpadDivide', 'Slash', 'KeyC', `${MOD}+Numpad2`]) await page.keyboard.press(key);
  await clickClip('clp_a');
  await page.keyboard.press('KeyP');
  await page.keyboard.press('Alt+KeyP');
  // The status bar's next engine.status poll comes after the keys.
  const polls = (await sent()).filter((r) => r.method === 'engine.status').length;
  await expect.poll(async () => (await sent()).filter((r) => r.method === 'engine.status').length).toBeGreaterThan(polls);
  expect(await loopRequests()).toBe(0);
});
