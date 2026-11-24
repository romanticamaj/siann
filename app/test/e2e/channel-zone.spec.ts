// The Channel zone and the e buttons, end to end (m5b-ui-editor-channel; UI
// redesign 2.1, 2.3, 2.4, 3.4, 10.11). The app runs the real siann-engine on
// the fake device under SIANN_SHELL_TEST=1, on a bundle seeded with
// siann-cli; waits are Playwright condition waits.
//
// - Off by default; the first zone button and Ctrl+Alt+C show and hide it;
//   it holds one strip of the selected track, left of the Inspector, 96 px.
// - Its divider drags within 80-160 px and collapses below; the keys step 8
//   and 32 px, Home and End go to the ends, Enter to the default; the state
//   and the size survive a reload (siann.layout.v1).
// - The strip is the MixConsole's: a fader gesture there is one revision and
//   the MixConsole strip follows; its meter canvas draws while playing; with
//   no track selected the zone is empty; the MixConsole's strips keep their
//   count of data-part-item="strip".
// - Tab and F6 order: channel, left, project, lower, right; its focus frame;
//   the left zone hides while the Channel zone stays; at 1080 px it starts
//   collapsed with the left zone; a shrinking window hides it after the left.
// - e on strip 2 selects track 2, shows the zone on it and is lit; again
//   hides it; the Inspector's e likewise; the master has no e.
// - Ctrl+Alt+Right / Left step the focused zone's tabs: MixConsole and Editor
//   in the lower zone, the right zone's tabs, nothing in the left zone.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { launchApp, seedBundle } from './support/seed';

const MOD = 'ControlOrMeta';
const TRACKS = [
  { id: 'trk_kick', name: 'Kick' },
  { id: 'trk_bass', name: 'Bass', gain: -4000 },
];

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-channel-'));
});

test.afterEach(async () => {
  engine?.close();
  engine = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  scratch = '';
});

async function launch(sessionDir: string, userData = path.join(scratch, 'user-data')): Promise<void> {
  app = await launchApp({ sessionDir, userData, languages: ['en-US'], hook: true });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('mixer-strip-trk_bass')).toBeVisible();
}

async function resize(size: { width: number; height: number }): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(width, height);
  }, size);
  await page.setViewportSize(size);
  await expect(page.getByTestId('shell')).toHaveAttribute('data-viewport', `${size.width}x${size.height}`);
}

const channel = () => page.getByTestId('zone-channel');

async function width(testId: string): Promise<number> {
  const el = page.getByTestId(testId);
  if ((await el.getAttribute('data-visible')) !== 'true') return 0;
  return Math.round((await el.boundingBox())?.width ?? 0);
}

async function settled(testId: string): Promise<number> {
  let last = -1;
  await expect.poll(async () => {
    const now = await width(testId);
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return last;
}

async function dragSeparator(dx: number): Promise<void> {
  await settled('zone-channel');
  const box = (await page.getByTestId('separator-channel').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

async function revision(): Promise<number> {
  return Number(/^r(\d+)$/.exec((await page.getByTestId('revision').textContent()) ?? '')![1]);
}

async function focused(): Promise<string | null> {
  return page.evaluate(() => document.querySelector('[data-zone][data-focused="true"]')?.getAttribute('data-zone') ?? null);
}

test('off by default; the first zone button and Ctrl+Alt+C show and hide one strip of the selected track, 96 px, left of the Inspector', async () => {
  await launch(seedBundle(scratch, TRACKS));
  await expect(channel()).toBeHidden();
  const button = page.getByTestId('zone-button-channel');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  // The first of the four zone buttons.
  await expect(page.locator('[data-part="zone-buttons"] > *').first()).toHaveAttribute('data-part', 'zone-button-channel');
  await button.click();
  await expect(channel()).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveClass('iconbtn on');
  expect(await settled('zone-channel')).toBe(96);
  // No track selected: the frame with nothing in it, no text.
  await expect(channel().locator('.strip')).toHaveCount(0);
  expect((await channel().innerText()).trim()).toBe('');
  // A header clicked selects the track; its strip shows in the zone.
  await page.getByTestId('track-header-trk_bass').click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId('channel-mixer-strip-trk_bass')).toBeVisible();
  await expect(channel().locator('.strip')).toHaveCount(1);
  // At the window's left edge, left of the Inspector.
  const zone = (await channel().boundingBox())!;
  const left = (await page.getByTestId('zone-left').boundingBox())!;
  expect(Math.round(zone.x)).toBe(0);
  expect(Math.round(zone.x + zone.width)).toBe(Math.round(left.x));
  // The strip fills the zone's width.
  const strip = (await page.getByTestId('channel-mixer-strip-trk_bass').boundingBox())!;
  expect(strip.width).toBeGreaterThan(zone.width - 8);
  // The MixConsole's strip numbering does not shift: only its two strips and the master carry data-part-item.
  expect(await page.locator('[data-part-item="strip"]').count()).toBe(3);
  expect(await channel().locator('[data-part-item]').count()).toBe(0);
  // Ctrl+Alt+C hides and shows it.
  await page.keyboard.press(`${MOD}+Alt+KeyC`);
  await expect(channel()).toBeHidden();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press(`${MOD}+Alt+KeyC`);
  await expect(channel()).toBeVisible();
  // The left zone hides while the Channel zone stays, and comes back beside it.
  await page.getByTestId('zone-button-left').click();
  await expect(page.getByTestId('zone-left')).toBeHidden();
  await expect(channel()).toBeVisible();
  expect(await settled('zone-channel')).toBe(96);
  await page.getByTestId('zone-button-left').click();
  await expect(page.getByTestId('zone-left')).toBeVisible();
});

test('the divider drags within 80-160 and collapses below; the keys; the state and size survive a reload', async () => {
  const session = seedBundle(scratch, TRACKS);
  await launch(session);
  await page.getByTestId('zone-button-channel').click();
  const separator = page.getByTestId('separator-channel');
  await expect(separator).toHaveAttribute('aria-valuemin', '80');
  await expect(separator).toHaveAttribute('aria-valuemax', '160');
  await dragSeparator(200);
  await expect.poll(() => width('zone-channel')).toBe(160);
  await dragSeparator(-50);
  await expect.poll(() => width('zone-channel')).toBe(110);
  await expect(separator).toHaveAttribute('aria-valuenow', '110');
  // The keys: 8 px, Shift 32 px, Home and End, Enter the default.
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '118');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '86');
  await page.keyboard.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', '160');
  await page.keyboard.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', '80');
  await page.keyboard.press('Enter');
  await expect(separator).toHaveAttribute('aria-valuenow', '96');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '112');
  // Kept in siann.layout.v1 and read back after a reload.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('siann.layout.v1') ?? '{}') as { sizes?: { channel?: number }; collapsed?: { channel?: boolean } });
  expect(stored.sizes?.channel).toBe(112);
  expect(stored.collapsed?.channel).toBe(false);
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(channel()).toBeVisible();
  await expect.poll(() => width('zone-channel')).toBe(112);
  // A drag below the minimum collapses it, and that is kept too.
  await dragSeparator(-60);
  await expect(channel()).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(channel()).toBeHidden();
  await expect(page.getByTestId('zone-button-channel')).toHaveAttribute('aria-pressed', 'false');
});

test('the strip is the MixConsole\'s: a fader gesture is one revision and the MixConsole follows; its meter draws while playing', async () => {
  await launch(seedBundle(scratch, TRACKS));
  engine = await engineClient(page, { events: false });
  await page.getByTestId('track-header-trk_kick').click({ position: { x: 4, y: 4 } });
  await page.getByTestId('zone-button-channel').click();
  const fader = page.getByTestId('channel-fader-trk_kick');
  await expect(fader).toBeVisible();
  const before = await revision();
  const box = (await fader.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 10, { steps: 3 });
  await page.mouse.move(x, y + 20, { steps: 3 });
  await page.mouse.up();
  await expect.poll(revision).toBe(before + 1);
  const value = await page.getByTestId('channel-fader-value-trk_kick').innerText();
  expect(value).toMatch(/^-\d+\.\d dB$/);
  await expect(page.getByTestId('fader-value-trk_kick')).toHaveText(value);
  await expect(page.getByTestId('fader-trk_kick')).toHaveAttribute('aria-valuenow', (await fader.getAttribute('aria-valuenow'))!);
  // M in the zone is the track's mute: one revision, the MixConsole's M follows.
  await page.getByTestId('channel-mute-trk_kick').click();
  await expect.poll(revision).toBe(before + 2);
  await expect(page.getByTestId('mute-trk_kick')).toHaveAttribute('aria-pressed', 'true');
  // The meter canvas of the zone is drawn while the transport plays.
  const draws = () => page.evaluate(() => (window as unknown as { __siannChannelMeters?: { frames(): number } }).__siannChannelMeters?.frames() ?? -1);
  const idle = await draws();
  expect(idle).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Space');
  await expect.poll(draws, { timeout: 10_000 }).toBeGreaterThan(idle + 5);
  await page.keyboard.press('Space');
});

test('Tab and F6 order: channel, left, project, lower, right; the focus frame', async () => {
  await launch(seedBundle(scratch, TRACKS));
  await page.getByTestId('zone-button-channel').click();
  await expect(channel()).toBeVisible();
  await page.getByTestId('zone-project').focus();
  const order: Array<string | null> = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('F6');
    order.push(await focused());
  }
  expect(order).toEqual(['lower', 'right', 'channel', 'left', 'project']);
  // Tab from the page or a zone cycles the zones in the same order.
  await page.keyboard.press('Shift+F6');
  await page.keyboard.press('Shift+F6');
  expect(await focused()).toBe('channel');
  await expect(channel()).toHaveAttribute('data-focused', 'true');
  const outline = await channel().evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('solid');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('left');
});

test('small windows: at 1080 px it starts collapsed with the left zone; a shrinking window hides it after the left zone', async () => {
  await launch(seedBundle(scratch, TRACKS));
  await page.getByTestId('zone-button-channel').click();
  await expect(channel()).toBeVisible();
  await resize({ width: 1080, height: 900 });
  await expect(channel()).toBeHidden();
  await expect(page.getByTestId('zone-left')).toBeHidden();
  // Shown here, it is remembered for this window only.
  await page.getByTestId('zone-button-channel').click();
  await expect(channel()).toBeVisible();
  await resize({ width: 1440, height: 900 });
  await expect(channel()).toBeVisible();
  // A narrower window: the left zone gives way first and the Channel zone keeps its size
  // (the order past the window's 960 px minimum is layout.test.ts's).
  await page.getByTestId('separator-channel').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('separator-channel')).toHaveAttribute('aria-valuenow', '160');
  await page.getByTestId('separator-left').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('separator-left')).toHaveAttribute('aria-valuenow', '420');
  await resize({ width: 1100, height: 900 });
  await expect(page.getByTestId('zone-left')).toBeVisible();
  await expect(channel()).toBeVisible();
  await expect.poll(() => width('zone-channel')).toBe(160);
  await expect.poll(() => width('zone-left')).toBeLessThan(420);
  // The stored sizes are untouched.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('siann.layout.v1') ?? '{}') as { sizes: { left: number; channel: number } });
  expect(stored.sizes).toMatchObject({ left: 420, channel: 160 });
});

test('e on a strip selects its track, shows the zone on it and is lit; again it hides it; the Inspector\'s e likewise; the master has none', async () => {
  await launch(seedBundle(scratch, TRACKS));
  const e2 = page.getByTestId('edit-trk_bass');
  await expect(e2).toHaveAttribute('aria-pressed', 'false');
  await e2.click();
  await expect(channel()).toBeVisible();
  await expect(page.getByTestId('channel-mixer-strip-trk_bass')).toBeVisible();
  await expect(page.getByTestId('inspector-track')).toHaveText('Bass');
  await expect(e2).toHaveClass('msr e on');
  await expect(e2).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('edit-trk_kick')).toHaveAttribute('aria-pressed', 'false');
  // The Inspector's e is lit for the selected track too.
  const inspectorE = page.locator('[data-part="inspector-edit"]');
  await expect(inspectorE).toHaveAttribute('aria-pressed', 'true');
  await e2.click();
  await expect(channel()).toBeHidden();
  await expect(e2).toHaveAttribute('aria-pressed', 'false');
  await expect(inspectorE).toHaveAttribute('aria-pressed', 'false');
  // e on the other strip moves the zone to its track.
  await e2.click();
  await page.getByTestId('edit-trk_kick').click();
  await expect(channel()).toBeVisible();
  await expect(page.getByTestId('channel-mixer-strip-trk_kick')).toBeVisible();
  await expect(page.getByTestId('edit-trk_kick')).toHaveAttribute('aria-pressed', 'true');
  await expect(e2).toHaveAttribute('aria-pressed', 'false');
  // The Inspector's e hides and shows it for the selected track.
  await inspectorE.click();
  await expect(channel()).toBeHidden();
  await inspectorE.click();
  await expect(channel()).toBeVisible();
  await expect(inspectorE).toHaveClass('msr e on');
  // The master has no e.
  await expect(page.getByTestId('mixer-strip-master').locator('.msr.e')).toHaveCount(0);
});

test('Ctrl+Alt+Right and Left step the focused zone\'s tabs; nothing in the left zone', async () => {
  await launch(seedBundle(scratch, TRACKS));
  await page.getByTestId('zone-lower').focus();
  await expect(page.getByTestId('tab-lower-mixconsole')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`);
  await expect(page.getByTestId('tab-lower-editor')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`);
  await expect(page.getByTestId('tab-lower-mixconsole')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+Alt+ArrowLeft`);
  await expect(page.getByTestId('tab-lower-editor')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+Alt+ArrowLeft`);
  // The right zone: its tabs as the engine has them.
  await page.getByTestId('zone-right').focus();
  await expect(page.getByTestId('tab-right-plans')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`);
  await expect(page.locator('[data-part="right-tabs"] [role="tab"][aria-selected="true"]')).not.toHaveAttribute('data-testid', 'tab-right-plans');
  await page.keyboard.press(`${MOD}+Alt+ArrowLeft`);
  await expect(page.getByTestId('tab-right-plans')).toHaveAttribute('aria-selected', 'true');
  // The left zone has one tab: nothing changes.
  await page.getByTestId('zone-left').focus();
  const tabs = await page.evaluate(() => localStorage.getItem('siann.layout.v1'));
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`);
  expect(await page.evaluate(() => localStorage.getItem('siann.layout.v1'))).toBe(tabs);
  await expect(page.getByTestId('tab-lower-mixconsole')).toHaveAttribute('aria-selected', 'true');
});
