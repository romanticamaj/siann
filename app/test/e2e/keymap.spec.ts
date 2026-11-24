// Cubase's remaining transport keys, the application menu and the Key
// Commands list end to end (m5b-ui-keymap; UI redesign 3.1, 3.6, UR-11), on
// the real siann-engine with the fake device under SIANN_SHELL_TEST=1:
//
// (a) Num - and Num + wind the cursor a bar back and on, and - and = do the
//     same off the keypad; Ctrl+Num - and Ctrl+Num + nudge it one grid step,
//     and so do Ctrl+- and Ctrl+=; none of them makes a revision.
// (b) The laptop fallbacks of the transport: Shift+Enter starts, Shift+0
//     stops, Ctrl+1 and Ctrl+2 set the left and the right locator.
// (c) Shift+T types a tempo: Enter makes exactly one revision with one
//     session.set_tempo, the display shows it, and undo restores the old one.
// (d) A menu click (through the shell's menu, as project.spec does) runs
//     Edit > Glue, Project > Add Bus and Project > Remove Bus, each one
//     revision, as their commands do.
// (e) Help > Key Commands opens the list; the search narrows it; Escape
//     closes it.
// (f) The menu registers no key (UI redesign 3.6): Ctrl+M, Cubase's Open
//     Markers, does not minimize the window, and no role item (Quit or
//     Close, Minimize) has an accelerator.
//
// Requests the renderer sent are read from window.__siannClient.sent();
// revisions and entities from a second protocol client. Waits are condition
// polls, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { chordsOf, formatChord, type Platform } from '../../src/renderer/keys/chord-label';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchApp, seedBundle } from './support/seed';
import { chooseGrid } from './support/toolbar';

const RATE = 48000;
// 120 BPM: a bar is 2 s, a beat 0.5 s.
const BAR = 2 * RATE;
const MOD = 'ControlOrMeta';
// The list writes keys for the platform it runs on (Apple's glyphs on macOS).
const PLATFORM: Platform = process.platform === 'darwin' ? 'mac' : 'other';
const TRACK = 'trk_a';

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

test.afterEach(async () => {
  await engine?.call('transport.stop').catch(() => undefined);
  engine?.close();
  engine = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(): Promise<void> {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-keymap-'));
  const sessionDir = seedBundle(
    scratch,
    [
      { id: TRACK, name: 'Alpha' },
      { id: 'trk_b', name: 'Beta' },
    ],
    [
      { id: 'clp_a', trackId: TRACK, at: 0 },
    ],
  );
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('undo')).toBeVisible();
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  // A running device: the status bar shows its latency once engine.status reported one.
  await expect(page.getByTestId('latency')).toBeVisible();
  await expect(page.getByTestId('transport-play')).toBeEnabled();
  engine = await engineClient(page);
}

async function revisions(): Promise<number> {
  return (await engine!.call('session.inspect')).revisions as number;
}

// The playhead of the newest realtime frame, in frames (-1 without one).
async function playhead(): Promise<number> {
  return page.evaluate(() => {
    const transport = (window as unknown as { __siannTransport?: { playhead(): string | null } }).__siannTransport;
    if (!transport) throw new Error('window.__siannTransport is missing (SIANN_SHELL_TEST=1)');
    const at = transport.playhead();
    return at === null ? -1 : Number(at);
  });
}

async function sentOf(method: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((wanted) => {
    const client = (window as unknown as { __siannClient?: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient;
    if (!client) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return client.sent().filter((r) => r.method === wanted).map((r) => r.params);
  }, method);
}

async function locateTo(frames: number): Promise<void> {
  await engine!.call('transport.locate', { frames: String(frames) });
  await expect.poll(playhead).toBe(frames);
}

// Clicks an empty spot of the canvas (below the lanes): the project zone has the focus, nothing selected.
async function focusProject(): Promise<void> {
  const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 20, canvas.y + canvas.height - 10);
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

async function clickMenu(id: string): Promise<void> {
  await expect.poll(() => app!.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null, id)).toBe(true);
  await app!.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.click(), id);
}

async function entity(ref: string): Promise<Record<string, unknown> | null> {
  const fetched = (await engine!.call('session.fetch', { refs: [ref] })) as { entities: Array<{ entity?: Record<string, unknown> }> };
  return fetched.entities[0]?.entity ?? null;
}

test('(a) the wind and nudge keys move the cursor through transport.locate, on the keypad and off it, with no revision', async () => {
  await launch();
  await focusProject();
  const before = await revisions();
  await locateTo(5 * BAR);
  for (const [key, delta] of [
    ['NumpadSubtract', -BAR],
    ['NumpadAdd', BAR],
    ['Minus', -BAR],
    ['Equal', BAR],
  ] as const) {
    const at = await playhead();
    await page.keyboard.press(key);
    await expect.poll(playhead, { message: key }).toBe(at + delta);
  }
  // Rewind stops at the start.
  await locateTo(BAR / 2);
  await page.keyboard.press('NumpadSubtract');
  await expect.poll(playhead).toBe(0);
  // Nudge: one step of the grid (the toolbar's Beat), on the keypad and off it.
  await chooseGrid(page, 'beat');
  await focusProject();
  await locateTo(4 * BAR);
  const beat = BAR / 4;
  for (const [key, delta] of [
    [`${MOD}+NumpadAdd`, beat],
    [`${MOD}+NumpadSubtract`, -beat],
    [`${MOD}+Equal`, beat],
    [`${MOD}+Minus`, -beat],
  ] as const) {
    const at = await playhead();
    await page.keyboard.press(key);
    await expect.poll(playhead, { message: key }).toBe(at + delta);
  }
  // Ctrl+- and Ctrl+= did not zoom the page.
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1);
  expect(await revisions()).toBe(before);
  expect((await sentOf('transport.locate')).length).toBeGreaterThanOrEqual(8);
  // Wind works while playing.
  await engine!.call('transport.play');
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('NumpadAdd');
  await expect.poll(playhead).toBeGreaterThan(4 * BAR + BAR / 2);
  await engine!.call('transport.stop');
});

test('(b) Shift+Enter starts, Shift+0 stops, Ctrl+1 and Ctrl+2 set the locators', async () => {
  await launch();
  await focusProject();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+Digit0');
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false');
  expect((await sentOf('transport.play')).length).toBe(1);
  expect((await sentOf('transport.stop')).length).toBe(1);
  // A new session has no locators: the right one first (the range from 0 to it), then the left.
  await locateTo(3 * BAR);
  await page.keyboard.press(`${MOD}+Digit2`);
  await expect.poll(async () => (await entity('locators:locators'))?.right ?? null).toBe(String(3 * BAR));
  await locateTo(BAR);
  await page.keyboard.press(`${MOD}+Digit1`);
  await expect.poll(async () => (await entity('locators:locators'))?.left ?? null).toBe(String(BAR));
  // Shift+Enter in a text field stays the field's (the position field takes it).
  await page.keyboard.press('Shift+KeyP');
  await expect(page.getByTestId('position-field')).toBeFocused();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
});

test('(c) Shift+T types a tempo: one revision with one session.set_tempo, and undo restores it', async () => {
  await launch();
  await focusProject();
  await expect(page.getByTestId('transport-tempo')).toHaveText('120.00');
  const before = await revisions();
  await page.keyboard.press('Shift+KeyT');
  const field = page.getByTestId('tempo-field');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('120.00');
  // Text that is no tempo sends nothing and marks the field.
  await field.fill('fast');
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.fill('98.5');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(page.getByTestId('transport-tempo')).toHaveText('98.50');
  await expect.poll(revisions).toBe(before + 1);
  const executes = (await sentOf('command.execute')).filter((p) => (p.commands as Array<{ op: string }>).some((c) => c.op === 'session.set_tempo'));
  expect(executes).toHaveLength(1);
  expect(executes[0]!.commands).toEqual([{ op: 'session.set_tempo', tempo: [{ ticks: '0', milliBpm: 98_500 }] }]);
  // Undo restores 120.
  await page.keyboard.press(`${MOD}+KeyZ`);
  await expect(page.getByTestId('transport-tempo')).toHaveText('120.00');
  // Escape cancels and sends nothing.
  await page.keyboard.press('Shift+KeyT');
  await page.getByTestId('tempo-field').fill('140');
  await page.getByTestId('tempo-field').press('Escape');
  await expect(page.getByTestId('tempo-field')).toHaveCount(0);
  await expect(page.getByTestId('transport-tempo')).toHaveText('120.00');
});

test('(d) menu clicks run Edit > Glue, Project > Add Bus and Project > Remove Bus, as their commands', async () => {
  await launch();
  // Glue: split the clip at the cursor, select both pieces, Edit > Glue joins them back.
  await focusProject();
  await locateTo(RATE / 4);
  const clipRect = await page.evaluate(() => (window as unknown as { __siannTimeline: { clips(): Array<{ clipId: string; x: number; y: number; width: number; height: number }> } }).__siannTimeline.clips()[0]!);
  const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + clipRect.x + clipRect.width / 2, canvas.y + clipRect.y + clipRect.height / 2);
  let at = await revisions();
  await page.keyboard.press('Alt+KeyX');
  await expect.poll(revisions).toBe(at + 1);
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  await focusProject();
  await page.keyboard.press(`${MOD}+KeyA`);
  at = await revisions();
  await clickMenu('edit.glue');
  await expect.poll(revisions).toBe(at + 1);
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  // Add Bus, then Remove Bus on the selected bus: one revision each.
  at = await revisions();
  await clickMenu('mixer.bus.add');
  await expect.poll(revisions).toBe(at + 1);
  const buses = ((await entity('root:root'))?.busOrder as string[] | undefined) ?? [];
  expect(buses).toHaveLength(1);
  await page.getByTestId(`mixer-strip-bus-${buses[0]}`).locator('.scale').click();
  at = await revisions();
  await clickMenu('mixer.bus.remove');
  await expect.poll(revisions).toBe(at + 1);
  await expect.poll(async () => (((await entity('root:root'))?.busOrder as string[] | undefined) ?? []).length).toBe(0);
  // The Project menu has them, the Studio menu no longer.
  const parent = (id: string) => app!.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.items.find((menu) => menu.submenu?.getMenuItemById(itemId))?.label ?? null, id);
  expect(await parent('mixer.bus.add')).toBe(en['menu.project']);
  expect(await parent('edit.glue')).toBe(en['menu.edit']);
  expect(await parent('help.keyCommands')).toBe(en['menu.help']);
});

test('(e) Help > Key Commands opens the list, the search narrows it, Escape closes it', async () => {
  await launch();
  await clickMenu('help.keyCommands');
  const dialog = page.getByTestId('key-commands');
  await expect(dialog).toBeVisible();
  const rows = dialog.locator('tr[data-command]');
  const all = await rows.count();
  expect(all).toBeGreaterThan(100);
  // Num 0 and Shift+0 on Windows and Linux, Num 0 and ⇧0 on macOS.
  const stopKeys = chordsOf('transport.stop').map((chord) => formatChord(chord, PLATFORM));
  expect(stopKeys).toEqual(PLATFORM === 'mac' ? ['Num 0', '⇧0'] : ['Num 0', 'Shift+0']);
  await expect(dialog.locator('tr[data-command="transport.stop"] kbd')).toHaveText(stopKeys);
  const search = page.getByTestId('key-commands-search');
  await expect(search).toBeFocused();
  await search.fill('glue');
  await expect(rows).toHaveCount(2);
  await search.fill(stopKeys[0]!);
  await expect(rows).toHaveCount(1);
  await search.fill('zzzz');
  await expect(page.getByTestId('key-commands-none')).toBeVisible();
  // Keys typed in the search are the field's: Space does not start the transport.
  await search.fill('');
  await search.press('Space');
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('(f) the menu registers no key: Ctrl+M does not minimize the window and no role item has an accelerator', async () => {
  await launch();
  await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('help.keyCommands') !== null)).toBe(true);
  // The live menu's role items (macOS's app menu is the system's own).
  const roles = await app!.evaluate(({ Menu }) => {
    const out: Array<{ role: string; register: boolean; accelerator: string | null }> = [];
    const walk = (menu: Electron.Menu) => {
      for (const item of menu.items) {
        if (item.role === 'appMenu' || (item.role as string) === 'appmenu') continue;
        if (item.role) out.push({ role: item.role, register: item.registerAccelerator, accelerator: item.accelerator ?? null });
        if (item.submenu) walk(item.submenu);
      }
    };
    walk(Menu.getApplicationMenu()!);
    return out;
  });
  expect(roles.map((r) => r.role.toLowerCase())).toContain('minimize');
  for (const item of roles) expect(item, item.role).toEqual({ role: item.role, register: false, accelerator: '' });
  // Ctrl+M (Cmd+M on macOS), then Ctrl+Alt+L: the left zone toggles, the window stays.
  await focusProject();
  const left = page.getByTestId('zone-left');
  const before = await left.getAttribute('data-visible');
  // Through the window's input pipeline, as a key from the keyboard reaches it
  // (unhandled by the page, Electron offers it to the menu's accelerators).
  await app!.evaluate(({ BrowserWindow }, mac) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const modifiers: Array<'control' | 'meta'> = [mac ? 'meta' : 'control'];
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers });
  }, process.platform === 'darwin');
  await page.keyboard.press(`${MOD}+Alt+KeyL`);
  await expect(left).toHaveAttribute('data-visible', before === 'true' ? 'false' : 'true');
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(false);
});
