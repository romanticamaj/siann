// The mockup fidelity gate, layers 2 and 3 (docs/harness/agent-rules.md, "UI
// fidelity"; UI redesign spec, "Mockup fidelity"). It opens the redesign's
// mockup in Chromium and the app in Electron, both at 1440x900 and device
// scale factor 1, the app on a session that reproduces the mockup's ("Night
// Drive": the same 7 tracks with their colours, levels, pans and mute, 17
// clips on the same bars, the same clip and track selected, and the pending
// 6-step plan), and compares, for every data-region / data-part id of the
// mockup that app/test/fidelity/manifest.json does not skip:
//
//   geometry  the bounding box, within 1 px on x, y, width and height;
//   styles    the computed styles the manifest lists, exactly;
//   pixels    each region, chrome only: waveform interiors, dynamic content
//             (times, meter levels, counts, hashes) and skipped parts are
//             masked; at most 0.5 % of the rest may differ.
//
// It writes report.md, report.json and the mockup, app and diff PNGs of every
// region to <SIANN_FIDELITY_OUT>/<locale>/ (a new temp directory by default),
// and fails on a mismatch whose gate is `enforce` in the manifest (`report`
// gates are measured and reported only). Both locales run: en against
// mockup.html and zh-TW against mockup.html?lang=zh-TW.
//
// It runs only with SIANN_FIDELITY=1 (playwright.config.ts ignores this file
// otherwise), in the "fidelity" project:
//
//   SIANN_FIDELITY=1 SIANN_FIDELITY_OUT=<dir> npx playwright test --project fidelity
//
// The mockup links the app's own stylesheets (app/renderer/tokens.css and
// app/renderer/ui) and so loads the fonts the app bundles: the run needs no
// network and both sides rasterise the same font files. The audio is
// generated into the scratch directory.
//
// A second mode measures the mockup alone, with no engine and no Electron
// (m5-ui-tokens-spacing: a change of the shared stylesheets or of the
// mockup's script that must not move anything the mockup draws):
//
//   SIANN_FIDELITY=1 SIANN_FIDELITY_MOCKUP_ONLY=1 SIANN_FIDELITY_MOCKUP_ROOT=<checkout> \
//     SIANN_FIDELITY_OUT=<dir> npx playwright test --project fidelity
//
// opens <checkout>/<manifest.mockup> (this checkout by default) and writes,
// per locale, <dir>/<locale>/mockup-parts.json (every part's box and listed
// computed styles, the canvas parts and the waveform masks), mockup.png (the
// window) and <region>.mockup.png (each region's crop), measured with this
// branch's manifest. scripts/fidelity-mockup-compare.js runs it on the base
// commit and on the branch and compares the two
// (compareMockupMeasurements in support/fidelity-core.ts).

import { chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LANES_TOP } from '../../src/renderer/timeline/geometry';
import {
  compareParts,
  crop,
  decodePng,
  diffRegion,
  encodePng,
  failures,
  markdownReport,
  maskOf,
  matches,
  ownerOf,
  type GateReport,
  type LocaleReport,
  type Manifest,
  type Part,
  type Rect,
  type RegionReport,
} from './support/fidelity-core';
import { engineClient } from './support/engine-client';
import { hook, painted, prepareBundle, RATE, stageSession, TRACK_IDS } from './support/fidelity-session';
import { launchElectron } from './support/launch';
import { exeFromEnv } from './support/seed';

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const MANIFEST: Manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'test', 'fidelity', 'manifest.json'), 'utf8'));
const VIEW = { width: MANIFEST.viewport.width, height: MANIFEST.viewport.height };
// The mockup-only measurement, and the checkout whose mockup it opens.
const MOCKUP_ONLY = process.env.SIANN_FIDELITY_MOCKUP_ONLY === '1';
const MOCKUP_ROOT = process.env.SIANN_FIDELITY_MOCKUP_ROOT ? path.resolve(process.env.SIANN_FIDELITY_MOCKUP_ROOT) : REPO;
const OUT = process.env.SIANN_FIDELITY_OUT ? path.resolve(process.env.SIANN_FIDELITY_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fidelity-'));

test.skip(process.env.SIANN_FIDELITY !== '1', 'set SIANN_FIDELITY=1 to run the mockup fidelity gate');

// ---------------------------------------------------------------- collecting parts

interface Collected {
  readonly parts: Part[];
  // Waveform interiors, window coordinates.
  readonly masks: Rect[];
}

// Runs in the page: every [data-region], [data-part] and [data-part-item]
// (with its [data-part-of] children) that is laid out, with its box and the
// computed styles asked for. An item is numbered in document order, or named
// by its data-part-key: <item>-<n>, and <item>-<n>-<of> for a child.
function collectDom(properties: readonly string[]): Part[] {
  const out: Part[] = [];
  const add = (id: string, el: Element) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return;
    if ((el as HTMLElement).closest?.('[hidden]')) return;
    const computed = getComputedStyle(el);
    if (computed.visibility === 'hidden' || computed.display === 'none') return;
    const styles: Record<string, string> = {};
    for (const property of properties) styles[property] = computed.getPropertyValue(property);
    out.push({ id, x: box.x, y: box.y, w: box.width, h: box.height, styles });
  };
  for (const el of Array.from(document.querySelectorAll('[data-region]'))) add(el.getAttribute('data-region')!, el);
  for (const el of Array.from(document.querySelectorAll('[data-part]'))) add(el.getAttribute('data-part')!, el);
  const counts = new Map<string, number>();
  for (const item of Array.from(document.querySelectorAll('[data-part-item]'))) {
    const name = item.getAttribute('data-part-item')!;
    let key = item.getAttribute('data-part-key');
    if (!key) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      key = String(counts.get(name));
    }
    const id = `${name}-${key}`;
    add(id, item);
    for (const child of Array.from(item.querySelectorAll('[data-part-of]'))) {
      if (child.closest('[data-part-item]') === item) add(`${id}-${child.getAttribute('data-part-of')}`, child);
    }
  }
  return out;
}

async function collectMockup(page: Page): Promise<Collected> {
  const parts = await page.evaluate(collectDom, MANIFEST.styles);
  const canvas = await page.evaluate(() => {
    const box = document.getElementById('tl')!.getBoundingClientRect();
    const drawn = (window as unknown as { __fidelity: { parts: Part[]; masks: Rect[] } }).__fidelity;
    return { x: box.x, y: box.y, parts: drawn.parts, masks: drawn.masks };
  });
  const display = parts.find((part) => part.id === 'event-display')!;
  // What the canvas draws, clipped to the event display as the window shows it.
  const clip = (rect: Rect): Rect => {
    const x = Math.max(display.x, rect.x + canvas.x);
    const y = Math.max(display.y, rect.y + canvas.y);
    return {
      x,
      y,
      w: Math.max(0, Math.min(display.x + display.w, rect.x + canvas.x + rect.w) - x),
      h: Math.max(0, Math.min(display.y + display.h, rect.y + canvas.y + rect.h) - y),
    };
  };
  for (const part of canvas.parts) parts.push({ id: part.id, ...clip(part) });
  return { parts, masks: canvas.masks.map(clip) };
}

// The surface's parts and waveform masks as its last frames drew them
// (TimelineCanvas.ts, testHooks().parts() and masks(); m5-ui-port-arrange-canvas),
// in the event display's coordinates, as the mockup's draw() records them
// in window.__fidelity: the canvas begins at the event display's corner.
async function collectApp(page: Page): Promise<Collected> {
  const parts = await page.evaluate(collectDom, MANIFEST.styles);
  const masks: Rect[] = [];
  const display = parts.find((part) => part.id === 'event-display');
  if (!display) return { parts, masks };
  const drawn = await hook<Array<{ id: string } & Rect>>(page, 'parts');
  const waves = await hook<Rect[]>(page, 'masks');
  const at = (rect: Rect): Rect => {
    const x = Math.max(display.x, display.x + rect.x);
    const y = Math.max(display.y, display.y + rect.y);
    return {
      x,
      y,
      w: Math.max(0, Math.min(display.x + display.w, display.x + rect.x + rect.w) - x),
      h: Math.max(0, Math.min(display.y + display.h, display.y + rect.y + rect.h) - y),
    };
  };
  // ruler-upper, ruler-lower, lane-N, clip-N (in lane order, as the mockup's
  // CLIPS), locator-band, cursor and cursor-head.
  for (const part of drawn) parts.push({ id: part.id, ...at(part) });
  for (const wave of waves) masks.push(at(wave));
  return { parts, masks };
}

// ---------------------------------------------------------------- the two windows

async function openMockup(root: string, query: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: MANIFEST.viewport.deviceScaleFactor });
  // The mockup loads the app's stylesheets and fonts from the checkout; nothing
  // may leave the machine.
  await context.route(/^https?:\/\//, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${pathToFileURL(path.join(root, MANIFEST.mockup)).href}${query}`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => document.fonts.ready);
  return { page, close: () => browser.close() };
}

// The mockup in a window of the app's own Electron (the gate's comparison):
// the same Chromium, the same font configuration and the same text rendering
// as the app, so a box differs only when the app's markup or styles do. On
// Linux, Playwright's Chromium and Electron's lay text out with different
// glyph advances (hinting and subpixel positioning come from different
// defaults), which moved every text-sized box by a few pixels while the fonts
// were the same bundled files. The window has a session of its own, which
// lets nothing leave the machine and shares no state with the app's.
async function openMockupInApp(electronApp: ElectronApplication, root: string, query: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const url = `${pathToFileURL(path.join(root, MANIFEST.mockup)).href}${query}`;
  const [page] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(({ BrowserWindow, session }, { url, width, height }) => {
      const partition = 'siann-fidelity-mockup';
      session.fromPartition(partition).webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
      const win = new BrowserWindow({
        width,
        height,
        useContentSize: true,
        title: 'SIANN mockup',
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      (globalThis as unknown as { __siannMockupWindow?: number }).__siannMockupWindow = win.id;
      void win.loadURL(url);
    }, { url, ...VIEW }),
  ]);
  await electronApp.evaluate(({ BrowserWindow }, { width, height }) => {
    const id = (globalThis as unknown as { __siannMockupWindow?: number }).__siannMockupWindow!;
    BrowserWindow.fromId(id)!.setContentSize(width, height);
  }, VIEW);
  await page.setViewportSize(VIEW);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio])).toEqual([VIEW.width, VIEW.height, 1]);
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => document.fonts.ready);
  await painted(page);
  return {
    page,
    close: async () => {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const id = (globalThis as unknown as { __siannMockupWindow?: number }).__siannMockupWindow;
        if (id !== undefined) BrowserWindow.fromId(id)?.destroy();
      });
      await page.waitForEvent('close').catch(() => undefined);
    },
  };
}

let app: ElectronApplication | undefined;
let scratch = '';

// `beforeSetup` runs once the app's window is up and sized, before the spec
// touches it (the gate measures the mockup there, in the same Electron).
async function openApp(locale: string, languages: readonly string[], notes: string[], beforeSetup?: (electronApp: ElectronApplication) => Promise<void>): Promise<Page> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fidelity-run-'));
  const sessionDir = prepareBundle(scratch);
  app = await launchElectron({
    args: ['--force-device-scale-factor=1', MAIN],
    languages,
    cwd: APP_DIR,
    viewport: VIEW,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: sessionDir,
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      // The test plugin's directory, for the mockup's insert racks (m5b-ui-inserts-master).
      SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake', ...(process.env.SIANN_TEST_PLUGIN_CLAP ? ['--plugin-dir', path.dirname(process.env.SIANN_TEST_PLUGIN_CLAP)] : [])]),
      // The mockup's device and build in the status bar (UI redesign 10.2).
      SIANN_FIDELITY_ENVIRONMENT: JSON.stringify(MANIFEST.environment),
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), VIEW);
  await page.setViewportSize(VIEW);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio])).toEqual([VIEW.width, VIEW.height, 1]);
  if (beforeSetup) {
    await beforeSetup(app);
    await page.bringToFront();
  }
  await stageSession(app, page, notes, locale);
  return page;
}

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  // The engine may still hold the bundle for a moment after the window closes.
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  scratch = '';
});

// m5b-ui-recording's app-only states (see the call in the gate's test). Vox
// Lead is armed on Mono In 1 with the fake device's input open (stageSession).
async function recordingStates(page: Page, dir: string, locale: string, notes: string[], parts: readonly Part[]): Promise<void> {
  const region = (id: string) => parts.find((part) => part.id === id) ?? null;
  const shootRegion = async (id: string, file: string) => {
    const rect = region(id);
    if (!rect) throw new Error(`the mockup has no region ${id}`);
    await page.mouse.move(VIEW.width - 2, 1);
    await painted(page);
    fs.writeFileSync(path.join(dir, file), encodePng(crop(decodePng(await page.screenshot()), rect)));
  };
  const shootWindow = async (file: string, away = true) => {
    if (away) await page.mouse.move(VIEW.width - 2, 1);
    await painted(page);
    fs.writeFileSync(path.join(dir, file), await page.screenshot());
  };
  const vox = TRACK_IDS[4]!;
  const record = page.getByTestId('transport-record');
  const engine = await engineClient(page, { events: true });
  try {
    await expect(page.getByTestId(`track-record-${vox}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(record).not.toHaveAttribute('aria-disabled', 'true');

    // The record options panel, opened by a right-click on Record.
    await record.click({ button: 'right' });
    await expect(page.getByTestId('record-options')).toBeVisible();
    await shootWindow('record-options.app.png', false);
    notes.push(`The record options panel (a right-click on Record: punch in and out, pre-roll and count-in with their bars) is ${locale}/record-options.app.png, the app's alone: the mockup draws no such panel.`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('record-options')).toHaveCount(0);

    // Record pressed: a red clip grows on Vox Lead from the take's first frame to the playhead.
    await record.click();
    await expect(record).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await hook<Array<{ trackId: string; columns: number }>>(page, 'recordingClips')).filter((c) => c.trackId === vox && c.columns > 4).length, { timeout: 20_000 }).toBe(1);
    await shootWindow('recording.app.png');
    notes.push(`A recording in progress (Record pressed, Vox Lead armed, its red clip growing to the playhead with the live waveform of its input) is ${locale}/recording.app.png, the app's alone: the mockup draws Record released and no recording clip.`);
    await page.getByTestId('transport-stop').click();
    await expect(record).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await hook<unknown[]>(page, 'recordingClips')).length).toBe(0);

    // The lit monitor: Vox Lead selected, its monitor on input (the app-only rule .i-btns > [data-part="inspector-monitor"].on).
    await page.getByTestId(`track-header-${vox}`).click({ position: { x: 30, y: 30 } });
    const monitor = page.locator('[data-part="inspector-monitor"]');
    await monitor.click();
    await expect(monitor).toHaveAttribute('aria-pressed', 'true');
    await shootRegion('left-zone', 'left-zone.monitor-on.app.png');
    notes.push(`The Inspector with Vox Lead's monitor on (input; lit by the app-only rule .i-btns > [data-part="inspector-monitor"].on) is ${locale}/left-zone.monitor-on.app.png, the app's alone: the mockup draws the monitor off. Compare it with ${locale}/left-zone.mockup.png.`);
    await monitor.click();
    await expect(monitor).toHaveAttribute('aria-pressed', 'false');

    // The Notepad open with a draft (m5b-ui-notepad): the mockup draws the section shut only.
    const notepadHead = page.locator('[data-part="inspector-notepad"] > .sec-h');
    await notepadHead.click();
    await expect(notepadHead).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('notepad-text').fill(locale === 'en' ? 'Double the chorus vocal at bar 17.\nBreath before the bridge: keep it.' : '第 17 小節的副歌人聲加倍。\n橋段前的換氣保留。');
    await shootRegion('left-zone', 'left-zone.notepad-open.app.png');
    notes.push(`The Notepad section open with a draft in its text area (app-only rules .notepad-text on existing tokens; UI redesign 3.4) is ${locale}/left-zone.notepad-open.app.png, the app's alone: the mockup draws the section shut. Compare its head with ${locale}/left-zone.mockup.png.`);
    await page.getByTestId('notepad-text').press('Escape');
    await notepadHead.click();
    await expect(notepadHead).toHaveAttribute('aria-expanded', 'false');

    // Record disabled: nothing armed (aria-disabled, the reason in its tooltip).
    await page.getByTestId(`track-record-${vox}`).click();
    await expect(page.getByTestId(`track-record-${vox}`)).toHaveAttribute('aria-pressed', 'false');
    await expect(record).toHaveAttribute('aria-disabled', 'true');
    const reason = (await record.getAttribute('title')) ?? '';
    await shootRegion('top-bar', 'top-bar.record-disabled.app.png');
    notes.push(`Record disabled with nothing armed (aria-disabled, its tooltip "${reason}") is ${locale}/top-bar.record-disabled.app.png, the app's alone: the mockup draws Record enabled. Compare it with ${locale}/top-bar.mockup.png.`);

    // The pending takes dialog: Vox Lead armed again, a recording with a durable second, the engine killed.
    await page.getByTestId(`track-record-${vox}`).click();
    await expect(record).not.toHaveAttribute('aria-disabled', 'true');
    await record.click();
    await expect
      .poll(
        () => {
          const last = engine.ofType('record.changed').at(-1) as { takes?: Array<{ durableFrames: string }> } | undefined;
          return (last?.takes ?? []).filter((t) => Number(t.durableFrames) >= RATE).length;
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    const pid = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
    if (pid === null) throw new Error('the shell has no engine');
    engine.close();
    process.kill(pid);
    await expect(page.getByTestId('status')).not.toHaveAttribute('data-status', 'connected');
    await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
    const dialog = page.getByTestId('pending-takes');
    await expect(dialog).toBeVisible();
    await shootWindow('pending-takes.app.png');
    notes.push(`The pending takes dialog (the engine killed while Vox Lead recorded; the restarted engine lists the take with Keep and Discard) is ${locale}/pending-takes.app.png, the app's alone: the mockup has no such dialog.`);
    await page.getByTestId('pending-takes-later').click();
    await expect(dialog).toBeHidden();
  } finally {
    engine.close();
  }
}

// m5b-ui-sends-buses' app-only states (UI redesign 3.4; 10.11, 24): the
// mockup draws the rack row with Inserts lit, no bus strip, no send and the
// Sends section shut. Two buses (Verb, Delay) and a post-fader send from Vox
// Lead to Verb are made through the protocol and taken back with
// session.undo at the end, so the later states see the session as before.
async function sendsBusesStates(page: Page, dir: string, locale: string, notes: string[], parts: readonly Part[]): Promise<void> {
  const region = (id: string) => {
    const rect = parts.find((part) => part.id === id);
    if (!rect) throw new Error(`the mockup has no region ${id}`);
    return rect;
  };
  const shootRegion = async (id: string, file: string, away = true) => {
    if (away) await page.mouse.move(VIEW.width - 2, 1);
    await painted(page);
    fs.writeFileSync(path.join(dir, file), encodePng(crop(decodePng(await page.screenshot()), region(id))));
  };
  const shootWindow = async (file: string) => {
    await page.mouse.move(VIEW.width - 2, 1);
    await painted(page);
    fs.writeFileSync(path.join(dir, file), await page.screenshot());
  };
  const vox = TRACK_IDS[4]!;
  const racks = page.locator('[data-part="mixer-racks"]');
  const engine = await engineClient(page);
  try {
    const before = (await engine.call('session.inspect')).revisions as number;
    await engine.call('command.execute', {
      commands: [
        { op: 'bus.add', busId: 'bus_fid_verb', name: 'Verb' },
        { op: 'bus.add', busId: 'bus_fid_delay', name: 'Delay' },
        { op: 'send.add', sendId: 'snd_fid_verb', trackId: vox, busId: 'bus_fid_verb', levelMilliDb: -6000, pre: false },
        { op: 'send.add', sendId: 'snd_fid_delay', trackId: vox, busId: 'bus_fid_delay', levelMilliDb: -12000, pre: true },
        { op: 'bus.set_output', busId: 'bus_fid_verb', output: { busId: 'bus_fid_delay' } },
      ],
    });
    await expect(page.getByTestId('mixer-strip-bus-bus_fid_delay')).toBeVisible();

    // The Inspector with Vox Lead's Sends section open, a send per slot, and the Routing section's Out row.
    await page.getByTestId(`track-header-${vox}`).click({ position: { x: 30, y: 30 } });
    await expect(page.locator('[data-part="inspector-sends"]').getByTestId('islot-send-snd_fid_verb')).toBeVisible();
    await shootRegion('left-zone', 'left-zone.sends.app.png');
    notes.push(`The Inspector's Sends section open with Vox Lead's two sends (Verb post-fader, Delay pre-fader) and "+ Add send", under the Routing section's In and Out rows, is ${locale}/left-zone.sends.app.png, the app's alone. The mockup draws the Sends section shut (sec('Sends','','0')); the app draws it open with its body whenever the engine lists features.sends and send.add, so left-zone.app.png has it open, with no send, where left-zone.mockup.png has it shut, and the geometry row of inspector-sends shows the difference (UI redesign 3.4; 10.11, 24). Compare it with ${locale}/left-zone.mockup.png.`);

    // The Sends rack: the strips' send slots, at rest and with Vox Lead's Verb slot hovered (on and Remove beside the level).
    await racks.getByTestId('rack-sends').click();
    await expect(page.getByTestId('send-snd_fid_verb')).toBeVisible();
    await shootRegion('lower-zone', 'lower-zone.sends.app.png');
    notes.push(`The Sends rack lit (Vox Lead's send slots: Verb at -6 dB post-fader, Delay at -12 dB pre-fader in italics; the other tracks' two empty slots; the bus strips' empty Sends box) with the bus strips Verb and Delay after the tracks is ${locale}/lower-zone.sends.app.png, the app's alone: the mockup draws Inserts lit and no bus strip. Compare it with ${locale}/lower-zone.mockup.png.`);
    await page.getByTestId('send-snd_fid_verb').hover();
    await shootRegion('lower-zone', 'lower-zone.sends-hover.app.png', false);
    notes.push(`Vox Lead's Verb send slot hovered (on and Remove beside the level, which keeps its room; PRE / POST shows in a strip's slot only with the keyboard focus) is ${locale}/lower-zone.sends-hover.app.png, the app's alone.`);

    // The bus picker of an empty send slot.
    await page.getByTestId(`mixer-strip-${TRACK_IDS[0]!}`).locator('.ins .slot.empty').first().click();
    await expect(page.getByTestId('bus-picker')).toBeVisible();
    await shootWindow('bus-picker.app.png');
    notes.push(`The bus picker of an empty send slot (the buses in busOrder) is ${locale}/bus-picker.app.png, the app's alone: the mockup has no such list.`);
    await page.getByTestId('bus-picker').getByTestId('picker-close').click();
    await expect(page.getByTestId('bus-picker')).toBeHidden();

    // The Routing rack: every strip's output selector (Verb routed to Delay); a selected bus strip.
    await racks.getByTestId('rack-routing').click();
    await expect(page.getByTestId('output-bus_fid_delay')).toBeVisible();
    await page.getByTestId('mixer-strip-bus-bus_fid_delay').locator('.scale').click();
    await expect(page.getByTestId('mixer-strip-bus-bus_fid_delay')).toHaveAttribute('aria-selected', 'true');
    await shootRegion('lower-zone', 'lower-zone.routing.app.png');
    notes.push(`The Routing rack lit (each strip's output selector: the tracks to the master, Verb to Delay, Delay to the master) with the bus strip Delay selected (.sel) is ${locale}/lower-zone.routing.app.png, the app's alone: the mockup draws Inserts lit and no bus strip.`);

    // Delay to Verb closes a loop: the engine refuses it (routing_cycle), shown at Delay's selector.
    await page.getByTestId('output-bus_fid_delay').selectOption('bus_fid_verb');
    await expect(page.getByTestId('output-refusal-bus_fid_delay')).toBeVisible();
    await shootRegion('lower-zone', 'lower-zone.routing-refusal.app.png');
    notes.push(`Delay routed to Verb, which routes to Delay: the engine's routing_cycle refusal line at Delay's output selector, which keeps the master, is ${locale}/lower-zone.routing-refusal.app.png, the app's alone.`);

    // Remove Bus on the selected Delay, which has a send and a bus routed to it: the confirmation names them.
    await page.getByTestId('mixer-strip-bus-bus_fid_delay').locator('.scale').click();
    await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('mixer.bus.remove')!.click());
    const confirm = page.locator('dialog[open][data-testid="confirm-dialog"]');
    await expect(confirm).toBeVisible();
    await shootWindow('bus-remove-confirm.app.png');
    notes.push(`The confirmation of Remove Bus on Delay (Vox Lead's send goes, Verb is rerouted to the master) is ${locale}/bus-remove-confirm.app.png, the app's alone: the mockup has no such dialog.`);
    await confirm.getByTestId('confirm-cancel').click();
    await expect(confirm).toHaveCount(0);

    // Back as before: Inserts lit, the bus selection cleared, the five commands taken back.
    await racks.getByTestId('rack-inserts').click();
    await page.keyboard.press('Escape');
    // One command.execute was one revision; the refused routing made none.
    expect((await engine.call('session.inspect')).revisions).toBe(before + 1);
    await engine.call('session.undo');
    await expect(page.locator('[data-testid^="mixer-strip-bus-"]')).toHaveCount(0);
  } finally {
    engine.close();
  }
}

// ---------------------------------------------------------------- the gate

function commit(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

const report: GateReport = { generated: new Date().toISOString(), commit: commit(), platform: `${process.platform} ${os.release()}`, locales: [] };

function writeReport(): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'report.md'), markdownReport(report, MANIFEST, 80));
}

for (const [locale, setting] of Object.entries(MANIFEST.locales)) {
  test(`the mockup's measurement (${locale})`, async () => {
    test.skip(!MOCKUP_ONLY, 'set SIANN_FIDELITY_MOCKUP_ONLY=1 to measure the mockup alone');
    const dir = path.join(OUT, locale);
    fs.mkdirSync(dir, { recursive: true });
    const mockup = await openMockup(MOCKUP_ROOT, setting.query);
    try {
      const measured = await collectMockup(mockup.page);
      const shot = await mockup.page.screenshot();
      fs.writeFileSync(path.join(dir, 'mockup-parts.json'), `${JSON.stringify({ root: MOCKUP_ROOT, locale, parts: measured.parts, masks: measured.masks }, null, 1)}\n`);
      fs.writeFileSync(path.join(dir, 'mockup.png'), shot);
      const image = decodePng(shot);
      for (const region of MANIFEST.regions) {
        const rect = measured.parts.find((part) => part.id === region);
        if (!rect) throw new Error(`the mockup has no region ${region}`);
        fs.writeFileSync(path.join(dir, `${region}.mockup.png`), encodePng(crop(image, rect)));
      }
      console.log(`fidelity [${locale}]: the mockup measured in ${dir}`);
    } finally {
      await mockup.close();
    }
  });

  test(`the app matches the mockup (${locale})`, async () => {
    test.skip(MOCKUP_ONLY, 'SIANN_FIDELITY_MOCKUP_ONLY=1 measures the mockup alone');
    test.setTimeout(360_000);
    const dir = path.join(OUT, locale);
    fs.mkdirSync(dir, { recursive: true });
    const notes: string[] = [];

    const measured: { parts?: Collected; shot?: Buffer } = {};
    const page = await openApp(locale, setting.languages, notes, async (electronApp) => {
      const mockup = await openMockupInApp(electronApp, REPO, setting.query);
      try {
        measured.parts = await collectMockup(mockup.page);
        measured.shot = await mockup.page.screenshot();
      } finally {
        await mockup.close();
      }
    });
    const mockupParts = measured.parts;
    const mockupShot = measured.shot;
    if (!mockupParts || !mockupShot) throw new Error('the mockup was not measured');
    // m5b-ui-plan-metadata's parts are in the window (the agent row, the plan's title and intent), and m5b-ui-composer's box.
    for (const id of ['agent-row', 'plan-title', 'plan-intent', 'composer']) await expect(page.locator(`[data-part="${id}"]`), id).toHaveCount(1);
    // m5b-ui-recording's parts are in the window: Record, the Inspector's record enable and monitor, and each header's and strip's record enable.
    for (const id of ['transport-record', 'inspector-record', 'inspector-monitor']) await expect(page.locator(`[data-part="${id}"]`), id).toHaveCount(1);
    await expect(page.locator('[data-part-item="track"] [data-part-of="record"]').first()).toBeVisible();
    await expect(page.locator('[data-part-item="strip"] [data-part-of="record"]').first()).toBeVisible();
    const appParts = await collectApp(page);
    const appShot = await page.screenshot();
    fs.writeFileSync(path.join(dir, 'mockup.png'), mockupShot);
    fs.writeFileSync(path.join(dir, 'app.png'), appShot);

    // Layer 2: geometry and computed styles.
    const comparison = compareParts(MANIFEST, mockupParts.parts, appParts.parts);
    const mockupIds = new Set(mockupParts.parts.map((part) => part.id));
    const extra = appParts.parts.map((part) => part.id).filter((id) => !mockupIds.has(id));

    // Layer 3: the chrome's pixels, per region. Masked on both sides:
    // waveform interiors, dynamic content, and every skipped part, each with
    // the shadow it casts beside its box (maskOf).
    const masks: Rect[] = [...mockupParts.masks, ...appParts.masks];
    for (const part of [...mockupParts.parts, ...appParts.parts]) {
      const mode = ownerOf(MANIFEST, part.id)?.mode;
      if (mode === 'pending' || mode === 'unowned' || matches(MANIFEST.pixels.dynamic, part.id)) masks.push(maskOf(part));
    }
    const mockupImage = decodePng(mockupShot);
    const appImage = decodePng(appShot);
    const regions: RegionReport[] = [];
    for (const region of MANIFEST.regions) {
      const rect = mockupParts.parts.find((part) => part.id === region);
      if (!rect) throw new Error(`the mockup has no region ${region}`);
      const owner = ownerOf(MANIFEST, region);
      if (!owner) throw new Error(`no manifest rule owns region ${region}`);
      const result = diffRegion(region, mockupImage, appImage, rect, masks, MANIFEST.pixels.channelTolerance);
      const files = { mockup: `${locale}/${region}.mockup.png`, app: `${locale}/${region}.app.png`, diff: `${locale}/${region}.diff.png` };
      fs.writeFileSync(path.join(OUT, files.mockup), encodePng(crop(mockupImage, rect)));
      fs.writeFileSync(path.join(OUT, files.app), encodePng(crop(appImage, rect)));
      fs.writeFileSync(path.join(OUT, files.diff), encodePng(result.diff));
      regions.push({
        region,
        feature: owner.feature,
        gate: owner.gate,
        mode: owner.mode,
        compared: result.compared,
        masked: result.masked,
        mismatched: result.mismatched,
        ratio: result.ratio,
        over: result.ratio > MANIFEST.pixels.maxMismatch,
        files,
      });
    }

    // m5b-ui-edit-more's states the mockup does not show, the app's alone,
    // with the mockup's clip still selected and nothing committed: the
    // repeat dialog (Ctrl+K, over the whole window), the snap type menu open
    // from the snap field's chevron and the info line's Start open as a text
    // field (each over the project zone). Each is cancelled with Escape.
    const projectZone = mockupParts.parts.find((part) => part.id === 'project-zone');
    if (projectZone && (await page.getByTestId('info-line').getAttribute('data-clip')) !== '') {
      await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
      await page.keyboard.press('ControlOrMeta+KeyK');
      await expect(page.getByTestId('repeat-dialog')).toBeVisible();
      await expect(page.getByTestId('repeat-count')).toBeFocused();
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      fs.writeFileSync(path.join(dir, 'repeat-dialog.app.png'), await page.screenshot());
      notes.push(`The repeat dialog (Ctrl+K on the selected clip) is ${locale}/repeat-dialog.app.png, the app's alone: the mockup has no such dialog.`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('repeat-dialog')).toBeHidden();

      await page.getByTestId('snap-toggle').locator('svg').last().click();
      await expect(page.getByTestId('snap-type-menu')).toBeVisible();
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      fs.writeFileSync(path.join(dir, 'project-zone.snap-type-menu.app.png'), encodePng(crop(decodePng(await page.screenshot()), projectZone)));
      notes.push(`The snap type menu open is ${locale}/project-zone.snap-type-menu.app.png, the app's alone: the mockup has no such menu.`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('snap-type-menu')).toHaveCount(0);

      await page.getByTestId('info-start').click();
      await expect(page.getByTestId('info-start-input')).toBeFocused();
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      fs.writeFileSync(path.join(dir, 'project-zone.info-edit.app.png'), encodePng(crop(decodePng(await page.screenshot()), projectZone)));
      notes.push(`The info line with its Start value open as a text field is ${locale}/project-zone.info-edit.app.png, the app's alone: the mockup's info line only shows its values.`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('info-start-input')).toHaveCount(0);
    }

    // The resting state (m5-ui-port-arrange-canvas): no clip selected. The
    // mockup draws its clip selected, so this is the app's project zone alone,
    // beside the selected-clip pair above. An empty spot of lane 3 (Bass,
    // bars 1 and 2) takes the selection away.
    const zone = mockupParts.parts.find((part) => part.id === 'project-zone');
    const display = appParts.parts.find((part) => part.id === 'event-display');
    if (zone && display) {
      await page.mouse.click(display.x + 20, display.y + LANES_TOP + 2 * 53 + 25);
      await expect.poll(() => hook<string[]>(page, 'selectedClips')).toEqual([]);
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      fs.writeFileSync(path.join(dir, 'project-zone.resting.app.png'), encodePng(crop(decodePng(await page.screenshot()), zone)));
      notes.push(`The resting state (no clip selected) is ${locale}/project-zone.resting.app.png, the app's alone: the mockup shows a selected clip.`);
      // The Media tab open (m5b-ui-media): Ctrl+P on the right zone. The
      // mockup draws the tab but not its content: the app's alone.
      const right = mockupParts.parts.find((part) => part.id === 'right-zone');
      await page.keyboard.press('ControlOrMeta+KeyP');
      await expect(page.getByTestId('media-tab')).toBeVisible();
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      if (right) fs.writeFileSync(path.join(dir, 'right-zone.media.app.png'), encodePng(crop(decodePng(await page.screenshot()), right)));
      notes.push(`The Media tab open (Ctrl+P) is ${locale}/right-zone.media.app.png, the app's alone: the mockup does not draw the tab's content.`);
      await page.getByTestId('tab-right-plans').click();
      await expect(page.getByTestId('media-tab')).toBeHidden();
    }

    // A strip with its fader held (m5-ui-port-mixer-strip, acceptance 9):
    // Bass's cap pressed and moved up, the screenshot taken before the
    // release, so the cap, the readout and the tooltip show the gesture's
    // value and nothing is committed. The muted strip is the mockup's FX, in
    // both images above. The mockup draws no held fader: the app's alone.
    const lowerZone = mockupParts.parts.find((part) => part.id === 'lower-zone');
    if (lowerZone) {
      const fader = page.getByTestId(`fader-${TRACK_IDS[2]!}`);
      const capBox = await fader.locator('.cap').boundingBox();
      if (!capBox) throw new Error('the Bass fader has no cap');
      const grab = { x: capBox.x + capBox.width / 2, y: capBox.y + capBox.height / 2 };
      const before = (await fader.getAttribute('aria-valuetext')) ?? '';
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      for (const dy of [-6, -12, -18]) await page.mouse.move(grab.x, grab.y + dy, { steps: 3 });
      await expect(fader).not.toHaveAttribute('aria-valuetext', before);
      await expect(page.getByTestId(`fader-${TRACK_IDS[2]!}-tooltip`)).toBeVisible();
      await painted(page);
      const heldValue = (await fader.getAttribute('aria-valuetext')) ?? '';
      fs.writeFileSync(path.join(dir, 'lower-zone.fader-held.app.png'), encodePng(crop(decodePng(await page.screenshot()), lowerZone)));
      notes.push(`The held-fader state (Bass held at ${heldValue} from ${before}, before the release; FX muted) is ${locale}/lower-zone.fader-held.app.png, the app's alone: the mockup draws no held fader. Compare it with ${locale}/lower-zone.mockup.png.`);
      await page.mouse.up();
    }

    // The left zone with no track selected (m5-ui-port-inspector, acceptance
    // 7): Ctrl-click on Vox Lead's header takes it out of the track selection,
    // and the Inspector shows its head and foot only. The mockup always shows
    // a selected track: the app's alone.
    const leftZone = mockupParts.parts.find((part) => part.id === 'left-zone');
    if (leftZone) {
      await page.getByTestId(`track-header-${TRACK_IDS[4]!}`).click({ modifiers: ['ControlOrMeta'], position: { x: 4, y: 4 } });
      await expect(page.locator('[data-part="inspector-track"]')).toHaveCount(0);
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      fs.writeFileSync(path.join(dir, 'left-zone.empty.app.png'), encodePng(crop(decodePng(await page.screenshot()), leftZone)));
      notes.push(`The left zone with no track selected is ${locale}/left-zone.empty.app.png, the app's alone: the mockup always shows a selected track.`);
    }

    // m5b-ui-sends-buses' states the mockup does not draw, the app's alone:
    // the Sends section open with sends, the Sends rack at rest and hovered,
    // the bus picker, the Routing rack with a selected bus strip, the
    // routing_cycle refusal and the removal confirmation (taken back after).
    await sendsBusesStates(page, dir, locale, notes, mockupParts.parts);

    // m5b-ui-recording's states the mockup does not draw, the app's alone,
    // after every measurement (they commit a take and restart the engine):
    // the record options panel (a right-click on Record), Record pressed with
    // the red clip growing on Vox Lead, the lit monitor, Record disabled with
    // nothing armed, and the pending takes dialog after the engine is killed
    // while recording (the restarted engine lists the take).
    await recordingStates(page, dir, locale, notes, mockupParts.parts);

    const entry: LocaleReport = { locale, comparison, regions, extra, notes };
    report.locales.push(entry);
    writeReport();
    console.log(`fidelity [${locale}]: report at ${path.join(OUT, 'report.md')}`);

    const failed = failures({ ...report, locales: [entry] });
    expect(failed, `the mockup fidelity gate failed; see ${path.join(OUT, 'report.md')}`).toEqual([]);
  });
}
