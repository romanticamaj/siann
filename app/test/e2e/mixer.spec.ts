// The MixConsole end to end (m5-ui-mixer; UI redesign spec 3.4, 4.5 C7, 5.3,
// 5.6; spec "Gestures", Protocol v0 item 24). The bundle is prepared with
// siann-cli (SIANN_CLI_EXE): trk_mix with a 10 s square wave at 0.9 of full
// scale, and trk_two, empty. The app runs the real siann-engine
// (SIANN_ENGINE_EXE) on the fake device, which meters only while playing, so
// every meter assertion plays the transport. A second protocol client (the
// "other client") reads revisions and commits, and a third watches events.
//
// Covered: strip order and the master strip; values in dB and L/C/R; a fader
// drag is one gesture (nothing committed while held, a value tooltip, one
// revision and one gesture.ended at release); a fader held still keeps its
// lease; Shift-drag moves a tenth as far; Ctrl-click resets gain and pan in
// one revision, on the strip and in the Inspector; a typed gain and pan; a
// gain above +6 dB pins the cap; the Inspector agrees with the strip; one
// meter canvas whose peak, hold and clip come from the realtime frames; clip
// latch and reset; zero React commits while playing (profiling bundle);
// mute and solo; a reload during a held drag. Waits are Playwright condition
// waits with bounded timeouts; none sleeps.

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { launchElectron } from './support/launch';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const TRACK = 'trk_mix';
const OTHER = 'trk_two';
const RATE = 48000;
const FRAMES = RATE * 10;
const LEASE_MS = 5000;
const INT32_MIN = -2147483648;

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

// A mono 16-bit PCM WAV: a square wave at 0.9 of full scale.
function loudWav(file: string): void {
  const data = Buffer.alloc(FRAMES * 2);
  const level = Math.round(0.9 * 32767);
  for (let i = 0; i < FRAMES; i += 1) data.writeInt16LE(Math.floor(i / 240) % 2 === 0 ? level : -level, i * 2);
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

let scratch: string;
let app: ElectronApplication;
let page: Page;
let client: EngineClient;
let watcher: EngineClient | null = null;

function prepare(): void {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-mixer-'));
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'Mixer', '--rate', String(RATE));
  cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: TRACK, name: 'Mix', channels: 2 }));
  cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: OTHER, name: 'Two', channels: 2 }));
  loudWav(path.join(scratch, 'loud.wav'));
  cli('import', bundle, path.join(scratch, 'loud.wav'), '--media-id', 'med_loud');
  cli(
    'exec',
    bundle,
    JSON.stringify({ op: 'clip.place', clipId: 'clp_loud', trackId: TRACK, mediaId: 'med_loud', position: { domain: 'audio', value: '0' }, sourceStart: '0', length: String(FRAMES) }),
  );
}

async function launch(env: Record<string, string> = {}): Promise<void> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  app = await launchElectron({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: path.join(scratch, 'sessions'),
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: '--device fake',
      ...env,
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId(`mixer-strip-${TRACK}`)).toBeVisible();
  client = await engineClient(page);
}

test.beforeEach(() => {
  prepare();
});

test.afterEach(async () => {
  watcher?.close();
  watcher = null;
  client?.close();
  await app?.close().catch(() => undefined);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function revisions(): Promise<number> {
  return (await client.call('session.inspect')).revisions as number;
}

async function fetchedTrack(id = TRACK): Promise<Record<string, unknown>> {
  const fetched = (await client.call('session.fetch', { refs: [`track:${id}`] })) as {
    entities: Array<{ entity: Record<string, unknown> }>;
  };
  return fetched.entities[0]!.entity;
}

async function setGain(milliDb: number, id = TRACK): Promise<void> {
  await client.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: id, gainMilliDb: milliDb }] });
  await expect(page.getByTestId(`fader-${id}`)).toHaveAttribute('aria-valuenow', String(milliDb));
}

async function valueNow(control: Locator): Promise<number> {
  return Number(await control.getAttribute('aria-valuenow'));
}

// The centre of a fader's cap, where a drag starts.
async function capCentre(fader: Locator): Promise<{ x: number; y: number }> {
  await fader.scrollIntoViewIfNeeded();
  const box = await fader.locator('.fader-cap').boundingBox();
  if (!box) throw new Error('the fader cap has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Mouse down on the cap and a move by (dx, dy) in a few steps; the button stays down.
async function dragWithoutRelease(control: Locator, dx: number, dy: number): Promise<void> {
  const start = await capCentre(control);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
}

// The renderer's gesture controller has nothing in flight and nothing unsent.
async function gestureSettled(): Promise<void> {
  await page.waitForFunction(() => {
    const controller = (window as unknown as { __siannGestures?: { settled: boolean } }).__siannGestures;
    return controller?.settled === true;
  });
}

async function gestureIdle(): Promise<void> {
  await page.waitForFunction(() => {
    const controller = (window as unknown as { __siannGestures?: { active: boolean } }).__siannGestures;
    return controller?.active === false;
  });
}

type MeterReading = { peak: number; hold: number; clip: boolean } | null;

async function meter(ref: string): Promise<MeterReading> {
  return page.evaluate((r) => {
    const hooks = (window as unknown as { __siannMeters?: { read(ref: string): MeterReading } }).__siannMeters;
    if (!hooks) throw new Error('window.__siannMeters is missing (SIANN_SHELL_TEST=1)');
    return hooks.read(r);
  }, ref);
}

async function meterFrames(): Promise<number> {
  return page.evaluate(() => (window as unknown as { __siannMeters: { frames(): number } }).__siannMeters.frames());
}

// A modifier held around a click or a drag.
async function withKey<T>(key: 'Control' | 'Shift', action: () => Promise<T>): Promise<T> {
  await page.keyboard.down(key);
  try {
    return await action();
  } finally {
    await page.keyboard.up(key);
  }
}

test('strips in track order, a master strip, values in dB and L/C/R', async () => {
  await launch();
  const strips = page.locator('[data-testid^="mixer-strip-"]');
  await expect(strips).toHaveCount(3);
  expect(await strips.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).toEqual([
    `mixer-strip-${TRACK}`,
    `mixer-strip-${OTHER}`,
    'mixer-strip-master',
  ]);
  const master = page.getByTestId('mixer-strip-master');
  await expect(master.getByTestId('meter-master')).toBeVisible();
  await expect(master.getByTestId('peak-value-master')).toBeVisible();
  await expect(master.locator('[role="slider"]')).toHaveCount(0);
  await expect(master.locator('button[aria-pressed]')).toHaveCount(0);

  await client.call('command.execute', {
    commands: [
      { op: 'track.set_gain', trackId: TRACK, gainMilliDb: -6500 },
      { op: 'track.set_pan', trackId: TRACK, pan: -3500 },
    ],
  });
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText('-6.5 dB');
  await expect(page.getByTestId(`fader-${TRACK}`)).toHaveAttribute('aria-valuetext', '-6.5 dB');
  await expect(page.getByTestId(`pan-${TRACK}`)).toHaveText('L35');
  await expect(page.getByTestId(`fader-value-${OTHER}`)).toHaveText('0.0 dB');
  await expect(page.getByTestId(`pan-${OTHER}`)).toHaveText('C');
  // No milli-dB or internal pan unit anywhere in the lower zone.
  expect(await page.getByTestId('mixer').innerText()).not.toMatch(/\d{4,}/);
});

test('a fader drag commits exactly one revision at release, shows a tooltip, and nothing while held', async () => {
  await launch();
  watcher = await engineClient(page, { events: true });
  const before = await revisions();
  const fader = page.getByTestId(`fader-${TRACK}`);
  const tooltip = page.getByTestId(`fader-${TRACK}-tooltip`);
  await expect(tooltip).toBeHidden();

  await dragWithoutRelease(fader, 0, 25);
  await gestureSettled();
  const moved = await valueNow(fader);
  expect(moved).toBeLessThan(0);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/^-\d+\.\d dB$/);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText(await tooltip.innerText());
  // The engine holds the gesture: another client cannot take the fader.
  expect(await client.refused('gesture.begin', { target: { ref: `track:${TRACK}`, param: 'gain' } })).toBe('gesture_held');
  expect(await revisions()).toBe(before);

  await page.mouse.up();
  await expect(tooltip).toBeHidden();
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).gainMilliDb).toBe(moved);
  await expect.poll(() => watcher!.ofType('gesture.ended').length).toBe(1);
  const ended = watcher.ofType('gesture.ended')[0]!;
  expect(ended.reason).toBe('ended');
  expect(ended.value).toBe(moved);
  const changed = watcher.ofType('session.changed');
  expect(changed).toHaveLength(1);
  expect(changed[0]!.revision).toBe(ended.committed);
  await expect(fader).toHaveAttribute('aria-valuenow', String(moved));
  expect(await revisions()).toBe(before + 1);
});

test('a fader held still past the lease keeps it: the holds renew it and nothing ends', async () => {
  await launch();
  watcher = await engineClient(page, { events: true });
  const fader = page.getByTestId(`fader-${TRACK}`);
  await dragWithoutRelease(fader, 0, 20);
  await gestureSettled();
  // gesture.hold goes out every leaseMs / 2: three answered holds span more than one lease.
  await page.waitForFunction(
    () => ((window as unknown as { __siannGestures: { holdsAnswered: number } }).__siannGestures.holdsAnswered ?? 0) >= 3,
    undefined,
    { timeout: LEASE_MS * 4 },
  );
  expect(watcher.ofType('gesture.ended')).toHaveLength(0);
  expect(await client.refused('gesture.begin', { target: { ref: `track:${TRACK}`, param: 'gain' } })).toBe('gesture_held');
  await page.mouse.up();
  await expect.poll(() => watcher!.ofType('gesture.ended').length).toBe(1);
  expect(watcher.ofType('gesture.ended')[0]!.reason).toBe('ended');
});

test('Shift-drag moves a tenth as far as the same plain drag', async () => {
  await launch();
  const fader = page.getByTestId(`fader-${TRACK}`);
  // From -4 dB, 12 px down stays between the -12 and 0 dB breakpoints (linear in dB).
  await setGain(-4000);
  await dragWithoutRelease(fader, 0, 12);
  await page.mouse.up();
  await gestureIdle();
  await expect.poll(async () => (await fetchedTrack()).gainMilliDb).not.toBe(-4000);
  const plain = ((await fetchedTrack()).gainMilliDb as number) + 4000;

  await setGain(-4000);
  await withKey('Shift', async () => {
    await dragWithoutRelease(fader, 0, 12);
    await page.mouse.up();
  });
  await gestureIdle();
  await expect.poll(async () => (await fetchedTrack()).gainMilliDb).not.toBe(-4000);
  const fine = ((await fetchedTrack()).gainMilliDb as number) + 4000;
  expect(plain).toBeLessThan(-1000);
  expect(Math.abs(fine - plain / 10)).toBeLessThanOrEqual(2);
});

test('Ctrl-click resets a fader to 0.0 dB and a pan to C in one revision each, on the strip and in the Inspector', async () => {
  await launch();
  await client.call('command.execute', {
    commands: [
      { op: 'track.set_gain', trackId: TRACK, gainMilliDb: -4000 },
      { op: 'track.set_pan', trackId: TRACK, pan: -3500 },
    ],
  });
  const fader = page.getByTestId(`fader-${TRACK}`);
  const pan = page.getByTestId(`pan-${TRACK}`);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText('-4.0 dB');
  await expect(pan).toHaveText('L35');

  let before = await revisions();
  await withKey('Control', () => fader.click());
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).gainMilliDb).toBe(0);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText('0.0 dB');

  before = await revisions();
  await withKey('Control', () => pan.click());
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).pan).toBe(0);
  await expect(pan).toHaveText('C');
  await gestureIdle();
  expect(await revisions()).toBe(before + 1);

  // The Inspector's controls: select the track's clip.
  await client.call('command.execute', {
    commands: [
      { op: 'track.set_gain', trackId: TRACK, gainMilliDb: -4000 },
      { op: 'track.set_pan', trackId: TRACK, pan: -3500 },
    ],
  });
  await selectClip();
  const volume = page.getByTestId('inspector-volume');
  const inspectorPan = page.getByTestId('inspector-pan');
  await expect(volume).toHaveAttribute('aria-valuetext', '-4.0 dB');
  before = await revisions();
  await withKey('Control', () => volume.click());
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).gainMilliDb).toBe(0);
  before = await revisions();
  await withKey('Control', () => inspectorPan.click());
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).pan).toBe(0);
  await gestureIdle();
  expect(await revisions()).toBe(before + 1);
});

test('double-clicking a value takes a typed gain or pan; Enter commits one revision, Escape nothing', async () => {
  await launch();
  let before = await revisions();
  await page.getByTestId(`fader-value-${TRACK}`).dblclick();
  const input = page.getByTestId(`gain-input-${TRACK}`);
  await expect(input).toBeFocused();
  await input.fill('-6.5');
  await input.press('Enter');
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).gainMilliDb).toBe(-6500);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText('-6.5 dB');
  await expect(input).toHaveCount(0);

  before = await revisions();
  await page.getByTestId(`fader-value-${TRACK}`).dblclick();
  await input.fill('-20');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await gestureIdle();
  expect(await revisions()).toBe(before);
  expect((await fetchedTrack()).gainMilliDb).toBe(-6500);

  await page.getByTestId(`pan-${TRACK}`).dblclick();
  const panInput = page.getByTestId(`pan-input-${TRACK}`);
  await expect(panInput).toBeFocused();
  await panInput.fill('R40');
  await panInput.press('Enter');
  await expect.poll(() => revisions()).toBe(before + 1);
  expect((await fetchedTrack()).pan).toBe(4000);
  await expect(page.getByTestId(`pan-${TRACK}`)).toHaveText('R40');
});

test('a gain above +6 dB stored by another client pins the cap at the top and shows the true value', async () => {
  await launch();
  await setGain(9000);
  const fader = page.getByTestId(`fader-${TRACK}`);
  await expect(fader).toHaveAttribute('data-position', '1');
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText('+9.0 dB');
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveClass(/\bwarn\b/);
  const track = (await fader.boundingBox())!;
  const cap = (await fader.locator('.fader-cap').boundingBox())!;
  expect(cap.y - track.y).toBeLessThanOrEqual(1);
  await setGain(6000);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).not.toHaveClass(/\bwarn\b/);
  await setGain(INT32_MIN);
  await expect(page.getByTestId(`fader-value-${TRACK}`)).toHaveText('-inf dB');
});

// Selects the track's clip on the timeline (the Inspector shows the selected clip's track).
async function selectClip(): Promise<void> {
  const rect = await page.evaluate(async () => {
    const hooks = (window as unknown as { __siannTimeline?: { clips(): Array<{ clipId: string; x: number; y: number; width: number; height: number }> } }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing');
    return hooks.clips().find((r) => r.clipId === 'clp_loud') ?? null;
  });
  if (!rect) throw new Error('clp_loud is not drawn');
  const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(box.x + rect.x + Math.min(20, rect.width / 2), box.y + rect.y + rect.height / 2);
  await expect(page.getByTestId('inspector-track')).toHaveText('Mix');
}

test('the Inspector agrees with the strip, during a held drag and after the commit, in both directions', async () => {
  await launch();
  await selectClip();
  const fader = page.getByTestId(`fader-${TRACK}`);
  const volume = page.getByTestId('inspector-volume');
  const same = async () => {
    expect(await volume.getAttribute('aria-valuenow')).toBe(await fader.getAttribute('aria-valuenow'));
    expect(await volume.getAttribute('aria-valuetext')).toBe(await fader.getAttribute('aria-valuetext'));
    await expect(page.getByTestId('inspector-volume-value')).toHaveText((await page.getByTestId(`fader-value-${TRACK}`).innerText()).trim());
  };
  await same();

  let before = await revisions();
  await dragWithoutRelease(fader, 0, 25);
  await gestureSettled();
  expect(await valueNow(fader)).toBeLessThan(0);
  await same();
  await page.mouse.up();
  await expect.poll(() => revisions()).toBe(before + 1);
  await gestureIdle();
  await same();

  // The Inspector's volume is horizontal: a drag to the left lowers it.
  before = await revisions();
  const stripValue = await valueNow(fader);
  await dragWithoutRelease(volume, -30, 0);
  await gestureSettled();
  expect(await valueNow(volume)).toBeLessThan(stripValue);
  await same();
  await page.mouse.up();
  await expect.poll(() => revisions()).toBe(before + 1);
  await gestureIdle();
  await same();
  expect((await fetchedTrack()).gainMilliDb).toBe(await valueNow(fader));
});

test('one meter canvas draws every strip from the realtime frames while playing', async () => {
  await launch();
  await expect(page.getByTestId('mixer').locator('canvas')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __siannMeters: { canvases: number } }).__siannMeters.canvases)).toBe(1);
  expect((await client.call('transport.play')).playing).toBe(true);
  await expect.poll(async () => (await meter(`track:${TRACK}`))?.peak ?? 0).toBeGreaterThan(0.5);
  await expect.poll(async () => (await meter('master'))?.peak ?? 0).toBeGreaterThan(0.3);
  expect((await meter(`track:${OTHER}`))?.peak ?? 0).toBe(0);
  const frames = await meterFrames();
  await expect.poll(() => meterFrames()).toBeGreaterThan(frames + 5);
  // The peak value reads in dBFS with one decimal.
  await expect(page.getByTestId(`peak-value-${TRACK}`)).toHaveText(/^[-+]?\d+\.\d$/);
  expect((await meter(`track:${TRACK}`))!.clip).toBe(false);
  await client.call('transport.stop');
});

test('a clip latches after stop until the peak value is clicked', async () => {
  await launch();
  await setGain(6000);
  await client.call('transport.play');
  await expect.poll(async () => (await meter(`track:${TRACK}`))?.clip ?? false).toBe(true);
  await client.call('transport.stop');
  // Stopped: the peak decays, the clip stays.
  await expect.poll(async () => (await meter(`track:${TRACK}`))?.peak ?? 1).toBe(0);
  expect((await meter(`track:${TRACK}`))!.clip).toBe(true);
  const peakValue = page.getByTestId(`peak-value-${TRACK}`);
  await expect(peakValue).toHaveText(/^\+\d+\.\d$/);
  await expect(peakValue).toHaveClass(/\bclip\b/);
  await peakValue.click();
  await expect.poll(async () => (await meter(`track:${TRACK}`))!.clip).toBe(false);
  await expect(peakValue).toHaveText('-inf');
  await expect(peakValue).not.toHaveClass(/\bclip\b/);
});

test('zero React commits while playing (profiling bundle), and the counter does count commits', async () => {
  await launch({ SIANN_SHELL_PROFILING: '1' });
  const commits = () => page.evaluate(() => (window as unknown as { __siannCommits?: number }).__siannCommits ?? 0);
  // The counter moves on a commit: a mute click re-renders the strip.
  const first = await commits();
  await page.getByTestId(`mute-${TRACK}`).click();
  await expect(page.getByTestId(`mute-${TRACK}`)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(commits).toBeGreaterThan(first);
  await page.getByTestId(`mute-${TRACK}`).click();
  await expect(page.getByTestId(`mute-${TRACK}`)).toHaveAttribute('aria-pressed', 'false');

  await client.call('transport.play');
  await expect.poll(async () => (await meter(`track:${TRACK}`))?.peak ?? 0).toBeGreaterThan(0.5);
  // Let the commits a play causes (the playing flag) settle, then count over meter frames.
  const startFrames = await meterFrames();
  await expect.poll(() => meterFrames()).toBeGreaterThan(startFrames + 10);
  const before = await commits();
  const frames = await meterFrames();
  await expect.poll(() => meterFrames()).toBeGreaterThan(frames + 60);
  expect(await commits()).toBe(before);
  await client.call('transport.stop');
});

test('mute and solo commit one revision each and the buttons show the commit', async () => {
  await launch();
  const before = await revisions();
  const mute = page.getByTestId(`mute-${TRACK}`);
  const solo = page.getByTestId(`solo-${TRACK}`);
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  expect(await revisions()).toBe(before + 1);
  expect((await fetchedTrack()).mute).toBe(true);
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  expect(await revisions()).toBe(before + 2);
  expect((await fetchedTrack()).solo).toBe(true);
});

test('a reload during a held drag ends the gesture as disconnected within the lease, and the renderer syncs to it', async () => {
  await launch();
  watcher = await engineClient(page, { events: true });
  const before = await revisions();
  const fader = page.getByTestId(`fader-${TRACK}`);
  await dragWithoutRelease(fader, 0, 25);
  await gestureSettled();
  const held = await valueNow(fader);
  expect(held).toBeLessThan(0);
  const reloaded = Date.now();
  await page.reload();
  await expect.poll(() => watcher!.ofType('gesture.ended').length, { timeout: LEASE_MS }).toBe(1);
  expect(Date.now() - reloaded).toBeLessThan(LEASE_MS);
  await page.mouse.up();
  const ended = watcher.ofType('gesture.ended')[0]!;
  expect(ended.reason).toBe('disconnected');
  expect(ended.value).toBe(held);
  expect(await revisions()).toBe(before + 1);
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId(`fader-${TRACK}`)).toHaveAttribute('aria-valuenow', String(held));
});
