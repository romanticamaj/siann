// The zone shell end to end (m5-ui-shell; UI redesign spec 2.3, 2.4, 3.6):
// the page never scrolls and each zone scrolls inside; the three zone
// boundaries drag within their ranges, collapse below their minimums,
// restore by button and key, move 8 px per arrow key when focused and reset
// on double-click; the layout survives a restart and a session.open, lives
// under one localStorage key and never reaches the engine; zone keys toggle
// their zones, nothing hides the project zone, Tab and Shift+Tab move the
// focus frame, and a key typed into a text field toggles nothing. The app
// runs the real siann-engine on the fake device with its own user data
// directory. Waits are Playwright condition waits, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient } from './support/engine-client';
import { agentFor, hash8, launchApp, seedBundle } from './support/seed';

type Zone = 'left' | 'lower' | 'right';
const ZONES: readonly Zone[] = ['left', 'lower', 'right'];
// The ranges of spec 2.3; the lower zone's upper bound is what leaves the
// event display 320 px high, asserted as that invariant.
const RANGE: Record<Exclude<Zone, 'lower'>, { min: number; max: number }> = {
  left: { min: 180, max: 420 },
  right: { min: 300, max: 560 },
};
const DEFAULTS: Record<Zone, number> = { left: 216, lower: 280, right: 348 };
const LOWER_MIN = 160;
const EVENT_MIN_HEIGHT = 320;
const MOD = 'ControlOrMeta';
const LAYOUT_FIELDS = ['siann.layout', '"sizes"', '"collapsed"', '"tabs"', 'stripWidth', 'trackHeights', 'mixconsole'];

const TRACKS = [
  { id: 'trk_kick', name: 'Kick' },
  { id: 'trk_bass', name: 'Bass', gain: -4000 },
];

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-shell-layout-'));
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(sessionDir: string, userData = path.join(scratch, 'user-data')): Promise<void> {
  app = await launchApp({ sessionDir, userData, languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
}

async function resize(size: { width: number; height: number }): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(width, height);
  }, size);
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([size.width, size.height]);
  // The shell has laid out for this size.
  await expect(page.getByTestId('shell')).toHaveAttribute('data-viewport', `${size.width}x${size.height}`);
}

// The zone's size along its boundary's axis, or 0 when hidden.
async function sizeOf(zone: Zone): Promise<number> {
  const el = page.getByTestId(`zone-${zone}`);
  if ((await el.getAttribute('data-visible')) !== 'true') return 0;
  const box = await el.boundingBox();
  if (!box) return 0;
  return Math.round(zone === 'lower' ? box.height : box.width);
}

async function visible(zone: Zone): Promise<boolean> {
  return (await page.getByTestId(`zone-${zone}`).getAttribute('data-visible')) === 'true';
}

async function eventDisplayHeight(): Promise<number> {
  return page.getByTestId('event-display').evaluate((el) => el.getBoundingClientRect().height);
}

// Drags the zone's separator so the zone becomes `size` px.
async function dragTo(zone: Zone, size: number): Promise<void> {
  // A zone that just opened may still be animating (120 ms): start from where it settles.
  let last = -1;
  await expect.poll(async () => {
    const now = await sizeOf(zone);
    const settled = now === last;
    last = now;
    return settled;
  }).toBe(true);
  const separator = page.getByTestId(`separator-${zone}`);
  const box = await separator.boundingBox();
  if (!box) throw new Error(`separator-${zone} is not laid out`);
  const current = await sizeOf(zone);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // The left zone grows to the right; the right zone to the left; the lower zone upwards.
  const delta = size - current;
  const to = zone === 'left' ? { x: x + delta, y } : zone === 'right' ? { x: x - delta, y } : { x, y: y - delta };
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + to.x) / 2, (y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function expectSize(zone: Zone, size: number): Promise<void> {
  await expect.poll(() => sizeOf(zone), { message: `${zone} size` }).toBeGreaterThanOrEqual(size - 1);
  await expect.poll(() => sizeOf(zone), { message: `${zone} size` }).toBeLessThanOrEqual(size + 1);
}

async function expectButton(zone: Zone, pressed: boolean): Promise<void> {
  await expect(page.getByTestId(`zone-button-${zone}`)).toHaveAttribute('aria-pressed', String(pressed));
}

const TOGGLE_KEY: Record<Zone, string> = { left: `${MOD}+Alt+KeyL`, lower: `${MOD}+Alt+KeyE`, right: `${MOD}+Alt+KeyR` };

test('at 1440x900 and 1024x700 the page never scrolls; each zone scrolls inside', async () => {
  const sessionDir = seedBundle(scratch, TRACKS);
  await launch(sessionDir);
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 700 },
  ]) {
    await resize(size);
    const page_ = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        overflow: getComputedStyle(document.body).overflow,
      };
    });
    expect(page_.scrollHeight, `${size.width}x${size.height}`).toBe(page_.clientHeight);
    expect(page_.scrollWidth, `${size.width}x${size.height}`).toBe(page_.clientWidth);
    // Open every zone (a small window starts some of them collapsed), then
    // make each body's content taller than the body: the body scrolls, the page does not.
    for (const zone of ZONES) {
      if (!(await visible(zone))) await page.getByTestId(`zone-button-${zone}`).click();
      await expect(page.getByTestId(`zone-${zone}`)).toHaveAttribute('data-visible', 'true');
    }
    for (const zone of [...ZONES, 'project'] as const) {
      const body = page.getByTestId(`zone-${zone}-body`);
      const result = await body.evaluate((el) => {
        const filler = document.createElement('div');
        filler.style.height = '5000px';
        filler.style.width = '5000px';
        filler.dataset.filler = 'true';
        el.appendChild(filler);
        const style = getComputedStyle(el);
        el.scrollTop = 100;
        const scrolled = el.scrollTop;
        filler.remove();
        el.scrollTop = 0;
        return { overflowY: style.overflowY, overflowX: style.overflowX, scrolled };
      });
      expect(result.overflowY, zone).toBe('auto');
      expect(result.scrolled, `${zone} scrolls inside`).toBe(100);
      const root = await page.evaluate(() => [document.documentElement.scrollHeight, document.documentElement.clientHeight]);
      expect(root[0], `${zone}: the page did not grow`).toBe(root[1]);
    }
  }
});

test('each zone boundary drags within its range, collapses below its minimum, restores, steps 8 px by key and resets on double-click', async () => {
  test.setTimeout(150_000);
  const sessionDir = seedBundle(scratch, TRACKS);
  await launch(sessionDir);
  for (const zone of ZONES) {
    await expectSize(zone, DEFAULTS[zone]);
    await expectButton(zone, true);
    // Inside the range.
    const inside = zone === 'lower' ? 220 : zone === 'left' ? 300 : 420;
    await dragTo(zone, inside);
    await expectSize(zone, inside);
    // Past the top of the range: held at the maximum.
    await dragTo(zone, zone === 'lower' ? 560 : 900);
    if (zone === 'lower') {
      const top = await sizeOf('lower');
      expect(top).toBeGreaterThan(400);
      expect(await eventDisplayHeight()).toBeGreaterThanOrEqual(EVENT_MIN_HEIGHT - 0.5);
      // One more pixel up would leave the event display under 320 px: it stays.
      await dragTo('lower', top + 40);
      await expectSize('lower', top);
    } else {
      await expectSize(zone, RANGE[zone].max);
    }
    // Exactly the minimum.
    const min = zone === 'lower' ? LOWER_MIN : RANGE[zone].min;
    await dragTo(zone, min);
    await expectSize(zone, min);
    // Below the minimum: collapsed, and the zone button says so.
    await dragTo(zone, 40);
    await expect(page.getByTestId(`zone-${zone}`)).toHaveAttribute('data-visible', 'false');
    await expectButton(zone, false);
    // Restored by the button, at its last size.
    await page.getByTestId(`zone-button-${zone}`).click();
    await expectButton(zone, true);
    await expectSize(zone, min);
    // Hidden and restored by its key.
    await page.keyboard.press(TOGGLE_KEY[zone]);
    await expectButton(zone, false);
    await page.keyboard.press(TOGGLE_KEY[zone]);
    await expectButton(zone, true);
    await expectSize(zone, min);
    // Arrow keys on the focused separator: 8 px per press, in the arrow's direction.
    const separator = page.getByTestId(`separator-${zone}`);
    await separator.focus();
    const [grow, shrink] = zone === 'left' ? ['ArrowRight', 'ArrowLeft'] : zone === 'right' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    await page.keyboard.press(grow!);
    await expectSize(zone, min + 8);
    await page.keyboard.press(grow!);
    await expectSize(zone, min + 16);
    await page.keyboard.press(shrink!);
    await expectSize(zone, min + 8);
    // Double-click restores the default.
    await separator.dblclick();
    await expectSize(zone, DEFAULTS[zone]);
  }
});

test('the layout survives a restart and a session.open, under one localStorage key', async () => {
  test.setTimeout(150_000);
  const sessionDir = seedBundle(scratch, TRACKS);
  const userData = path.join(scratch, 'user-data');
  await launch(sessionDir, userData);
  await dragTo('left', 300);
  await expectSize('left', 300);
  await dragTo('lower', 200);
  await expectSize('lower', 200);
  await page.keyboard.press(TOGGLE_KEY.right);
  await expectButton('right', false);
  const before = { left: await sizeOf('left'), lower: await sizeOf('lower'), right: await visible('right') };

  await app!.close();
  app = undefined;
  await launch(sessionDir, userData);
  await expectSize('left', before.left);
  await expectSize('lower', before.lower);
  await expectButton('right', false);
  expect(await visible('right')).toBe(false);

  // Another session: the layout is the user's, not the session's.
  const otherScratch = path.join(scratch, 'other');
  fs.mkdirSync(otherScratch);
  const otherDir = seedBundle(otherScratch, [{ id: 'trk_other', name: 'Other' }]);
  const sessionId = await page.getByTestId('session-id').textContent();
  const engine = await engineClient(page);
  await engine.call('session.open', { path: path.join(otherDir, 'Untitled.siann') });
  engine.close();
  await expect(page.getByTestId('session-id')).not.toHaveText(sessionId ?? '');
  await expect(page.getByTestId('track-count')).toHaveText('1');
  await expectSize('left', before.left);
  await expectSize('lower', before.lower);
  expect(await visible('right')).toBe(false);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('siann.layout')));
  expect(keys).toEqual(['siann.layout.v1']);
});

test('no protocol request carries the layout, and layout changes make no revision', async () => {
  const sessionDir = seedBundle(scratch, TRACKS);
  await launch(sessionDir);
  // Collect every frame the renderer sends, from a fresh page load on.
  const frames: string[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => frames.push(String(frame.payload))));
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText(String(TRACKS.length));
  expect(frames.some((f) => f.includes('"auth"')), 'the frames of the new page are collected').toBe(true);
  const revision = await page.getByTestId('revision').textContent();

  await dragTo('left', 320);
  await expectSize('left', 320);
  await dragTo('right', 40);
  await expectButton('right', false);
  await page.keyboard.press(`${MOD}+Alt+KeyP`);
  await expectButton('right', true);
  await page.keyboard.press('Alt+F3');
  await expectButton('lower', false);
  await page.keyboard.press('F3');
  await expectButton('lower', true);
  await page.getByTestId('separator-lower').dblclick();
  await expectSize('lower', DEFAULTS.lower);

  await expect(page.getByTestId('revision')).toHaveText(revision ?? '');
  const carrying = frames.filter((f) => LAYOUT_FIELDS.some((field) => f.includes(field)));
  expect(carrying).toEqual([]);
});

test('zone keys toggle their zones, nothing hides the project zone, Tab moves the focus frame, and typing in a field toggles nothing', async () => {
  test.setTimeout(120_000);
  const sessionDir = seedBundle(scratch, TRACKS);
  await launch(sessionDir);

  const press = async (key: string, zone: Zone, shown: boolean) => {
    await page.keyboard.press(key);
    await expectButton(zone, shown);
    await expect(page.getByTestId(`zone-project`)).toHaveAttribute('data-visible', 'true');
  };
  await press(`${MOD}+Alt+KeyL`, 'left', false);
  await press('Alt+KeyI', 'left', true);
  await press(`${MOD}+Alt+KeyE`, 'lower', false);
  await press(`${MOD}+Alt+KeyB`, 'lower', true);
  await press('Alt+F3', 'lower', false);
  await press('Alt+F3', 'lower', true);
  await press('F3', 'lower', false);
  await press('F3', 'lower', true);
  await press(`${MOD}+Alt+KeyR`, 'right', false);
  await press(`${MOD}+Alt+KeyP`, 'right', true);
  await press(`${MOD}+Alt+KeyP`, 'right', false);
  await press(`${MOD}+Alt+KeyR`, 'right', true);
  await expect(page.getByTestId('zone-button-project')).toHaveCount(0);

  // Tab and Shift+Tab move the focus frame through the visible zones in order.
  const focused = () =>
    page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-zone][data-focused="true"]')].map((el) => el.dataset.zone));
  const frame = (zone: string) =>
    page.locator(`[data-zone="${zone}"]`).evaluate((el) => {
      const style = getComputedStyle(el);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1;
    });
  await page.getByTestId('zone-project-body').click({ position: { x: 5, y: 5 } });
  expect(await focused()).toEqual(['project']);
  expect(await frame('project')).toBe(true);
  expect(await frame('lower')).toBe(false);
  for (const zone of ['lower', 'right', 'left', 'project']) {
    await page.keyboard.press('Tab');
    expect(await focused()).toEqual([zone]);
    expect(await frame(zone)).toBe(true);
  }
  for (const zone of ['left', 'right', 'lower', 'project']) {
    await page.keyboard.press('Shift+Tab');
    expect(await focused()).toEqual([zone]);
  }
  // A hidden zone is skipped.
  await page.keyboard.press(`${MOD}+Alt+KeyL`);
  await expectButton('left', false);
  for (const zone of ['lower', 'right', 'project']) {
    await page.keyboard.press('Tab');
    expect(await focused()).toEqual([zone]);
  }
  await page.keyboard.press(`${MOD}+Alt+KeyL`);
  await expectButton('left', true);

  // A key typed into the plan note field toggles nothing.
  const agent = await agentFor(app!);
  const plan = await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: 'trk_kick', gainMilliDb: -3000 }] });
  await page.getByTestId(`plan-${hash8(plan.hash as string)}`).click();
  const note = page.getByTestId('plan-note');
  await note.click();
  for (const key of [`${MOD}+Alt+KeyL`, 'Alt+KeyI', `${MOD}+Alt+KeyE`, 'Alt+F3', 'F3', `${MOD}+Alt+KeyR`, `${MOD}+Alt+KeyP`]) {
    await page.keyboard.press(key);
  }
  await note.pressSequentially('ok');
  await expect(note).toHaveValue('ok');
  for (const zone of ZONES) await expectButton(zone, true);
});

// The licence line (UI redesign spec 2.1; AGPL section 13): in every locale,
// at 1440x900 and 1024x700, with the engine's real about (and the rest of the
// line padded as a long revision, session id or source URL would make it),
// the licence span is drawn whole inside the status bar's about button, the
// button's title is the whole line, and one click opens the About panel
// showing the whole line unclipped; Escape closes it.
test('the licence line stays visible at 1440x900 and 1024x700 in every locale, and the About panel is one click away', async () => {
  const sessionDir = seedBundle(scratch, TRACKS);
  await launch(sessionDir);
  const about = page.getByTestId('about');
  await expect(about).toContainText(/(A?GPL)-\d\.\d-or-later/);
  const license = (await page.locator('.about .about-license').textContent()) ?? '';
  expect(license).toMatch(/^(A?GPL)-\d\.\d-or-later$/);
  const title = (await about.getAttribute('title')) ?? '';
  expect(title).toContain(license);
  expect(title).toContain('siann-engine');

  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    await page.evaluate((next) => {
      const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
      if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
      store.setLocale(next);
    }, locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    // Pads the rest of the line with a node React does not own.
    await page.locator('.about .about-summary').evaluate((el) => {
      if (el.querySelector('[data-pad]')) return;
      const pad = document.createElement('span');
      pad.dataset.pad = 'true';
      pad.textContent = ` ${'https://example.invalid/a-very-long-source-path/'.repeat(4)}`;
      el.appendChild(pad);
    });
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1024, height: 700 },
    ]) {
      await resize(size);
      const where = `${locale} ${size.width}x${size.height}`;
      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width };
        };
        const span = document.querySelector<HTMLElement>('.about .about-license')!;
        return {
          button: rect('[data-testid=about]'),
          bar: rect('[data-testid=status-bar]'),
          license: rect('.about .about-license'),
          clipped: span.scrollWidth > span.clientWidth,
          viewport: window.innerWidth,
        };
      });
      expect(boxes.license.width, where).toBeGreaterThan(0);
      expect(boxes.clipped, where).toBe(false);
      expect(boxes.license.left, where).toBeGreaterThanOrEqual(boxes.button.left - 0.5);
      expect(boxes.license.right, where).toBeLessThanOrEqual(boxes.button.right + 0.5);
      expect(boxes.button.right, where).toBeLessThanOrEqual(boxes.bar.right + 0.5);
      expect(boxes.bar.right, where).toBeLessThanOrEqual(boxes.viewport + 0.5);

      // One click away: the panel shows the whole line, nothing clipped.
      await about.click();
      const panel = page.getByTestId('about-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(license);
      await expect(panel).toContainText('siann-engine');
      const fits = await panel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const line = el.querySelector<HTMLElement>('[data-testid=about-panel-line]')!;
        return {
          inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
          lineFits: line.scrollWidth <= line.clientWidth && line.scrollHeight <= line.clientHeight + 1,
        };
      });
      expect(fits, where).toEqual({ inside: true, lineFits: true });
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
  }
});
