// Bus strips, send slots and output routing end to end (m5b-ui-sends-buses;
// UI redesign 3.4, 3.0, 3.6, 4.5 C5; 10.11, 24; docs/schemas/
// protocol-engine-v0.md, "Buses and sends"). Against the real engine with the
// fake device and a seeded one-second clip on Keys, played in a cycle over
// it, so the meters read while the tests act:
//
// (a) Add Bus from the application menu is one bus.add ("Bus 1"); a send from
//     the Sends rack's empty slot is one send.add post-fader at 0 dB; the bus
//     meter (bus:<id>) reads the track; the track fader lowered, it falls;
//     the send switched to pre, it reads again; the track routed to the bus
//     from the Routing rack is one track.set_output; Ctrl+Z undoes each, one
//     revision per step.
// (b) Two buses: A to B, then B to A is refused with routing_cycle, shown at
//     B's selector, which keeps its value; no revision.
// (c) Removing a bus with a send asks first, naming the track; one revision,
//     and one undo restores the bus, its send and the routing.
// (d) The send level (the Inspector's slot): a drag is one revision, Shift is
//     fine, Ctrl-click 0 dB; the bus pan is one bus.set_pan at release; the
//     bus is renamed by a double-click on its name.
// (e) Every data-part id of the feature is in the window; with capabilities
//     without features.buses and features.sends (capabilities-reduced.json,
//     the override inserts.spec.ts uses) none of it is in the DOM.
//
// Waits are Playwright condition waits; none sleeps.

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { APP_DIR, launchApp, seedBundle } from './support/seed';

const KEYS = 'trk_keys';
const PAD = 'trk_pad';
const FIXTURES = path.join(APP_DIR, 'test', 'unit', 'fixtures');

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let client: EngineClient | undefined;

test.afterEach(async () => {
  await client?.call('transport.stop').catch(() => undefined);
  client?.close();
  client = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(env: Record<string, string> = {}): Promise<void> {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-buses-'));
  const sessionDir = seedBundle(scratch, [{ id: KEYS, name: 'Keys' }, { id: PAD, name: 'Pad' }], [{ id: 'clp_keys', trackId: KEYS, at: 0 }]);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true, env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId(`mixer-strip-${KEYS}`)).toBeVisible();
  client = await engineClient(page);
}

async function revisions(): Promise<number> {
  return (await client!.call('session.inspect')).revisions as number;
}

async function entity(ref: string): Promise<Record<string, unknown> | null> {
  const fetched = (await client!.call('session.fetch', { refs: [ref] })) as { entities: Array<{ entity?: Record<string, unknown>; missing?: true }> };
  return fetched.entities[0]?.entity ?? null;
}

async function busIds(): Promise<string[]> {
  return ((await entity('root:root'))?.busOrder as string[] | undefined) ?? [];
}

async function clickMenu(id: string): Promise<void> {
  await expect.poll(() => app!.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null, id)).toBe(true);
  await app!.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.click(), id);
}

async function meterPeak(ref: string): Promise<number> {
  return page.evaluate((r) => (window as unknown as { __siannMeters?: { read(ref: string): { peak: number } | null } }).__siannMeters?.read(r)?.peak ?? 0, ref);
}

// The clip in a cycle over its second, playing.
async function play(): Promise<void> {
  await client!.call('command.execute', { commands: [{ op: 'session.set_locators', left: '0', right: '48000' }] });
  await client!.call('transport.set_cycle', { enabled: true });
  await client!.call('transport.play');
}

// One user action and the one revision it makes.
async function oneRevision(action: () => Promise<void>): Promise<void> {
  const before = await revisions();
  await action();
  await expect.poll(() => revisions()).toBe(before + 1);
}

async function undo(): Promise<void> {
  await oneRevision(async () => {
    await page.getByTestId('mixer').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('ControlOrMeta+KeyZ');
  });
}

const rackSwitch = (rack: 'routing' | 'inserts' | 'sends') => page.locator('[data-part="mixer-racks"]').getByTestId(`rack-${rack}`);
const busStrip = (id: string) => page.getByTestId(`mixer-strip-bus-${id}`);

async function addBusFromMenu(): Promise<string> {
  const before = await busIds();
  await oneRevision(() => clickMenu('mixer.bus.add'));
  const after = await busIds();
  const id = after.find((b) => !before.includes(b))!;
  await expect(busStrip(id)).toBeVisible();
  return id;
}

async function addSend(trackId: string, busName: string): Promise<string> {
  await rackSwitch('sends').click();
  await expect(rackSwitch('sends')).toHaveAttribute('aria-pressed', 'true');
  await oneRevision(async () => {
    await page.getByTestId(`mixer-strip-${trackId}`).locator('.ins .slot.empty').first().click();
    const picker = page.getByTestId('bus-picker');
    await expect(picker).toBeVisible();
    await picker.locator('[data-testid="bus-picker-choose"]', { hasText: busName }).click();
  });
  const sends = ((await entity(`track:${trackId}`))?.sends as string[] | undefined) ?? [];
  return sends.at(-1)!;
}

test('(a) a bus from the menu, a post-fader send, the bus meter following the fader, pre, routing, and undo of each', async () => {
  await launch();
  // The clip plays in a cycle (its locators are the one revision before the test's own).
  await play();
  // Add Bus: one bus.add named Bus 1; the strip stands after the tracks, before the master.
  const bus = await addBusFromMenu();
  expect((await entity(`bus:${bus}`))?.name).toBe('Bus 1');
  const order = await page.locator('[data-testid^="mixer-strip-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(order).toEqual([`mixer-strip-${KEYS}`, `mixer-strip-${PAD}`, `mixer-strip-bus-${bus}`, 'mixer-strip-master']);
  await expect(busStrip(bus).locator('.nametag')).toHaveText('Bus 1');

  // A send: post-fader at 0 dB.
  const sendId = await addSend(KEYS, 'Bus 1');
  expect(await entity(`send:${sendId}`)).toMatchObject({ trackId: KEYS, busId: bus, levelMilliDb: 0, pre: false, enabled: true });
  await expect(page.getByTestId(`send-pre-${sendId}`)).toHaveText('POST');

  // The bus meter reads the track; the track fader lowered, it falls.
  await expect.poll(() => meterPeak(`bus:${bus}`), { timeout: 10_000 }).toBeGreaterThan(0.2);
  await oneRevision(async () => {
    await page.getByTestId(`fader-value-${KEYS}`).dblclick();
    await page.getByTestId(`gain-input-${KEYS}`).fill('-40');
    await page.getByTestId(`gain-input-${KEYS}`).press('Enter');
  });
  await expect.poll(() => meterPeak(`bus:${bus}`), { timeout: 10_000 }).toBeLessThan(0.05);

  // Pre-fader: the bus reads the track before its fader again.
  await oneRevision(async () => {
    await page.getByTestId(`send-${sendId}`).hover();
    await page.getByTestId(`send-pre-${sendId}`).click();
  });
  await expect(page.getByTestId(`send-pre-${sendId}`)).toHaveText('PRE');
  await expect(page.getByTestId(`send-pre-${sendId}`)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => meterPeak(`bus:${bus}`), { timeout: 10_000 }).toBeGreaterThan(0.2);

  // Route Pad to the bus from the Routing rack.
  await rackSwitch('routing').click();
  await expect(rackSwitch('sends')).toHaveAttribute('aria-pressed', 'false');
  const selector = page.getByTestId(`output-${PAD}`);
  await expect(page.getByTestId(`mixer-strip-${PAD}`).locator('.ins .slot-name')).toHaveText('Master');
  await oneRevision(() => selector.selectOption(bus));
  expect((await entity(`track:${PAD}`))?.output).toEqual({ busId: bus });
  await expect(page.getByTestId(`mixer-strip-${PAD}`).locator('.ins .slot-name')).toHaveText('Bus 1');

  // Ctrl+Z undoes each, one revision per step, newest first.
  await undo();
  expect((await entity(`track:${PAD}`))?.output).toBeUndefined();
  await expect(page.getByTestId(`mixer-strip-${PAD}`).locator('.ins .slot-name')).toHaveText('Master');
  await undo();
  expect((await entity(`send:${sendId}`))?.pre).toBe(false);
  await undo();
  expect((await entity(`track:${KEYS}`))?.gainMilliDb).toBe(0);
  await undo();
  expect(await entity(`send:${sendId}`)).toBeNull();
  await undo();
  expect(await busIds()).toEqual([]);
  await expect(page.locator('[data-testid^="mixer-strip-bus-"]')).toHaveCount(0);
});

test('(b) a bus routed into a loop is refused with routing_cycle at its selector, and nothing changes', async () => {
  await launch();
  const a = await addBusFromMenu();
  const b = await addBusFromMenu();
  await expect(busStrip(b).locator('.nametag')).toHaveText('Bus 2');
  await rackSwitch('routing').click();
  // A to B.
  await oneRevision(() => page.getByTestId(`output-${a}`).selectOption(b));
  expect((await entity(`bus:${a}`))?.output).toEqual({ busId: b });
  // B to A is offered, and refused.
  const before = await revisions();
  const selector = page.getByTestId(`output-${b}`);
  await expect(selector.locator('option')).toHaveCount(2);
  await selector.selectOption(a);
  const refusal = page.getByTestId(`output-refusal-${b}`);
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('routing_cycle');
  await expect(selector).toHaveValue('');
  await expect(busStrip(b).locator('.ins .slot-name')).toHaveText('Master');
  expect(await revisions()).toBe(before);
  expect((await entity(`bus:${b}`))?.output).toBeUndefined();
});

test('(c) removing a bus with a send asks, naming the track; one revision; one undo restores the bus, its send and the routing', async () => {
  await launch();
  const bus = await addBusFromMenu();
  const sendId = await addSend(KEYS, 'Bus 1');
  await client!.call('command.execute', { commands: [{ op: 'track.set_output', trackId: PAD, output: { busId: bus } }] });
  // Remove Bus acts on the selected bus: disabled until a bus strip is pressed.
  expect(await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('mixer.bus.remove')?.enabled ?? null)).toBe(false);
  await busStrip(bus).locator('.scale').click();
  await expect(busStrip(bus)).toHaveClass(/\bsel\b/);
  await expect(busStrip(bus)).toHaveAttribute('aria-selected', 'true');
  const before = await revisions();
  await clickMenu('mixer.bus.remove');
  const dialog = page.locator('dialog[open][data-testid="confirm-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Keys');
  await expect(dialog).toContainText('Pad');
  expect(await revisions()).toBe(before, 'nothing before the confirmation');
  await dialog.getByTestId('confirm-ok').click();
  await expect.poll(() => revisions()).toBe(before + 1);
  await expect(busStrip(bus)).toHaveCount(0);
  expect(await entity(`send:${sendId}`)).toBeNull();
  // One undo: the bus, the send and the output are back.
  await undo();
  await expect(busStrip(bus)).toBeVisible();
  expect(await entity(`send:${sendId}`)).toMatchObject({ trackId: KEYS, busId: bus });
  expect((await entity(`track:${PAD}`))?.output).toEqual({ busId: bus });
  // Selecting a track clears the bus selection.
  await busStrip(bus).locator('.scale').click();
  await expect(busStrip(bus)).toHaveClass(/\bsel\b/);
  await page.getByTestId(`track-header-${KEYS}`).click();
  await expect(busStrip(bus)).not.toHaveClass(/\bsel\b/);
});

async function dragBy(control: Locator, dx: number, shift = false): Promise<void> {
  const box = (await control.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test('(d) the send level is one revision per drag, Shift fine, Ctrl-click 0 dB; the bus pan is one bus.set_pan at release; rename', async () => {
  await launch();
  const bus = await addBusFromMenu();
  const sendId = await addSend(KEYS, 'Bus 1');
  await page.getByTestId(`track-header-${KEYS}`).click();
  const level = page.locator('[data-part="inspector-sends"]').getByTestId(`islot-send-level-${sendId}`);
  await expect(level).toHaveAttribute('aria-valuetext', '0.0 dB');
  // A drag to the left: one revision, a lower level.
  await oneRevision(() => dragBy(level, -60));
  const coarse = (await entity(`send:${sendId}`))!.levelMilliDb as number;
  expect(coarse).toBeLessThan(0);
  await expect(level).not.toHaveAttribute('aria-valuetext', '0.0 dB');
  // Ctrl-click: 0 dB, one revision.
  await oneRevision(async () => {
    await page.keyboard.down('Control');
    await level.click();
    await page.keyboard.up('Control');
  });
  expect((await entity(`send:${sendId}`))!.levelMilliDb).toBe(0);
  // Shift: the same drag moves a tenth as far.
  await oneRevision(() => dragBy(level, -60, true));
  const fine = (await entity(`send:${sendId}`))!.levelMilliDb as number;
  expect(fine).toBeLessThan(0);
  expect(fine).toBeGreaterThan(coarse);

  // The bus pan: nothing while dragging, one bus.set_pan at release.
  const knob = page.getByTestId(`pan-${bus}`);
  const box = (await knob.boundingBox())!;
  const before = await revisions();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 5 });
  expect(await revisions()).toBe(before, 'no revision while held');
  await page.mouse.up();
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await entity(`bus:${bus}`))!.pan as number).toBeLessThan(0);
  const sent = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient.sent());
  expect(sent.filter((r) => r.method === 'gesture.begin' && (r.params.target as { ref: string }).ref === `bus:${bus}` && (r.params.target as { param: string }).param === 'pan')).toEqual([]);

  // Rename by a double-click on the name tag: Enter commits one bus.rename; an unchanged name sends nothing.
  await oneRevision(async () => {
    await page.getByTestId(`strip-name-${bus}`).dblclick();
    await page.getByTestId(`bus-rename-${bus}`).fill('Verb');
    await page.getByTestId(`bus-rename-${bus}`).press('Enter');
  });
  await expect(page.getByTestId(`strip-name-${bus}`)).toHaveText('Verb');
  const unchanged = await revisions();
  await page.getByTestId(`strip-name-${bus}`).dblclick();
  await page.getByTestId(`bus-rename-${bus}`).press('Enter');
  await expect(page.getByTestId(`bus-rename-${bus}`)).toHaveCount(0);
  expect(await revisions()).toBe(unchanged);
});

test('(e) every data-part id of the feature is in the window; reduced capabilities have none of it', async () => {
  await launch();
  await page.getByTestId(`track-header-${KEYS}`).click();
  for (const id of ['inspector-routing', 'inspector-sends', 'mixer-racks']) await expect(page.locator(`[data-part="${id}"]`), id).toHaveCount(1);
  await expect(page.getByTestId('rack-routing')).toHaveText('Routing');
  await expect(page.getByTestId('rack-sends')).toHaveText('Sends');
  await expect(page.getByTestId('inspector-out-row')).toBeVisible();
  // The Routing section keeps the mockup's box (91 px) and the Sends section is open.
  await expect(page.locator('[data-part="inspector-sends"] .islot.empty')).toHaveCount(1);
  await app!.close();
  app = undefined;
  fs.rmSync(scratch, { recursive: true, force: true });

  await launch({ SIANN_TEST_CAPABILITIES: path.join(FIXTURES, 'capabilities-reduced.json') });
  await page.getByTestId(`track-header-${KEYS}`).click();
  for (const id of ['inspector-routing', 'inspector-sends']) await expect(page.locator(`[data-part="${id}"]`), id).toHaveCount(0);
  await expect(page.locator('[data-testid^="rack-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="mixer-strip-bus-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="output-"], [data-testid^="send-"], [data-testid^="islot-send-"]')).toHaveCount(0);
  await expect(page.getByTestId('inspector-out-row')).toHaveCount(0);
  expect(await app!.evaluate(({ Menu }) => [Menu.getApplicationMenu()?.getMenuItemById('mixer.bus.add') ?? null, Menu.getApplicationMenu()?.getMenuItemById('mixer.bus.remove') ?? null])).toEqual([null, null]);
  // The Routing box keeps its size.
  const hold = page.locator('.inspector-hold.routing');
  await expect(hold).toHaveCount(1);
  expect(await hold.evaluate((el) => el.getBoundingClientRect().height)).toBe(91);
});
