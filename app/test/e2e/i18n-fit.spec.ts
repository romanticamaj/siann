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
// type and auto-scroll fields, the info line's fields and the open Pool.
const TOOLBAR = '.arr-toolbar .b, .arr-toolbar .field, .infoline .f, [data-testid=media-pool] .pool-head, [data-testid^=pool-]';
// The ghosts (m5b-ui-ghosts): the toolbar's proposal pill and its Ghosts
// toggle, the steps' target buttons, the proposed track's header labels and
// the proposed strip's NEW · STEP label.
const GHOSTS = '.overlaypill, .overlaypill .tog, .step .go, .th.ghost .r1 > span, .th.ghost .r2 > span, .strip.ghost .btns > span';
// The track list head (m5-ui-port-track-list): the .add button is a button; its count is text that must fit too.
const LABELLED = `button, select, summary, label, th, dt, [role=tab], [role=button], [role=menuitemradio], [data-testid^=position-], [data-testid=transport-tempo], [data-testid=display-locators], [data-testid=display-signature], [data-testid=track-count], ${PLANS}, ${MIXER}, ${TOOLBAR}, ${GHOSTS}`;
const ONE_LINE = `button, summary, th, dt, [role=tab], [role=menuitemradio], [data-testid^=position-], [data-testid=transport-tempo], [data-testid=display-locators-value], [data-testid=display-signature-value], [data-testid=track-count], ${PLANS}, ${MIXER}, ${TOOLBAR}, ${GHOSTS}`;

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
async function overflowing(): Promise<string[]> {
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
  }, LABELLED);
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
    return out;
  });
}

// Labels drawn on more than one line: the line boxes of each text node.
async function wrapped(): Promise<string[]> {
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
  }, ONE_LINE);
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
  for (const id of ['tool-select', 'tool-split', 'snap-toggle', 'grid-type']) await expect(page.getByTestId(id)).toBeVisible();
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
    // The Pool, open, in this locale (Ctrl+P; m5-ui-port-toolbar). The reason
    // row's text field has the focus, where no key command fires: out of it first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('ControlOrMeta+KeyP');
    await expect(page.getByTestId('media-pool')).toBeVisible();
    await expect(page.getByTestId('pool-med_seed')).toBeVisible();
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
    await expect(page.getByTestId('media-pool')).toHaveCount(0);
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
