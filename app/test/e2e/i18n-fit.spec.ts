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
import { agentFor, hash8, launchApp, seedBundle } from './support/seed';

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
];
const LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'pseudo'] as const;
const LABELLED = 'button, select, summary, label, th, dt, [role=tab], [role=button]';
const ONE_LINE = 'button, summary, th, dt, [role=tab]';

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
  const sessionDir = seedBundle(scratch, TRACKS);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText(String(TRACKS.length));
  const agent = await agentFor(app);
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  // A plan auditioned: its card reads approved for audition and the banner shows.
  const auditioned = await agent.tool('submit_plan', { steps: MIX_PASS.slice(1, 3) });
  await page.getByTestId(`plan-${hash8(auditioned.hash as string)}`).click();
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('audition-banner')).toBeVisible();
  // The plan under review, selected: steps, actions and diff.
  const plan = await agent.tool('submit_plan', { steps: MIX_PASS });
  await page.getByTestId(`plan-${hash8(plan.hash as string)}`).click();
  await expect(page.getByTestId('plan-diff')).toBeVisible();
  await expect(page.getByTestId('plan-approve-apply')).toBeVisible();
  // The track list (m5-ui-arrange) is in the check: its + button, M and S of
  // every header and the info line's terms are labelled controls.
  await expect(page.getByTestId('track-add')).toBeVisible();
  await expect(page.getByTestId('track-mute-trk_kick')).toBeVisible();
  await expect(page.getByTestId('info-line').locator('dt').first()).toBeAttached();

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
    for (const size of SIZES) {
      await resize(size);
      for (const entry of await overflowing()) failures.push(`${locale} ${size.width}x${size.height}: ${entry}`);
      for (const entry of await wrapped()) failures.push(`${locale} ${size.width}x${size.height}: ${entry}`);
    }
  }
  expect(failures).toEqual([]);
});
