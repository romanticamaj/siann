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

import { chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { laneHeightOf, laneTops, type ClipRect, type Viewport } from '../../src/renderer/timeline/geometry';
import { trackColourIndex } from '../../src/renderer/timeline/track-colour';
import {
  compareParts,
  crop,
  decodePng,
  diffRegion,
  encodePng,
  failures,
  markdownReport,
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
const OUT = process.env.SIANN_FIDELITY_OUT ? path.resolve(process.env.SIANN_FIDELITY_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'siann-fidelity-'));
const RATE = 48000;
// The mockup draws 40 px per bar at 120 BPM: 20 px per second.
const FRAMES_PER_PIXEL = RATE / 20;
const BAR = 2 * RATE;

test.skip(process.env.SIANN_FIDELITY !== '1', 'set SIANN_FIDELITY=1 to run the mockup fidelity gate');

// ---------------------------------------------------------------- the mockup's session

// The palette entry (tokens.css --track-<n>) of each mockup track's colour.
const TRACKS: ReadonlyArray<{ name: string; palette: number; gain: number; pan?: number; mute?: boolean; kind: string }> = [
  { name: 'Kick', palette: 0, gain: 0, kind: 'kick' },
  { name: 'Snare', palette: 1, gain: -2500, kind: 'snare' },
  { name: 'Bass', palette: 2, gain: -4000, kind: 'bass' },
  { name: 'Keys', palette: 4, gain: -8000, pan: -3500, kind: 'keys' },
  { name: 'Vox Lead', palette: 6, gain: 1500, kind: 'vox' },
  { name: 'Vox BG', palette: 7, gain: -9000, pan: 4000, kind: 'bgv' },
  { name: 'FX', palette: 10, gain: -12000, mute: true, kind: 'fx' },
];
// [track, start bar (1-based), length in bars], in the mockup's order: clip-1 to clip-17.
const CLIPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 4], [0, 5, 4], [0, 9, 4], [0, 13, 4],
  [1, 5, 4], [1, 9, 4], [1, 13, 4],
  [2, 3, 6], [2, 9, 8],
  [3, 1, 8], [3, 9, 8],
  [4, 5, 3.5], [4, 9, 3.75], [4, 13, 3.5],
  [5, 9, 8],
  [6, 6, 2], [6, 9, 1.5],
];
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
  TRACKS.forEach((track, index) => {
    const id = TRACK_IDS[index]!;
    const wav = path.join(scratch, `${track.kind}.wav`);
    writeWav(wav, 55 * (index + 1));
    cli('import', bundle, wav, '--media-id', `med_${track.kind}`);
    exec({ op: 'track.add', trackId: id, name: track.name, channels: 1 });
    if (track.gain !== 0) exec({ op: 'track.set_gain', trackId: id, gainMilliDb: track.gain });
    if (track.pan !== undefined) exec({ op: 'track.set_pan', trackId: id, pan: track.pan });
    if (track.mute) exec({ op: 'track.set_mute', trackId: id, mute: true });
  });
  CLIPS.forEach(([track, bar, bars], index) => {
    exec({
      op: 'clip.place',
      clipId: clipId(index + 1),
      trackId: TRACK_IDS[track]!,
      mediaId: `med_${TRACKS[track]!.kind}`,
      position: { domain: 'audio', value: String((bar - 1) * BAR) },
      sourceStart: '0',
      length: String(Math.round(bars * BAR)),
    });
  });
  return path.dirname(bundle);
}

// The mockup's pending plan, "Lift the chorus": six steps.
function planSteps(): Array<Record<string, unknown>> {
  return [
    { op: 'track.add', trackId: 'trk_pad', name: 'Pad', channels: 2 },
    {
      op: 'clip.place',
      clipId: 'clp_pad_swell',
      trackId: 'trk_pad',
      mediaId: 'med_keys',
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

// The title strip of a clip in the mockup; below it is the waveform.
const CLIP_TITLE = 13;

async function collectApp(page: Page): Promise<Collected> {
  const parts = await page.evaluate(collectDom, MANIFEST.styles);
  const masks: Rect[] = [];
  const display = parts.find((part) => part.id === 'event-display');
  if (!display) return { parts, masks };
  const view = await hook<Viewport>(page, 'view');
  const lanes = await hook<string[]>(page, 'lanes');
  const rects = await hook<ClipRect[]>(page, 'clips');
  const cursorX = await hook<number | null>(page, 'cursorX');
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
  // The ruler's two halves (TimelineCanvas.ts: locators above, cursor below).
  const half = view.rulerHeight / 2;
  parts.push({ id: 'ruler-upper', ...at({ x: 0, y: 0, w: view.width, h: half }) });
  parts.push({ id: 'ruler-lower', ...at({ x: 0, y: half, w: view.width, h: view.rulerHeight - half }) });
  const tops = laneTops(lanes, view);
  lanes.forEach((id, index) => {
    const n = TRACK_IDS.indexOf(id);
    if (n >= 0) parts.push({ id: `lane-${n + 1}`, ...at({ x: 0, y: tops[index]!, w: view.width, h: laneHeightOf(id, view) }) });
  });
  for (const rect of rects) {
    const match = /^clp_(\d\d)$/.exec(rect.clipId);
    const box = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    if (match) parts.push({ id: `clip-${Number(match[1])}`, ...at(box) });
    masks.push(at({ x: box.x, y: box.y + CLIP_TITLE, w: box.w, h: Math.max(0, box.h - CLIP_TITLE) }));
  }
  if (cursorX !== null) parts.push({ id: 'cursor', ...at({ x: cursorX - 0.5, y: half, w: 1, h: (view.height ?? display.h) - half }) });
  return { parts, masks };
}

// ---------------------------------------------------------------- the two windows

async function openMockup(query: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: MANIFEST.viewport.deviceScaleFactor });
  // The mockup loads the app's stylesheets and fonts from the checkout; nothing
  // may leave the machine.
  await context.route(/^https?:\/\//, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${pathToFileURL(path.join(REPO, MANIFEST.mockup)).href}${query}`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => document.fonts.ready);
  return { page, close: () => browser.close() };
}

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

let app: ElectronApplication | undefined;
let scratch = '';

async function openApp(languages: readonly string[], notes: string[]): Promise<Page> {
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
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), VIEW);
  await page.setViewportSize(VIEW);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio])).toEqual([VIEW.width, VIEW.height, 1]);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText(String(TRACKS.length));
  await expect(page.getByTestId('clip-count')).toHaveText(String(CLIPS.length));

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

  // The pending plan, selected so its steps and actions show.
  const ready = await app.evaluate(() => {
    const shell = (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } | null } }).__siannShell;
    return shell.current();
  });
  if (!ready) throw new Error('the shell has no engine');
  const agent = new Agent(ready.port, ready.mcpToken);
  await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mockup-fidelity', version: '1' } });
  const plan = await agent.tool('submit_plan', { steps: planSteps() });
  await page.getByTestId(`plan-${hash8(plan.hash as string)}`).click();
  await expect(page.getByTestId('plan-detail')).toBeVisible();

  // The mockup's selection: Vox Lead, and its clip at bar 9.
  await page.getByTestId(`track-header-${TRACK_IDS[4]!}`).click({ position: { x: 30, y: 30 } });
  const rects = await hook<ClipRect[]>(page, 'clips');
  const target = rects.find((rect) => rect.clipId === clipId(SELECTED_CLIP));
  const canvas = await page.getByTestId('timeline-canvas').boundingBox();
  if (target && canvas) await page.mouse.click(canvas.x + target.x + target.width / 2, canvas.y + target.y + target.height / 2);
  else notes.push(`Clip ${clipId(SELECTED_CLIP)} is not in view: nothing is selected.`);
  // The mockup's project cursor: 10.3.1, which is 19 s at 120 BPM.
  const engine = await engineClient(page, { events: false });
  await engine.call('transport.locate', { frames: String(19 * RATE) });
  await expect.poll(async () => Math.round((await hook<number | null>(page, 'cursorX')) ?? -1)).toBe(Math.round((19 * RATE) / FRAMES_PER_PIXEL));
  // Toasts are transient (the plan's arrival): dismissed, they are not chrome.
  await page.evaluate(() => {
    const toasts = (window as unknown as { __siannToasts?: { getSnapshot(): ReadonlyArray<{ id: number }>; dismiss(id: number): void } }).__siannToasts;
    for (const toast of toasts?.getSnapshot() ?? []) toasts!.dismiss(toast.id);
  });
  await expect(page.getByTestId('toast')).toHaveCount(0);
  // The pointer leaves the window's content, so nothing is drawn hovered.
  await page.mouse.move(VIEW.width - 2, 1);
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
  test(`the app matches the mockup (${locale})`, async () => {
    test.setTimeout(240_000);
    const dir = path.join(OUT, locale);
    fs.mkdirSync(dir, { recursive: true });
    const notes: string[] = [];

    const mockup = await openMockup(setting.query);
    let mockupParts: Collected;
    let mockupShot: Buffer;
    try {
      mockupParts = await collectMockup(mockup.page);
      mockupShot = await mockup.page.screenshot();
    } finally {
      await mockup.close();
    }
    const page = await openApp(setting.languages, notes);
    const appParts = await collectApp(page);
    const appShot = await page.screenshot();
    fs.writeFileSync(path.join(dir, 'mockup.png'), mockupShot);
    fs.writeFileSync(path.join(dir, 'app.png'), appShot);

    // Layer 2: geometry and computed styles.
    const comparison = compareParts(MANIFEST, mockupParts.parts, appParts.parts);
    const mockupIds = new Set(mockupParts.parts.map((part) => part.id));
    const extra = appParts.parts.map((part) => part.id).filter((id) => !mockupIds.has(id));

    // Layer 3: the chrome's pixels, per region. Masked on both sides:
    // waveform interiors, dynamic content, and every skipped part.
    const masks: Rect[] = [...mockupParts.masks, ...appParts.masks];
    for (const part of [...mockupParts.parts, ...appParts.parts]) {
      const mode = ownerOf(MANIFEST, part.id)?.mode;
      if (mode === 'pending' || mode === 'unowned' || matches(MANIFEST.pixels.dynamic, part.id)) masks.push(part);
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

    const entry: LocaleReport = { locale, comparison, regions, extra, notes };
    report.locales.push(entry);
    writeReport();
    console.log(`fidelity [${locale}]: report at ${path.join(OUT, 'report.md')}`);

    const failed = failures({ ...report, locales: [entry] });
    expect(failed, `the mockup fidelity gate failed; see ${path.join(OUT, 'report.md')}`).toEqual([]);
  });
}
