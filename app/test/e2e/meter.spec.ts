// The DSP load, the master's loudness and the Meter tab end to end
// (m5b-ui-meter; UI redesign UR-14, 2.1, 2.4, 3.0, 5.3, 5.6). The bundle is
// prepared with siann-cli (SIANN_CLI_EXE): trk_mix with a 10 s square wave at
// 0.9 of full scale. The app runs the real siann-engine (SIANN_ENGINE_EXE) on
// the fake device with every callback timed as 2 ms of its 5.3 ms period
// (--fake-callback-nanos), so engine.status's load is about 38 %; the fake
// device meters and measures loudness only while playing, so every loudness
// assertion plays the transport. A second protocol client plays and stops.
//
// Covered: (a) the DSP load is in the window, its percentage and tooltip are
// the poll's, written with no React commit; (b) the master strip's LUFS-S is a
// finite value with one decimal while playing and -inf after stop; (c) the
// Meter tab's panel: the master's wells, its peak value, momentary, short-term
// and integrated, the integrated value held after stop and returned to -inf by
// the reset (meter.reset_loudness on the wire); (d) with capabilities without
// features.load, features.loudness and meter.reset_loudness none of the three
// ids is in the DOM, the empty boxes take the two tokens' widths and nothing
// beside them moves; (e) under 1300 px the DSP load and its empty box go.
// Waits are Playwright condition waits with bounded timeouts; none sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';
import { launchElectron } from './support/launch';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const TRACK = 'trk_mix';
const RATE = 48000;
const FRAMES = RATE * 10;
const ENGINE_ARGS = '--device fake --fake-callback-nanos 2000000';
const LUFS = /^[-+]?\d+\.\d$/;

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
let app: ElectronApplication | null = null;
let page: Page;
let client: EngineClient | null = null;

function prepare(): void {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-meter-'));
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'Meter', '--rate', String(RATE));
  cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: TRACK, name: 'Mix', channels: 2 }));
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
  client?.close();
  client = null;
  await app?.close().catch(() => undefined);
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
      SIANN_ENGINE_TEST_ARGS: ENGINE_ARGS,
      ...env,
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId(`mixer-strip-${TRACK}`)).toBeVisible();
  client = await engineClient(page);
}

test.beforeEach(() => {
  prepare();
});

test.afterEach(async () => {
  client?.close();
  client = null;
  await app?.close().catch(() => undefined);
  app = null;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

// The load the renderer last polled (window.__siannLoad under SIANN_SHELL_TEST=1).
async function polledLoad(): Promise<{ average: number; peak: number } | null> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __siannLoad?: () => { average: number; peak: number } | null }).__siannLoad;
    if (!hook) throw new Error('window.__siannLoad is missing (SIANN_SHELL_TEST=1)');
    return hook();
  });
}

const percent = (fraction: number) => `${Math.max(0, Math.round(fraction * 100))}%`;

async function sent(): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __siannClient?: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient;
    if (!hooks) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return hooks.sent().map((r) => ({ method: r.method, params: r.params }));
  });
}

const commitsOf = (id: string) => page.evaluate((key) => ((window as unknown as { __siannCommitsBy?: Record<string, number> }).__siannCommitsBy ?? {})[key] ?? 0, id);

test('(a) the DSP load follows the once-a-second poll: the bar, the percentage and the peak in the tooltip, with no React commit', async () => {
  await launch({ SIANN_SHELL_PROFILING: '1' });
  const dsp = page.locator('[data-part="dsp-load"]');
  await expect(dsp).toBeVisible();
  await expect(dsp).toContainText('DSP');
  await expect(dsp.locator('.bar > i')).toHaveCount(1);
  expect(await client!.call('transport.play')).toMatchObject({ playing: true });
  // The fake device's callbacks are 2 ms of 5.3 ms: a load well above zero.
  await expect.poll(async () => (await polledLoad())?.average ?? 0).toBeGreaterThan(0.2);
  // What the top bar shows is what the poll answered: the average as text, the peak in the tooltip.
  const shownAgrees = async () => {
    const load = (await polledLoad())!;
    const shown = await dsp.evaluate((el) => ({ text: el.querySelector('.num')!.textContent, title: el.getAttribute('title') ?? '' }));
    return shown.text === percent(load.average) && shown.title.includes(percent(load.peak));
  };
  await expect.poll(shownAgrees).toBe(true);
  const width = await dsp.locator('.bar > i').evaluate((el) => (el as HTMLElement).style.width);
  expect(parseFloat(width)).toBeGreaterThan(20);
  // Three more polls: the text keeps following them and React commits nothing.
  const before = await commitsOf('dsp-load');
  const polls = (await sent()).filter((r) => r.method === 'engine.status').length;
  await expect.poll(async () => (await sent()).filter((r) => r.method === 'engine.status').length, { timeout: 10_000 }).toBeGreaterThan(polls + 2);
  await expect.poll(shownAgrees).toBe(true);
  expect(await commitsOf('dsp-load')).toBe(before);
  await client!.call('transport.stop');
});

test('(b) the master strip shows LUFS-S with one decimal while playing and -inf after stop', async () => {
  await launch();
  const row = page.locator('[data-part-item="strip"][data-part-key="master"] [data-part-of="loudness"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('span').first()).toHaveText('LUFS-S');
  const value = page.getByTestId('strip-master-lufs');
  await expect(value).toHaveText('-inf');
  await client!.call('transport.play');
  await expect(value).toHaveText(LUFS, { timeout: 10_000 });
  await client!.call('transport.stop');
  await expect(value).toHaveText('-inf', { timeout: 10_000 });
});

test('(c) the Meter tab: the master\'s wells, its peak value and the three loudness values; integrated holds after stop and the reset clears it', async () => {
  await launch({ SIANN_SHELL_PROFILING: '1' });
  const tab = page.locator('[data-part="tab-meter"]');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('meter-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.meter > .ch')).toHaveCount(2);
  await expect(panel.locator('canvas')).toHaveCount(1);
  const [momentary, shortTerm, integrated] = ['loudness-momentary', 'loudness-short-term', 'loudness-integrated'].map((id) => page.getByTestId(id));
  for (const value of [momentary!, shortTerm!, integrated!]) await expect(value).toHaveText('-inf');
  // No loudness value through React: the panel commits nothing while the values
  // move from -inf to readings. (The square wave is steady, so once its 400 ms
  // window is full the momentary value stops changing: waiting for a change
  // after the first reading raced the runner's speed, macOS CI.)
  const commits = await commitsOf('meter-panel');
  await client!.call('transport.play');
  for (const value of [momentary!, shortTerm!, integrated!]) await expect(value).toHaveText(LUFS, { timeout: 10_000 });
  await expect(page.getByTestId('meter-panel-peak')).toHaveText(LUFS);
  expect(await commitsOf('meter-panel')).toBe(commits);
  await client!.call('transport.stop');
  await expect(momentary!).toHaveText('-inf', { timeout: 10_000 });
  await expect(shortTerm!).toHaveText('-inf');
  await expect(integrated!).toHaveText(LUFS);
  // The reset: meter.reset_loudness {} on the wire, once, and integrated reads -inf.
  const resets = (await sent()).filter((r) => r.method === 'meter.reset_loudness').length;
  await page.getByTestId('meter-reset-loudness').click();
  await expect.poll(async () => (await sent()).filter((r) => r.method === 'meter.reset_loudness')).toHaveLength(resets + 1);
  expect((await sent()).filter((r) => r.method === 'meter.reset_loudness').at(-1)!.params).toEqual({});
  await expect(integrated!).toHaveText('-inf', { timeout: 10_000 });
  // The peak value resets on a click.
  await page.getByTestId('meter-panel-peak').click();
  await expect(page.getByTestId('meter-panel-peak')).toHaveText('-inf');
  // Back to Plans with the Plans tab.
  await page.getByTestId('tab-right-plans').click();
  await expect(panel).toHaveCount(0);
});

// A token's px value at the window's scale, read through a probe element.
async function tokenWidth(token: string): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement('i');
    probe.style.cssText = `display:block;position:absolute;width:var(${name})`;
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }, token);
}

async function neighbours(): Promise<Record<string, { x: number; y: number; width: number; height: number } | null>> {
  const out: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
  for (const id of ['zone-buttons', 'plans-button', 'transport', 'tab-plans', 'hearing-switch']) out[id] = await page.locator(`[data-part="${id}"]`).boundingBox();
  out['strip-master-readout'] = await page.locator('[data-part-item="strip"][data-part-key="master"] [data-part-of="readout"]').boundingBox();
  return out;
}

test('(d) against capabilities without load and loudness none of the three parts is in the DOM and their boxes stay empty at the tokens\' widths', async () => {
  await launch();
  const full = await neighbours();
  const capabilities = (await client!.call('engine.capabilities')) as { methods: string[]; features: Record<string, unknown> };
  const reduced = {
    ...capabilities,
    methods: capabilities.methods.filter((m) => m !== 'meter.reset_loudness'),
    features: Object.fromEntries(Object.entries(capabilities.features).filter(([name]) => !['load', 'loudness'].includes(name))),
  };
  const file = path.join(scratch, 'capabilities-without-meter.json');
  fs.writeFileSync(file, JSON.stringify(reduced));
  await launch({ SIANN_TEST_CAPABILITIES: file });
  for (const id of ['dsp-load', 'tab-meter']) await expect(page.locator(`[data-part="${id}"]`), id).toHaveCount(0);
  await expect(page.locator('[data-part-of="loudness"]')).toHaveCount(0);
  await expect(page.getByTestId('tab-right-meter')).toHaveCount(0);
  for (const [selector, token] of [['.dsp-load-empty', '--dsp-load-empty-w'], ['.tab-meter-empty', '--tab-meter-empty-w']] as const) {
    const box = page.locator(selector);
    await expect(box).toHaveCount(1);
    await expect(box).toHaveAttribute('aria-hidden', 'true');
    for (const attr of ['role', 'tabindex', 'data-part']) expect(await box.getAttribute(attr), `${selector} ${attr}`).toBeNull();
    const width = (await box.boundingBox())!.width;
    expect(Math.abs(width - (await tokenWidth(token))), `${selector} is ${token} wide`).toBeLessThan(0.01);
  }
  // The master's loudness row is the empty .panrow the shared rules size.
  const row = page.locator('[data-part-item="strip"][data-part-key="master"] > .panrow');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('aria-hidden', 'true');
  expect(await row.evaluate((el) => el.childElementCount)).toBe(0);
  // Nothing beside them moved: within 1 px, as media.spec and the fidelity
  // run compare boxes. The empty box is the mockup's measured width and the
  // tab its text's, which the platform's font lays out a fraction of a pixel
  // apart (Windows CI: the hearing switch 0.016 px to the left).
  const after = await neighbours();
  expect(Object.keys(after)).toEqual(Object.keys(full));
  for (const [id, box] of Object.entries(full)) {
    const moved = after[id];
    expect(box, id).not.toBeNull();
    expect(moved, id).not.toBeNull();
    for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(moved![side] - box![side]), `${id} ${side}`).toBeLessThan(1);
  }
});

test('(e) under 1300 px neither the DSP load nor its empty box is displayed', async () => {
  await launch();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('[data-part="dsp-load"]')).toBeHidden();
  expect(await page.locator('.dsp').evaluate((el) => getComputedStyle(el).display)).toBe('none');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-part="dsp-load"]')).toBeVisible();
  const capabilities = (await client!.call('engine.capabilities')) as { methods: string[]; features: Record<string, unknown> };
  const file = path.join(scratch, 'capabilities-without-load.json');
  fs.writeFileSync(file, JSON.stringify({ ...capabilities, features: { ...capabilities.features, load: false } }));
  await launch({ SIANN_TEST_CAPABILITIES: file });
  await expect(page.locator('.dsp-load-empty')).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await page.locator('.dsp-load-empty').evaluate((el) => getComputedStyle(el).display)).toBe('none');
});
