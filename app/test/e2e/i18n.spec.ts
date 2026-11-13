// Locale detection, the manual switch and its persistence end to end
// (m5-ui-i18n; UI redesign spec 6.1): with the system language reported as
// zh-TW a first launch on a fresh profile renders in Traditional Chinese with
// <html lang="zh-TW">; the switch (data-testid="locale-switch") changes every
// visible string without a reload; the choice survives a restart that still
// reports zh-TW. Expected strings come from the catalogs, never hard-coded
// Chinese. Waits are Playwright condition waits, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en, type Catalog } from '../../src/renderer/i18n/en';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import { translator } from '../../src/renderer/i18n/t';
import { describeStep } from '../../src/renderer/plans/describe';
import { agentFor, hash8, launchApp, seedBundle } from './support/seed';

type Locale = 'en' | 'zh-Hant' | 'zh-Hans';
const CATALOGS: Record<Locale, Catalog> = { en, 'zh-Hant': zhHant, 'zh-Hans': zhHans };
// Values that are the same in every locale on purpose (i18n-catalogs.test.ts).
const SAME: ReadonlySet<string> = new Set(['app.title']);

let scratch = '';
let sessionDir = '';
let userData = '';
let app: ElectronApplication | undefined;
let page: Page;

const STEPS = [
  { op: 'track.add', trackId: 'trk_new', name: 'New', channels: 2 },
  { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -600 },
  { op: 'track.set_mute', trackId: 'trk_b', mute: true },
];

async function launch(languages: readonly string[]): Promise<void> {
  app = await launchApp({ sessionDir, userData, languages });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText('2');
}

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-i18n-'));
  sessionDir = seedBundle(scratch, [
    { id: 'trk_a', name: 'trk_a' },
    { id: 'trk_b', name: 'trk_b' },
  ]);
  userData = path.join(scratch, 'user-data');
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

// Every text node and label attribute the page shows, outside the language
// switch (its options name each language in its own script).
async function shownTexts(): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      if (!text || node.parentElement?.closest('select, script, style')) continue;
      out.push(text);
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) {
      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = el.getAttribute(name);
        if (value) out.push(value.trim());
      }
    }
    return out;
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The chrome strings of a catalog as matchers of a whole text node: a static
// message exactly, a template with its placeholders as wildcards, and the
// plural messages for small counts.
function matchers(catalog: Catalog): Array<{ key: string; re: RegExp }> {
  const out: Array<{ key: string; re: RegExp }> = [];
  for (const [key, message] of Object.entries(catalog)) {
    if (SAME.has(key)) continue;
    if (typeof message === 'string') {
      const parts = message.split(/\{\w+\}/);
      // A template with almost no words of its own ('{value}s') would match anything.
      if (parts.length > 1 && (parts.join('').match(/\p{L}/gu) ?? []).length < 3) continue;
      out.push({ key, re: new RegExp(`^${parts.map(escape).join('.+')}$`, 'u') });
    } else {
      const fn = message as (p: Record<string, number>) => string;
      for (let n = 0; n <= 10; n += 1) out.push({ key, re: new RegExp(`^${escape(fn({ count: n, steps: n }))}$`, 'u') });
    }
  }
  return out;
}

// No shown text is a chrome string of another locale (unless the current
// catalog has the same text for it), and the strings the window must show in
// `locale` are there.
async function expectLocale(locale: Locale): Promise<void> {
  const catalog = CATALOGS[locale];
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : locale === 'zh-Hant' ? 'zh-TW' : 'zh-CN');
  await expect(page.getByTestId('locale-switch')).toHaveValue(locale);
  const t = translator(locale);
  await expect(page.getByTestId('status')).toHaveText(catalog['connection.connected']);
  await expect(page.locator('dt').first()).toHaveText(catalog['status.engine']);
  await expect(page.getByTestId('delete-clip')).toHaveText(catalog['timeline.deleteClip']);
  await expect(page.getByTestId('plan-approve')).toHaveText(catalog['plans.approve']);
  await expect(page.getByTestId('fader-trk_a')).toHaveAttribute('aria-label', t('strip.gainLabel', { track: 'trk_a' }));
  await expect(page.getByTestId('mixer')).toHaveAttribute('aria-label', catalog['mixer.label']);
  const names = (id: string) => ({ trk_a: 'trk_a', trk_b: 'trk_b' })[id];
  for (const [index, step] of STEPS.entries()) {
    await expect(page.getByTestId(`step-${index}`)).toHaveText(describeStep(step, t, names));
  }
  // The letters stay M and S, and the dB value is the same bytes.
  await expect(page.getByTestId('mute-trk_a')).toHaveText('M');
  await expect(page.getByTestId('solo-trk_a')).toHaveText('S');
  await expect(page.getByTestId('step-1')).toContainText('-0.60 dB');

  const shown = await shownTexts();
  const others = (Object.keys(CATALOGS) as Locale[]).filter((l) => l !== locale);
  const own = matchers(catalog);
  const foreign: string[] = [];
  for (const other of others) {
    for (const { key, re } of matchers(CATALOGS[other])) {
      for (const text of shown) {
        if (re.test(text) && !own.some((m) => m.re.test(text))) foreign.push(`${other} ${key}: ${text}`);
      }
    }
  }
  expect(foreign).toEqual([]);
  if (locale === 'en') expect(shown.filter((text) => /\p{Script=Han}/u.test(text))).toEqual([]);
}

// An agent's plan, selected: its steps, buttons and diff are on screen.
async function submitAndSelect(): Promise<void> {
  const agent = await agentFor(app!);
  const plan = await agent.tool('submit_plan', { steps: STEPS });
  await page.getByTestId(`plan-${hash8(plan.hash as string)}`).click();
  await expect(page.getByTestId('plan-detail')).toBeVisible();
}

test('the system language decides the first launch, the switch is live, the choice survives a restart', async () => {
  test.setTimeout(150_000);
  await launch(['zh-TW', 'en-US']);
  await submitAndSelect();
  await expectLocale('zh-Hant');

  // A marker on window: a reload or navigation would drop it.
  await page.evaluate(() => {
    (window as unknown as { __noReload: number }).__noReload = 42;
  });
  const url = page.url();
  await page.getByTestId('locale-switch').selectOption('zh-Hans');
  await expectLocale('zh-Hans');
  await page.getByTestId('locale-switch').selectOption('en');
  await expectLocale('en');
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(42);
  expect(page.url()).toBe(url);

  // A restart on the same profile, the system still in zh-TW: the choice holds.
  await app!.close();
  app = undefined;
  await launch(['zh-TW', 'en-US']);
  await submitAndSelect();
  await expectLocale('en');
});
