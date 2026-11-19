// Fit check (m5-ui-i18n; UI redesign spec 6.3): in en, zh-Hant, zh-Hans and
// the pseudo-locale that pads every English string by 40 %, at 1440x900 and
// 1024x700, on a session seeded like the tour's (its seven tracks and mixer
// settings) with an agent's plan selected, a second plan auditioned (its
// banner shown) and a plan-arrival toast in the locale, no labelled control is wider
// inside than it is shown (scrollWidth <= clientWidth), and no button, header
// cell or term breaks its label over lines (Chinese wraps between any two
// characters, so a narrow column stacks a two-character header vertically). The pseudo-locale is
// reachable only through the test hooks (window.__siannLocale under
// SIANN_SHELL_TEST=1). Waits are Playwright condition waits, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Locale } from '../../src/renderer/i18n/locale';
import { planArrivedMessage } from '../../src/renderer/i18n/messages';
import { engineClient } from './support/engine-client';
import { Agent, agentFor, launchApp, seedBundle, selectPlan } from './support/seed';

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
];
const LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'pseudo'] as const;
// The Plans tab's controls (m5-ui-port-plans): the tab, the hearing switch's
// segments, the steps head's link, the three action buttons and the badges.
const PLANS = '.p-head .tab, .ab .b, .steps-h a, .acts .btn, .plans .badge';
// The MixConsole (m5-ui-port-mixer-strip): the knob, the pan value, M, S, the
// readout (level and peak value) and the MixConsole tab, in the mockup's boxes.
const MIXER = '[role=slider], [data-testid^=pan-value-], .readout, [data-testid^=fader-value-]';
// The project zone toolbar (m5-ui-port-toolbar): the tools, the snap, grid
// type and auto-scroll fields and the info line's fields.
const TOOLBAR = '.arr-toolbar .b, .arr-toolbar .field, .infoline .f';
// The Media tab (m5b-ui-media): the tab, Import, the search field, the
// column heads and each row's Remove.
const MEDIA = '[data-part=tab-media], [data-testid=media-import], [data-testid=media-search], .media-list th, [data-testid^=media-remove-]';
// The ghosts (m5b-ui-ghosts): the toolbar's proposal pill and its Ghosts
// toggle, the steps' target buttons, the proposed track's header labels and
// the proposed strip's NEW · STEP label.
const GHOSTS = '.overlaypill, .overlaypill .tog, .step .go, .th.ghost .r1 > span, .th.ghost .r2 > span, .strip.ghost .btns > span';
// The track list head (m5-ui-port-track-list): the .add button is a button; its count is text that must fit too.
const LABELLED = `button, select, summary, label, th, dt, [role=tab], [role=button], [role=menuitemradio], [data-testid^=position-], [data-testid=transport-tempo], [data-testid=display-locators], [data-testid=display-signature], [data-testid=track-count], ${PLANS}, ${MIXER}, ${TOOLBAR}, ${GHOSTS}, ${MEDIA}`;
const ONE_LINE = `button, summary, th, dt, [role=tab], [role=menuitemradio], [data-testid^=position-], [data-testid=transport-tempo], [data-testid=display-locators-value], [data-testid=display-signature-value], [data-testid=track-count], ${PLANS}, ${MIXER}, ${TOOLBAR}, ${GHOSTS}, ${MEDIA}`;

// The tour's tracks (ux-tour.spec.ts), without the audio.
const TRACKS = [
  { id: 'trk_kick', name: 'Kick' },
  { id: 'trk_snare', name: 'Snare', gain: -2500 },
  { id: 'trk_bass', name: 'Bass', gain: -4000 },
  { id: 'trk_keys', name: 'Keys', gain: -8000, pan: -3500 },
  { id: 'trk_voxlead', name: 'Vox Lead', gain: 1500, solo: true },
  { id: 'trk_voxbg', name: 'Vox BG', gain: -9000, pan: 4000 },
  { id: 'trk_fx', name: 'FX', gain: -12000, mute: true },
];

// The tour's mix plan: an added track, gain, pan, unmute and rename.
const MIX_PASS = [
  { op: 'track.add', trackId: 'trk_pad', name: 'Pad', channels: 2 },
  { op: 'track.set_gain', trackId: 'trk_voxbg', gainMilliDb: -6000 },
  { op: 'track.set_pan', trackId: 'trk_keys', pan: -2000 },
  { op: 'track.set_mute', trackId: 'trk_fx', mute: false },
  { op: 'track.rename', trackId: 'trk_fx', name: 'FX Riser' },
];

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function resize(size: { width: number; height: number }): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(width, height);
  }, size);
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([size.width, size.height]);
}

// Labelled controls whose content is wider than their box.
async function overflowing(within: string = LABELLED): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.getClientRects().length === 0) continue;
      if (el.scrollWidth > el.clientWidth) {
        const id = el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : '';
        out.push(`${el.tagName.toLowerCase()}${id} "${(el.textContent ?? '').trim().slice(0, 40)}" ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return out;
  }, within);
}

// The branch chip (m5b-ui-audition), naming the auditioned plan: one line,
// inside .tb-left and clear of the separator after it, shortened with an
// ellipsis, its whole name in its title. Under 1300 px it is not shown.
async function chipFits(): Promise<string[]> {
  return page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('[data-part=branch-chip]');
    if (!chip) return ['no branch chip'];
    if (window.innerWidth <= 1300) return getComputedStyle(chip).display === 'none' ? [] : ['the chip is shown under 1300 px'];
    const out: string[] = [];
    const box = chip.getBoundingClientRect();
    const sep = chip.parentElement!.querySelector<HTMLElement>('.sep')!.getBoundingClientRect();
    const left = chip.parentElement!.getBoundingClientRect();
    if (box.right > sep.left + 0.5 || box.right > left.right + 0.5) out.push(`the chip runs past its group: ${box.right} > ${sep.left}`);
    const name = chip.querySelector<HTMLElement>('span')!;
    if (name.getClientRects().length !== 1) out.push('the chip wraps');
    if (!chip.title || !chip.title.includes((name.textContent ?? '').slice(0, 4))) out.push(`the chip's title does not hold its name: ${chip.title}`);
    // A long name shortens; it never pushes the bar's right group out of the window.
    const plans = document.querySelector<HTMLElement>('[data-testid=plans-button]')!.getBoundingClientRect();
    if (plans.right > window.innerWidth + 0.5) out.push(`the Plans button is pushed out: ${plans.right} > ${window.innerWidth}`);
    // The chip gives way first: the session's name stays whole (its text as
    // wide as its box; an ellipsis shows at any fraction of a pixel short).
    const session = document.querySelector<HTMLElement>('[data-testid=session-name] > span')!;
    const range = document.createRange();
    range.selectNodeContents(session);
    const text = range.getBoundingClientRect().width;
    const shown = session.getBoundingClientRect().width;
    if (text > shown + 0.01) out.push(`the session's name is shortened: ${text} > ${shown}`);
    return out;
  });
}

// Labels drawn on more than one line: the line boxes of each text node.
async function wrapped(within: string = ONE_LINE): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.getClientRects().length === 0) continue;
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(`${el.tagName.toLowerCase()} "${node.textContent.trim()}" on ${tops.size} lines`);
      }
    }
    return out;
  }, within);
}

test('no labelled control overflows or wraps its label in any locale at either window size', async () => {
  test.setTimeout(150_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-'));
  // One clip, selected below, so the info line holds its fields.
  const sessionDir = seedBundle(scratch, TRACKS, [{ id: 'clp_fit', trackId: 'trk_kick', at: 0.25 }]);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('about-track-count')).toHaveText(String(TRACKS.length));
  // The clip selected first (an auditioned plan holds the event display), so the info line holds its fields.
  const clip = await page.evaluate(async () => {
    const hooks = (window as unknown as { __siannTimeline?: { clips(): Array<{ clipId: string; x: number; y: number; width: number; height: number }> } }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
    for (let i = 0; i < 200; i += 1) {
      const found = hooks.clips().find((c) => c.clipId === 'clp_fit');
      if (found) return found;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return null;
  });
  expect(clip).not.toBeNull();
  const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + clip!.x + clip!.width / 2, canvas.y + clip!.y + clip!.height / 2);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_fit');
  await expect(page.getByTestId('info-line').locator('.f').first()).toBeVisible();
  // Tools 4 and 5 (m5b-ui-edit-more) are .arr-toolbar .b too.
  for (const id of ['tool-select', 'tool-split', 'tool-glue', 'tool-erase', 'snap-toggle', 'grid-type']) await expect(page.getByTestId(id)).toBeVisible();
  const agent = await agentFor(app);
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  // A plan auditioned: its card reads approved for audition and the banner shows.
  const auditioned = await agent.tool('submit_plan', { steps: MIX_PASS.slice(1, 3) });
  await selectPlan(page, auditioned.hash as string);
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('audition-banner')).toBeVisible();
  // The plan under review, selected: its card (summary chips, steps with the
  // one select link, the three actions), the reason row opened by Reject, the
  // earlier plan's history row, and the hearing switch in the tab row.
  const plan = await agent.tool('submit_plan', { steps: MIX_PASS });
  await selectPlan(page, plan.hash as string);
  await expect(page.getByTestId('plan-approve-apply')).toBeVisible();
  await page.getByTestId('plan-reject').click();
  await expect(page.getByTestId('plan-note')).toBeFocused();
  for (const id of ['tab-right-plans', 'hear-main', 'hear-proposal', 'steps-none', 'plan-audition', 'plan-reject', `plan-${(auditioned.hash as string).slice(7, 15)}`]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.locator('[data-part="plan-summary"] > span')).toHaveCount(3);
  // m5b-ui-ghosts: the plan under review is reviewable, so its pill ends the toolbar and its ghosts are drawn.
  await expect(page.locator('[data-part="proposal-pill"]')).toBeVisible();
  await expect(page.locator('[data-part="proposal-pill"] .tog')).toBeVisible();
  await expect(page.locator('.step .go').first()).toBeVisible();
  // The track list (m5-ui-arrange) is in the check: its + button, M and S of
  // every header and the info line's fields (m5-ui-port-toolbar: .f, for
  // the selected clip) are labelled controls; the head's .add label and its
  // count (m5-ui-port-track-list) are text in the head.
  await expect(page.getByTestId('track-add')).toBeVisible();
  await expect(page.getByTestId('track-add')).toHaveText(/\S/);
  await expect(page.getByTestId('track-count')).toBeVisible();
  await expect(page.getByTestId('track-count')).toHaveText(`${TRACKS.length} tracks · 1 clip`);
  await expect(page.getByTestId('track-mute-trk_kick')).toBeVisible();
  // The transport bar (m5-ui-transport): its buttons, the position display,
  // the tempo, undo and redo in the top bar.
  // m5-ui-loop-click: the cycle and metronome buttons and the locator display
  // (the session has locators: set by a second connection).
  const engine = await engineClient(page);
  await engine.call('command.execute', { commands: [{ op: 'session.set_locators', left: '768000', right: '1152000' }] });
  engine.close();
  for (const id of [
    'transport-to-start',
    'transport-play',
    'transport-stop',
    'position-primary',
    'position-secondary',
    'transport-tempo',
    'auto-scroll',
    'undo',
    'redo',
    'transport-cycle',
    'transport-metronome',
    'display-locators',
    // The Sig cell (m5b-ui-signature): hidden under 1100 px, which fits.
    'display-signature',
    'display-signature-value',
    // The MixConsole strip (m5-ui-port-mixer-strip) and its tab.
    'pan-trk_keys',
    'pan-value-trk_keys',
    'mute-trk_keys',
    'solo-trk_keys',
    'fader-value-trk_keys',
    'peak-value-trk_keys',
    'peak-value-master',
    'tab-lower-mixconsole',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  const failures: string[] = [];
  for (const locale of LOCALES) {
    await page.evaluate((next) => {
      const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
      if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
      store.setLocale(next);
    }, locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    // A toast in this locale (a toast keeps the locale it was raised in).
    await page.evaluate((message) => {
      const toasts = (window as unknown as { __siannToasts?: { push(m: string): number } }).__siannToasts;
      if (!toasts) throw new Error('window.__siannToasts is missing (SIANN_SHELL_TEST=1)');
      toasts.push(message);
    }, planArrivedMessage(locale as Locale, { steps: MIX_PASS.length }));
    await expect(page.getByTestId('toast').last()).toBeVisible();
    // The time format menu, open, in this locale.
    await page.getByTestId('position-display').click({ button: 'right' });
    await expect(page.getByTestId('time-format-menu')).toBeVisible();
    for (const size of SIZES) {
      await resize(size);
      for (const entry of await overflowing()) failures.push(`${locale} ${size.width}x${size.height}: ${entry}`);
      for (const entry of await wrapped()) failures.push(`${locale} ${size.width}x${size.height}: ${entry}`);
      for (const entry of await chipFits()) failures.push(`${locale} ${size.width}x${size.height}: ${entry}`);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('time-format-menu')).toBeHidden();
  }
  // The Media tab (m5b-ui-media), open in each locale at both sizes (Ctrl+P,
  // which also opens the small window's drawer): the tab, Import, the search
  // field, the column heads and Remove. The reason row's text field has the
  // focus, where no key command fires: out of it first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const locale of LOCALES) {
    await page.evaluate((next) => {
      const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
      if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
      store.setLocale(next);
    }, locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    for (const size of SIZES) {
      await resize(size);
      if (!(await page.getByTestId('media-tab').isVisible())) await page.keyboard.press('ControlOrMeta+KeyP');
      await expect(page.getByTestId('media-tab')).toBeVisible();
      await expect(page.getByTestId('media-row-med_seed')).toBeVisible();
      for (const entry of await overflowing(MEDIA)) failures.push(`${locale} ${size.width}x${size.height} (Media tab): ${entry}`);
      for (const entry of await wrapped(MEDIA)) failures.push(`${locale} ${size.width}x${size.height} (Media tab): ${entry}`);
    }
  }
  expect(failures).toEqual([]);
});

// m5b-ui-project: the start view (its New and Open buttons, its recent row)
// and Studio Setup (its device table, the output and input lists, the status
// terms and its buttons) in the four locales at both sizes.
test('the start view and Studio Setup fit in every locale at either window size', async () => {
  test.setTimeout(150_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-project-'));
  const userData = path.join(scratch, 'user-data');
  // One recent bundle, gone, and a launch with no bundle: the start view with an empty list;
  // then New gives the list a row for the next launch.
  app = await launchApp({ sessionDir: null, userData, languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const bundle = path.join(scratch, 'A project with a long name.siann');
  await app.evaluate(({ dialog }, file) => {
    (dialog as unknown as Record<string, unknown>).showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, bundle);
  await page.getByTestId('start-new').click();
  await expect(page.getByTestId('start-view')).toHaveCount(0);
  await app.close();
  // The bundle moved away: the next launch shows the start view, and New made a record of another one.
  const other = path.join(scratch, 'Other.siann');
  fs.renameSync(bundle, other);
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({ schema: 'siann.recent.v1', recent: [path.join(scratch, 'Gone.siann'), other] }));
  app = await launchApp({ sessionDir: null, userData, languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect(page.getByTestId('start-recent-1')).toBeVisible();

  const failures: string[] = [];
  const check = async (what: string, locale: string) => {
    for (const size of SIZES) {
      await resize(size);
      for (const entry of await overflowing()) failures.push(`${what} ${locale} ${size.width}x${size.height}: ${entry}`);
      for (const entry of await wrapped()) failures.push(`${what} ${locale} ${size.width}x${size.height}: ${entry}`);
    }
  };
  for (const locale of LOCALES) {
    await page.evaluate((next) => window.__siannLocale!.setLocale(next as never), locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    await check('start view', locale);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('studio.setup')!.click());
    await expect(page.getByTestId('studio-setup')).toBeVisible();
    await expect(page.getByTestId('setup-device-fake')).toBeVisible();
    await check('Studio Setup', locale);
    await page.getByTestId('setup-close').click();
    await expect(page.getByTestId('studio-setup')).toBeHidden();
  }
  expect(failures).toEqual([]);
});

// m5b-ui-plan-metadata: the agent row and a titled card with its intent, in
// en, zh-TW and zh-CN, at 1440 px and with the right zone at its minimum
// width. The row is one line (.agent is nowrap), so a long name ellipsises
// inside its span instead of pushing the state off the row.
test('the agent row and a titled card fit in every locale at 1440 px and at the right zone\'s minimum width', async () => {
  test.setTimeout(120_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-agent-'));
  const sessionDir = seedBundle(scratch, TRACKS);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await resize({ width: 1440, height: 900 });
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  // An agent with a long name.
  const ready = await app.evaluate(() => (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } } }).__siannShell.current());
  const named = new Agent(ready.port, ready.mcpToken);
  await named.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mix-assistant for the whole chorus and the bridge', version: '1' } });
  const plan = await named.tool('submit_plan', {
    steps: MIX_PASS,
    title: 'Lift the chorus',
    intent: 'Add a pad under the chorus, bring the backing vocals forward and land the riser on the downbeat of bar 9.',
  });
  await selectPlan(page, plan.hash as string);
  const row = page.locator('[data-part="agent-row"]');
  await expect(row.locator('b')).toHaveText('mix-assistant for the whole chorus and the bridge');
  await expect(row).toHaveCSS('white-space', 'nowrap');
  await expect(page.locator('[data-part="plan-title"]')).toBeVisible();
  await expect(page.locator('[data-part="plan-intent"]')).toBeVisible();
  const separator = page.getByTestId('separator-right');
  const failures: string[] = [];
  for (const locale of ['en', 'zh-Hant', 'zh-Hans']) {
    await page.evaluate((next) => {
      const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
      if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
      store.setLocale(next);
    }, locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    for (const edge of ['Enter', 'Home']) {
      await separator.focus();
      await page.keyboard.press(edge);
      if (edge === 'Home') await expect(separator).toHaveAttribute('aria-valuenow', await separator.getAttribute('aria-valuemin') ?? '');
      const report = await page.evaluate(() => {
        const out: string[] = [];
        const zone = document.querySelector<HTMLElement>('[data-region="right-zone"]')!;
        const right = zone.getBoundingClientRect().right;
        const agentRow = document.querySelector<HTMLElement>('[data-part="agent-row"]')!;
        if (agentRow.scrollWidth > agentRow.clientWidth) out.push(`agent row ${agentRow.scrollWidth} > ${agentRow.clientWidth}`);
        for (const el of agentRow.querySelectorAll<HTMLElement>(':scope > span')) {
          if (el.getBoundingClientRect().right > right + 0.5) out.push(`agent row span "${el.textContent}" past the zone`);
        }
        const live = agentRow.querySelector<HTMLElement>('.live')!;
        const rects = new Set([...live.getClientRects()].map((r) => Math.round(r.top)));
        if (rects.size > 1) out.push('the state wraps');
        for (const sel of ['[data-part="plan-title"]', '[data-part="plan-intent"]', '[data-part="plan-head"]']) {
          const el = document.querySelector<HTMLElement>(sel)!;
          if (el.scrollWidth > el.clientWidth) out.push(`${sel} ${el.scrollWidth} > ${el.clientWidth}`);
        }
        return out;
      });
      for (const entry of report) failures.push(`${locale} ${edge === 'Home' ? 'minimum' : '1440'}: ${entry}`);
    }
  }
  expect(failures).toEqual([]);
});

// m5b-ui-inserts-master: the rack switch, the slot buttons (bypass, e,
// Remove, the empty slot's +), the Inspector's Inserts section and the open
// plugin picker fit in en, zh-TW and zh-CN at 1440x900. The slot's plugin
// name ellipsises inside its box by design, so the check is on the controls.
// A strip's slot shows its buttons while hovered: they are measured on the
// hovered slot.
const PLUGIN = process.env.SIANN_TEST_PLUGIN_CLAP;
const RACKS = '[data-part=mixer-racks] button, .slot.empty, .slot:hover button, .islot button, .islot.empty, [data-part=inspector-inserts] .sec-h';
const PICKER = '.plugin-picker button, .plugin-picker .picker-format, .plugin-picker .picker-state';

test('the rack switch, the slots, the Inspector\'s Inserts section and the picker fit in every locale', async () => {
  test.skip(!PLUGIN, 'set SIANN_TEST_PLUGIN_CLAP');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-inserts-'));
  const sessionDir = seedBundle(scratch, TRACKS);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], env: { SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake', '--plugin-dir', path.dirname(PLUGIN!)]) } });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const engine = await engineClient(page);
  const registry = (await engine.call('plugin.registry')) as { plugins: Array<{ format: string; path: string }> };
  const install = registry.plugins.find((p) => path.basename(p.path) === path.basename(PLUGIN!))!;
  await engine.call('plugin.approve', { format: install.format, path: install.path, approved: true });
  await engine.call('plugin.instantiate', { trackId: 'trk_keys', index: 0, descriptor: { format: install.format, path: install.path } });
  engine.close();
  await resize(SIZES[0]!);
  await expect(page.getByTestId('mixer-strip-trk_keys').locator('.slot:not(.empty)')).toHaveCount(1);
  await page.getByTestId('track-header-trk_keys').click();
  await expect(page.locator('[data-part="inspector-inserts"] .islot:not(.empty)')).toHaveCount(1);
  const failures: string[] = [];
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    await page.evaluate((next) => (window as unknown as { __siannLocale: { setLocale(l: string): void } }).__siannLocale.setLocale(next), locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    const measure = (selector: string) => page.evaluate((selector) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (el.getClientRects().length === 0) continue;
        if (el.scrollWidth > el.clientWidth) out.push(`${el.className} "${(el.textContent ?? '').trim().slice(0, 40)}" ${el.scrollWidth} > ${el.clientWidth}`);
        for (const node of el.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) out.push(`${el.className} "${node.textContent.trim()}" wraps`);
        }
      }
      return out;
    }, selector);
    await page.getByTestId('mixer-strip-trk_keys').locator('.slot:not(.empty)').hover();
    await expect(page.getByTestId('mixer-strip-trk_keys').locator('.slot:hover button')).toHaveCount(3);
    for (const entry of await measure(RACKS)) failures.push(`${locale}: ${entry}`);
    await page.getByTestId('mixer-strip-trk_bass').locator('.slot.empty').first().click();
    await expect(page.getByTestId('plugin-picker')).toBeVisible();
    await expect(page.getByTestId('picker-install').first()).toBeVisible();
    for (const entry of await measure(PICKER)) failures.push(`${locale}: ${entry}`);
    await page.getByTestId('picker-close').click();
    await expect(page.getByTestId('plugin-picker')).toBeHidden();
  }
  expect(failures).toEqual([]);
});

// m5b-ui-edit-more (UI redesign 3.2, 6.3): the snap type menu, open, and the
// repeat dialog (Ctrl+K), open, fit in every locale at both window sizes: no
// item or label overflows its box or wraps.
test('the snap type menu and the repeat dialog fit in every locale at either window size', async () => {
  test.setTimeout(150_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-edit-'));
  const sessionDir = seedBundle(scratch, TRACKS, [{ id: 'clp_fit', trackId: 'trk_kick', at: 0.25 }]);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('tool-glue')).toBeVisible();
  const clip = await page.evaluate(async () => {
    const hooks = (window as unknown as { __siannTimeline?: { clips(): Array<{ clipId: string; x: number; y: number; width: number; height: number }> } }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
    for (let i = 0; i < 200; i += 1) {
      const found = hooks.clips().find((c) => c.clipId === 'clp_fit');
      if (found) return found;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return null;
  });
  expect(clip).not.toBeNull();
  const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!;
  const failures: string[] = [];
  const DIALOG = '[data-testid=repeat-dialog] label, [data-testid=repeat-dialog] button, [data-testid=repeat-dialog] p';
  const check = async (what: string, selector?: string) => {
    for (const size of SIZES) {
      await resize(size);
      for (const entry of await overflowing()) failures.push(`${what} ${size.width}x${size.height}: ${entry}`);
      for (const entry of await wrapped()) failures.push(`${what} ${size.width}x${size.height}: ${entry}`);
      if (selector) {
        const report = await page.evaluate((sel) => {
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(sel)) {
            if (el.scrollWidth > el.clientWidth) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim()}" ${el.scrollWidth} > ${el.clientWidth}`);
          }
          return out;
        }, selector);
        for (const entry of report) failures.push(`${what} ${size.width}x${size.height}: ${entry}`);
      }
    }
    await resize(SIZES[0]!);
  };
  for (const locale of LOCALES) {
    await page.evaluate((next) => {
      const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
      if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
      store.setLocale(next);
    }, locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    // The snap type menu, from the snap field's chevron.
    await page.getByTestId('snap-toggle').locator('svg').last().click();
    await expect(page.getByTestId('snap-type-menu')).toBeVisible();
    await expect(page.getByTestId('snap-type-menu').getByRole('menuitemradio')).toHaveCount(4);
    await check(`${locale} snap type menu`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('snap-type-menu')).toHaveCount(0);
    // The repeat dialog: the clip selected, Ctrl+K.
    await page.mouse.click(canvas.x + clip!.x + clip!.width / 2, canvas.y + clip!.y + clip!.height / 2);
    await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_fit');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.getByTestId('repeat-dialog')).toBeVisible();
    await check(`${locale} repeat dialog`, DIALOG);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('repeat-dialog')).toBeHidden();
  }
  expect(failures).toEqual([]);
});

// m5b-ui-meter: the DSP load, the Meter tab, the master's loudness row and the
// panel's controls (its head, the four readouts and Reset) fit on one line in
// en, zh-TW, zh-CN and the pseudo-locale, at 1440 px and with the right zone
// at its minimum width (the DSP load goes under 1300 px, spec 2.4).
test('the DSP load, the Meter tab, the loudness row and the Meter panel fit in every locale', async () => {
  test.setTimeout(120_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-meter-'));
  const sessionDir = seedBundle(scratch, TRACKS);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await resize({ width: 1440, height: 900 });
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  await page.getByTestId('tab-right-meter').click();
  await expect(page.getByTestId('meter-panel')).toBeVisible();
  for (const id of ['dsp-load', 'strip-master-loudness', 'meter-reset-loudness', 'loudness-momentary', 'loudness-short-term', 'loudness-integrated']) await expect(page.getByTestId(id)).toBeVisible();
  const separator = page.getByTestId('separator-right');
  const SELECTORS = ['[data-part="dsp-load"]', '[data-part="tab-meter"]', '[data-part="tab-plans"]', '[data-part-of="loudness"]', '.meter-panel .z-head', '.meter-panel .readout', '[data-testid="meter-reset-loudness"]'];
  const failures: string[] = [];
  for (const locale of LOCALES) {
    await page.evaluate((next) => {
      const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
      if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
      store.setLocale(next);
    }, locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    for (const edge of ['Enter', 'Home']) {
      await separator.focus();
      await page.keyboard.press(edge);
      const report = await page.evaluate((selectors) => {
        const out: string[] = [];
        const zone = document.querySelector<HTMLElement>('[data-region="right-zone"]')!.getBoundingClientRect();
        for (const selector of selectors) {
          const all = [...document.querySelectorAll<HTMLElement>(selector)];
          if (all.length === 0) out.push(`${selector} is missing`);
          for (const el of all) {
            if (el.scrollWidth > el.clientWidth) out.push(`${selector} "${(el.textContent ?? '').trim()}" ${el.scrollWidth} > ${el.clientWidth}`);
            for (const node of el.childNodes) {
              if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
              if (tops.size > 1) out.push(`${selector} "${node.textContent.trim()}" on ${tops.size} lines`);
            }
            if (el.closest('[data-region="right-zone"]') && el.getBoundingClientRect().right > zone.right + 0.5) out.push(`${selector} past the zone`);
          }
        }
        return out;
      }, SELECTORS);
      for (const entry of report) failures.push(`${locale} ${edge === 'Home' ? 'minimum' : '1440'}: ${entry}`);
    }
  }
  expect(failures).toEqual([]);
});

// m5b-ui-composer: the "ask the agent" box, its send control, the request
// rows' state texts and their cancel and dismiss controls, in en, zh-TW, zh-CN
// and the pseudo-locale, at 1440x900: an open request sent and one taken,
// under them the closed one in each closed state in turn (answered with a
// message, declined, cancelled, then expired by the agent's disconnect).
test('the composer, its send control, the request states and their controls fit in every locale', async () => {
  test.setTimeout(150_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-composer-'));
  const sessionDir = seedBundle(scratch, TRACKS);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await resize({ width: 1440, height: 900 });
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  const ready = await app.evaluate(() => (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } } }).__siannShell.current());
  const agent = new Agent(ready.port, ready.mcpToken);
  await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mix-assistant', version: '1' } });
  const field = page.locator('[data-part="composer"] textarea');
  await expect(field).toBeEnabled();
  const send = async (text: string) => {
    const before = await page.locator('.request').count();
    await field.fill(text);
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await expect(page.locator('.request[data-state="pending"]').last()).toContainText(text);
    return before;
  };
  const failures: string[] = [];
  const check = async (what: string) => {
    for (const locale of LOCALES) {
      await page.evaluate((next) => {
        const store = (window as unknown as { __siannLocale?: { setLocale(l: string): void } }).__siannLocale;
        if (!store) throw new Error('window.__siannLocale is missing (SIANN_SHELL_TEST=1)');
        store.setLocale(next);
      }, locale);
      await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
      const report = await page.evaluate(() => {
        const out: string[] = [];
        const zone = document.querySelector<HTMLElement>('[data-region="right-zone"]')!.getBoundingClientRect();
        for (const el of document.querySelectorAll<HTMLElement>('[data-part="composer"], [data-part="composer"] .send, .request-state, .request button, .composer-refusal')) {
          const box = el.getBoundingClientRect();
          if (el.scrollWidth > el.clientWidth) out.push(`${el.className} "${el.textContent}" ${el.scrollWidth} > ${el.clientWidth}`);
          if (box.right > zone.right + 0.5 || box.left < zone.left - 0.5) out.push(`${el.className} "${el.textContent}" outside the zone`);
          if (el.classList.contains('request-state')) {
            const range = document.createRange();
            range.selectNodeContents(el);
            if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) out.push(`state "${el.textContent}" wraps`);
          }
        }
        // The placeholder on the box's one line.
        const area = document.querySelector<HTMLTextAreaElement>('[data-part="composer"] textarea')!;
        if (area.value === '' && area.scrollHeight > area.clientHeight + 1) out.push(`placeholder "${area.placeholder}" wraps`);
        return out;
      });
      for (const entry of report) failures.push(`${locale} ${what}: ${entry}`);
    }
  };
  await check('empty');
  // next_request takes the oldest pending request.
  const take = async () => ((await agent.tool('next_request', { waitMs: 0 })).request as { id: string }).id;
  await send('Taken request');
  await take();
  await send('Open request');
  await send('Answered request');
  await take(); // "Open request" stays taken
  await agent.tool('answer_request', { request: await take(), message: 'Lowered the drums by 3 dB' });
  await expect(page.locator('.request[data-state="answered"]')).toHaveCount(1);
  await check('answered');
  await send('Declined request');
  await agent.tool('answer_request', { request: await take(), decline: true, message: 'Not now' });
  await expect(page.locator('.request[data-state="declined"]')).toHaveCount(1);
  await check('declined');
  await send('Cancelled request');
  await page.locator('.request[data-state="pending"] [data-testid="request-cancel"]').last().click();
  await expect(page.locator('.request[data-state="cancelled"]')).toHaveCount(1);
  await page.locator('.request[data-state="cancelled"]').getByTestId('request-dismiss').waitFor();
  await check('cancelled');
  await agent.end();
  await expect(page.locator('.request[data-state="expired"]')).toHaveCount(1);
  await check('expired');
  expect(failures).toEqual([]);
});

// m5b-ui-recording (UI redesign 3.1, 3.5; 10.11, 16 and 17): the record
// options panel (its four options and two bar counts), Record and the
// Inspector's In row (its .pick and the native select over it) in the four
// locales at both sizes, with an input open and a track armed.
test('the record options panel, Record and the In row fit in every locale at either window size', async () => {
  test.setTimeout(150_000);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fit-record-'));
  const sessionDir = seedBundle(scratch, [{ id: 'trk_vox', name: 'Vox Lead', input: { port: 0, channels: 1 } }]);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const engine = await engineClient(page);
  await engine.call('engine.select_device', { id: 'fake', inputId: 'fake' });
  await expect.poll(async () => ((await engine.call('engine.status')).device as { input: unknown } | null)?.input ?? null).not.toBeNull();
  await page.getByTestId('track-header-trk_vox').locator('.name').click();
  await page.getByTestId('track-record-trk_vox').click();
  await expect(page.getByTestId('track-record-trk_vox')).toHaveAttribute('aria-pressed', 'true');
  const RECORD = '[data-testid=record-options] label, [data-testid=record-options] input, [data-part=transport-record], .irow .pick';
  const failures: string[] = [];
  for (const locale of LOCALES) {
    await page.evaluate((next) => window.__siannLocale!.setLocale(next as never), locale);
    await expect(page.locator('html')).toHaveAttribute('data-locale', locale);
    await page.getByTestId('transport-record').click({ button: 'right' });
    await expect(page.getByTestId('record-options')).toBeVisible();
    for (const size of SIZES) {
      await resize(size);
      for (const entry of await overflowing(RECORD)) failures.push(`${locale} ${size.width}x${size.height} (recording): ${entry}`);
      for (const entry of await wrapped('[data-testid=record-options] label, .irow > span, .irow .pick')) failures.push(`${locale} ${size.width}x${size.height} (recording): ${entry}`);
      // The panel stays inside the window.
      const inside = await page.getByTestId('record-options').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
      });
      if (!inside) failures.push(`${locale} ${size.width}x${size.height}: the record options panel leaves the window`);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('record-options')).toBeHidden();
  }
  engine.close();
  expect(failures).toEqual([]);
});
