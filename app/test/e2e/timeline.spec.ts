// The timeline end to end (m5-timeline; spec "Frontend", Protocol v0 item 23):
// clips drawn from the engine's peak pyramids, and each gesture ending in one
// command.execute. The bundle is prepared before the shell opens it with
// siann-cli create, exec and import (SIANN_CLI_EXE), since no protocol method
// imports media; the app runs the real siann-engine (SIANN_ENGINE_EXE) under
// SIANN_SHELL_TEST=1, which exposes window.__siannTimeline. Commits are checked
// with a second protocol client. Waits are Playwright condition waits with
// bounded timeouts, never sleeps.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const RATE = 48000;
const FRAMES = 48000;

function exeFromEnv(name: string): string {
  const exe = process.env[name];
  if (!exe) throw new Error(`set ${name} to the built executable`);
  if (!fs.existsSync(exe)) throw new Error(`${name} points at a missing file: ${exe}`);
  return exe;
}

function cli(...args: string[]): Record<string, unknown> {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  const line = (result.stdout || '').trim().split(/\r?\n/).pop() ?? '';
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${line} ${result.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

// A mono 16-bit PCM WAV: a square wave at half scale, or silence.
function wav(file: string, square: boolean): string {
  const data = Buffer.alloc(FRAMES * 2);
  for (let i = 0; i < FRAMES; i += 1) data.writeInt16LE(square ? (Math.floor(i / 240) % 2 === 0 ? 16384 : -16384) : 0, i * 2);
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
  const bytes = Buffer.concat([header, data]);
  fs.writeFileSync(file, bytes);
  // Stored byte for byte (same rate): the media's contentHash is the file's.
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

let scratch: string;
let bundle: string;
let squareHex: string;
let silenceHex: string;
let app: ElectronApplication;
let page: Page;

// trk_a and trk_b in that order, media med_sq (square) and med_si (silence),
// and the clips each test asks for.
function prepare(clips: ReadonlyArray<Record<string, unknown>>): void {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-timeline-'));
  bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'Timeline', '--rate', String(RATE));
  for (const id of ['trk_a', 'trk_b']) cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: id, name: id, channels: 1 }));
  squareHex = wav(path.join(scratch, 'square.wav'), true);
  silenceHex = wav(path.join(scratch, 'silence.wav'), false);
  cli('import', bundle, path.join(scratch, 'square.wav'), '--media-id', 'med_sq');
  cli('import', bundle, path.join(scratch, 'silence.wav'), '--media-id', 'med_si');
  for (const clip of clips) {
    cli('exec', bundle, JSON.stringify({ op: 'clip.place', sourceStart: '0', length: String(FRAMES), ...clip }));
  }
}

function place(clipId: string, trackId: string, mediaId: string, position: number): Record<string, unknown> {
  return { clipId, trackId, mediaId, position: { domain: 'audio', value: String(position) } };
}

async function launch(): Promise<void> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  app = await electron.launch({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: path.dirname(bundle),
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId('track-count')).toHaveText('2');
}

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

interface Rect {
  readonly clipId: string;
  readonly trackId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface TimelineHooks {
  clips(): Rect[];
  peakColumns(clipId: string): { drawn: number; nonZero: number };
  view(): { framesPerPixel: number; scrollFrames: string; rulerHeight: number; laneHeight: number };
  lanes(): string[];
}

// The test hooks, read with page.evaluate (the CSP allows no eval in the page).
type Hook = 'clips' | 'peakColumns' | 'view' | 'lanes';

async function hook<K extends Hook>(name: K, arg?: string): Promise<ReturnType<TimelineHooks[K]>> {
  return page.evaluate(
    ({ name: called, arg: value }) => {
      const timeline = (window as unknown as { __siannTimeline?: Record<string, (a?: string) => unknown> }).__siannTimeline;
      if (!timeline) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return timeline[called]!(value);
    },
    { name, arg },
  ) as Promise<ReturnType<TimelineHooks[K]>>;
}

const hooks = {
  clips: () => hook('clips'),
  peakColumns: (clipId: string) => hook('peakColumns', clipId),
  view: () => hook('view'),
};

async function rect(clipId: string): Promise<Rect> {
  await expect.poll(async () => (await hooks.clips()).some((r) => r.clipId === clipId)).toBe(true);
  return (await hooks.clips()).find((r) => r.clipId === clipId)!;
}

// The canvas's page coordinates, to turn canvas pixels into mouse positions.
async function canvasBox(): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('timeline-canvas').boundingBox();
  if (!box) throw new Error('the timeline canvas is not laid out');
  return { x: box.x, y: box.y };
}

function revisionNumber(text: string | null): number {
  const match = /^r(\d+)$/.exec(text ?? '');
  if (!match) throw new Error(`not a revision: ${text}`);
  return Number(match[1]);
}

async function revision(): Promise<number> {
  await expect(page.getByTestId('revision')).toHaveText(/^r\d+$/);
  return revisionNumber(await page.getByTestId('revision').textContent());
}

type Reply = { requestId?: string; ok?: boolean; result?: Record<string, unknown>; error?: { code: string } };

let calls = 0;

// A second protocol client of the engine the renderer is on (read-model.spec.ts's pattern).
async function engineClient() {
  const endpoint = await page.evaluate(() =>
    (window as unknown as { siann: { engine: { current(): Promise<{ port: number; token: string } | null> } } }).siann.engine.current(),
  );
  if (endpoint === null) throw new Error('the renderer has no engine');
  const sessionId = (await page.getByTestId('session-id').textContent()) ?? '';
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
  const replies: string[] = [];
  let wake = () => {};
  socket.addEventListener('message', (event) => {
    replies.push(String(event.data));
    wake();
  });
  const next = async (): Promise<Reply> => {
    while (replies.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    return JSON.parse(replies.shift()!) as Reply;
  };
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  socket.send(JSON.stringify({ type: 'auth', token: endpoint.token }));
  await next();
  return {
    async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const requestId = `req_timeline_${++calls}`;
      socket.send(JSON.stringify({ requestId, sessionId, method, params }));
      for (;;) {
        const reply = await next();
        if (reply.requestId !== requestId) continue;
        if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
        return reply.result!;
      }
    },
    close: () => socket.close(),
  };
}

type ClipJson = { trackId: string; position: { value: string }; sourceStart: string; length: string };

async function fetchClip(clipId: string): Promise<ClipJson | null> {
  const client = await engineClient();
  try {
    const { entities } = (await client.call('session.fetch', { refs: [`clip:${clipId}`] })) as {
      entities: Array<{ entity?: ClipJson; missing?: boolean }>;
    };
    return entities[0]?.missing ? null : (entities[0]?.entity ?? null);
  } finally {
    client.close();
  }
}

async function framesPerPixel(): Promise<number> {
  return (await hooks.view()).framesPerPixel;
}

test('clips render from peak pyramids', async () => {
  prepare([place('clp_sq', 'trk_a', 'med_sq', 0), place('clp_si', 'trk_b', 'med_si', 0)]);
  await launch();
  // The engine computed and cached both pyramids.
  await expect.poll(() => fs.existsSync(path.join(bundle, 'peaks', `${squareHex}.peaks`))).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(bundle, 'peaks', `${silenceHex}.peaks`))).toBe(true);
  // Columns drawn from the pyramid: the square wave's are non-zero, the silence's all zero.
  await expect.poll(async () => (await hooks.peakColumns('clp_sq')).nonZero).toBeGreaterThan(0);
  const square = await hooks.peakColumns('clp_sq');
  expect(square.nonZero).toBe(square.drawn);
  await expect.poll(async () => (await hooks.peakColumns('clp_si')).drawn).toBeGreaterThan(0);
  expect((await hooks.peakColumns('clp_si')).nonZero).toBe(0);
  await expect(page.getByTestId('clip-count')).toHaveText('2');
});

test('placing a clip from the media pool issues clip.place', async () => {
  prepare([]);
  await launch();
  await expect(page.getByTestId('clip-count')).toHaveText('0');
  const before = await revision();
  await page.getByTestId('pool-med_sq').click();
  const view = await hooks.view();
  const box = await canvasBox();
  // The second lane (trk_b), 150 px in.
  const y = view.rulerHeight + view.laneHeight * 1.5;
  await page.mouse.click(box.x + 150, box.y + y);
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  // The canvas redraws on the next animation frame after the model changed.
  await expect.poll(async () => (await hooks.clips()).length).toBe(1);
  const [placed] = await hooks.clips();
  expect(placed!.clipId).toMatch(/^clp_[0-9a-f]{16}$/);
  const clip = await fetchClip(placed!.clipId);
  expect(clip).not.toBeNull();
  expect(clip!.trackId).toBe('trk_b');
  expect(clip!.position.value).toBe(String(150 * view.framesPerPixel));
  expect(clip!.length).toBe(String(FRAMES));
  await expect(page.getByTestId('timeline-error')).toHaveText('');
});

test('dragging a clip issues clip.move', async () => {
  prepare([place('clp_sq', 'trk_a', 'med_sq', 0)]);
  await launch();
  const start = await rect('clp_sq');
  const box = await canvasBox();
  const fpp = await framesPerPixel();
  const before = await revision();
  const grab = { x: box.x + start.x + start.width / 2, y: box.y + start.y + start.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y, { steps: 4 });
  await page.mouse.move(grab.x + 80, grab.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  await expect.poll(async () => (await fetchClip('clp_sq'))?.position.value).toBe(String(80 * fpp));
  expect((await fetchClip('clp_sq'))!.trackId).toBe('trk_a');

  // Down one lane: the move names the new track.
  const moved = await rect('clp_sq');
  await expect.poll(async () => (await rect('clp_sq')).x).toBe(start.x + 80);
  const view = await hooks.view();
  const from = { x: box.x + moved.x + 20, y: box.y + moved.y + moved.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + view.laneHeight, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 2}`);
  await expect.poll(async () => (await fetchClip('clp_sq'))?.trackId).toBe('trk_b');
  expect((await fetchClip('clp_sq'))!.position.value).toBe(String(80 * fpp));
});

test('dragging the right handle issues clip.trim', async () => {
  prepare([place('clp_sq', 'trk_a', 'med_sq', 0)]);
  await launch();
  const start = await rect('clp_sq');
  const box = await canvasBox();
  const fpp = await framesPerPixel();
  const before = await revision();
  const handle = { x: box.x + start.x + start.width - 2, y: box.y + start.y + start.height / 2 };
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x - 60, handle.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  await expect.poll(async () => (await fetchClip('clp_sq'))?.length).toBe(String(FRAMES - 60 * fpp));
  const clip = (await fetchClip('clp_sq'))!;
  expect(clip.position.value).toBe('0');
  expect(clip.sourceStart).toBe('0');
});

test('delete issues clip.remove', async () => {
  prepare([place('clp_sq', 'trk_a', 'med_sq', 0), place('clp_si', 'trk_b', 'med_si', 0)]);
  await launch();
  const target = await rect('clp_si');
  const box = await canvasBox();
  const before = await revision();
  await page.mouse.click(box.x + target.x + target.width / 2, box.y + target.y + target.height / 2);
  await expect(page.getByTestId('selected-clip')).toHaveText('clp_si');
  // Selecting is no command.
  await expect(page.getByTestId('revision')).toHaveText(`r${before}`);
  await page.getByTestId('delete-clip').click();
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  expect(await fetchClip('clp_si')).toBeNull();
  expect(await fetchClip('clp_sq')).not.toBeNull();
  await expect(page.getByTestId('selected-clip')).toHaveText('');
});

test('a stale revision is refused and not retried', async () => {
  prepare([place('clp_sq', 'trk_a', 'med_sq', 0)]);
  await launch();
  const start = await rect('clp_sq');
  const box = await canvasBox();
  const before = await revision();
  const grab = { x: box.x + start.x + start.width / 2, y: box.y + start.y + start.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 50, grab.y, { steps: 5 });
  // Another client commits while the clip is held.
  const client = await engineClient();
  try {
    await client.call('command.execute', { commands: [{ op: 'track.add', trackId: 'trk_c', name: 'C', channels: 1 }] });
  } finally {
    client.close();
  }
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  await page.mouse.up();
  await expect(page.getByTestId('timeline-error')).toHaveText(/revision_mismatch/);
  // The gesture was discarded, not retried at the new revision.
  expect((await fetchClip('clp_sq'))!.position.value).toBe('0');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 1}`);
  const inspect = await engineClient();
  try {
    expect((await inspect.call('session.inspect')).revision).toBe(`r${before + 1}`);
  } finally {
    inspect.close();
  }
  await expect.poll(async () => (await rect('clp_sq')).x).toBe(start.x);
});
