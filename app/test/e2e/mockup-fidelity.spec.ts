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

import { LANES_TOP, type ClipRect, type Viewport } from '../../src/renderer/timeline/geometry';
import { trackColourIndex } from '../../src/renderer/timeline/track-colour';
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
import { launchElectron } from './support/launch';
import { Agent, exeFromEnv, hash8 } from './support/seed';

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const MANIFEST: Manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'test', 'fidelity', 'manifest.json'), 'utf8'));
const VIEW = { width: MANIFEST.viewport.width, height: MANIFEST.viewport.height };
// The mockup-only measurement, and the checkout whose mockup it opens.
const MOCKUP_ONLY = process.env.SIANN_FIDELITY_MOCKUP_ONLY === '1';
const MOCKUP_ROOT = process.env.SIANN_FIDELITY_MOCKUP_ROOT ? path.resolve(process.env.SIANN_FIDELITY_MOCKUP_ROOT) : REPO;
const OUT = process.env.SIANN_FIDELITY_OUT ? path.resolve(process.env.SIANN_FIDELITY_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fidelity-'));
const RATE = 48000;
// The mockup draws 40 px per bar at 120 BPM: 20 px per second.
const FRAMES_PER_PIXEL = RATE / 20;
const BAR = 2 * RATE;

test.skip(process.env.SIANN_FIDELITY !== '1', 'set SIANN_FIDELITY=1 to run the mockup fidelity gate');

// ---------------------------------------------------------------- the mockup's session

// The palette entry (tokens.css --track-<n>) of each mockup track's colour.
// `seed`: what the bundle holds before the earlier applied plan brings the
// track to the mockup's values (UI redesign 10.2: the history's applied plan
// has four steps, and the window draws the mockup's session).
const TRACKS: ReadonlyArray<{ name: string; palette: number; gain: number; pan?: number; mute?: boolean; seed?: { gain?: number; pan?: number } }> = [
  { name: 'Kick', palette: 0, gain: 0, seed: { gain: -1000 } },
  { name: 'Snare', palette: 1, gain: -2500, seed: { gain: -3000 } },
  { name: 'Bass', palette: 2, gain: -4000, seed: { gain: -5000 } },
  { name: 'Keys', palette: 4, gain: -8000, pan: -3500, seed: { pan: -3000 } },
  { name: 'Vox Lead', palette: 6, gain: 1500 },
  { name: 'Vox BG', palette: 7, gain: -9000, pan: 4000 },
  { name: 'FX', palette: 10, gain: -12000, mute: true },
];
// [track, start bar (1-based), length in bars, name], in the mockup's order:
// clip-1 to clip-17. A clip's title is its media's name (UI redesign 10.7), so
// each of the mockup's clip names is one media of that name.
const CLIPS: ReadonlyArray<readonly [number, number, number, string]> = [
  [0, 1, 4, 'Kick 909'], [0, 5, 4, 'Kick 909'], [0, 9, 4, 'Kick 909'], [0, 13, 4, 'Kick 909'],
  [1, 5, 4, 'Snare'], [1, 9, 4, 'Snare'], [1, 13, 4, 'Snare'],
  [2, 3, 6, 'Bass DI'], [2, 9, 8, 'Bass DI · chorus'],
  [3, 1, 8, 'Rhodes · verse'], [3, 9, 8, 'Rhodes · chorus'],
  [4, 5, 3.5, 'Verse 1'], [4, 9, 3.75, 'Chorus A · take 3'], [4, 13, 3.5, 'Chorus B'],
  [5, 9, 8, 'BGV stack'],
  [6, 6, 2, 'Riser'], [6, 9, 1.5, 'Impact'],
];
// The pending plan's ghost clip, the mockup's eighteenth.
const PAD_SWELL = 'Pad swell';
// The media of a clip name.
const mediaId = (name: string): string => `med_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;

// The clip names of mockup.html's own CLIPS table, in its order: what the
// session above has to follow.
function mockupClipNames(): string[] {
  const html = fs.readFileSync(path.join(REPO, 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html'), 'utf8');
  const table = /const CLIPS=\[([\s\S]*?)\r?\n\];/.exec(html);
  if (!table) throw new Error('mockup.html has no CLIPS table');
  return [...table[1]!.matchAll(/\[\d+,'([^']*)',/g)].map((m) => m[1]!);
}
// The mockup's selection: "Chorus A · take 3" on Vox Lead.
const SELECTED_CLIP = 13;
const RISER_CLIP = 16;

// A track id whose stable hash picks `palette` (track-colour.ts), so the app
// colours the track as the mockup does.
function trackId(name: string, palette: number): string {
  const base = `trk_${name.toLowerCase().replace(/[^a-z]/g, '')}`;
  for (let n = 0; n < 10_000; n += 1) {
    const id = `${base}_${n}`;
    if (trackColourIndex(id) === palette) return id;
  }
  throw new Error(`no id for ${name} in palette entry ${palette}`);
}
const TRACK_IDS = TRACKS.map((track) => trackId(track.name, track.palette));
const clipId = (index: number): string => `clp_${String(index).padStart(2, '0')}`;

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

// A mono 16-bit WAV of 16 s (8 bars): a decaying tone per beat. The waveform
// is not compared (the gate masks waveform interiors); the file only has to
// be long enough for the mockup's longest clip.
function writeWav(file: string, pitch: number): void {
  const frames = 16 * RATE;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * pitch * t) * Math.exp(-(t % 0.5) * 6) * 24000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function prepareBundle(scratch: string): string {
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'Night Drive', '--rate', String(RATE));
  const exec = (command: Record<string, unknown>) => cli('exec', bundle, JSON.stringify(command));
  // One media per clip name (and the plan's Pad swell, on Keys' tone), renamed
  // to the mockup's clip name, with the tone of its track.
  const named = new Map<string, number>();
  for (const [track, , , name] of CLIPS) if (!named.has(name)) named.set(name, track);
  named.set(PAD_SWELL, 3);
  for (const [name, track] of named) {
    const wav = path.join(scratch, `${mediaId(name)}.wav`);
    writeWav(wav, 55 * (track + 1));
    cli('import', bundle, wav, '--media-id', mediaId(name));
    exec({ op: 'media.rename', mediaId: mediaId(name), name });
  }
  TRACKS.forEach((track, index) => {
    const id = TRACK_IDS[index]!;
    exec({ op: 'track.add', trackId: id, name: track.name, channels: 1 });
    const gain = track.seed?.gain ?? track.gain;
    const pan = track.seed?.pan ?? track.pan;
    if (gain !== 0) exec({ op: 'track.set_gain', trackId: id, gainMilliDb: gain });
    if (pan !== undefined) exec({ op: 'track.set_pan', trackId: id, pan });
    if (track.mute) exec({ op: 'track.set_mute', trackId: id, mute: true });
  });
  // The mockup's locators (bars 9.1 to 13.1) are set once the app runs: they are
  // the one undoable command of UI redesign 10.7, so undo is lit and redo dim.
  CLIPS.forEach(([track, bar, bars, name], index) => {
    exec({
      op: 'clip.place',
      clipId: clipId(index + 1),
      trackId: TRACK_IDS[track]!,
      mediaId: mediaId(name),
      position: { domain: 'audio', value: String((bar - 1) * BAR) },
      sourceStart: '0',
      length: String(Math.round(bars * BAR)),
    });
  });
  return path.dirname(bundle);
}

// The mockup's three earlier plans (UI redesign 10.2), in submission order:
// one made stale (approved, then the applied plan changes its track), one
// rejected with the mockup's note, one applied whose four steps bring the
// seeded values to the mockup's. The history rows then read Applied,
// Rejected, Stale from the top.
const NOTE = 'Too wide for the verse — keep it mono.';
function staleSteps(): Array<Record<string, unknown>> {
  return [{ op: 'track.set_gain', trackId: TRACK_IDS[0]!, gainMilliDb: -2000 }];
}
function rejectedSteps(): Array<Record<string, unknown>> {
  return [{ op: 'track.set_pan', trackId: TRACK_IDS[4]!, pan: 3000 }];
}
function appliedSteps(): Array<Record<string, unknown>> {
  return TRACKS.flatMap((track, index) => [
    ...(track.seed?.gain !== undefined ? [{ op: 'track.set_gain', trackId: TRACK_IDS[index]!, gainMilliDb: track.gain }] : []),
    ...(track.seed?.pan !== undefined ? [{ op: 'track.set_pan', trackId: TRACK_IDS[index]!, pan: track.pan }] : []),
  ]);
}

// The mockup's pending plan, "Lift the chorus": six steps.
function planSteps(): Array<Record<string, unknown>> {
  return [
    { op: 'track.add', trackId: 'trk_pad', name: 'Pad', channels: 2 },
    {
      op: 'clip.place',
      clipId: 'clp_pad_swell',
      trackId: 'trk_pad',
      mediaId: mediaId(PAD_SWELL),
      position: { domain: 'audio', value: String(8 * BAR) },
      sourceStart: '0',
      length: String(8 * BAR),
    },
    { op: 'track.set_gain', trackId: TRACK_IDS[5]!, gainMilliDb: -6000 },
    { op: 'track.set_pan', trackId: TRACK_IDS[3]!, pan: -2000 },
    { op: 'track.set_mute', trackId: TRACK_IDS[6]!, mute: false },
    { op: 'clip.move', clipId: clipId(RISER_CLIP), position: { domain: 'audio', value: String(6 * BAR) } },
  ];
}

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

async function hook<T>(page: Page, name: string, arg?: string): Promise<T> {
  return page.evaluate(
    ({ name: called, arg: value }) => {
      const hooks = (window as unknown as { __siannTimeline?: Record<string, (a?: string) => unknown> }).__siannTimeline;
      if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return hooks[called]!(value);
    },
    { name, arg },
  ) as Promise<T>;
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

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

let app: ElectronApplication | undefined;
let scratch = '';

// `beforeSetup` runs once the app's window is up and sized, before the spec
// touches it (the gate measures the mockup there, in the same Electron).
async function openApp(languages: readonly string[], notes: string[], beforeSetup?: (electronApp: ElectronApplication) => Promise<void>): Promise<Page> {
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
      SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake']),
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
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText(String(TRACKS.length));
  await expect(page.getByTestId('clip-count')).toHaveText(String(CLIPS.length));
  // The session names each clip's media as the mockup names the clip (UI
  // redesign 10.7), so every clip title of the side-by-side is the mockup's.
  const names = mockupClipNames();
  expect(CLIPS.map((clip) => clip[3])).toEqual(names.slice(0, CLIPS.length));
  expect(names[CLIPS.length]).toBe(PAD_SWELL);
  await expect
    .poll(async () => (await hook<Array<{ clipId: string; title: string }>>(page, 'clips')).map((clip) => `${clip.clipId} ${clip.title}`).sort())
    .toEqual(CLIPS.map((clip, index) => `${clipId(index + 1)} ${clip[3]}`).sort());

  // The mockup's zoom: 20 px per second. The slider moves in quarter octaves,
  // so its step is lifted for this one value (a test-side change of the
  // element, not of the app).
  const slider = page.getByTestId('zoom-slider');
  if ((await slider.count()) > 0) {
    await slider.evaluate((el, fpp) => {
      const input = el as HTMLInputElement;
      input.step = 'any';
      const value = Number(input.max) - Math.log2(fpp);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, FRAMES_PER_PIXEL);
  }
  const view = await hook<Viewport>(page, 'view');
  if (view.framesPerPixel !== FRAMES_PER_PIXEL) notes.push(`The app's zoom is ${view.framesPerPixel} frames per pixel, not the mockup's ${FRAMES_PER_PIXEL}: clip positions differ by that ratio.`);

  // The earlier plans, then the pending plan, which the default selection
  // makes the card (no click: UI redesign 10.10, P1-13 notes).
  const ready = await app.evaluate(() => {
    const shell = (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } | null } }).__siannShell;
    return shell.current();
  });
  if (!ready) throw new Error('the shell has no engine');
  const agent = new Agent(ready.port, ready.mcpToken);
  await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mockup-fidelity', version: '1' } });
  const engine = await engineClient(page, { events: false });
  expect(appliedSteps()).toHaveLength(4);
  const stale = (await agent.tool('submit_plan', { steps: staleSteps() })).hash as string;
  await engine.call('plan.approve', { plan: stale });
  const rejected = (await agent.tool('submit_plan', { steps: rejectedSteps() })).hash as string;
  await engine.call('plan.reject', { plan: rejected, note: NOTE });
  const applied = (await agent.tool('submit_plan', { steps: appliedSteps() })).hash as string;
  await engine.call('plan.approve', { plan: applied });
  await engine.call('plan.apply', { plan: applied });
  await expect.poll(async () => ((await engine.call('plan.status', { plan: stale })).stale as unknown[]).length).toBeGreaterThan(0);
  const plan = await agent.tool('submit_plan', { steps: planSteps() });
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(plan.hash as string));
  await expect(page.locator('[data-part-item="plan-history"]')).toHaveCount(3);
  await expect(page.locator('[data-part-item="plan-history"] .badge')).toHaveText([/./, /./, /./]);
  await expect(page.getByTestId(`plan-state-${hash8(applied)}`)).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId(`plan-state-${hash8(stale)}`)).toHaveAttribute('data-badge', 'stale');
  // The Plans button counts the one validated plan, as the mockup's does.
  await expect(page.getByTestId('plans-count')).toHaveText('1');

  // The mockup's selection: Vox Lead, and its clip at bar 9.
  await page.getByTestId(`track-header-${TRACK_IDS[4]!}`).click({ position: { x: 30, y: 30 } });
  const rects = await hook<ClipRect[]>(page, 'clips');
  const target = rects.find((rect) => rect.clipId === clipId(SELECTED_CLIP));
  const canvas = await page.getByTestId('timeline-canvas').boundingBox();
  if (target && canvas) await page.mouse.click(canvas.x + target.x + target.width / 2, canvas.y + target.y + target.height / 2);
  else notes.push(`Clip ${clipId(SELECTED_CLIP)} is not in view: nothing is selected.`);
  // The info line shows the selected clip, as the mockup's does (m5-ui-port-toolbar).
  if (target) await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', clipId(SELECTED_CLIP));
  // The mockup's toolbar: the Object Selection tool, snap on with the grid
  // Adapt to Zoom (the defaults) and auto-scroll off (the app's default is on).
  if ((await page.getByTestId('auto-scroll').getAttribute('aria-pressed')) === 'true') await page.getByTestId('auto-scroll').click();
  await expect(page.getByTestId('auto-scroll')).toHaveAttribute('aria-pressed', 'false');
  // The mockup's project cursor: 10.3.1, which is 19 s at 120 BPM.
  // The mockup's cycle: on (the locators came with the bundle).
  // One undoable command that draws only what the mockup draws: the locators.
  await engine.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(8 * BAR), right: String(12 * BAR) }] });
  await expect(page.getByTestId('display-locators')).toBeVisible();
  await expect(page.getByTestId('undo')).not.toHaveClass(/\bdim\b/);
  await expect(page.getByTestId('redo')).toHaveClass(/\bdim\b/);
  await engine.call('transport.set_cycle', { enabled: true });
  await expect(page.getByTestId('transport-cycle')).toHaveAttribute('aria-pressed', 'true');
  await engine.call('transport.locate', { frames: String(19 * RATE) });
  await expect.poll(async () => Math.round((await hook<number | null>(page, 'cursorX')) ?? -1)).toBe(Math.round((19 * RATE) / FRAMES_PER_PIXEL));
  // Toasts are transient (the plan's arrival): dismissed, they are not chrome.
  await page.evaluate(() => {
    const toasts = (window as unknown as { __siannToasts?: { getSnapshot(): ReadonlyArray<{ id: number }>; dismiss(id: number): void } }).__siannToasts;
    for (const toast of toasts?.getSnapshot() ?? []) toasts!.dismiss(toast.id);
  });
  await expect(page.getByTestId('toast')).toHaveCount(0);
  // Live values inside enforced boxes, masked in pixels only: the widths of the
  // mockup's "0 xruns" and "r39" need one xrun digit and two revision digits.
  await expect(page.getByTestId('xruns')).toHaveText('0');
  await expect(page.getByTestId('revision')).toHaveText(/^r\d\d$/);
  await expect(page.getByTestId('device')).toHaveText('ASIO · Scarlett 4i4 · 48 kHz / 128 · 5.3 ms');
  // The pointer rests on step 3 of the plan, which the mockup draws hovered
  // (UI redesign 10.2); everywhere else nothing is hovered.
  await page.locator('[data-part-item="plan-step"]').nth(2).hover();
  await expect(page.locator('[data-part-item="plan-step"]').nth(2)).toHaveClass(/\bhot\b/);
  // Every clip in view has its peaks.
  for (const rect of await hook<ClipRect[]>(page, 'clips')) {
    await expect
      .poll(async () => rect.x >= (await hook<Viewport>(page, 'view')).width || (await hook<{ drawn: number }>(page, 'peakColumns', rect.clipId)).drawn > 0)
      .toBe(true);
  }
  await page.evaluate(() => document.fonts.ready);
  await painted(page);
  return page;
}

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  // The engine may still hold the bundle for a moment after the window closes.
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  scratch = '';
});

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
    test.setTimeout(240_000);
    const dir = path.join(OUT, locale);
    fs.mkdirSync(dir, { recursive: true });
    const notes: string[] = [];

    const measured: { parts?: Collected; shot?: Buffer } = {};
    const page = await openApp(setting.languages, notes, async (electronApp) => {
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
      // The Pool open (m5-ui-port-toolbar): Ctrl+P over the project zone. The
      // mockup has no Pool: the app's alone.
      await page.keyboard.press('ControlOrMeta+KeyP');
      await expect(page.getByTestId('media-pool')).toBeVisible();
      await page.mouse.move(VIEW.width - 2, 1);
      await painted(page);
      fs.writeFileSync(path.join(dir, 'project-zone.pool.app.png'), encodePng(crop(decodePng(await page.screenshot()), zone)));
      notes.push(`The Pool open (Ctrl+P) is ${locale}/project-zone.pool.app.png, the app's alone: the mockup has no Pool.`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('media-pool')).toHaveCount(0);
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

    const entry: LocaleReport = { locale, comparison, regions, extra, notes };
    report.locales.push(entry);
    writeReport();
    console.log(`fidelity [${locale}]: report at ${path.join(OUT, 'report.md')}`);

    const failed = failures({ ...report, locales: [entry] });
    expect(failed, `the mockup fidelity gate failed; see ${path.join(OUT, 'report.md')}`).toEqual([]);
  });
}
