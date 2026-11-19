// Recording in the UI end to end (m5b-ui-recording; UI redesign UR-8, 3.1,
// 3.3, 3.5; 10.11, 16 to 21): the app on the real siann-engine and the paced
// fake device, whose two outputs loop back to two inputs once the input is
// opened (engine.select_device {id: "fake", inputId: "fake"}, from a second
// protocol client). The input a recording takes is the loopback of a seeded
// clip playing on another track. At 240 BPM a bar is one second.
//
// - Record enable from the header, the strip, the Inspector and R; a second
//   client arms and sets an input and the window follows; the input selector
//   sends track.set_input.
// - Record's disabled reasons: no input open (a click opens Studio Setup),
//   nothing armed.
// - A recording after a one-bar count-in starts at the record position and,
//   stopped after four bars, is one clip of at least four bars; while it
//   runs a red clip grows on the armed track with no React commit per frame;
//   Ctrl+Z removes the committed clip.
// - Punch in and out at the locators give a clip of exactly [left, right).
// - Monitor: the monitored track's meter shows its input (the seeded clip's
//   loopback, the track's fader lowered so the loop decays), and nothing with
//   monitoring off.
// - The engine killed while recording: the restarted engine lists the takes
//   and the window offers Keep and Discard per take.
// - The edit guard (4.5 C5; 10.11, 22): while a proposal is heard Record, the
//   In selector and the monitor are disabled with the guard's reason and the
//   keys send nothing; record enable still arms.
// - Against capabilities without features.recording none of the controls
//   exists.
//
// Waits are condition polls, never sleeps.

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, launchApp, seedBundle, selectPlan } from './support/seed';

const RATE = 48000;
// 240 BPM: one bar of four quarter notes is one second.
const BAR = RATE;
const FIXTURES = path.resolve(__dirname, '..', 'unit', 'fixtures');

interface Request {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Clip {
  readonly id: string;
  readonly trackId: string;
  readonly position: { readonly value: string };
  readonly length: string;
}

interface RecordingClip {
  readonly takeId: string;
  readonly trackId: string;
  readonly start: string;
  readonly end: string;
  readonly columns: number;
}

let scratch = '';
let sessionDir = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

test.setTimeout(120_000);

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-recording-'));
  // The source plays the seeded square wave every second for twelve seconds.
  sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_src', name: 'Source' },
      { id: 'trk_rec', name: 'Vox', input: { port: 0, channels: 1 } },
      { id: 'trk_rec2', name: 'Keys', input: { port: 1, channels: 1 } },
    ],
    Array.from({ length: 12 }, (_, i) => ({ id: `clp_src_${i}`, trackId: 'trk_src', at: i })),
    { tempoMilliBpm: 240000 },
  );
});

test.afterEach(async () => {
  engine?.close();
  engine = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(env: Record<string, string> = {}, options: { input?: boolean } = {}): Promise<void> {
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  engine = await engineClient(page);
  await expect(page.getByTestId('clip-count')).toHaveText('12');
  if (options.input !== false) await openInput();
}

// The fake device with its input: the outputs loop back to the inputs.
async function openInput(): Promise<void> {
  await engine!.call('engine.select_device', { id: 'fake', inputId: 'fake' });
  await expect.poll(async () => ((await engine!.call('engine.status')).device as { input: unknown } | null)?.input ?? null).not.toBeNull();
  // The window's engine.status poll has seen the input.
  await expect(page.getByTestId('transport-record')).not.toHaveAttribute('title', new RegExp(en['record.reason.noInput']));
}

async function sent(): Promise<Request[]> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient?: { sent(): Request[] } }).__siannClient;
    if (!client) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return client.sent().map((r) => ({ method: r.method, params: r.params }));
  });
}

async function commands(op: string): Promise<Array<Record<string, unknown>>> {
  return (await sent())
    .filter((r) => r.method === 'command.execute')
    .flatMap((r) => (r.params.commands as Array<Record<string, unknown>>) ?? [])
    .filter((c) => c.op === op);
}

async function hook<T>(name: string): Promise<T> {
  return page.evaluate((called) => {
    const hooks = (window as unknown as { __siannTimeline?: Record<string, () => unknown> }).__siannTimeline;
    if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
    return hooks[called]!();
  }, name) as Promise<T>;
}

async function playhead(): Promise<number> {
  const at = await page.evaluate(() => (window as unknown as { __siannTransport?: { playhead(): string | null } }).__siannTransport?.playhead() ?? null);
  return at === null ? -1 : Number(at);
}

async function clips(): Promise<Clip[]> {
  const sync = await engine!.call('session.sync');
  return ((sync.chunk as { clips?: Clip[] }).clips ?? []).filter((c) => !c.id.startsWith('clp_src_'));
}

async function armed(): Promise<string[]> {
  return (await engine!.call('engine.status')).armed as string[];
}

const header = (id: string) => page.getByTestId(`track-header-${id}`);

async function selectTrack(id: string): Promise<void> {
  await header(id).locator('.name').click();
  await expect(header(id)).toHaveAttribute('aria-selected', 'true');
}

async function focusProject(): Promise<void> {
  const box = await page.getByTestId('timeline-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.click(box.x + 20, box.y + box.height - 10);
}

async function openOptions() {
  // force: Record may be aria-disabled (nothing armed), which Playwright's actionability check refuses; a person's right-click is not.
  await page.getByTestId('transport-record').click({ button: 'right', force: true });
  const panel = page.getByTestId('record-options');
  await expect(panel).toBeVisible();
  return panel;
}

test('record enable from the header, the strip, the Inspector and R; another client\'s arming and input show; the input selector sends track.set_input', async () => {
  await launch();
  // Each id of the mockup's recording parts is in the window.
  for (const part of ['transport-record']) await expect(page.locator(`[data-part="${part}"]`)).toHaveCount(1);
  await expect(header('trk_rec').locator('[data-part-of="record"]')).toHaveCount(1);
  await expect(page.getByTestId('mixer-strip-trk_rec').locator('[data-part-of="record"]')).toHaveCount(1);

  const headerRecord = page.getByTestId('track-record-trk_rec');
  const stripRecord = page.getByTestId('strip-record-trk_rec');
  await headerRecord.click();
  await expect(headerRecord).toHaveAttribute('aria-pressed', 'true');
  await expect(stripRecord).toHaveAttribute('aria-pressed', 'true');
  expect(await armed()).toEqual(['trk_rec']);
  await stripRecord.click();
  await expect(headerRecord).toHaveAttribute('aria-pressed', 'false');
  expect(await armed()).toEqual([]);

  await selectTrack('trk_rec');
  for (const part of ['inspector-record', 'inspector-monitor']) await expect(page.locator(`[data-part="${part}"]`)).toHaveCount(1);
  await page.locator('[data-part="inspector-record"]').click();
  await expect(headerRecord).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-part="inspector-record"]').click();
  await expect(headerRecord).toHaveAttribute('aria-pressed', 'false');
  // R arms the selected track from the project zone.
  await focusProject();
  await selectTrack('trk_rec');
  await page.keyboard.press('KeyR');
  await expect(headerRecord).toHaveAttribute('aria-pressed', 'true');
  const arms = (await sent()).filter((r) => r.method === 'record.arm');
  expect(arms.map((r) => r.params.armed)).toEqual([true, false, true, false, true]);

  // Another connection sets an input on the source and arms it: the window follows.
  await engine!.call('command.execute', { commands: [{ op: 'track.set_input', trackId: 'trk_src', input: { port: 1, channels: 1 } }] });
  await engine!.call('record.arm', { trackId: 'trk_src', armed: true });
  await expect(page.getByTestId('track-record-trk_src')).toHaveAttribute('aria-pressed', 'true');
  await selectTrack('trk_src');
  await expect(page.getByTestId('inspector-input-name')).toHaveText('Mono In 2');

  // The input selector: the open input's mono ports and its stereo pair.
  await selectTrack('trk_rec2');
  const select = page.getByTestId('inspector-input');
  await expect(select.locator('option')).toHaveCount(4);
  await select.selectOption({ label: 'Stereo In 1/2' });
  await expect.poll(async () => (await commands('track.set_input')).at(-1)).toEqual({ op: 'track.set_input', trackId: 'trk_rec2', input: { port: 0, channels: 2 } });
  await expect(page.getByTestId('inspector-input-name')).toHaveText('Stereo In 1/2');
});

test('Record is disabled with its reason: no input open opens Studio Setup; nothing armed', async () => {
  await launch({}, { input: false });
  const record = page.getByTestId('transport-record');
  await expect(record).toHaveAttribute('aria-disabled', 'true');
  await expect(record).toHaveAttribute('title', `${en['record.reason.noInput']}\n${en['transport.studioSetupHint']}`);
  // aria-disabled: Playwright's actionability check refuses it, a person's click does not.
  await record.click({ force: true });
  await expect(page.getByTestId('studio-setup')).toBeVisible();
  await page.keyboard.press('Escape');
  await openInput();
  await expect(record).toHaveAttribute('title', en['record.reason.nothingArmed']);
  await record.click({ force: true });
  expect((await sent()).filter((r) => r.method === 'transport.record')).toEqual([]);
  // Arming enables it.
  await page.getByTestId('track-record-trk_rec').click();
  await expect(record).not.toHaveAttribute('aria-disabled', 'true');
});

test('a recording after a one-bar count-in starts at the record position, grows a red clip with no React commit per frame, and Ctrl+Z removes it', async () => {
  await launch({ SIANN_SHELL_PROFILING: '1' });
  // The source's loopback is the only input: the recording track's monitor is off.
  const panel = await openOptions();
  // The box shows the engine's state, so it turns once the answer is in.
  await panel.getByTestId('record-option-count-in').click();
  await expect(panel.getByTestId('record-option-count-in')).toBeChecked();
  await panel.getByTestId('record-option-count-in-bars').fill('1');
  await panel.getByTestId('record-option-count-in-bars').press('Enter');
  await expect.poll(async () => (await engine!.call('engine.status')).countIn).toEqual({ enabled: true, bars: 1 });
  await page.keyboard.press('Escape');
  await page.getByTestId('track-record-trk_rec').click();
  await expect(page.getByTestId('track-record-trk_rec')).toHaveAttribute('aria-pressed', 'true');
  // Armed, Record's tooltip names the options that are on.
  await expect(page.getByTestId('transport-record')).toHaveAttribute('title', new RegExp(en['record.option.countIn']));
  const before = (await clips()).length;
  const recordAt = 0;
  await page.getByTestId('transport-record').click();
  await expect(page.getByTestId('transport-record')).toHaveAttribute('aria-pressed', 'true');
  // The red clip appears once the take has its first frame, at the record position.
  await expect.poll(async () => (await hook<RecordingClip[]>('recordingClips')).length, { timeout: 10_000 }).toBe(1);
  const first = (await hook<RecordingClip[]>('recordingClips'))[0]!;
  expect(first.trackId).toBe('trk_rec');
  expect(Number(first.start)).toBe(recordAt);
  // It grows at display rate with a live waveform, and React commits nothing per frame.
  const commits = () => page.evaluate(() => (window as unknown as { __siannCommits?: number }).__siannCommits ?? 0);
  const startCommits = await commits();
  const startEnd = Number(first.end);
  await expect.poll(async () => Number((await hook<RecordingClip[]>('recordingClips'))[0]?.end ?? 0)).toBeGreaterThan(startEnd + BAR);
  expect(await commits()).toBeLessThanOrEqual(startCommits + 2);
  expect((await hook<RecordingClip[]>('recordingClips'))[0]!.columns).toBeGreaterThan(0);
  // Past four bars, stop.
  await expect.poll(playhead, { timeout: 20_000 }).toBeGreaterThan(recordAt + 4 * BAR + BAR / 4);
  await page.getByTestId('transport-stop').click();
  await expect(page.getByTestId('transport-record')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await clips()).length).toBe(before + 1);
  const recorded = (await clips()).find((c) => c.trackId === 'trk_rec')!;
  expect(recorded.id).toMatch(/^clp_take_/);
  expect(Number(recorded.position.value)).toBe(recordAt);
  expect(Number(recorded.length)).toBeGreaterThanOrEqual(4 * BAR);
  // The red clip gave way to the committed one.
  await expect.poll(async () => (await hook<RecordingClip[]>('recordingClips')).length).toBe(0);
  // One revision: Ctrl+Z removes it.
  await focusProject();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await clips()).length).toBe(before);
});

test('punch in and out at the locators record exactly [left, right)', async () => {
  await launch();
  const left = 1 * BAR;
  const right = 3 * BAR;
  await engine!.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(left), right: String(right) }] });
  // I and O toggle the punch; the panel shows it.
  await focusProject();
  await page.keyboard.press('KeyI');
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await engine!.call('engine.status')).punch).toEqual({ in: true, out: true });
  const panel = await openOptions();
  await expect(panel.getByTestId('record-option-punch-in')).toBeChecked();
  await expect(panel.getByTestId('record-option-punch-out')).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByTestId('track-record-trk_rec').click();
  await expect(page.getByTestId('track-record-trk_rec')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('transport-record').click();
  // The punch-out ends the recording by itself; playback goes on.
  await expect.poll(async () => (await clips()).length, { timeout: 20_000 }).toBe(1);
  await expect(page.getByTestId('transport-record')).toHaveAttribute('aria-pressed', 'false');
  const recorded = (await clips())[0]!;
  expect(recorded.trackId).toBe('trk_rec');
  expect(recorded.position.value).toBe(String(left));
  expect(recorded.length).toBe(String(right - left));
  await page.getByTestId('transport-stop').click();
});

test('monitor shows the input on the track\'s meter, and nothing with monitoring off', async () => {
  await launch();
  // The monitored track's fader 20 dB down: its output loops back into its input and decays.
  await engine!.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_rec', gainMilliDb: -20000 }] });
  await selectTrack('trk_rec');
  const monitor = page.locator('[data-part="inspector-monitor"]');
  await expect(monitor).toHaveAttribute('aria-pressed', 'false');
  const peak = () => page.evaluate(() => (window as unknown as { __siannMeters?: { read(ref: string): { peak: number } | null } }).__siannMeters?.read('track:trk_rec')?.peak ?? 0);
  await page.getByTestId('transport-play').click();
  await expect.poll(playhead).toBeGreaterThan(BAR / 2);
  // Off: the track has no clip, its meter reads nothing.
  for (let i = 0; i < 5; i += 1) expect(await peak()).toBe(0);
  await monitor.click();
  await expect(monitor).toHaveAttribute('aria-pressed', 'true');
  await expect(monitor).toHaveAttribute('title', new RegExp(en['monitor.mode.input']));
  expect((await commands('track.set_monitor')).at(-1)).toEqual({ op: 'track.set_monitor', trackId: 'trk_rec', monitor: 'input' });
  await expect.poll(peak, { timeout: 10_000 }).toBeGreaterThan(0.01);
  await monitor.click();
  await expect(monitor).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(peak, { timeout: 10_000 }).toBe(0);
  await page.getByTestId('transport-stop').click();
});

test('after the engine dies while recording, the pending takes are listed with Keep and Discard', async () => {
  await launch();
  await page.getByTestId('track-record-trk_rec').click();
  await page.getByTestId('track-record-trk_rec2').click();
  await expect.poll(armed).toEqual(['trk_rec', 'trk_rec2']);
  const watcher = await engineClient(page, { events: true });
  await page.getByTestId('transport-record').click();
  // Both takes made a second durable before the kill.
  await expect
    .poll(
      () => {
        const last = watcher.ofType('record.changed').at(-1) as { takes?: Array<{ durableFrames: string }> } | undefined;
        return (last?.takes ?? []).filter((t) => Number(t.durableFrames) >= RATE).length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  const takes = (watcher.ofType('record.changed').at(-1) as unknown as { takes: Array<{ takeId: string; trackId: string }> }).takes;
  watcher.close();
  engine?.close();
  engine = undefined;
  const pid = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
  expect(pid).not.toBeNull();
  process.kill(pid!);
  await expect(page.getByTestId('status')).not.toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  engine = await engineClient(page);
  expect(((engine.auth.pendingTakes as Array<{ takeId: string }>) ?? []).map((t) => t.takeId).sort()).toEqual(takes.map((t) => t.takeId).sort());
  const dialog = page.getByTestId('pending-takes');
  await expect(dialog).toBeVisible();
  const keep = takes.find((t) => t.trackId === 'trk_rec')!;
  const discard = takes.find((t) => t.trackId === 'trk_rec2')!;
  await expect(dialog.getByTestId(`pending-take-${keep.takeId}`)).toContainText('Vox');
  await expect(dialog.getByTestId(`pending-take-${discard.takeId}`)).toContainText('Keys');
  await dialog.getByTestId(`pending-take-keep-${keep.takeId}`).click();
  await expect.poll(async () => (await clips()).map((c) => c.id)).toEqual([`clp_${keep.takeId}`]);
  await dialog.getByTestId(`pending-take-discard-${discard.takeId}`).click();
  await expect(dialog).toHaveCount(0);
  const recovers = (await sent()).filter((r) => r.method === 'record.recover_take').map((r) => r.params);
  expect(recovers).toEqual([
    { takeId: keep.takeId, accept: true },
    { takeId: discard.takeId, accept: false },
  ]);
  // The discarded take is in the bundle's trash, not committed.
  expect((await clips()).length).toBe(1);
});

test('while a proposal is heard Record, the In selector and the monitor are disabled with the guard\'s reason and send nothing; record enable still arms', async () => {
  await launch();
  // The Plans tab in the right zone (a drawer under 1280 px).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('track-record-trk_rec').click();
  await expect.poll(armed).toEqual(['trk_rec']);
  const record = page.getByTestId('transport-record');
  await expect(record).not.toHaveAttribute('aria-disabled', 'true');
  // A plan on the source track, auditioned: the branch is heard.
  const agent = await agentFor(app!);
  const hash = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: 'trk_src', gainMilliDb: -6000 }] })).hash as string;
  await selectPlan(page, hash);
  await page.getByTestId('plan-audition').click();
  await expect.poll(async () => (await engine!.call('session.inspect')).heard as string).not.toBe('main');
  await expect(page.getByTestId('hear-proposal')).toHaveAttribute('aria-pressed', 'true');
  const head = (await engine!.call('session.inspect')).revision as string;
  const guarded = async (control: Locator) => expect(control).toHaveAttribute('title', en['guard.structural']);

  await expect(record).toHaveAttribute('aria-disabled', 'true');
  await guarded(record);
  await selectTrack('trk_rec');
  const select = page.getByTestId('inspector-input');
  await expect(select).toBeDisabled();
  await guarded(select);
  const monitor = page.locator('[data-part="inspector-monitor"]');
  await expect(monitor).toBeDisabled();
  await guarded(monitor);
  // aria-disabled: Playwright's actionability check refuses it, a person's click does not.
  await record.click({ force: true });
  await focusProject();
  await page.keyboard.press('NumpadMultiply');
  await page.keyboard.press('ControlOrMeta+Shift+KeyR');
  await engine!.call('session.inspect');
  expect((await sent()).filter((r) => r.method === 'transport.record')).toEqual([]);
  expect(await commands('track.set_input')).toEqual([]);
  expect(await commands('track.set_monitor')).toEqual([]);
  expect((await engine!.call('engine.status')).recording).toBe(false);
  expect((await engine!.call('session.inspect')).revision).toBe(head);
  // Record enable is engine state: it still arms and disarms.
  await page.getByTestId('track-record-trk_rec2').click();
  await expect.poll(armed).toEqual(['trk_rec', 'trk_rec2']);
  await page.getByTestId('track-record-trk_rec2').click();
  await expect.poll(armed).toEqual(['trk_rec']);

  // With main heard every control goes again.
  await engine!.call('audition.hear', { side: 'main' });
  await expect(page.getByTestId('hear-main')).toHaveAttribute('aria-pressed', 'true');
  await expect(record).not.toHaveAttribute('aria-disabled', 'true');
  await expect(select).toBeEnabled();
  await expect(monitor).toBeEnabled();
});

test('against capabilities without features.recording none of the recording controls is in the DOM', async () => {
  await launch({ SIANN_TEST_CAPABILITIES: path.join(FIXTURES, 'capabilities-reduced.json') }, { input: false });
  await selectTrack('trk_rec');
  await expect(page.locator('[data-part$="-record"]')).toHaveCount(0);
  await expect(page.locator('[data-part-of="record"]')).toHaveCount(0);
  await expect(page.locator('[data-part="inspector-monitor"]')).toHaveCount(0);
  await expect(page.getByTestId('inspector-input')).toHaveCount(0);
  await expect(page.getByTestId('record-options')).toHaveCount(0);
  // The keys send nothing.
  await focusProject();
  await page.keyboard.press('KeyR');
  await page.keyboard.press('ControlOrMeta+Shift+KeyR');
  await page.keyboard.press('KeyI');
  expect((await sent()).filter((r) => /^record\.|^transport\.(record|set_punch)/.test(r.method))).toEqual([]);
});
