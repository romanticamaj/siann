// JetBrains Mono Medium (m5-ui-alignment-chrome; decided by the maintainer,
// 2026-11-15; UI redesign 1.3): the numeric display font ships as Regular
// (400) and Medium (500) from one release, and every rule that asks the
// family for a weight asks for one of those. Regular and Medium have the same
// advance width, so a box cannot tell them apart: this spec reads the face
// Chromium used for a node (CDP CSS.getPlatformFontsForNode), in the app
// (Electron) and in the mockup (Playwright's Chromium, file://, no network):
//
//   - a display value (.lcd .val, weight 500) and the status bar's commit
//     (.mono, 500) draw in JetBrainsMono-Medium;
//   - a node asking for 400 draws in JetBrainsMono-Regular;
//   - no element whose first used family is JetBrains Mono computes a weight
//     other than 400 or 500 (the runtime side of test/ui-tokens.test.js's
//     static check).

import { chromium, expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { launchApp, seedBundle } from './support/seed';

const REPO = path.resolve(__dirname, '..', '..', '..');
const MOCKUP = path.join(REPO, 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html');

let scratch = '';
let app: ElectronApplication | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  scratch = '';
});

interface PlatformFont {
  readonly familyName: string;
  readonly postScriptName?: string;
  readonly isCustomFont: boolean;
  readonly glyphCount: number;
}

// The faces Chromium drew the text of the first node matching `selector` with.
async function facesOf(cdp: CDPSession, selector: string): Promise<PlatformFont[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  expect(nodeId, `${selector} is in the page`).toBeGreaterThan(0);
  const { fonts } = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })) as { fonts: PlatformFont[] };
  return fonts;
}

// The PostScript names of the bundled faces used for the node's digits.
async function monoFaces(cdp: CDPSession, selector: string): Promise<string[]> {
  const fonts = await facesOf(cdp, selector);
  return fonts.filter((font) => font.familyName === 'JetBrains Mono').map((font) => font.postScriptName ?? font.familyName);
}

async function cdpFor(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  return cdp;
}

// A node that asks the family for 400, added for the check.
async function addRegularProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.id = 'font-probe-400';
    probe.style.fontFamily = 'var(--font-num)';
    probe.style.fontWeight = 'var(--fw-regular)';
    probe.textContent = '0123456789';
    document.body.appendChild(probe);
  });
}

// Every element with text whose first used family is JetBrains Mono, with its computed weight.
async function monoWeights(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const own = Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== '');
      if (!own || el.getClientRects().length === 0) continue;
      const style = getComputedStyle(el);
      const first = style.fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
      if (first !== 'JetBrains Mono') continue;
      if (style.fontWeight !== '400' && style.fontWeight !== '500') out.push(`${el.tagName.toLowerCase()}.${el.className} ${style.fontWeight}`);
    }
    return out;
  });
}

test('in the app, weight 500 of JetBrains Mono is the Medium face, 400 the Regular, and no mono text asks for another weight', async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fonts-'));
  const sessionDir = seedBundle(scratch, [{ id: 'trk_kick', name: 'Kick' }]);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'] });
  const page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('position-primary')).not.toHaveText('');
  await expect(page.locator('.statusbar [data-part="status-about"] .mono')).not.toHaveText('');
  await addRegularProbe(page);
  await page.evaluate(() => document.fonts.ready);
  const cdp = await cdpFor(page);
  expect(await monoFaces(cdp, '.lcd .val')).toEqual(['JetBrainsMono-Medium']);
  expect(await monoFaces(cdp, '.statusbar [data-part="status-about"] .mono')).toEqual(['JetBrainsMono-Medium']);
  expect(await monoFaces(cdp, '#font-probe-400')).toEqual(['JetBrainsMono-Regular']);
  for (const font of await facesOf(cdp, '.lcd .val')) if (font.familyName === 'JetBrains Mono') expect(font.isCustomFont).toBe(true);
  expect(await monoWeights(page)).toEqual([]);
});

test('in the mockup, weight 500 of JetBrains Mono is the Medium face, 400 the Regular, and no mono text asks for another weight', async () => {
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.route(/^https?:\/\//, (route) => route.abort());
    const page = await context.newPage();
    for (const query of ['', '?lang=zh-TW']) {
      await page.goto(`${pathToFileURL(MOCKUP).href}${query}`);
      await page.waitForSelector('body[data-ready="1"]');
      await addRegularProbe(page);
      await page.evaluate(() => document.fonts.ready);
      const cdp = await cdpFor(page);
      expect(await monoFaces(cdp, '.lcd .val'), query).toEqual(['JetBrainsMono-Medium']);
      expect(await monoFaces(cdp, '.statusbar .mono'), query).toEqual(['JetBrainsMono-Medium']);
      expect(await monoFaces(cdp, '#font-probe-400'), query).toEqual(['JetBrainsMono-Regular']);
      expect(await monoWeights(page), query).toEqual([]);
      await cdp.detach();
    }
  } finally {
    await browser.close();
  }
});
