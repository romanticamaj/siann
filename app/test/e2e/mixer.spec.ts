// The mixer end to end (m5-mixer; spec "Gestures", Protocol v0 item 24): a
// strip per track, a fader drag that is one gesture (no revision while it is
// held, exactly one at release), mute and solo committed through
// command.execute, meters from the realtime channel's binary frames, and a
// renderer reload mid-drag that the engine ends as disconnected. The engine
// runs on the fake device: frames flow while stopped (entry count 0 until the
// first meter reading), and the meters read once the transport plays. Waits
// are Playwright condition waits with bounded timeouts.

import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const TRACK = 'trk_mix';
const LEASE_MS = 5000;

function engineExe(): string {
  const exe = process.env.SIANN_ENGINE_EXE;
  if (!exe) throw new Error('set SIANN_ENGINE_EXE to the built siann-engine executable');
  if (!fs.existsSync(exe)) throw new Error(`SIANN_ENGINE_EXE points at a missing file: ${exe}`);
  return exe;
}

let scratch: string;
let app: ElectronApplication;
let page: Page;
let watcher: EngineClient | null = null;

test.beforeEach(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-mixer-'));
  app = await electron.launch({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: engineExe(),
      SIANN_SESSION_DIR: path.join(scratch, 'sessions'),
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: '--device fake',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId('sync-count')).not.toHaveText('0');
});

test.afterEach(async () => {
  watcher?.close();
  watcher = null;
  await app?.close().catch(() => undefined);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function revisions(client: EngineClient): Promise<number> {
  return (await client.call('session.inspect')).revisions as number;
}

async function fetchedTrack(client: EngineClient): Promise<Record<string, unknown>> {
  const fetched = (await client.call('session.fetch', { refs: [`track:${TRACK}`] })) as {
    entities: Array<{ entity: Record<string, unknown> }>;
  };
  return fetched.entities[0]!.entity;
}

// Adds the track through a second client and waits for its strip.
async function withTrack(): Promise<EngineClient> {
  const client = await engineClient(page);
  await client.call('command.execute', { commands: [{ op: 'track.add', trackId: TRACK, name: 'Mix', channels: 2 }] });
  await expect(page.getByTestId(`mixer-strip-${TRACK}`)).toBeVisible();
  return client;
}

// A point on the fader's track at `fraction` of its width.
async function faderPoint(fader: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const box = await fader.boundingBox();
  if (!box) throw new Error('the fader has no box');
  return { x: box.x + box.width * fraction, y: box.y + box.height / 2 };
}

// Mouse down on the fader and a few moves; the button stays down. The
// timeline sits above the mixer, so the strip may start below the window:
// mouse events at a point outside the viewport reach nothing.
async function dragWithoutRelease(fader: Locator): Promise<void> {
  await fader.scrollIntoViewIfNeeded();
  const start = await faderPoint(fader, 0.5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const fraction of [0.45, 0.4, 0.35, 0.3]) {
    const point = await faderPoint(fader, fraction);
    await page.mouse.move(point.x, point.y, { steps: 3 });
  }
}

// The renderer's gesture controller has nothing in flight and nothing unsent.
async function gestureSettled(): Promise<void> {
  await page.waitForFunction(() => {
    const controller = (window as unknown as { __siannGestures?: { settled: boolean } }).__siannGestures;
    return controller?.settled === true;
  });
}

test('a track added by another client gets a strip with fader, pan, mute, solo and meter', async () => {
  const client = await withTrack();
  for (const id of ['fader', 'pan', 'mute', 'solo', 'meter']) {
    await expect(page.getByTestId(`${id}-${TRACK}`)).toBeVisible();
  }
  await expect(page.getByTestId(`fader-${TRACK}`)).toHaveValue('0');
  client.close();
});

test('a fader drag commits exactly one revision at release, and nothing while held', async () => {
  const client = await withTrack();
  watcher = await engineClient(page, { events: true });
  const before = await revisions(client);
  const fader = page.getByTestId(`fader-${TRACK}`);

  await dragWithoutRelease(fader);
  await gestureSettled();
  const moved = Number(await fader.inputValue());
  expect(moved).toBeLessThan(0);
  // The engine holds the gesture: another client cannot take the fader.
  expect(await client.refused('gesture.begin', { target: { ref: `track:${TRACK}`, param: 'gain' } })).toBe('gesture_held');
  expect(await revisions(client)).toBe(before);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText(String(moved));

  await page.mouse.up();
  await expect.poll(() => revisions(client)).toBe(before + 1);
  expect((await fetchedTrack(client)).gainMilliDb).toBe(moved);
  await expect.poll(() => watcher!.ofType('gesture.ended').length).toBe(1);
  const ended = watcher.ofType('gesture.ended')[0]!;
  expect(ended.reason).toBe('ended');
  expect(ended.value).toBe(moved);
  const changed = watcher.ofType('session.changed');
  expect(changed).toHaveLength(1);
  expect(changed[0]!.revision).toBe(ended.committed);
  expect(changed[0]!.cause).toBe('command');
  // The committed value stays in the strip after the overlay is gone.
  await expect(fader).toHaveValue(String(moved));
  expect(await revisions(client)).toBe(before + 1);
  client.close();
});

test('mute and solo commit one revision each and the buttons show the commit', async () => {
  const client = await withTrack();
  const before = await revisions(client);
  const mute = page.getByTestId(`mute-${TRACK}`);
  const solo = page.getByTestId(`solo-${TRACK}`);
  await expect(mute).toHaveAttribute('aria-pressed', 'false');

  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  expect(await revisions(client)).toBe(before + 1);
  expect((await fetchedTrack(client)).mute).toBe(true);

  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  expect(await revisions(client)).toBe(before + 2);
  expect((await fetchedTrack(client)).solo).toBe(true);

  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  expect(await revisions(client)).toBe(before + 3);
  client.close();
});

test('meters come from the realtime channel: frames keep arriving with one entry per legend entity', async () => {
  const client = await withTrack();
  const meter = page.getByTestId(`meter-${TRACK}`);
  // Stopped: frames already arrive.
  await expect.poll(async () => Number((await meter.getAttribute('data-frames')) ?? '0')).toBeGreaterThan(0);
  const first = Number(await meter.getAttribute('data-frames'));
  await expect.poll(async () => Number((await meter.getAttribute('data-frames')) ?? '0')).toBeGreaterThan(first);
  // Playing: every metered entity has a reading in each frame.
  expect((await client.call('transport.play')).playing).toBe(true);
  // The legend of the graph with the track: the master and the track.
  const synced = (await client.call('session.sync')) as { meters: { entities: string[] } };
  expect(synced.meters.entities).toContain(`track:${TRACK}`);
  await expect(meter).toHaveAttribute('data-legend', String(synced.meters.entities.length));
  await expect(meter).toHaveAttribute('data-entries', String(synced.meters.entities.length));
  expect(await meter.getAttribute('data-peak')).toMatch(/^\d/);
  await client.call('transport.stop');
  client.close();
});

test('a reload during a held drag ends the gesture as disconnected within the lease, and the renderer syncs to it', async () => {
  const client = await withTrack();
  watcher = await engineClient(page, { events: true });
  const before = await revisions(client);
  const fader = page.getByTestId(`fader-${TRACK}`);

  await dragWithoutRelease(fader);
  await gestureSettled();
  const held = Number(await fader.inputValue());
  expect(held).toBeLessThan(0);
  expect(await revisions(client)).toBe(before);

  const reloaded = Date.now();
  await page.reload();
  await expect.poll(() => watcher!.ofType('gesture.ended').length, { timeout: LEASE_MS }).toBe(1);
  expect(Date.now() - reloaded).toBeLessThan(LEASE_MS);
  await page.mouse.up();
  const ended = watcher.ofType('gesture.ended')[0]!;
  expect(ended.reason).toBe('disconnected');
  expect(ended.value).toBe(held);
  expect(watcher.ofType('session.changed')).toHaveLength(1);
  expect(await revisions(client)).toBe(before + 1);
  expect((await fetchedTrack(client)).gainMilliDb).toBe(held);

  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId(`fader-${TRACK}`)).toHaveValue(String(held));
  client.close();
});
