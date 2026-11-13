// A screenshot tour of the shell for UX review (not a correctness test): the
// real siann-engine (SIANN_ENGINE_EXE) on the fake device, a bundle prepared
// with siann-cli (SIANN_CLI_EXE) like timeline.spec.ts, an MCP agent submitting
// plans like plan-review.spec.ts, and a full-window PNG of each state the
// window shows, written to <SIANN_UX_OUT>/<locale>/ (SIANN_UX_OUT defaults to
// a new temp directory) as NN-description.png with an index.json of {file,
// state, notes}. SIANN_UX_LOCALE=en|zh-Hant|zh-Hans (default en) picks the
// locale: the launches report the system language that detects it (en-US,
// zh-TW, zh-CN) on a fresh profile. File names keep the English slugs, so the
// numbers line up across locales; waits use test ids and data attributes, not
// text, so the tour runs in every locale.
//
// It runs only with SIANN_UX_TOUR=1 (playwright.config.ts ignores this file
// otherwise, so the normal e2e run and CI never see it):
//
//   SIANN_UX_TOUR=1 SIANN_UX_OUT=<dir> [SIANN_UX_LOCALE=zh-Hant] npx playwright test ux-tour
//
// The audio is generated into the scratch directory (synthetic drums, bass,
// keys, voices and a riser) and removed with it; nothing is written into the
// repository. The tour drives the UI as a user does wherever the UI offers the
// action, and leaves a note where it does not (zoom, plugins).

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Locale } from '../../src/renderer/i18n/locale';
import { formatMilliDb } from '../../src/renderer/format';
import { translator } from '../../src/renderer/i18n/t';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchElectron } from './support/launch';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const RATE = 48000;
const WIDE = { width: 1440, height: 900 };
const SMALL = { width: 1024, height: 700 };
// The restart delay after the tour kills the engine: long enough to photograph
// the disconnected window before the shell starts a new engine.
const RESTART_MS = 12_000;

test.skip(process.env.SIANN_UX_TOUR !== '1', 'set SIANN_UX_TOUR=1 to run the UX screenshot tour');

function exeFromEnv(name: string): string {
  const exe = process.env[name];
  if (!exe) throw new Error(`set ${name} to the built executable`);
  if (!fs.existsSync(exe)) throw new Error(`${name} points at a missing file: ${exe}`);
  return exe;
}

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

// siann-cli exec: one command on the bundle (no shell involved).
function cliExec(bundle: string, command: Record<string, unknown>): void {
  cli('exec', bundle, JSON.stringify(command));
}

// ---------------------------------------------------------------- audio

// A deterministic PRNG, so every run draws the same waveforms.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// A mono 16-bit PCM WAV of `seconds`, each sample from `sample(t)` in [-1, 1].
function writeWav(file: string, seconds: number, sample: (t: number, i: number) => number): number {
  const frames = Math.round(seconds * RATE);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.max(-1, Math.min(1, sample(i / RATE, i)));
    data.writeInt16LE(Math.round(value * 32000), i * 2);
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
  return frames;
}

const TAU = Math.PI * 2;
const BEAT = 0.5; // 120 bpm

// Synthetic stems: enough shape that each waveform reads as its instrument.
const STEMS: Record<string, { seconds: number; sample: (t: number) => number }> = (() => {
  const noise = prng(7);
  const vox = prng(11);
  const bg = prng(13);
  const syllables = (rand: () => number, count: number, length: number) => {
    const out: Array<[number, number, number]> = [];
    let t = 0.05;
    for (let i = 0; i < count && t < length; i += 1) {
      const d = 0.12 + rand() * 0.3;
      out.push([t, d, 0.4 + rand() * 0.6]);
      t += d + (rand() < 0.25 ? 0.25 : 0.04);
    }
    return out;
  };
  const leadSyllables = syllables(vox, 40, 3);
  const bgSyllables = syllables(bg, 20, 3);
  const voice = (t: number, list: Array<[number, number, number]>, pitch: number) => {
    let env = 0;
    for (const [start, d, level] of list) {
      if (t >= start && t < start + d) env = level * Math.sin((Math.PI * (t - start)) / d);
    }
    const tone = Math.sin(TAU * pitch * t) * 0.6 + Math.sin(TAU * pitch * 2 * t) * 0.25 + Math.sin(TAU * pitch * 3 * t) * 0.1;
    return env * tone;
  };
  return {
    kick: {
      seconds: 4,
      sample: (t) => {
        const local = t % BEAT;
        const f = 50 + 90 * Math.exp(-local * 30);
        return Math.exp(-local * 9) * Math.sin(TAU * f * local) * 0.95;
      },
    },
    snare: {
      seconds: 4,
      sample: (t) => {
        const bar = t % (BEAT * 2);
        if (bar < BEAT) return (noise() * 2 - 1) * 0.04 * Math.exp(-bar * 40);
        const local = bar - BEAT;
        return ((noise() * 2 - 1) * 0.7 + Math.sin(TAU * 190 * local) * 0.3) * Math.exp(-local * 14);
      },
    },
    bass: {
      seconds: 4,
      sample: (t) => {
        const notes = [55, 55, 73.4, 65.4, 55, 82.4, 73.4, 61.7];
        const step = Math.floor(t / BEAT) % notes.length;
        const local = t % BEAT;
        const env = Math.min(1, local / 0.01) * Math.exp(-local * 2.5);
        return Math.tanh(Math.sin(TAU * notes[step]! * t) * 2) * env * 0.7;
      },
    },
    keys: {
      seconds: 4,
      sample: (t) => {
        const chords = [
          [261.6, 329.6, 392],
          [220, 261.6, 329.6],
        ];
        const chord = chords[Math.floor(t / 2) % 2]!;
        const local = t % 2;
        const env = Math.min(1, local / 0.3) * Math.min(1, (2 - local) / 0.4) * (0.75 + 0.25 * Math.sin(TAU * 3 * t));
        return (chord.reduce((sum, f) => sum + Math.sin(TAU * f * t), 0) / chord.length) * env * 0.6;
      },
    },
    voxLead: { seconds: 3, sample: (t) => voice(t, leadSyllables, 220) * 0.9 },
    voxBg: { seconds: 3, sample: (t) => voice(t, bgSyllables, 330) * 0.5 },
    fx: {
      seconds: 2,
      sample: (t) => (noise() * 2 - 1) * Math.pow(t / 2, 2) * 0.9 * (0.6 + 0.4 * Math.sin(TAU * (2 + t * 6) * t)),
    },
  };
})();

// The tracks in order, each with its media, mixer settings and clips
// ([start, sourceStart, length] in seconds).
const TRACKS: ReadonlyArray<{
  id: string;
  name: string;
  media: keyof typeof STEMS;
  gain: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  clips: ReadonlyArray<[number, number, number]>;
}> = [
  { id: 'trk_kick', name: 'Kick', media: 'kick', gain: 0, clips: [[0, 0, 2], [2, 0, 2]] },
  { id: 'trk_snare', name: 'Snare', media: 'snare', gain: -2500, clips: [[0, 0, 3]] },
  { id: 'trk_bass', name: 'Bass', media: 'bass', gain: -4000, clips: [[0, 0, 1.5], [1.5, 2, 1.5]] },
  { id: 'trk_keys', name: 'Keys', media: 'keys', gain: -8000, pan: -3500, clips: [[0.25, 0, 2.5]] },
  { id: 'trk_voxlead', name: 'Vox Lead', media: 'voxLead', gain: 1500, solo: true, clips: [[0.5, 0, 1.1], [1.8, 1.2, 1]] },
  { id: 'trk_voxbg', name: 'Vox BG', media: 'voxBg', gain: -9000, pan: 4000, clips: [[1, 0.2, 1.6]] },
  { id: 'trk_fx', name: 'FX', media: 'fx', gain: -12000, mute: true, clips: [[2, 0, 2]] },
];

// ---------------------------------------------------------------- shots

interface Shot {
  // null for a state the window has no surface for (noted, not captured).
  readonly file: string | null;
  readonly state: string;
  readonly notes: string;
}

// The locale of the run and the system languages that select it.
const UX_LOCALES: Record<string, readonly string[]> = { en: ['en-US'], 'zh-Hant': ['zh-TW'], 'zh-Hans': ['zh-CN'] };
const LOCALE = process.env.SIANN_UX_LOCALE || 'en';
const LANGUAGES = UX_LOCALES[LOCALE];
if (!LANGUAGES) throw new Error(`SIANN_UX_LOCALE must be one of ${Object.keys(UX_LOCALES).join(', ')}, not ${LOCALE}`);
const OUT = path.join(
  process.env.SIANN_UX_OUT ? path.resolve(process.env.SIANN_UX_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'siann-ux-')),
  LOCALE,
);
const shots: Shot[] = [];

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Two animation frames: whatever changed has been drawn.
async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function shoot(page: Page, state: string, notes: string, options: { fullPage?: boolean } = {}): Promise<void> {
  await painted(page);
  const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  const file = `${String(shots.filter((s) => s.file !== null).length + 1).padStart(2, '0')}-${slug(state)}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: options.fullPage === true });
  shots.push({ file, state, notes: `${notes} [viewport ${size}${options.fullPage ? ', full page' : ''}]` });
  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(shots, null, 2)}\n`);
}

// ---------------------------------------------------------------- app

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;

async function launch(sessionDir: string, extraEnv: Record<string, string> = {}): Promise<void> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  app = await launchElectron({
    args: [MAIN],
    languages: LANGUAGES,
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: sessionDir,
      SIANN_USER_DATA: path.join(scratch, `user-data-${path.basename(sessionDir)}`),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake']),
      ...extraEnv,
    },
  });
  page = await app.firstWindow();
}

// The window's content area at `size` (what a screenshot captures).
async function resize(size: { width: number; height: number }): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(width, height);
    win.center();
  }, size);
  // Windows clamps a window to the screen's work area (after the resize, so a
  // check could pass before it): the page's viewport is pinned to the size too.
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([size.width, size.height]);
}

async function scrollTo(testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ block: 'start' }));
}

async function scrollTop(): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
}

type Rect = { clipId: string; trackId: string; x: number; y: number; width: number; height: number };

async function timeline<T>(name: 'clips' | 'peakColumns' | 'view', arg?: string): Promise<T> {
  return page.evaluate(
    ({ name: called, arg: value }) => {
      const hooks = (window as unknown as { __siannTimeline?: Record<string, (a?: string) => unknown> }).__siannTimeline;
      if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return hooks[called]!(value);
    },
    { name, arg },
  ) as Promise<T>;
}

async function canvasBox(): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('timeline-canvas').boundingBox();
  if (!box) throw new Error('the timeline canvas is not laid out');
  return box;
}

async function clipRect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await timeline<Rect[]>('clips')).some((r) => r.clipId === clipId)).toBe(true);
  return (await timeline<Rect[]>('clips')).find((r) => r.clipId === clipId)!;
}

// Every clip in view has its waveform drawn from the engine's peaks.
async function waveformsDrawn(): Promise<void> {
  // The canvas has laid out every clip the read model holds.
  const count = Number(await page.getByTestId('clip-count').textContent());
  await expect.poll(async () => (await timeline<Rect[]>('clips')).length).toBe(count);
  const rects = await timeline<Rect[]>('clips');
  const width = (await timeline<{ width: number }>('view')).width;
  for (const rect of rects.filter((r) => r.x < width)) {
    // drawn, not nonZero: a clip whose visible part is silence (the riser's
    // quiet start) has its columns drawn, all zero.
    await expect.poll(async () => (await timeline<{ drawn: number }>('peakColumns', rect.clipId)).drawn).toBeGreaterThan(0);
  }
}

async function gestureSettled(): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __siannGestures?: { settled: boolean } }).__siannGestures?.settled === true);
}

// The agent of plan-review.spec.ts: MCP JSON-RPC over POST /v0/mcp.
class Agent {
  #session = '';
  #id = 0;
  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${this.token}` };
    if (this.#session) headers['mcp-session-id'] = this.#session;
    const response = await fetch(`http://127.0.0.1:${this.port}/v0/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
    });
    expect(response.status).toBe(200);
    const session = response.headers.get('mcp-session-id');
    if (session) this.#session = session;
    return (await response.json()) as Record<string, unknown>;
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ux-tour', version: '1' } });
  }

  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.rpc('tools/call', { name, arguments: args });
    const result = reply.result as { isError: boolean; structuredContent: Record<string, unknown> };
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result.structuredContent;
  }
}

async function agent(): Promise<Agent> {
  const ready = await app!.evaluate(() => {
    const shell = (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } | null } }).__siannShell;
    return shell.current();
  });
  if (!ready) throw new Error('the shell has no engine');
  const client = new Agent(ready.port, ready.mcpToken);
  await client.initialize();
  return client;
}

function hash8(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 8);
}

async function submit(client: Agent, steps: ReadonlyArray<Record<string, unknown>>): Promise<string> {
  const plan = await client.tool('submit_plan', { steps });
  const hash = plan.hash as string;
  await page.getByTestId(`plan-${hash8(hash)}`).click();
  await expect(page.getByTestId('plan-detail')).toBeVisible();
  return hash;
}

// ---------------------------------------------------------------- bundle

function prepareBundle(): string {
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  const audio = path.join(scratch, 'audio');
  fs.mkdirSync(audio, { recursive: true });
  cli('create', bundle, '--name', 'UX Tour', '--rate', String(RATE));
  for (const [name, stem] of Object.entries(STEMS)) {
    const file = path.join(audio, `${name}.wav`);
    writeWav(file, stem.seconds, stem.sample);
    cli('import', bundle, file, '--media-id', `med_${slug(name).replace(/-/g, '')}`);
  }
  let clipNumber = 0;
  for (const track of TRACKS) {
    cliExec(bundle, { op: 'track.add', trackId: track.id, name: track.name, channels: 1 });
    if (track.gain !== 0) cliExec(bundle, { op: 'track.set_gain', trackId: track.id, gainMilliDb: track.gain });
    if (track.pan !== undefined) cliExec(bundle, { op: 'track.set_pan', trackId: track.id, pan: track.pan });
    if (track.mute) cliExec(bundle, { op: 'track.set_mute', trackId: track.id, mute: true });
    if (track.solo) cliExec(bundle, { op: 'track.set_solo', trackId: track.id, solo: true });
    for (const [start, sourceStart, length] of track.clips) {
      clipNumber += 1;
      cliExec(bundle, {
        op: 'clip.place',
        clipId: `clp_${String(clipNumber).padStart(2, '0')}_${track.id.slice(4)}`,
        trackId: track.id,
        mediaId: `med_${slug(track.media).replace(/-/g, '')}`,
        position: { domain: 'audio', value: String(Math.round(start * RATE)) },
        sourceStart: String(Math.round(sourceStart * RATE)),
        length: String(Math.round(length * RATE)),
      });
    }
  }
  return bundle;
}

// ---------------------------------------------------------------- tour

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

test('UX screenshot tour', async () => {
  test.setTimeout(420_000);
  fs.mkdirSync(OUT, { recursive: true });
  for (const old of fs.readdirSync(OUT).filter((f) => /^\d\d-.*\.png$/.test(f) || f === 'index.json')) {
    fs.rmSync(path.join(OUT, old));
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-ux-'));
  let watcher: EngineClient | null = null;

  // ---- 1. A first launch on an empty session directory: a new, empty session.
  await launch(path.join(scratch, 'empty-sessions'));
  await resize(WIDE);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText('0');
  await shoot(page, 'Empty session', 'First launch on an empty session directory: the engine created a new session with no tracks, clips or plans.');
  await app!.close();
  app = undefined;

  // ---- 2. The prepared session: 7 tracks, 10 clips, mixer settings.
  const bundle = prepareBundle();
  await launch(path.dirname(bundle), { SIANN_SHELL_BACKOFF_MS: String(RESTART_MS) });
  await resize(WIDE);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('track-count')).toHaveText(String(TRACKS.length));
  await expect(page.getByTestId('clip-count')).toHaveText('10');
  await waveformsDrawn();
  watcher = await engineClient(page, { events: true });
  const summary = 'Kick 0 dB, Snare -2.5 dB, Bass -4 dB, Keys -8 dB pan L35, Vox Lead +1.5 dB solo, Vox BG -9 dB pan R40, FX -12 dB muted';
  await shoot(page, 'Session loaded', `A 7-track session (${summary}); 10 clips with waveforms from the engine's peaks. Transport stopped.`);
  await shoot(page, 'Session loaded full page', 'The same state as the whole page: since m5-ui-shell the page never scrolls, so this is the window.', { fullPage: true });

  // Playing: the meters read (fake device). Vox Lead's solo is clicked off
  // first, so every unmuted track sounds, and back on after.
  const solo = page.getByTestId('solo-trk_voxlead');
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'false');
  await watcher.call('transport.locate', { frames: String(Math.round(1.2 * RATE)) });
  await watcher.call('transport.play');
  await scrollTo('timeline-canvas');
  for (const id of ['trk_kick', 'trk_voxlead']) {
    await expect.poll(async () => Number((await page.getByTestId(`meter-${id}`).getAttribute('data-peak')) ?? '0')).toBeGreaterThan(0.05);
  }
  const peaks: string[] = [];
  for (const track of TRACKS) {
    const peak = Number((await page.getByTestId(`meter-${track.id}`).getAttribute('data-peak')) ?? '0');
    peaks.push(`${track.name} ${peak.toFixed(3)}`);
  }
  await shoot(
    page,
    'Playing meters',
    `Transport playing from 1.2 s on the fake device with Vox Lead's solo clicked off (FX stays muted); the timeline and the mixer are both in view. Meter peaks (linear) at the shot: ${peaks.join(', ')}. The timeline draws no playhead.`,
  );
  await watcher.call('transport.stop');
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  await scrollTop();

  // The smaller window.
  await resize(SMALL);
  await waveformsDrawn();
  await shoot(page, 'Session loaded small window', 'The loaded session at 1024x700.');
  await resize(WIDE);
  await waveformsDrawn();

  // ---- 3. Timeline scroll and zoom: wheel and Ctrl+wheel over the canvas.
  const box = await canvasBox();
  const before = await timeline<{ framesPerPixel: number; scrollFrames: string }>('view');
  await page.mouse.move(box.x + 400, box.y + 100);
  await page.mouse.wheel(600, 0);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await painted(page);
  const after = await timeline<{ framesPerPixel: number; scrollFrames: string }>('view');
  const zoom = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());
  const viewNote =
    after.framesPerPixel === before.framesPerPixel && after.scrollFrames === before.scrollFrames
      ? `the timeline view did not change (still ${before.framesPerPixel} frames/px, scroll ${before.scrollFrames}): the timeline has no scroll or zoom control`
      : `the timeline view went from ${before.framesPerPixel} frames/px, scroll ${before.scrollFrames} to ${after.framesPerPixel} frames/px, scroll ${after.scrollFrames}`;
  await shoot(page, 'Timeline after scroll and zoom', `Horizontal wheel then Ctrl+wheel over the timeline canvas: ${viewNote}; page zoom factor ${zoom}.`);
  if (zoom !== 1) await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1));
  // A vertical wheel scrolls inside the event display, never the page (m5-ui-shell).
  await page.mouse.move(box.x + 400, box.y + 100);
  await page.mouse.wheel(0, 400);
  await painted(page);
  expect(await page.evaluate(() => [window.scrollY, document.documentElement.scrollHeight - document.documentElement.clientHeight])).toEqual([0, 0]);
  const inside = await page.getByTestId('event-display').evaluate((el) => el.scrollTop);
  await shoot(page, 'Page scrolled to mixer', `A vertical wheel over the timeline: the page does not scroll (the zones keep their place); the event display scrolled ${inside} px inside. The mixer is always in the lower zone.`);
  await scrollTop();

  // ---- 4. A fader held mid-drag (one gesture, nothing committed yet).
  const fader = page.getByTestId('fader-trk_bass');
  await scrollTo('mixer');
  const fbox = (await fader.boundingBox())!;
  const at = (fraction: number) => ({ x: fbox.x + fbox.width * fraction, y: fbox.y + fbox.height / 2 });
  const startValue = Number(await fader.inputValue());
  const startFraction = (startValue + 60_000) / 72_000;
  await page.mouse.move(at(startFraction).x, at(startFraction).y);
  await page.mouse.down();
  for (const fraction of [startFraction + 0.05, startFraction + 0.1, startFraction + 0.14]) {
    await page.mouse.move(at(fraction).x, at(fraction).y, { steps: 3 });
  }
  await gestureSettled();
  const held = await fader.inputValue();
  await shoot(page, 'Fader drag held', `Bass fader held mid-drag (pointer down) at ${held} mdB from ${startValue}: the strip shows the gesture's value; no revision is committed until release.`);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.getByTestId('fader-value-trk_bass').textContent())).toBe(Number(held));
  await shoot(page, 'Fader released', `Bass fader released: one revision committed at ${held} mdB.`);
  await scrollTop();

  // ---- 5. A clip selected, mid-move, and moved.
  const target = await clipRect('clp_06_keys');
  const cbox = await canvasBox();
  const grab = { x: cbox.x + target.x + target.width / 2, y: cbox.y + target.y + target.height / 2 };
  await page.mouse.click(grab.x, grab.y);
  await expect(page.getByTestId('selected-clip')).toHaveText('clp_06_keys');
  await shoot(page, 'Clip selected', 'The Keys clip clicked: drawn selected; the selection and the enabled Delete clip button show beside the canvas.');
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y, { steps: 5 });
  await page.mouse.move(grab.x + 120, grab.y, { steps: 5 });
  await painted(page);
  await shoot(page, 'Clip drag in progress', 'The Keys clip held mid-drag 120 px to the right: the canvas previews the move; nothing is committed yet.');
  const revisionBefore = await page.getByTestId('revision').textContent();
  await page.mouse.up();
  await expect(page.getByTestId('revision')).not.toHaveText(revisionBefore ?? '');
  await expect.poll(async () => (await clipRect('clp_06_keys')).x).toBe(target.x + 120);
  await waveformsDrawn();
  await shoot(page, 'Clip moved', 'Released: one clip.move committed; the Keys clip starts 120 px (0.25 s) later on its lane and stays selected.');

  // ---- 6. The Plans tab (m5-ui-plan-panel): an agent's plan as a card, in user wording.
  const client = await agent();
  const mixPass = [
    { op: 'track.add', trackId: 'trk_pad', name: 'Pad', channels: 2 },
    { op: 'track.set_gain', trackId: 'trk_voxbg', gainMilliDb: -6000 },
    { op: 'track.set_pan', trackId: 'trk_keys', pan: -2000 },
    { op: 'track.set_mute', trackId: 'trk_fx', mute: false },
    { op: 'track.rename', trackId: 'trk_fx', name: 'FX Riser' },
  ];
  const mixHash = await submit(client, mixPass);
  await expect(page.getByTestId('plan-diff')).toBeVisible();
  await expect(page.getByTestId('toast')).toBeVisible();
  await scrollTo('plan-review');
  await shoot(
    page,
    'Plan submitted with diff',
    `An MCP agent submitted a 5-step mix plan (${hash8(mixHash)}): a toast says a plan arrived and the Plans button counts it; the card leads with its first step, the step count, when it arrived, a Needs review badge and the short hash; the steps are numbered from 1, all ticked, in user wording (dB, L/C/R pan, names, no ids); one filled primary (Approve and apply) beside Audition and Reject with its reason field; the diff in user units, raw JSON behind each row's disclosure.`,
  );
  await shoot(page, 'Plan submitted full page', 'The same state as the whole page (the window: the page never scrolls).', { fullPage: true });

  // Partial approval: steps 3 and 5 unticked, the primary reads "Approve 3 of 5".
  for (const step of [2, 4]) await page.getByTestId(`step-${step}`).getByRole('checkbox').uncheck();
  await expect(page.getByTestId('plan-approve-apply')).toBeEnabled();
  await scrollTo('plan-review');
  await shoot(page, 'Partial approval steps checked', 'Steps 3 and 5 unticked (pan Keys, rename FX): the primary now reads "Approve 3 of 5"; Select all and Select none sit above the steps.');
  await page.getByTestId('plan-approve-apply').click();
  await expect(page.getByTestId(`plan-state-${hash8(mixHash)}`)).toHaveAttribute('data-state', 'rejected');
  const listed = (await watcher.call('plan.list')).plans as Array<Record<string, unknown>>;
  const subHash = listed.find((p) => p.parentPlan === mixHash)!.hash as string;
  await expect(page.getByTestId(`plan-state-${hash8(subHash)}`)).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId(`plan-split-${hash8(mixHash)}`)).toBeVisible();
  await scrollTo('plan-review');
  await shoot(
    page,
    'Partial approval sub-plan approved',
    `"Approve 3 of 5" approved a 3-step sub-plan (${hash8(subHash)}, part of ${hash8(mixHash)}) and applied it as one revision (Pad added, Vox BG volume, FX unmuted); the original card reads "Split, 3 of 5 approved".`,
  );

  // Audition: a plan approved, proposed and heard in one action.
  const lift = [
    { op: 'track.set_gain', trackId: 'trk_keys', gainMilliDb: -5000 },
    { op: 'track.set_pan', trackId: 'trk_voxbg', pan: 2500 },
    { op: 'track.set_solo', trackId: 'trk_voxlead', solo: false },
  ];
  const liftHash = await submit(client, lift);
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('audition-banner')).toBeVisible();
  await expect(page.getByTestId('hear-proposal')).toHaveAttribute('aria-pressed', 'true');
  await scrollTo('plan-review');
  await shoot(
    page,
    'Audition active',
    `Audition on a validated 3-step plan (${hash8(liftHash)}): approved, proposed and heard in one action; the card reads "Approved for audition", the banner under the top bar names the plan with Hear main, Merge and Discard, the hearing switch at the top of the Plans tab and the status bar show Proposal; main is unchanged.`,
  );
  await page.getByTestId('banner-hear-main').click();
  await expect(page.getByTestId('hear-main')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('plan-discard').click();
  await expect(page.getByTestId(`plan-state-${hash8(liftHash)}`)).toHaveText(translator(LOCALE as Locale)('badge.approved'));

  // A rejected plan with a reason.
  const tidy = [
    { op: 'track.remove', trackId: 'trk_fx' },
    { op: 'track.set_gain', trackId: 'trk_kick', gainMilliDb: 3000 },
  ];
  const tidyHash = await submit(client, tidy);
  await page.getByTestId('plan-note').fill('Keep the FX riser; kick is loud enough');
  await scrollTo('plan-review');
  await shoot(page, 'Reject note typed', `A second plan (${hash8(tidyHash)}: remove FX, kick +3 dB) selected with a reason typed in "Reason (sent to agent)".`);
  await page.getByTestId('plan-reject').click();
  await expect(page.getByTestId(`plan-state-${hash8(tidyHash)}`)).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId(`plan-reason-${hash8(tidyHash)}`)).toBeVisible();
  const rejected = await watcher.call('plan.status', { plan: tidyHash });
  await scrollTo('plan-review');
  await shoot(page, 'Plan rejected with note', `Rejected; the card shows the reason the engine recorded ("${String(rejected.rejectionNote)}"). The reason field is cleared after Reject.`);

  // A stale plan: another client commits to an entity of the plan.
  const vox = [{ op: 'track.set_gain', trackId: 'trk_voxlead', gainMilliDb: -1000 }, { op: 'track.set_solo', trackId: 'trk_voxlead', solo: false }];
  const voxHash = await submit(client, vox);
  await watcher.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_voxlead', gainMilliDb: 500 }] });
  await expect(page.getByTestId(`plan-stale-${hash8(voxHash)}`)).toBeVisible();
  await expect(page.getByTestId('plan-stale-reasons')).toBeVisible();
  await expect(page.getByTestId('plan-approve-apply')).toBeDisabled();
  await scrollTo('plan-review');
  await shoot(
    page,
    'Plan stale error',
    `A third plan (${hash8(voxHash)}) went stale when another client set the Vox Lead volume: the card carries a Stale badge, the reason reads in dB ("Vox Lead: volume was ${formatMilliDb(1500)}, now ${formatMilliDb(500)}"), and Approve and apply is disabled with the reason as its tooltip; Reject stays.`,
  );

  // ---- 7. The engine dies: the window while the shell waits to restart it.
  const pid = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
  watcher.close();
  watcher = null;
  await scrollTop();
  process.kill(pid!);
  await expect(page.getByTestId('status')).not.toHaveAttribute('data-status', 'connected');
  const down = await page.getByTestId('status').textContent();
  await shoot(page, 'Engine disconnected', `The engine process was killed; status "${down}" while the shell waits ${RESTART_MS / 1000} s to restart it.`);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected', { timeout: RESTART_MS + 30_000 });
  await expect(page.getByTestId('track-count')).not.toHaveText('');
  await waveformsDrawn().catch(() => undefined);
  await shoot(page, 'Engine reconnected', 'The shell restarted the engine on the same bundle and the renderer reconnected to a new session.');

  // ---- What the window has no surface for.
  shots.push({
    file: null,
    state: 'Plugin insert and editor (not captured)',
    notes:
      'The renderer shows no plugin inserts and no editor inside its window: a plugin editor is a separate native window owned by the shell (editor.spec.ts, desktop engine only), so there is nothing in the window to capture.',
  });
  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(shots, null, 2)}\n`);
  console.log(`UX tour: ${shots.filter((s) => s.file !== null).length} screenshots in ${OUT}`);
});
