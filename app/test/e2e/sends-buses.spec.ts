// Bus strips, send slots and output routing end to end (m5b-ui-sends-buses;
// UI redesign 3.4, 3.0, 3.6, 4.5 C5; 10.11, 25; docs/schemas/
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
// (f) The strip's send slot: the level (the bus name) keeps its room at rest,
//     hovered and focused; a drag, Ctrl-click and a typed value on it; PRE /
//     POST by the keyboard; on and Remove, one revision each.
// (g) A bus strip's fader is one gesture on bus:<id> (gain) and one
//     revision; M and S one revision each; Escape clears the bus selection;
//     the Inspector's Out row routes the track to the bus.
// (h) SIANN_TEST_PLUGIN_CLAP: an insert on a bus strip is one
//     plugin.instantiate with its busId.
// (i) While a proposal is heard (the edit guard, 4.5 C5): Add Bus and Remove
//     Bus in the menu, the bus strip's M, S, pan and rename, the send slots'
//     buttons and empty slot, the output selectors and the Out row are
//     disabled with the reason (the pan knob stays, aria-disabled); the bus
//     fader and the send level go onto the branch.
//
// Waits are Playwright condition waits; none sleeps.

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, APP_DIR, launchApp, seedBundle, selectPlan } from './support/seed';

const t = translator('en');
const PLUGIN = process.env.SIANN_TEST_PLUGIN_CLAP;

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

  // Pre-fader (the Inspector's slot, which always shows the switch): the bus reads the track before its fader again.
  await page.getByTestId(`track-header-${KEYS}`).click();
  await oneRevision(() => page.getByTestId(`islot-send-pre-${sendId}`).click());
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

// The centre of a control a raw mouse gesture starts on, read once the control
// is scrolled into view, visible and stable (Playwright's actionability checks
// for hover) and hovered, so a section laid out late, a scroll or the hover
// state cannot move it between the read and the press.
async function centreOf(control: Locator): Promise<{ x: number; y: number }> {
  await control.hover();
  const box = (await control.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragBy(control: Locator, dx: number, shift = false): Promise<void> {
  const { x, y } = await centreOf(control);
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
  const centre = await centreOf(knob);
  const before = await revisions();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x - 30, centre.y, { steps: 5 });
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

// A send in the strip's 80 px slot, en and zh-TW measured by i18n-fit.spec.ts:
// the level (the bus name) keeps the room at rest, hovered and focused, with
// on and Remove beside it; PRE / POST shows there only while it holds the
// keyboard focus.
async function levelWidth(sendId: string): Promise<number> {
  return page.getByTestId(`send-level-${sendId}`).evaluate((el) => el.getBoundingClientRect().width);
}

test('(f) the strip\'s send slot: the level keeps its room; drag, Ctrl-click and a typed value; on, PRE by the keyboard, and Remove', async () => {
  await launch();
  const bus = await addBusFromMenu();
  const sendId = await addSend(KEYS, 'Bus 1');
  const slot = page.getByTestId(`send-${sendId}`);
  const level = page.getByTestId(`send-level-${sendId}`);
  await page.mouse.move(1, 1);
  const slotWidth = await slot.evaluate((el) => el.getBoundingClientRect().width);
  const rest = await levelWidth(sendId);
  expect(rest, 'the level at rest').toBeGreaterThan(slotWidth / 2);
  await expect(level).toHaveText('Bus 1');
  // Hovered: on and Remove show, PRE / POST does not, and the level keeps more than a third of the slot.
  await slot.hover();
  await expect(page.getByTestId(`send-remove-${sendId}`)).toBeVisible();
  const hovered = await levelWidth(sendId);
  expect(hovered, 'the level hovered').toBeGreaterThan(slotWidth / 3);
  expect(await page.getByTestId(`send-pre-${sendId}`).evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  for (const id of [`send-on-${sendId}`, `send-remove-${sendId}`]) expect(await page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().width), id).toBeGreaterThan(0);
  // A drag on the strip's level is one revision.
  await oneRevision(() => dragBy(level, -40));
  expect((await entity(`send:${sendId}`))!.levelMilliDb as number).toBeLessThan(0);
  // Ctrl-click: 0 dB.
  await oneRevision(async () => {
    await page.keyboard.down('Control');
    await level.click();
    await page.keyboard.up('Control');
  });
  expect((await entity(`send:${sendId}`))!.levelMilliDb).toBe(0);
  // A double-click types a value.
  await oneRevision(async () => {
    await level.dblclick();
    await page.getByTestId(`send-level-input-${sendId}`).fill('-12');
    await page.getByTestId(`send-level-input-${sendId}`).press('Enter');
  });
  expect((await entity(`send:${sendId}`))!.levelMilliDb).toBe(-12000);
  // Focused (the keyboard): the level keeps its room too.
  await page.mouse.move(1, 1);
  await level.focus();
  expect(await levelWidth(sendId), 'the level focused').toBeGreaterThan(slotWidth / 3);
  // PRE / POST by the keyboard: it shows while focused, and Enter switches it (Space is the transport's).
  await page.keyboard.press('Tab');
  await expect(page.getByTestId(`send-pre-${sendId}`)).toBeFocused();
  expect(await page.getByTestId(`send-pre-${sendId}`).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(0);
  await oneRevision(() => page.keyboard.press('Enter'));
  expect((await entity(`send:${sendId}`))!.pre).toBe(true);
  // A pre-fader send at rest: PRE does not take the level's room; the name is in italics and the tooltip says PRE.
  await page.mouse.move(1, 1);
  await page.getByTestId('mixer').click({ position: { x: 2, y: 2 } });
  expect(await levelWidth(sendId), 'a pre send at rest').toBeGreaterThan(slotWidth / 2);
  expect(await level.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
  await expect(slot).toHaveAttribute('title', /PRE$/);
  // The on button: one send.set_enabled.
  await oneRevision(async () => {
    await slot.hover();
    await page.getByTestId(`send-on-${sendId}`).click();
  });
  expect((await entity(`send:${sendId}`))!.enabled).toBe(false);
  await expect(page.getByTestId(`send-on-${sendId}`)).toHaveAttribute('aria-pressed', 'false');
  // Remove: one send.remove; the rack has two empty slots again.
  await oneRevision(async () => {
    await slot.hover();
    await page.getByTestId(`send-remove-${sendId}`).click();
  });
  expect(await entity(`send:${sendId}`)).toBeNull();
  await expect(page.getByTestId(`mixer-strip-${KEYS}`).locator('.ins .slot.empty')).toHaveCount(2);
  expect((await entity(`bus:${bus}`))?.name).toBe('Bus 1');
});

test('(g) a bus strip: the fader is one bus gain gesture, M and S one revision each; Escape clears the selection; the Inspector\'s Out row routes the track', async () => {
  await launch();
  const bus = await addBusFromMenu();
  // The fader: one gesture on bus:<id> (gain), one revision.
  const cap = page.getByTestId(`fader-${bus}`).locator('[data-part-of="cap"]');
  const centre = await centreOf(cap);
  await oneRevision(async () => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x, centre.y + 40, { steps: 5 });
    await page.mouse.up();
  });
  expect((await entity(`bus:${bus}`))!.gainMilliDb as number).toBeLessThan(0);
  const sent = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient.sent());
  const begins = sent.filter((r) => r.method === 'gesture.begin' && (r.params.target as { ref: string }).ref === `bus:${bus}`);
  expect(begins.map((r) => (r.params.target as { param: string }).param)).toEqual(['gain']);
  // M and S: one revision each.
  for (const [id, field] of [[`mute-${bus}`, 'mute'], [`solo-${bus}`, 'solo']] as const) {
    await oneRevision(() => page.getByTestId(id).click());
    await expect(page.getByTestId(id)).toHaveAttribute('aria-pressed', 'true');
    expect((await entity(`bus:${bus}`))![field], field).toBe(true);
  }
  await expect(busStrip(bus)).toHaveClass(/\bmuted\b/);
  // A press outside the controls selects the bus; Escape in the lower zone clears it.
  await busStrip(bus).locator('.scale').click();
  await expect(busStrip(bus)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(busStrip(bus)).toHaveAttribute('aria-selected', 'false');
  await expect(busStrip(bus)).not.toHaveClass(/\bsel\b/);
  // The Inspector's Out row: Keys to the bus, one track.set_output.
  await page.getByTestId(`track-header-${KEYS}`).click();
  await expect(page.getByTestId('inspector-output-name')).toHaveText('Master');
  await oneRevision(() => page.getByTestId('inspector-output').selectOption(bus));
  expect((await entity(`track:${KEYS}`))?.output).toEqual({ busId: bus });
  await expect(page.getByTestId('inspector-output-name')).toHaveText('Bus 1');
});

test('(h) an insert on a bus strip is one plugin.instantiate with its busId', async () => {
  test.skip(!PLUGIN, 'set SIANN_TEST_PLUGIN_CLAP (the test plugin, as inserts.spec.ts)');
  await launch({ SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake', '--plugin-dir', path.dirname(PLUGIN!)]) });
  const bus = await addBusFromMenu();
  const registry = (await client!.call('plugin.registry')) as { plugins: Array<{ format: string; path: string; approved: boolean }> };
  const install = registry.plugins.find((p) => path.basename(p.path) === path.basename(PLUGIN!))!;
  expect(install, 'the test plugin is registered').toBeTruthy();
  if (!install.approved) await client!.call('plugin.approve', { format: install.format, path: install.path, approved: true });
  await expect(rackSwitch('inserts')).toHaveAttribute('aria-pressed', 'true');
  await oneRevision(async () => {
    await busStrip(bus).locator('.ins .slot.empty').first().click();
    const picker = page.getByTestId('plugin-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('picker-search').fill(path.basename(PLUGIN!, '.clap'));
    await picker.locator(`[data-testid="picker-install"][data-file="${path.basename(PLUGIN!)}"]`).getByTestId('picker-choose').click();
  });
  const inserts = ((await entity(`bus:${bus}`))?.inserts as string[] | undefined) ?? [];
  expect(inserts).toHaveLength(1);
  await expect(busStrip(bus).locator('.ins .slot:not(.empty) .slot-name')).toHaveText('SIANN Test Plugin');
  const sent = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient.sent());
  const instantiated = sent.filter((r) => r.method === 'plugin.instantiate');
  expect(instantiated.map((r) => [r.params.busId, r.params.trackId])).toEqual([[bus, undefined]]);
});

test('(i) while a proposal is heard every bus, send and routing control is disabled with the reason, the menu items too; the bus fader and the send level go onto the branch', async () => {
  await launch();
  const bus = await addBusFromMenu();
  const sendId = await addSend(KEYS, 'Bus 1');
  const watcher = await engineClient(page, { events: true });
  try {
    const agent = await agentFor(app!);
    const hash = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: PAD, gainMilliDb: -6000 }] })).hash as string;
    await selectPlan(page, hash);
    await page.getByTestId('plan-audition').click();
    await expect(page.getByTestId('shell')).toHaveAttribute('data-hearing', 'proposal');
    const mainHead = (await watcher.call('session.inspect')).revision as string;
    const reason = t('guard.structural');
    const guarded = async (id: string) => {
      await expect(page.getByTestId(id), id).toBeDisabled();
      await expect(page.getByTestId(id), id).toHaveAttribute('title', reason);
    };
    // The menu: Add Bus and Remove Bus disabled, the reason in their label.
    await busStrip(bus).locator('.scale').click();
    await expect(busStrip(bus)).toHaveAttribute('aria-selected', 'true');
    const items = () => app!.evaluate(({ Menu }) => ['mixer.bus.add', 'mixer.bus.remove'].map((id) => { const item = Menu.getApplicationMenu()?.getMenuItemById(id); return item ? [item.enabled, item.label] : null; }));
    await expect.poll(items).toEqual([[false, t('menu.guarded', { label: t('menu.addBus'), reason })], [false, t('menu.guarded', { label: t('menu.removeBus'), reason })]]);
    // The bus strip: M, S and the name tag; the pan knob stays, aria-disabled with the reason.
    await guarded(`mute-${bus}`);
    await guarded(`solo-${bus}`);
    await expect(page.getByTestId(`strip-name-${bus}`)).toHaveAttribute('title', reason);
    await page.getByTestId(`strip-name-${bus}`).dblclick();
    await expect(page.getByTestId(`bus-rename-${bus}`)).toHaveCount(0);
    const knob = page.getByTestId(`pan-${bus}`);
    await expect(knob).toBeVisible();
    await expect(knob).toHaveAttribute('aria-disabled', 'true');
    await expect(knob.locator('title')).toHaveText(reason);
    const knobCentre = await centreOf(knob);
    await page.mouse.move(knobCentre.x, knobCentre.y);
    await page.mouse.down();
    await page.mouse.move(knobCentre.x - 30, knobCentre.y, { steps: 5 });
    await page.mouse.up();
    // The Sends rack: on, PRE / POST and Remove; the empty slot.
    await expect(rackSwitch('sends')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId(`send-${sendId}`).hover();
    for (const id of [`send-on-${sendId}`, `send-pre-${sendId}`, `send-remove-${sendId}`]) await guarded(id);
    const empty = page.getByTestId(`mixer-strip-${PAD}`).locator('.ins .slot.empty').first();
    await expect(empty).toHaveAttribute('aria-disabled', 'true');
    await expect(empty).toHaveAttribute('title', reason);
    await empty.click({ force: true });
    await expect(page.getByTestId('bus-picker')).toHaveCount(0);
    // The Inspector: its send's buttons and its Out row.
    await page.getByTestId(`track-header-${KEYS}`).click();
    for (const id of [`islot-send-on-${sendId}`, `islot-send-pre-${sendId}`, `islot-send-remove-${sendId}`]) await guarded(id);
    await expect(page.getByTestId('inspector-output')).toBeDisabled();
    await expect(page.getByTestId('inspector-output')).toHaveAttribute('title', reason);
    // The Routing rack: every output selector.
    await rackSwitch('routing').click();
    for (const id of [`output-${KEYS}`, `output-${PAD}`, `output-${bus}`]) await expect(page.getByTestId(id), id).toBeDisabled();
    await expect(page.getByTestId(`mixer-strip-${KEYS}`).locator('.ins .slot')).toHaveAttribute('title', reason);
    // Nothing reached main.
    expect((await watcher.call('session.inspect')).revision).toBe(mainHead);
    expect((await entity(`bus:${bus}`))!.pan).toBe(0);

    // The bus fader and the send level are gestures: they go onto the branch, main's head stays.
    const from = watcher.events.length;
    const cap = page.getByTestId(`fader-${bus}`).locator('[data-part-of="cap"]');
    const capCentre = await centreOf(cap);
    await page.mouse.move(capCentre.x, capCentre.y);
    await page.mouse.down();
    await page.mouse.move(capCentre.x, capCentre.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => watcher.events.slice(from).filter((e) => e.type === 'proposal.changed').length).toBeGreaterThan(0);
    const level = page.locator('[data-part="inspector-sends"]').getByTestId(`islot-send-level-${sendId}`);
    const second = watcher.events.length;
    await dragBy(level, -40);
    await expect.poll(() => watcher.events.slice(second).filter((e) => e.type === 'proposal.changed').length).toBeGreaterThan(0);
    expect((await watcher.call('session.inspect')).revision).toBe(mainHead);

    // With main heard everything is enabled again.
    await watcher.call('audition.hear', { side: 'main' });
    await expect(page.getByTestId('shell')).not.toHaveAttribute('data-hearing', 'proposal');
    for (const id of [`mute-${bus}`, `islot-send-on-${sendId}`, `output-${bus}`, 'inspector-output']) await expect(page.getByTestId(id), id).toBeEnabled();
    await expect(page.getByTestId(`pan-${bus}`)).not.toHaveAttribute('aria-disabled', 'true');
    // Remove Bus is disabled again for its own reason: the track's selection cleared the bus's.
    await expect.poll(items).toEqual([[true, t('menu.addBus')], [false, t('menu.removeBus')]]);
  } finally {
    watcher.close();
  }
});
