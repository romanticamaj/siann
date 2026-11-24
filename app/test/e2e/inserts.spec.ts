// The insert racks, the plugin picker and the rack switch end to end
// (m5b-ui-inserts-master; UI redesign 3.4, 3.0, 4.2; docs/schemas/
// protocol-plugins-v0.md). Three blocks:
//
// A. SIANN_TEST_PLUGIN_CLAP (siann_test_plugin's CLAP) on the core engine:
//    the plugin's directory goes to the engine as --plugin-dir through
//    SIANN_ENGINE_TEST_ARGS, in the test's own user data (so its own plugin
//    registry). An empty slot opens the picker, which approves the install
//    after a confirmation naming the file and inserts it as one revision; the
//    slot shows the plugin's name; bypass and Remove are one revision each,
//    and session.undo takes each back. A rack of three scrolls inside its row,
//    by the wheel and to a focused slot; the Inspector lists every slot; the
//    Inserts switch hides and shows every rack and survives a reload; e on the
//    core engine answers editor_failed (a CLAP editor on the headless target);
//    a plan's plugin.set_bypass and plugin.remove ring and dim a real slot.
//    The engine also registers the platform's standard plugin directories, so
//    the test finds the plugin by its file, never by a row's index.
// B. SIANN_DESKTOP_ENGINE_EXE and SIANN_TEST_PLUGIN_CLAP, Windows only (as
//    editor.spec.ts): e opens the editor, lit from editorOpen, and e again
//    closes it.
// C. No gate: capabilities without features.plugins (no slot, switch or
//    picker; the empty rack row; the Inspector's Inserts box of 117 px; the
//    tab row ends at its spacer) and without features.masterGain (the master
//    is the M5 meter).
//
// Waits are Playwright condition waits; none sleeps.

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, APP_DIR, launchApp, seedBundle, selectPlan, type Agent } from './support/seed';

const PLUGIN = process.env.SIANN_TEST_PLUGIN_CLAP;
const DESKTOP = process.env.SIANN_DESKTOP_ENGINE_EXE;
const TRACK = 'trk_fx';
const FIXTURES = path.join(APP_DIR, 'test', 'unit', 'fixtures');
const OWNED_WINDOWS = path.join(__dirname, 'support', 'owned-windows.ps1');

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let client: EngineClient | undefined;

test.afterEach(async () => {
  client?.close();
  client = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(options: { engine?: string; env?: Record<string, string>; plugin?: boolean } = {}): Promise<void> {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-inserts-'));
  const sessionDir = seedBundle(scratch, [
    { id: TRACK, name: 'FX' },
    { id: 'trk_two', name: 'Two' },
  ]);
  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.plugin !== false && PLUGIN) env.SIANN_ENGINE_TEST_ARGS = JSON.stringify(['--device', 'fake', '--plugin-dir', path.dirname(PLUGIN)]);
  if (options.engine) env.SIANN_ENGINE_EXE = options.engine;
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true, env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId(`mixer-strip-${TRACK}`)).toBeVisible();
  client = await engineClient(page);
}

async function revisions(): Promise<number> {
  return (await client!.call('session.inspect')).revisions as number;
}

const strip = (id = TRACK) => page.getByTestId(`mixer-strip-${id}`);
const rack = (id = TRACK) => strip(id).locator('.ins');
const slots = (id = TRACK) => rack(id).locator('.slot:not(.empty)');

// The picker's row of the test plugin, found by its file.
function testPluginRow(): Locator {
  return page.getByTestId('plugin-picker').locator(`[data-testid="picker-install"][data-file="${path.basename(PLUGIN!)}"]`);
}

// Approve and insert the test plugin through the protocol (the setup of the later tests).
async function insertByProtocol(trackId = TRACK, count = 1): Promise<string[]> {
  const registry = (await client!.call('plugin.registry')) as { plugins: Array<{ format: string; path: string; approved: boolean }> };
  const install = registry.plugins.find((p) => path.basename(p.path) === path.basename(PLUGIN!))!;
  expect(install, 'the test plugin is registered').toBeTruthy();
  if (!install.approved) await client!.call('plugin.approve', { format: install.format, path: install.path, approved: true });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const job = (await client!.call('plugin.instantiate', { trackId, index: 99, descriptor: { format: install.format, path: install.path } })) as { state: string; result: { slotId: string } };
    expect(job.state).toBe('done');
    ids.push(job.result.slotId);
  }
  await expect(slots(trackId)).toHaveCount(ids.length);
  return ids;
}

test.describe('block A: the test plugin on the core engine', () => {
  test.skip(!PLUGIN, 'set SIANN_TEST_PLUGIN_CLAP');

  test('the picker approves and inserts; bypass and Remove are one revision each; undo takes each back', async () => {
    await launch();
    // Two empty slots in the rack of a track without inserts; the rack carries its fidelity id.
    await expect(rack()).toHaveAttribute('data-part-of', 'inserts');
    await expect(rack().locator('.slot.empty')).toHaveCount(2);
    await rack().locator('.slot.empty').first().click();
    const picker = page.getByTestId('plugin-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('picker-search').fill(path.basename(PLUGIN!, '.clap'));
    const row = testPluginRow();
    await expect(row).toHaveCount(1);
    // Unapproved in this user data: Approve, after a confirmation that names the file.
    await expect(row.getByTestId('picker-choose')).toHaveCount(0);
    await row.getByTestId('picker-approve').click();
    // The picker's own confirmation (the project zone has the track removal's).
    const confirm = picker.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(path.basename(PLUGIN!));
    const unchanged = await revisions();
    await confirm.getByTestId('confirm-ok').click();
    await expect(row.getByTestId('picker-choose')).toHaveCount(1);
    expect(await revisions()).toBe(unchanged, 'an approval is no revision');

    // Insert: one revision, the slot shows the plugin's name.
    let before = await revisions();
    await row.getByTestId('picker-choose').click();
    await expect.poll(() => revisions()).toBe(before + 1);
    await expect(picker).toBeHidden();
    await expect(slots()).toHaveCount(1);
    await expect(slots().first().locator('.slot-name')).toHaveText('SIANN Test Plugin');
    await expect(rack().locator('.slot.empty')).toHaveCount(1);
    const slotId = (await slots().first().getAttribute('data-slot-id'))!;
    expect(slotId).toMatch(/^slt_/);

    // Bypass: one revision through plugin.set_bypass; undo takes it back.
    const bypass = page.getByTestId(`slot-bypass-${slotId}`);
    await expect(bypass).toHaveAttribute('aria-pressed', 'false');
    before = await revisions();
    await page.getByTestId(`slot-${slotId}`).hover();
    await bypass.click();
    await expect.poll(() => revisions()).toBe(before + 1);
    await expect(bypass).toHaveAttribute('aria-pressed', 'true');
    const fetched = (await client!.call('session.fetch', { refs: [`plugin_slot:${slotId}`] })) as { entities: Array<{ entity: { bypass: boolean } }> };
    expect(fetched.entities[0]!.entity.bypass).toBe(true);
    await client!.call('session.undo');
    await expect(bypass).toHaveAttribute('aria-pressed', 'false');

    // Remove: one revision; undo brings the slot back.
    before = await revisions();
    await page.getByTestId(`slot-${slotId}`).hover();
    await page.getByTestId(`slot-remove-${slotId}`).click();
    await expect.poll(() => revisions()).toBe(before + 1);
    await expect(slots()).toHaveCount(0);
    await client!.call('session.undo');
    await expect(slots()).toHaveCount(1);
    // Undo of the insert: the rack is empty again.
    await client!.call('session.undo');
    await expect(slots()).toHaveCount(0);
    await expect(rack().locator('.slot.empty')).toHaveCount(2);
  });

  test('a rack of three scrolls inside its row by the wheel and to a focused slot; the Inspector lists every slot', async () => {
    await launch();
    const ids = await insertByProtocol(TRACK, 3);
    await expect(rack().locator('.slot')).toHaveCount(4, { timeout: 10_000 });
    const box = await rack().evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop, bar: el.offsetWidth - el.clientWidth }));
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(box.top).toBe(0);
    expect(box.bar).toBe(0);
    // The row keeps its size (--strip-inserts-h, 34 px at scale 1).
    expect(box.client).toBeLessThanOrEqual(34);
    await rack().hover();
    await page.mouse.wheel(0, 40);
    await expect.poll(() => rack().evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await rack().evaluate((el) => (el.scrollTop = 0));
    await page.getByTestId(`slot-bypass-${ids[2]}`).focus();
    await expect.poll(() => rack().evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The Inspector lists all three and one empty slot.
    await page.getByTestId(`track-header-${TRACK}`).click();
    const section = page.locator('[data-part="inspector-inserts"]');
    await expect(section.locator('.islot:not(.empty)')).toHaveCount(3);
    await expect(section.locator('.islot.empty')).toHaveCount(1);
    await expect(section.locator('.sec-h')).toContainText('3');
  });

  test('the Inserts switch hides and shows every rack and survives a reload', async () => {
    await launch();
    await insertByProtocol(TRACK, 1);
    const racks = page.locator('[data-part="mixer-racks"]');
    await expect(racks).toBeVisible();
    const inserts = racks.getByTestId('rack-inserts');
    await expect(inserts).toHaveAttribute('aria-pressed', 'true');
    await inserts.click();
    await expect(inserts).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.strip .ins .slot')).toHaveCount(0);
    await expect(rack()).toHaveAttribute('aria-hidden', 'true');
    await page.reload();
    await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
    await expect(page.locator('[data-part="mixer-racks"]').getByTestId('rack-inserts')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.strip .ins .slot')).toHaveCount(0);
    await page.locator('[data-part="mixer-racks"]').getByTestId('rack-inserts').click();
    await expect(slots()).toHaveCount(1);
  });

  test('e on the core engine answers editor_failed, and e stays unlit', async () => {
    await launch();
    const [slotId] = await insertByProtocol(TRACK, 1);
    const edit = page.getByTestId(`slot-edit-${slotId}`);
    await page.getByTestId(`slot-${slotId}`).hover();
    await edit.click();
    await expect(page.getByTestId('toast-message').filter({ hasText: 'editor_failed' })).toHaveCount(1);
    await expect(edit).toHaveAttribute('aria-pressed', 'false');
  });

  test('a plan\'s plugin.set_bypass rings the bypass button and its plugin.remove dims the slot', async () => {
    await launch();
    const [first, second] = await insertByProtocol(TRACK, 2);
    const agent: Agent = await agentFor(app!);
    const plan = (await agent.tool('submit_plan', {
      steps: [
        { op: 'plugin.set_bypass', slotId: first, bypass: true },
        { op: 'plugin.remove', slotId: second },
      ],
    })).hash as string;
    await selectPlan(page, plan);
    await expect(page.getByTestId(`slot-bypass-${first}`)).toHaveClass(/\bghost\b/);
    await expect(page.getByTestId(`slot-${second}`)).toHaveClass(/\bghost-removed\b/);
    await expect(page.getByTestId(`slot-${second}`)).toHaveAttribute('data-ghost', '2');
  });
});

test.describe('block B: the editor on the desktop engine (Windows)', () => {
  test.skip(process.platform !== 'win32', 'editor ownership (GWLP_HWNDPARENT) is Windows, as editor.spec.ts');
  test.skip(!DESKTOP || !PLUGIN, 'set SIANN_DESKTOP_ENGINE_EXE and SIANN_TEST_PLUGIN_CLAP');

  test('e opens the editor, lit from editorOpen, owned by the window; e again closes it', async () => {
    await launch({ engine: DESKTOP! });
    const [slotId] = await insertByProtocol(TRACK, 1);
    const edit = page.getByTestId(`slot-edit-${slotId}`);
    await expect(edit).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId(`slot-${slotId}`).hover();
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'true');
    const shellWindow = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readBigUInt64LE(0).toString());
    const pid = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
    const owned = () =>
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OWNED_WINDOWS, '-ProcessId', String(pid)], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => line.trim().split(' '))
        .filter(([, owner, visible]) => owner === shellWindow && visible === 'True').length;
    await expect.poll(owned).toBe(1);
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(owned).toBe(0);
  });
});

test.describe('block C: reduced capabilities', () => {
  test('without features.plugins: no slot, switch or picker; the empty rack row; the Inspector\'s box; the tab row ends at its spacer', async () => {
    await launch({ plugin: false, env: { SIANN_TEST_CAPABILITIES: path.join(FIXTURES, 'capabilities-no-plugins.json') } });
    await expect(page.locator('.slot')).toHaveCount(0);
    await expect(page.locator('.islot')).toHaveCount(0);
    // No Inserts switch; Routing and Sends stay (m5b-ui-sends-buses: the fixture lists buses and sends).
    await expect(page.getByTestId('rack-inserts')).toHaveCount(0);
    await expect(page.locator('[data-part="mixer-racks"] button')).toHaveCount(2);
    await expect(page.getByTestId('plugin-picker')).toHaveCount(0);
    for (const id of [TRACK, 'trk_two']) {
      const ins = rack(id);
      await expect(ins).toHaveAttribute('aria-hidden', 'true');
      expect(await ins.evaluate((el) => [el.children.length, el.getAttribute('data-part-of'), el.getBoundingClientRect().height])).toEqual([0, null, 34]);
    }
    const last = await page.locator('[data-part="lower-tabs"]').evaluate((el) => el.lastElementChild?.className);
    expect(last).toBe('mixer-racks');
    await page.getByTestId(`track-header-${TRACK}`).click();
    await expect(page.locator('[data-part="inspector-inserts"]')).toHaveCount(0);
    const hold = page.locator('.inspector-hold.inserts');
    await expect(hold).toHaveCount(1);
    expect(await hold.evaluate((el) => el.getBoundingClientRect().height)).toBe(117);
  });

  test('without features.masterGain the master is the M5 meter', async () => {
    await launch({ plugin: false, env: { SIANN_TEST_CAPABILITIES: path.join(FIXTURES, 'capabilities-no-master.json') } });
    const master = page.getByTestId('mixer-strip-master');
    await expect(master.getByTestId('meter-master')).toBeVisible();
    await expect(master.getByTestId('peak-value-master')).toBeVisible();
    await expect(master.getByTestId('fader-master')).toHaveCount(0);
    await expect(master.locator('[role="slider"]')).toHaveCount(0);
    await expect(master.getByTestId('fader-value-master')).toHaveCount(0);
  });
});
