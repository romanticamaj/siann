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
import { RULER_UPPER } from '../../src/renderer/timeline/geometry';
import { snappedMoveDelta, snapperFor } from '../../src/renderer/timeline/snap';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchElectron } from './support/launch';
import { selectPlan } from './support/seed';

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

// A state is numbered by its order, or by `number` when a later ticket's
// state goes after numbers left free for another (UI redesign spec, section 7:
// new states are appended, never renumbered; 23 and 24 are m5-ui-loop-click's).
async function shoot(page: Page, state: string, notes: string, options: { fullPage?: boolean; number?: number } = {}): Promise<void> {
  await painted(page);
  const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  const number = options.number ?? shots.filter((s) => s.file !== null).length + 1;
  const file = `${String(number).padStart(2, '0')}-${slug(state)}.png`;
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
      SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake', ...(process.env.SIANN_TEST_PLUGIN_CLAP ? ['--plugin-dir', path.dirname(process.env.SIANN_TEST_PLUGIN_CLAP)] : [])]),
      ...extraEnv,
    },
  });
  page = await app.firstWindow();}

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

// The newest linear peak of a metered entity, from the mixer's one meter
// canvas (window.__siannMeters under SIANN_SHELL_TEST=1; m5-ui-mixer).
async function meterPeak(p: Page, ref: string): Promise<number> {
  return p.evaluate((r) => {
    const hooks = (window as unknown as { __siannMeters?: { read(ref: string): { peak: number } | null } }).__siannMeters;
    return hooks?.read(r)?.peak ?? 0;
  }, ref);
}

// The meters.legend epoch the mixer's meter store follows.
async function meterEpoch(p: Page): Promise<string | null> {
  return p.evaluate(() => {
    const hooks = (window as unknown as { __siannMeters?: { epoch(): string | null } }).__siannMeters;
    return hooks?.epoch() ?? null;
  });
}

type PeakLatch = { max: Record<string, number>; on: boolean };

// From now on, the loudest linear peak of each metered entity on every animation
// frame (the meter store takes the newest realtime frame once a frame). A poll of
// meterPeak samples one frame a few times a second, and an entity sounds only
// while the transport is inside one of its clips: a stem with gaps, or one whose
// clips the transport has passed by the time a slow poll gets to it, can read 0
// at every sample. The latch sees every frame the meters drew. Stopped frames
// read as silence (meter-store.ts), so a latched peak above 0 is a playing frame.
async function latchPeaks(p: Page, refs: readonly string[]): Promise<void> {
  await p.evaluate((list) => {
    const w = window as unknown as {
      __siannMeters?: { read(ref: string): { peak: number } | null };
      __siannTourPeaks?: PeakLatch;
    };
    if (w.__siannTourPeaks) w.__siannTourPeaks.on = false;
    const latch: PeakLatch = { max: Object.fromEntries(list.map((ref) => [ref, 0])), on: true };
    w.__siannTourPeaks = latch;
    const tick = () => {
      if (!latch.on) return;
      for (const ref of list) {
        const peak = w.__siannMeters?.read(ref)?.peak ?? 0;
        if (peak > latch.max[ref]!) latch.max[ref] = peak;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, refs);
}

async function latchedPeak(p: Page, ref: string): Promise<number> {
  return p.evaluate((r) => (window as unknown as { __siannTourPeaks?: PeakLatch }).__siannTourPeaks?.max[r] ?? 0, ref);
}

async function stopLatch(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __siannTourPeaks?: PeakLatch };
    if (w.__siannTourPeaks) w.__siannTourPeaks.on = false;
    delete w.__siannTourPeaks;
  });
}

type Rect = { clipId: string; trackId: string; position: string; x: number; y: number; width: number; height: number };

async function timeline<T>(name: 'clips' | 'peakColumns' | 'view' | 'cursorX' | 'locatorBand', arg?: string): Promise<T> {
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
  for (const rect of rects) {
    // drawn, not nonZero: a clip whose visible part is silence (the riser's
    // quiet start) has its columns drawn, all zero. The view's width is read
    // in the poll: after a resize the zones animate to their sizes (120 ms),
    // so a clip at the right edge may leave the view while this waits. While
    // a proposal is heard a moved clip's original is main's place as a faint
    // outline with no waveform (peakColumns says outline), and is passed by.
    await expect
      .poll(async () => {
        const width = (await timeline<{ width: number }>('view')).width;
        const columns = await timeline<{ drawn: number; outline?: true }>('peakColumns', rect.clipId);
        return rect.x >= width || columns.outline === true || columns.drawn > 0;
      })
      .toBe(true);
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
  // The card by the default selection, or a click on its history row (m5-ui-port-plans).
  await selectPlan(page, hash);
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
    // Named as the Media tab's import names a file (m5b-ui-media): the clips
    // of states 01, 02, 06, 10, 11, 12 and 25 are titled with it.
    cliExec(bundle, { op: 'media.rename', mediaId: `med_${slug(name).replace(/-/g, '')}`, name: `${name}.wav` });
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

// siann_test_plugin's CLAP (m5b-ui-inserts-master): its directory is a
// --plugin-dir of every launch, and state 34 and the racks of 04 onward need it.
const TEST_PLUGIN = process.env.SIANN_TEST_PLUGIN_CLAP;

// The test plugin's install in the engine's registry, approved.
async function testPluginInstall(client: EngineClient): Promise<{ format: string; path: string }> {
  const registry = (await client.call('plugin.registry')) as { plugins: Array<{ format: string; path: string; approved: boolean }> };
  const install = registry.plugins.find((p) => path.basename(p.path) === path.basename(TEST_PLUGIN!));
  if (!install) throw new Error(`the engine did not register ${TEST_PLUGIN}`);
  if (!install.approved) await client.call('plugin.approve', { format: install.format, path: install.path, approved: true });
  return install;
}

test('UX screenshot tour', async () => {
  if (!TEST_PLUGIN) throw new Error('set SIANN_TEST_PLUGIN_CLAP to siann_test_plugin\'s CLAP (state 34 and the racks need it)');
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
  await expect(page.getByTestId('about-track-count')).toHaveText('0');
  await shoot(page, 'Empty session', 'First launch on an empty session directory: the engine created a new session with no tracks, clips or plans.');
  await app!.close();
  app = undefined;

  // ---- 2. The prepared session: 7 tracks, 10 clips, mixer settings.
  const bundle = prepareBundle();
  await launch(path.dirname(bundle), { SIANN_SHELL_BACKOFF_MS: String(RESTART_MS) });
  await resize(WIDE);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('about-track-count')).toHaveText(String(TRACKS.length));
  await expect(page.getByTestId('clip-count')).toHaveText('10');
  await waveformsDrawn();
  watcher = await engineClient(page, { events: true });
  const summary = 'Kick 0 dB, Snare -2.5 dB, Bass -4 dB, Keys -8 dB pan L35, Vox Lead +1.5 dB solo, Vox BG -9 dB pan R40, FX -12 dB muted';
  await shoot(page, 'Session loaded', `A 7-track session (${summary}); 10 clips with waveforms from the engine's peaks. Transport stopped.`);
  await shoot(page, 'Session loaded full page', 'The same state as the whole page: since m5-ui-shell the page never scrolls, so this is the window.', { fullPage: true });

  // m5b-ui-inserts-master: Vox Lead gets the test plugin as an insert (approved
  // and instantiated through the protocol), so the racks of 04 onward show a slot.
  const install = await testPluginInstall(watcher);
  await watcher.call('plugin.instantiate', { trackId: 'trk_voxlead', index: 0, descriptor: { format: install.format, path: install.path } });
  await expect(page.getByTestId('mixer-strip-trk_voxlead').locator('.slot:not(.empty)')).toHaveCount(1);

  // Playing: the meters read (fake device). Vox Lead's solo is clicked off
  // first, so every unmuted track sounds, and back on after. The solo
  // republishes the graph, which brings a new meters.legend epoch; until the
  // store follows it, every frame of the new epoch is dropped, so the play
  // waits for it. Vox Lead sounds only from 1.8 s to 2.8 s of the session, the
  // first second of this play: its meter is latched over every drawn frame
  // (latchPeaks), not sampled by a poll after the kick's.
  const solo = page.getByTestId('solo-trk_voxlead');
  const epoch = await meterEpoch(page);
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => meterEpoch(page)).not.toBe(epoch);
  await watcher.call('transport.locate', { frames: String(Math.round(1.2 * RATE)) });
  const metered = ['trk_kick', 'trk_voxlead'].map((id) => `track:${id}`);
  await latchPeaks(page, metered);
  // Started from the top bar's transport (m5-ui-transport); auto-scroll is
  // turned off first so the shot keeps the session's first page in view.
  const autoScroll = page.getByTestId('auto-scroll');
  if ((await autoScroll.getAttribute('aria-pressed')) === 'true') await autoScroll.click();
  await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('transport-play').click();
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'true');
  await scrollTo('timeline-canvas');
  for (const ref of metered) {
    await expect.poll(() => latchedPeak(page, ref), { message: `${ref} metered while playing` }).toBeGreaterThan(0.05);
  }
  await stopLatch(page);
  await expect.poll(async () => (await timeline<number | null>('cursorX')) ?? 0).toBeGreaterThan(0);
  const peaks: string[] = [];
  for (const track of TRACKS) {
    const peak = await meterPeak(page, `track:${track.id}`);
    peaks.push(`${track.name} ${peak.toFixed(3)}`);
  }
  peaks.push(`master ${(await meterPeak(page, 'master')).toFixed(3)}`);
  await shoot(
    page,
    'Playing meters',
    `Transport playing from 1.2 s on the fake device, started with the top bar's start button (pressed), with Vox Lead's solo clicked off (FX stays muted) and auto-scroll off; the timeline and the mixer are both in view. The position display reads ${await page.getByTestId('position-primary').textContent()} (Bars+Beats) over ${await page.getByTestId('position-secondary').textContent()} (Seconds). Meter peaks (linear) at the shot: ${peaks.join(', ')}. The project cursor is drawn on the overlay layer at x = ${Math.round((await timeline<number | null>('cursorX')) ?? -1)} px.`,
  );
  await page.getByTestId('transport-stop').click();
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false');
  await autoScroll.click();
  await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  await scrollTop();

  // The smaller window.
  await resize(SMALL);
  await waveformsDrawn();
  await shoot(page, 'Session loaded small window', 'The loaded session at 1024x700; the MixConsole keeps the strip width of the mockup and scrolls sideways, the master strip at the end.');
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
  const inside = (await timeline<{ scrollY?: number }>('view')).scrollY ?? 0;
  await shoot(page, 'Page scrolled to mixer', `A vertical wheel over the timeline: the page does not scroll (the zones keep their place); the lanes scrolled ${inside} px under the ruler (a transform, not a DOM scroll). The mixer is always in the lower zone.`);
  await scrollTop();
  // Back to the whole session (Shift+F in the project zone) so the later
  // states show every clip; a click below the lanes focuses the zone.
  const reset = await canvasBox();
  await page.mouse.click(reset.x + 20, reset.y + (await page.getByTestId('timeline-canvas').boundingBox())!.height - 10);
  await page.keyboard.press('Shift+KeyF');
  await expect.poll(async () => (await timeline<{ scrollFrames: string }>('view')).scrollFrames).toBe('0');
  await waveformsDrawn();

  // ---- 4. A fader held mid-drag (one gesture, nothing committed yet).
  const fader = page.getByTestId('fader-trk_bass');
  await scrollTo('mixer');
  // The fader is vertical (UI redesign spec 3.4): the drag starts on its cap
  // and moves up, toward 0 dB at three quarters of the travel.
  const capBox = (await fader.locator('.cap').boundingBox())!;
  const grabCap = { x: capBox.x + capBox.width / 2, y: capBox.y + capBox.height / 2 };
  const startValue = (await fader.getAttribute('aria-valuetext')) ?? '';
  await page.mouse.move(grabCap.x, grabCap.y);
  await page.mouse.down();
  for (const dy of [-6, -12, -18]) {
    await page.mouse.move(grabCap.x, grabCap.y + dy, { steps: 3 });
  }
  await gestureSettled();
  const held = (await fader.getAttribute('aria-valuetext')) ?? '';
  await shoot(page, 'Fader drag held', `Bass fader held mid-drag (pointer down) at ${held} from ${startValue}: the cap, the level value and the tooltip show the gesture's value; no revision is committed until release. The MixConsole is the mockup's strip() (m5-ui-port-mixer-strip): the insert rack (m5b-ui-inserts-master: Vox Lead's SIANN Test Plugin, whose bypass, e and Remove show while the slot is hovered or focused, and the empty + slots), pan knob, M and S, the dB scale, the fader with its unity line, two meter channels, the level and peak readout and the name tag; the automation row is an empty box. The Inserts rack switch ends the lower zone's tab row.`);
  await page.mouse.up();
  await expect(page.getByTestId('fader-value-trk_bass')).toHaveText(held);
  await shoot(page, 'Fader released', `Bass fader released: one revision committed at ${held}; the strip's cap and readout show it. The master strip has its fader at 0.0 dB (m5b-ui-inserts-master), its meter, its level and peak value and its name; its M, rack and e are M6c's and their boxes stay empty.`);
  await scrollTop();

  // ---- 5. A clip selected, mid-move, and moved.
  const target = await clipRect('clp_06_keys');
  const cbox = await canvasBox();
  const grab = { x: cbox.x + target.x + target.width / 2, y: cbox.y + target.y + target.height / 2 };
  await page.mouse.click(grab.x, grab.y);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_06_keys');
  await shoot(page, 'Clip selected', `The Keys clip clicked: a 2 px outline on the overlay with its handles (the resize squares in the lower corners and the volume control just inside the lower-left one); the info line (the mockup's, m5-ui-port-toolbar) shows its name in its track's colour (${await page.getByTestId('info-name').textContent()}), then its start ${await page.getByTestId('info-start').textContent()} and end ${await page.getByTestId('info-end').textContent()} in bar.beat.sixteenth.tick, its length and offset counted from zero and its volume (${await page.getByTestId('info-volume').textContent()}). Delete and Backspace remove it; the toolbar has no Delete clip button.`);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y, { steps: 5 });
  await page.mouse.move(grab.x + 120, grab.y, { steps: 5 });
  await painted(page);
  await shoot(page, 'Clip drag in progress', 'The Keys clip held mid-drag 120 px to the right: the canvas previews the move snapped to the grid (snap on, grid Adapt to Zoom, the defaults), with the snap guide at its new start; nothing is committed yet.');
  const revisionBefore = await page.getByTestId('revision').textContent();
  await page.mouse.up();
  await expect(page.getByTestId('revision')).not.toHaveText(revisionBefore ?? '');
  // Snapped: the start lands on the grid line nearest to 120 px later.
  const moveView = await timeline<{ framesPerPixel: number; scrollFrames: string }>('view');
  const snapToGrid = snapperFor({ on: true, grid: 'adapt' }, moveView.framesPerPixel, [], RATE);
  const startFrame = BigInt(target.position);
  const movedFrames = snappedMoveDelta(startFrame, BigInt(120 * moveView.framesPerPixel), snapToGrid);
  await expect.poll(async () => Math.round((await clipRect('clp_06_keys')).x)).toBe(Math.round(target.x + Number(movedFrames) / moveView.framesPerPixel));
  await waveformsDrawn();
  const movedSeconds = (Number(movedFrames) / RATE).toFixed(2);
  await shoot(page, 'Clip moved', `Released: one clip.move committed; the Keys clip starts ${movedSeconds} s later on its lane, on the nearest grid line to where it was dropped, and stays selected; the info line shows its new start.`);

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
  await expect(page.getByTestId('plan-card')).toBeVisible();
  await expect(page.getByTestId('toast')).toBeVisible();
  await scrollTo('plan-review');
  await shoot(
    page,
    'Plan submitted with diff',
    `An MCP agent submitted a 5-step mix plan (${hash8(mixHash)}): a toast says a plan arrived and the Plans button counts it. The Plans tab is the mockup's (m5-ui-port-plans): the tab row with the hearing switch, the plan as its card (a Needs review badge, when it arrived, its base revision and short hash; the count chips +1 track, 3 mix, 1 edit; m5b-ui-plan-metadata: the agent row heads the tab, "ux-tour · MCP", connected, its last tool in user wording ("submitted a plan"), and the plan, submitted without a title, leads its card with its first step while its intent box stays empty; the composer's box is left empty until m5b-ui-composer), the steps numbered from 1 and all ticked under "Steps · 5 of 5 selected" and its Select none link, each in the mockup's wording with the old value struck and the new one emphasised (dB, L/C/R pan, names, no ids), and the three actions: Audition, the violet primary "Approve 5 of 5" and the icon-only Reject. Each step's raw JSON and entity diff are behind a click on its text. Since m5b-ui-ghosts the plan's ghosts are drawn in place (UI redesign 4.2): the proposed Pad as a dashed header, a hatched lane under the last one and a dashed strip labelled NEW · STEP 1 before the master; the Vox BG fader's ghost cap joined to its cap with both values and its step badge, the violet tick on the Keys pan knob, the dashed ring on FX's M and both names of the rename; the toolbar ends with the proposal pill naming the plan (its first step and the step count) with its Ghosts toggle.`,
  );
  await shoot(page, 'Plan submitted full page', 'The same state as the whole page (the window: the page never scrolls), with the plan\'s ghosts and the proposal pill.', { fullPage: true });

  // Partial approval: steps 3 and 5 unticked, the primary reads "Approve 3 of 5".
  for (const step of [2, 4]) await page.getByTestId(`step-${step}`).getByRole('checkbox').uncheck();
  await expect(page.getByTestId('plan-approve-apply')).toBeEnabled();
  await scrollTo('plan-review');
  await shoot(page, 'Partial approval steps checked', 'Steps 3 and 5 unticked (pan Keys, rename FX): their boxes empty, the head reads "Steps · 3 of 5 selected" with its link now Select all, and the primary "Approve 3 of 5". The ghosts of the unticked steps are gone (the Keys pan tick, the second FX name): the picture shows what Approve 3 of 5 would do.');
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
    `"Approve 3 of 5" approved a 3-step sub-plan (${hash8(subHash)}, part of ${hash8(mixHash)}) and applied it as one revision (Pad added, Vox BG volume, FX unmuted): the card follows the sub-plan, its badge "Applied · <revision>" and "(part of ${hash8(mixHash)})" under it, its steps without boxes; the original plan is a history row under "Earlier" reading "Split, 3 of 5 approved". An applied plan has no ghosts and the toolbar no pill.`,
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
  // m5b-ui-audition: the ghosts turn solid once the branch snapshot arrives.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __siannGhosts?: { list(): Array<{ mode?: string }> } }).__siannGhosts?.list().every((g) => g.mode === 'solid') ?? false)).toBe(true);
  await scrollTo('plan-review');
  await shoot(
    page,
    'Audition active',
    `Audition on a validated 3-step plan (${hash8(liftHash)}): approved, proposed and heard in one action. The window has the 2 px violet frame; the branch chip in the top bar names the proposal as the banner does (its first step and "3 steps") instead of main r<head>; the card (selected from its history row) reads "Approved for audition" with Hear main, the primary Merge with its ⏎ (Ctrl+Return in the right zone) and the icon-only Discard; the banner under the top bar names the plan (untitled: by its first step and "3 steps") with Hear main, Merge and Discard; the hearing switch in the tab row and the status bar show Proposal; main is unchanged. The ghosts are solid, drawn from the branch snapshot (what is playing): the Keys and Vox BG caps and the pan tick, the ring on Vox Lead's S, with main's caps as faint outlines. Structural edits are disabled with the reason as their tooltip. The mockup has no hearing state: this state is the app's alone.`,
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
  // The reason row opens with the first press of Reject (UI redesign 10.10, P1-13).
  await page.getByTestId('plan-reject').click();
  await page.getByTestId('plan-note').fill('Keep the FX riser; kick is loud enough');
  await scrollTo('plan-review');
  await shoot(page, 'Reject note typed', `A second plan (${hash8(tidyHash)}: remove FX, kick +3 dB) selected; the first press of Reject opened the reason row above the actions, and a reason is typed in "Reason (sent to agent)" (Enter or Reject again sends it, Escape closes it). The plan is still validated: its ghosts (FX's strip dimmed and its clip cross-hatched, the Kick ghost cap) and the pill stay until it is rejected.`);
  await page.getByTestId('plan-reject').click();
  await expect(page.getByTestId(`plan-state-${hash8(tidyHash)}`)).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId(`plan-reason-${hash8(tidyHash)}`)).toBeVisible();
  const rejected = await watcher.call('plan.status', { plan: tidyHash });
  await scrollTo('plan-review');
  await shoot(page, 'Plan rejected with note', `Rejected; the card's badge reads Rejected and a row under it shows the reason the engine recorded ("${String(rejected.rejectionNote)}" · sent to agent), with no actions left. The reason row is closed and cleared after Reject.`);

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
    `A third plan (${hash8(voxHash)}) went stale when another client set the Vox Lead volume: the card carries a Stale badge beside Needs review, a row between the steps and the actions gives the reason in dB ("Vox Lead: volume was ${formatMilliDb(1500)}, now ${formatMilliDb(500)}"), and "Approve 2 of 2" is disabled with the reason as its tooltip; Reject stays.`,
  );

  // ---- 7. The engine dies: the window while the shell waits to restart it.
  const pid = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
  watcher.close();
  watcher = null;
  await scrollTop();
  process.kill(pid!);
  await expect(page.getByTestId('status')).not.toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('connection-banner')).toBeVisible();
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-offline', 'true');
  const down = await page.getByTestId('status').textContent();
  await shoot(
    page,
    'Engine disconnected',
    `The engine process was killed; status "${down}" while the shell waits ${RESTART_MS / 1000} s to restart it. A full-width banner under the top bar says the engine is disconnected; the agent row reads "No agent connected" (the agents are forgotten with the engine); the four zones are dimmed and inert, so no control can send a request (the top bar's zone buttons and the status bar stay live).`,
  );
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected', { timeout: RESTART_MS + 30_000 });
  // The toast is shot while it shows (it dismisses itself after a few seconds).
  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();
  await expect(page.getByTestId('about-track-count')).not.toHaveText('');
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  const toastText = await toast.locator('.toast-text').textContent();
  await painted(page);
  await expect(toast).toBeVisible();
  await shoot(
    page,
    'Engine reconnected',
    `The shell restarted the engine on the same bundle and the renderer reconnected to a new session. The banner is gone, the zones are live again, the clip selection is cleared, and a toast names the recovered revision ("${toastText}"). The new engine has no agent yet: the agent row reads "No agent connected".`,
  );

  // ---- 25 (m5-ui-edit-basics; 23 and 24 are m5-ui-loop-click's): the
  // Keys clip zoomed to with Shift+E, split at the cursor with Alt+X, both
  // pieces selected (click, Shift-click) and duplicated with Ctrl+D.
  await expect(toast).toBeHidden({ timeout: 30_000 });
  await waveformsDrawn();
  const editor = await engineClient(page);
  const keysBox = await canvasBox();
  const keysAt = await clipRect('clp_06_keys');
  await page.mouse.click(keysBox.x + Math.max(0, keysAt.x) + 20, keysBox.y + keysAt.y + keysAt.height / 2);
  await expect(page.getByTestId('info-line')).toHaveAttribute('data-clip', 'clp_06_keys');
  await page.keyboard.press('Shift+KeyE');
  const viewWidth = (await timeline<{ width: number }>('view')).width;
  await expect.poll(async () => (await clipRect('clp_06_keys')).width).toBeLessThan(viewWidth);
  const keys = await clipRect('clp_06_keys');
  const keysView = await timeline<{ framesPerPixel: number; scrollFrames: string }>('view');
  const cut = BigInt(keysView.scrollFrames) + BigInt(Math.round((keys.x + keys.width / 2) * keysView.framesPerPixel));
  await editor.call('transport.locate', { frames: cut.toString() });
  await expect.poll(async () => Math.abs(((await timeline<number | null>('cursorX')) ?? -100) - (keys.x + keys.width / 2))).toBeLessThan(2);
  const clipsBefore = Number(await page.getByTestId('clip-count').textContent());
  await page.keyboard.press('Alt+KeyX');
  await expect(page.getByTestId('clip-count')).toHaveText(String(clipsBefore + 1));
  await expect.poll(async () => (await timeline<Rect[]>('clips')).filter((r) => r.trackId === 'trk_keys').length).toBeGreaterThan(1);
  const right = (await timeline<Rect[]>('clips')).find((r) => r.trackId === 'trk_keys' && BigInt(r.position) === cut)!;
  await page.keyboard.down('Shift');
  await page.mouse.click(keysBox.x + right.x + right.width / 2, keysBox.y + right.y + right.height / 2);
  await page.keyboard.up('Shift');
  await page.keyboard.press('ControlOrMeta+KeyD');
  await expect(page.getByTestId('clip-count')).toHaveText(String(clipsBefore + 3));
  await page.keyboard.press('Shift+KeyF');
  await waveformsDrawn();
  editor.close();
  await shoot(
    page,
    'Clip split and duplicated',
    'The Keys clip split at the project cursor with Alt+X (its two pieces play the same audio as before: the right one continues in the file where the left one ends), then both pieces selected (click, Shift-click) and duplicated with Ctrl+D: the copies land directly after them on the same lane, as one unit. Each edit was one revision. Zoomed full (Shift+F) to show the whole session.',
    { number: 25 },
  );

  // ---- 23 and 24 (m5-ui-loop-click; numbered explicitly, written after 25).
  // 23: a locator range drawn in the ruler's upper half over bars 2 to 4 of
  // the zoomed-full view and cycle turned on with the cycle button.
  const loopView = await timeline<{ framesPerPixel: number; scrollFrames: string }>('view');
  const loopBox = await canvasBox();
  const barX = (bar: number) => (2 * (bar - 1) * RATE - Number(loopView.scrollFrames)) / loopView.framesPerPixel;
  await page.mouse.move(loopBox.x + barX(2), loopBox.y + RULER_UPPER / 2);
  await page.mouse.down();
  await page.mouse.move(loopBox.x + barX(4), loopBox.y + RULER_UPPER / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('display-locators')).toBeVisible();
  await page.getByTestId('transport-cycle').click();
  await expect(page.getByTestId('transport-cycle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await timeline<{ cycle: boolean } | null>('locatorBand'))?.cycle).toBe(true);
  const locatorText = await page.getByTestId('display-locators-value').textContent();
  await shoot(
    page,
    'Locators set, cycle on',
    `A locator range drawn by dragging in the ruler's upper half (one session.set_locators on release, snapped to the grid), then cycle turned on with the cycle button between go to start and stop. The band is light with its L and R flags, the lanes under the range are tinted, the cycle button is lit, and the locator display in the top bar reads ${locatorText}.`,
    { number: 23 },
  );
  // 24: the metronome on (its button after the displays).
  await page.getByTestId('transport-metronome').click();
  await expect(page.getByTestId('transport-metronome')).toHaveAttribute('aria-pressed', 'true');
  await shoot(
    page,
    'Metronome on',
    'The metronome turned on with its button (transport.set_click; C does the same, a right-click on it gives its level): the button is lit. The click is generated from the tempo map and added to the device output after the master meter; nothing else in the window changes.',
    { number: 24 },
  );

  // ---- 31 (m5b-ui-media; the Pool's state until the Media tab replaced it,
  // UI redesign 10.11, 8): the Media tab with imported files, opened with
  // Ctrl+P (Cmd+P on macOS). The mockup draws the tab but not its content, so
  // the review reads this state alone.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+KeyP');
  await expect(page.getByTestId('media-tab')).toBeVisible();
  const mediaItems = await page.locator('[data-testid^="media-row-"]').count();
  await shoot(
    page,
    'Media tab with imported files',
    `The right zone's Media tab (UR-5), opened with Ctrl+P (Cmd+P on macOS; the event display's context menu opens it too): the session's ${mediaItems} imported files by name with their length, channels, sample rate and use count, a search field and Import (the shell's file dialog). A row drags to the event display to place a clip, a double-click renames it, and Remove is enabled only for media no clip uses. Files dropped from the desktop on the event display import and land at the drop position.`,
    { number: 31 },
  );
  await page.getByTestId('tab-right-plans').click();
  await expect(page.getByTestId('media-tab')).toBeHidden();

  // ---- 32 (m5b-ui-edit-more; UI redesign 3.2): the two pieces of the Keys
  // clip split at 25 glued again with the Glue tool (4; a click on a selected
  // piece joins the selection's run in one revision), then the snap type menu
  // open from the snap field's chevron. The mockup has no such menu, so the
  // review reads this state alone.
  await waveformsDrawn();
  const glueBox = await canvasBox();
  const leftPiece = await clipRect('clp_06_keys');
  const rightPiece = (await timeline<Rect[]>('clips')).find((r) => r.trackId === 'trk_keys' && BigInt(r.position) === cut)!;
  await page.mouse.click(glueBox.x + leftPiece.x + leftPiece.width / 2, glueBox.y + leftPiece.y + leftPiece.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(glueBox.x + rightPiece.x + rightPiece.width / 2, glueBox.y + rightPiece.y + rightPiece.height / 2);
  await page.keyboard.up('Shift');
  const clipsBeforeGlue = Number(await page.getByTestId('clip-count').textContent());
  await page.keyboard.press('Digit4');
  await expect(page.getByTestId('tool-glue')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(glueBox.x + leftPiece.x + leftPiece.width / 2, glueBox.y + leftPiece.y + leftPiece.height / 2);
  await expect(page.getByTestId('clip-count')).toHaveText(String(clipsBeforeGlue - 1));
  await expect.poll(async () => (await clipRect('clp_06_keys')).width).toBeGreaterThan(leftPiece.width);
  await page.getByTestId('snap-toggle').locator('svg').last().click();
  await expect(page.getByTestId('snap-type-menu')).toBeVisible();
  await shoot(
    page,
    'Pieces glued, snap type menu open',
    'The Keys clip\'s two pieces (split at the cursor in state 25) selected and glued with the Glue tool (key 4, lit in the toolbar): one clip.remove and one clip.trim in one revision, so the clip is whole again with its fades and volume. The snap type menu is open under the snap field\'s chevron: Grid (checked), Grid Relative, Events (magnetic to the other clips\' starts and ends) and Magnetic Cursor. The mockup does not show this menu.',
    { number: 32 },
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('snap-type-menu')).toHaveCount(0);
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');

  // ---- 26 and 27 (m5b-ui-ghosts; UI redesign 4.2, 5.2): a plan's ghosts in
  // the event display and on the MixConsole.
  const ghostPlan = [
    { op: 'track.add', trackId: 'trk_strings', name: 'Strings', channels: 2 },
    { op: 'clip.place', clipId: 'clp_ghost_strings', trackId: 'trk_strings', mediaId: 'med_keys', position: { domain: 'audio', value: String(RATE) }, sourceStart: '0', length: String(2 * RATE) },
    { op: 'clip.move', clipId: 'clp_01_kick', position: { domain: 'audio', value: String(RATE / 2) } },
    { op: 'track.set_gain', trackId: 'trk_bass', gainMilliDb: -1000 },
    { op: 'track.set_pan', trackId: 'trk_keys', pan: 3000 },
    { op: 'track.set_mute', trackId: 'trk_kick', mute: true },
  ];
  // The engine restarted at 21: a new agent connection.
  const ghostHash = await submit(await agent(), ghostPlan);
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(ghostHash));
  await expect(page.locator('[data-part="proposal-pill"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __siannGhosts?: { list(): unknown[] } }).__siannGhosts?.list().length ?? 0)).toBe(ghostPlan.length);
  await page.keyboard.press('Shift+KeyF');
  await waveformsDrawn();
  await shoot(
    page,
    'Ghosts in the event display',
    `A 6-step plan (${hash8(ghostHash)}) selected: its ghosts on the event display's content layer in the agent violet, dashed and hatched, each with its step number: the proposed Strings track as a hatched lane under the last one with a dashed header, a ghost clip with its waveform placed on it, the first Kick clip moved half a second earlier (its original at 38 %, the ghost at the new place, an arrow between them), and in the headers the Bass gain with both values and the dashed ring on Kick's M. The toolbar's pill names the plan; Ctrl+Alt+G hides the ghosts.`,
    { number: 26 },
  );
  await page.getByTestId('step-3').hover();
  await shoot(
    page,
    'Ghosts on the MixConsole',
    'The same plan on the MixConsole, the pointer on step 4 (Bass gain): its ghosts outlined; the Bass strip\'s ghost cap joined to the real cap with its step badge and both values in the readout, the violet tick on the Keys pan knob with the new value, the dashed ring on Kick\'s M with its badge, and the dashed Strings strip labelled NEW · STEP 1 before the master, its insert row empty.',
    { number: 27 },
  );

  // ---- 28 (m5b-ui-audition; UI redesign 4.3, 4.5 C5): the same plan
  // auditioned: its clip and track ghosts solid in the event display, the
  // frame and the banner, and a structural control disabled with its reason.
  await page.mouse.move(0, 0);
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('audition-banner')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __siannGhosts?: { list(): Array<{ mode?: string }> } }).__siannGhosts?.list().filter((g) => g.mode === 'solid').length ?? 0)).toBeGreaterThanOrEqual(ghostPlan.length);
  await expect(page.getByTestId('tool-split')).toBeDisabled();
  await page.getByTestId('tool-split').hover();
  await waveformsDrawn();
  await shoot(
    page,
    'Hearing a proposal with clip and track ghosts',
    `The 6-step plan (${hash8(ghostHash)}) auditioned: the 2 px violet frame, the banner and the branch chip naming it, and its ghosts solid in the event display (the Strings lane, unhatched, and its placed clip; the moved Kick clip, its original now main's place as a faint outline), on the headers and the MixConsole (the Strings header and strip unhatched, the Bass cap solid with main's cap as a faint outline; Kick's M and the Keys knob solid, main's value the control itself), drawn from the branch snapshot. Structural edits are disabled while the proposal is heard: the Split tool, under the pointer, is dimmed and its tooltip gives the reason (the tooltip is the system's and is not in the capture); the fader and pan stay live and go to the side heard. The mockup has no hearing state: this state is the app's alone.`,
    { number: 28 },
  );
  // Discarded, so what follows is as before.
  await page.getByTestId('banner-discard').click();
  await expect(page.getByTestId('audition-banner')).toHaveCount(0);
  // ---- 41 (m5b-ui-plan-metadata): a titled plan with its intent, the agent
  // row connected. The tour's MCP client keeps its name (ux-tour).
  const titledClient = await agent();
  const titled = await titledClient.tool('submit_plan', {
    steps: [
      { op: 'track.set_gain', trackId: 'trk_voxbg', gainMilliDb: -6000 },
      { op: 'track.set_pan', trackId: 'trk_keys', pan: -2000 },
    ],
    title: 'Lift the chorus',
    intent: 'Bring the backing vocals forward and narrow the keys so the lead vocal sits on top.',
  });
  await selectPlan(page, titled.hash as string);
  await expect(page.locator('[data-part="plan-title"]')).toHaveText('Lift the chorus');
  await expect(page.locator('[data-part="agent-row"] b')).toHaveText('ux-tour');
  await scrollTo('plan-review');
  await shoot(
    page,
    'Titled plan with intent',
    `An MCP agent (clientInfo.name "ux-tour") submitted a plan with a title and an intent (${hash8(titled.hash as string)}): the agent row heads the Plans tab with the agent's name, MCP and "connected · submitted a plan" (the time in its tooltip); the card leads with the title "Lift the chorus" and the intent under it in two lines, then the count chips; the toast named the plan by its title.`,
    { number: 41 },
  );

  // ---- 34 (m5b-ui-inserts-master; UI redesign 3.4): an insert rack with a
  // plugin, and the picker open from an empty slot.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mixer-strip-trk_voxlead').locator('.slot:not(.empty)')).toHaveCount(1);
  await page.getByTestId('mixer-strip-trk_bass').locator('.slot.empty').first().click();
  await expect(page.getByTestId('plugin-picker')).toBeVisible();
  await expect(page.getByTestId('picker-install').first()).toBeVisible();
  const installs = await page.getByTestId('picker-install').count();
  await shoot(
    page,
    'Insert rack and plugin picker',
    `Vox Lead's insert rack holds the SIANN Test Plugin (its name; bypass, e for its editor and Remove, added to the mockup's .slot, show while it is hovered or focused) above one empty + slot; a click on an empty slot of Bass opened the plugin picker: the ${installs} installs of plugin.registry by name and format with a search field, an approved one chosen with its row, an unapproved one with Approve (after a confirmation that names the file). Choosing one inserts it at the end of the chain as one revision. The picker is app-only (the mockup draws none), so the review reads this state alone; a plugin's editor is a native window outside the page.`,
    { number: 34 },
  );
  await page.getByTestId('picker-close').click();
  await expect(page.getByTestId('plugin-picker')).toBeHidden();

  // ---- 35 and 36 (m5b-ui-recording; UI redesign 3.1, 3.5; 10.11, 16 and 17):
  // the fake device with its input (its outputs loop back), Vox Lead on Mono
  // In 1 and armed, a recording in progress; then the record options panel
  // with punch in and out and a one-bar count-in.
  const recorder = await engineClient(page);
  await recorder.call('engine.select_device', { id: 'fake', inputId: 'fake' });
  await expect.poll(async () => ((await recorder.call('engine.status')).device as { input: unknown } | null)?.input ?? null).not.toBeNull();
  await recorder.call('command.execute', { commands: [{ op: 'track.set_input', trackId: 'trk_voxlead', input: { port: 0, channels: 1 } }] });
  await page.getByTestId('track-record-trk_voxlead').click();
  await expect(page.getByTestId('track-record-trk_voxlead')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('transport-record').click();
  await expect(page.getByTestId('transport-record')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => page.evaluate(() => ((window as unknown as { __siannTimeline?: { recordingClips(): Array<{ columns: number }> } }).__siannTimeline?.recordingClips() ?? []).filter((c) => c.columns > 4).length), { timeout: 20_000 })
    .toBe(1);
  await shoot(
    page,
    'Recording in progress',
    'Vox Lead armed (its record enable lit on the header, the strip and the Inspector, whose In row reads Mono In 1) and Record pressed: a red clip grows on its lane from the take\'s first frame to the playhead with the live waveform of its input meter (input:trk_voxlead), drawn on the overlay at display rate with no React commit; the header and strip meters of the armed track read its input. The fake device\'s input is the loopback of what plays.',
    { number: 35 },
  );
  await page.getByTestId('transport-stop').click();
  await expect(page.getByTestId('transport-record')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('transport-record').click({ button: 'right' });
  const options = page.getByTestId('record-options');
  await expect(options).toBeVisible();
  // The box shows the engine's state, so it turns once the answer is in.
  await options.getByTestId('record-option-punch-in').click();
  await expect(options.getByTestId('record-option-punch-in')).toBeChecked();
  // The box shows the engine's state, so it turns once the answer is in.
  await options.getByTestId('record-option-punch-out').click();
  await expect(options.getByTestId('record-option-punch-out')).toBeChecked();
  // The box shows the engine's state, so it turns once the answer is in.
  await options.getByTestId('record-option-count-in').click();
  await expect(options.getByTestId('record-option-count-in')).toBeChecked();
  await expect.poll(async () => (await recorder.call('engine.status')).punch).toEqual({ in: true, out: true });
  await expect.poll(async () => ((await recorder.call('engine.status')).countIn as { enabled: boolean }).enabled).toBe(true);
  await shoot(
    page,
    'Punch and count-in on',
    'A right-click on Record opened the record options panel (app-only, styled in shell.css on existing tokens; UI redesign 10.11, 17): punch in and punch out at the locators (I and O), pre-roll and count-in with their bar counts (1 to 8), each showing the engine\'s state from transport.changed; Record\'s tooltip names the options that are on. The mockup draws no such panel, so the review reads this state alone.',
    { number: 36 },
  );
  await page.keyboard.press('Escape');
  recorder.close();

  // ---- 29 and 30 (m5b-ui-project): the start view, on a launch of its own
  // without SIANN_SESSION_DIR and with a recent list whose last bundle is
  // gone, then Studio Setup from the Studio menu. The mockup draws neither:
  // the review reads these states alone.
  await app!.close();
  app = undefined;
  const projectData = path.join(scratch, 'user-data-projects');
  fs.mkdirSync(projectData, { recursive: true });
  fs.writeFileSync(
    path.join(projectData, 'recent-projects.json'),
    JSON.stringify({ schema: 'siann.recent.v1', recent: [path.join(scratch, 'Deleted song.siann'), bundle] }),
  );
  const projectEnv: Record<string, string | undefined> = {
    ...process.env,
    SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
    SIANN_USER_DATA: projectData,
    SIANN_SHELL_BACKOFF_MS: '50',
    SIANN_SHELL_TEST: '1',
    SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake']),
  };
  delete projectEnv.SIANN_SESSION_DIR;
  app = await launchElectron({ args: [MAIN], languages: LANGUAGES, cwd: APP_DIR, env: projectEnv });
  page = await app.firstWindow();
  await resize(WIDE);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect(page.getByTestId('start-recent-1')).toBeVisible();
  await shoot(
    page,
    'Start view',
    'A launch whose last bundle was deleted (no SIANN_SESSION_DIR): the engine runs on a scratch bundle in user data, never listed as recent, and the start view over the zones offers New Project (Ctrl+N), Open (Ctrl+O) and the recent list (the bundle that is gone was dropped from it). The top bar shows no session name. App-only state: the mockup has no start view.',
    { number: 29 },
  );
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('studio.setup')!.click());
  await expect(page.getByTestId('studio-setup')).toBeVisible();
  await expect(page.getByTestId('setup-device-fake')).toBeVisible();
  await expect(page.getByTestId('setup-rate')).toBeVisible();
  await shoot(
    page,
    'Studio Setup',
    'Studio > Studio Setup: the devices of engine.devices with their input and output channel counts (the fake device: 2 and 2), the output and input lists engine.select_device takes, and the running device\'s sample rate, buffer, input and output latency and whether device-side SRC is active, from engine.status. App-only state: the mockup has no Studio Setup.',
    { number: 30 },
  );
  await page.getByTestId('setup-close').click();
  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(shots, null, 2)}\n`);
  console.log(`UX tour: ${shots.filter((s) => s.file !== null).length} screenshots in ${OUT}`);
});
