// The mockup's session for the app (UI redesign 10.2): "Night Drive", the
// mockup's 7 tracks with their colours, levels, pans and mute, its 17 clips on
// the same bars, the earlier plans of its history, the pending 6-step plan, the
// same clip and track selected, the locators, cycle and cursor. The fidelity
// run (mockup-fidelity.spec.ts) compares the window on it with the mockup, and
// shell.spec.ts checks the whole window's ids on it against the manifest
// (m5-ui-port-cleanup). prepareBundle() builds the bundle with siann-cli
// (SIANN_CLI_EXE) before the app starts; stageSession() does the rest once the
// app is up.

import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClipRect, Viewport } from '../../../src/renderer/timeline/geometry';
import { trackColourIndex } from '../../../src/renderer/timeline/track-colour';
import { engineClient } from './engine-client';
import { mockupZhTable, sessionText } from './fidelity-text';
import { Agent, exeFromEnv, hash8 } from './seed';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
export const RATE = 48000;
// The mockup draws 40 px per bar at 120 BPM: 20 px per second.
export const FRAMES_PER_PIXEL = RATE / 20;
export const BAR = 2 * RATE;


// The palette entry (tokens.css --track-<n>) of each mockup track's colour.
// `seed`: what the bundle holds before the earlier applied plan brings the
// track to the mockup's values (UI redesign 10.2: the history's applied plan
// has four steps, and the window draws the mockup's session).
export const TRACKS: ReadonlyArray<{ name: string; palette: number; gain: number; pan?: number; mute?: boolean; seed?: { gain?: number; pan?: number } }> = [
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
export const CLIPS: ReadonlyArray<readonly [number, number, number, string]> = [
  [0, 1, 4, 'Kick 909'], [0, 5, 4, 'Kick 909'], [0, 9, 4, 'Kick 909'], [0, 13, 4, 'Kick 909'],
  [1, 5, 4, 'Snare'], [1, 9, 4, 'Snare'], [1, 13, 4, 'Snare'],
  [2, 3, 6, 'Bass DI'], [2, 9, 8, 'Bass DI · chorus'],
  [3, 1, 8, 'Rhodes · verse'], [3, 9, 8, 'Rhodes · chorus'],
  [4, 5, 3.5, 'Verse 1'], [4, 9, 3.75, 'Chorus A · take 3'], [4, 13, 3.5, 'Chorus B'],
  [5, 9, 8, 'BGV stack'],
  [6, 6, 2, 'Riser'], [6, 9, 1.5, 'Impact'],
];
// The pending plan's ghost clip, the mockup's eighteenth.
export const PAD_SWELL = 'Pad swell';
// Its media's name: the file the mockup's step 2 names in its detail line
// ("bar 9.1 → 17.1 · pad_swell.wav"). A step names a clip by its media's name
// (m5b-ui-media), so step 2's title reads "Place pad_swell.wav on Pad" where
// the mockup names the clip "Pad swell": plan-step-2-title stays masked
// (UI redesign 10.11).
export const PAD_SWELL_MEDIA = 'pad_swell.wav';
// The media of a clip name.
export const mediaId = (name: string): string => `med_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;

// The clip names of mockup.html's own CLIPS table, in its order: what the
// session above has to follow.
export function mockupClipNames(): string[] {
  const html = fs.readFileSync(MOCKUP_HTML, 'utf8');
  const table = /const CLIPS=\[([\s\S]*?)\r?\n\];/.exec(html);
  if (!table) throw new Error('mockup.html has no CLIPS table');
  return [...table[1]!.matchAll(/\[\d+,'([^']*)',/g)].map((m) => m[1]!);
}
// The mockup's selection: "Chorus A · take 3" on Vox Lead.
export const SELECTED_CLIP = 13;
export const RISER_CLIP = 16;

// A track id whose stable hash picks `palette` (track-colour.ts), so the app
// colours the track as the mockup does.
export function trackId(name: string, palette: number): string {
  const base = `trk_${name.toLowerCase().replace(/[^a-z]/g, '')}`;
  for (let n = 0; n < 10_000; n += 1) {
    const id = `${base}_${n}`;
    if (trackColourIndex(id) === palette) return id;
  }
  throw new Error(`no id for ${name} in palette entry ${palette}`);
}
export const TRACK_IDS = TRACKS.map((track) => trackId(track.name, track.palette));
export const clipId = (index: number): string => `clp_${String(index).padStart(2, '0')}`;

export function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

// A mono 16-bit WAV of 16 s (8 bars): a decaying tone per beat. The waveform
// is not compared (the gate masks waveform interiors); the file only has to
// be long enough for the mockup's longest clip.
export function writeWav(file: string, pitch: number): void {
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

export function prepareBundle(scratch: string): string {
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
    exec({ op: 'media.rename', mediaId: mediaId(name), name: name === PAD_SWELL ? PAD_SWELL_MEDIA : name });
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
  // The mockup's fades on its selected clip (m5b-ui-fades): its info line
  // reads Fade In 12 ms and Fade Out 180 ms, 576 and 8640 frames at 48 kHz.
  if (RATE === 48000) {
    exec({ op: 'clip.set_fade', clipId: clipId(SELECTED_CLIP), fadeIn: { length: '576', curve: 'linear' }, fadeOut: { length: '8640', curve: 'equal_power' } });
  }
  return path.dirname(bundle);
}

// The mockup's three earlier plans (UI redesign 10.2), in submission order:
// one made stale (approved, then the applied plan changes its track), one
// rejected with the mockup's note, one applied whose four steps bring the
// seeded values to the mockup's. The history rows then read Applied,
// Rejected, Stale from the top. Each carries the mockup's title, and an MCP
// client named mix-assistant submits them, so the rows read the mockup's
// titles and agent (m5b-ui-plan-metadata). The app does not translate an
// agent's text, so the titles, the intent and the note are the ones the
// mockup draws in the locale under test (fidelity-text.ts: its ZH table for
// zh-TW), and the zh-TW rows read 收緊低頻, 疊加主唱, 修剪鼓組的空白.
export const AGENT_NAME = 'mix-assistant';
export const MOCKUP_HTML = path.join(REPO, 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html');
export function staleSteps(): Array<Record<string, unknown>> {
  return [{ op: 'track.set_gain', trackId: TRACK_IDS[0]!, gainMilliDb: -2000 }];
}
export function rejectedSteps(): Array<Record<string, unknown>> {
  return [{ op: 'track.set_pan', trackId: TRACK_IDS[4]!, pan: 3000 }];
}
export function appliedSteps(): Array<Record<string, unknown>> {
  return TRACKS.flatMap((track, index) => [
    ...(track.seed?.gain !== undefined ? [{ op: 'track.set_gain', trackId: TRACK_IDS[index]!, gainMilliDb: track.gain }] : []),
    ...(track.seed?.pan !== undefined ? [{ op: 'track.set_pan', trackId: TRACK_IDS[index]!, pan: track.pan }] : []),
  ]);
}

// The mockup's pending plan, "Lift the chorus": six steps.
export function planSteps(): Array<Record<string, unknown>> {
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


// A test hook of the event display (TimelineCanvas.ts, under SIANN_SHELL_TEST=1).
export async function hook<T>(page: Page, name: string, arg?: string): Promise<T> {
  return page.evaluate(
    ({ name: called, arg: value }) => {
      const hooks = (window as unknown as { __siannTimeline?: Record<string, (a?: string) => unknown> }).__siannTimeline;
      if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return hooks[called]!(value);
    },
    { name, arg },
  ) as Promise<T>;
}

export async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// Brings the app's window to the mockup's state, once it is up and sized on a
// bundle from prepareBundle(): what the run cannot reproduce goes to `notes`.
// `locale` is the manifest's locale the window runs in (en, zh-TW): the
// agent's text is the mockup's in that locale.
// The slots of the mockup's T (Kick to FX): its ins entries that are not "—".
const MOCKUP_INSERTS = [1, 2, 2, 1, 2, 2, 1];

async function stageInserts(page: Page, notes: string[]): Promise<void> {
  const plugin = process.env.SIANN_TEST_PLUGIN_CLAP;
  if (!plugin) {
    notes.push('SIANN_TEST_PLUGIN_CLAP is not set: the insert racks hold empty slots only, the mockup draws plugins in them.');
    return;
  }
  const engine = await engineClient(page, { events: false });
  try {
    const registry = (await engine.call('plugin.registry')) as { plugins: Array<{ format: string; path: string; approved: boolean }> };
    const install = registry.plugins.find((p) => path.basename(p.path) === path.basename(plugin));
    if (!install) {
      notes.push(`The engine did not register ${plugin} (no --plugin-dir for it): the insert racks hold empty slots only.`);
      return;
    }
    if (!install.approved) await engine.call('plugin.approve', { format: install.format, path: install.path, approved: true });
    for (const [index, count] of MOCKUP_INSERTS.entries()) {
      for (let n = 0; n < count; n += 1) {
        await engine.call('plugin.instantiate', { trackId: TRACK_IDS[index]!, index: n, descriptor: { format: install.format, path: install.path } });
      }
    }
  } finally {
    engine.close();
  }
  await expect(page.locator('.strip .ins .slot:not(.empty)')).toHaveCount(MOCKUP_INSERTS.reduce((a, b) => a + b, 0));
  notes.push('The insert slots hold siann_test_plugin ("SIANN Test Plugin"), with the bypass, e and Remove the app adds to the mockup\'s slot; the mockup names its plugins (Transient, Gate, EQ ...).');
}

export async function stageSession(app: ElectronApplication, page: Page, notes: string[], locale = 'en'): Promise<void> {
  const text = sessionText(locale, fs.readFileSync(MOCKUP_HTML, 'utf8'));
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('about-track-count')).toHaveText(String(TRACKS.length));
  await expect(page.getByTestId('clip-count')).toHaveText(String(CLIPS.length));
  // The session names each clip's media as the mockup names the clip (UI
  // redesign 10.7), so every clip title of the side-by-side is the mockup's.
  const names = mockupClipNames();
  expect(CLIPS.map((clip) => clip[3])).toEqual(names.slice(0, CLIPS.length));
  expect(names[CLIPS.length]).toBe(PAD_SWELL);
  await expect
    .poll(async () => (await hook<Array<{ clipId: string; title: string }>>(page, 'clips')).map((clip) => `${clip.clipId} ${clip.title}`).sort())
    .toEqual(CLIPS.map((clip, index) => `${clipId(index + 1)} ${clip[3]}`).sort());

  // The mockup's insert racks (m5b-ui-inserts-master): as many slots per track
  // as strip() draws (T.ins without its "—"), siann_test_plugin's CLAP in each,
  // before any plan, so no plan reads a track the inserts change. The mockup's
  // plugin names are its own; the slots read the test plugin's.
  await stageInserts(page, notes);

  // The mockup's record enable (m5b-ui-recording): every track on an input
  // before any plan (an input is a revision; a plan that read the track would
  // go stale), the fake device's input open (its outputs loop back).
  {
    const inputs = await engineClient(page, { events: false });
    await inputs.call('engine.select_device', { id: 'fake', inputId: 'fake' });
    await expect.poll(async () => ((await inputs.call('engine.status')).device as { input: unknown } | null)?.input ?? null).not.toBeNull();
    for (const trackId of TRACK_IDS) await inputs.call('command.execute', { commands: [{ op: 'track.set_input', trackId, input: { port: 0, channels: 1 } }] });
    inputs.close();
  }

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
  await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: AGENT_NAME, version: '1' } });
  const engine = await engineClient(page, { events: false });
  expect(appliedSteps()).toHaveLength(4);
  const stale = (await agent.tool('submit_plan', { steps: staleSteps(), title: text.titles.stale })).hash as string;
  await engine.call('plan.approve', { plan: stale });
  const rejected = (await agent.tool('submit_plan', { steps: rejectedSteps(), title: text.titles.rejected })).hash as string;
  await engine.call('plan.reject', { plan: rejected, note: text.note });
  const applied = (await agent.tool('submit_plan', { steps: appliedSteps(), title: text.titles.applied })).hash as string;
  await engine.call('plan.approve', { plan: applied });
  await engine.call('plan.apply', { plan: applied });
  await expect.poll(async () => ((await engine.call('plan.status', { plan: stale })).stale as unknown[]).length).toBeGreaterThan(0);
  const plan = await agent.tool('submit_plan', { steps: planSteps(), title: text.titles.plan, intent: text.intent });
  // The mockup's agent row reads "connected · idle": the session that
  // submitted ends, and a second one named the same only initializes, so the
  // agent shown has made no tool call yet (lastAction null).
  await agent.end();
  const idle = new Agent(ready.port, ready.mcpToken);
  await idle.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: AGENT_NAME, version: '1' } });
  const row = page.locator('[data-part="agent-row"]');
  await expect(row.locator('b')).toHaveText(AGENT_NAME);
  await expect(row.locator('.live')).toHaveText(new RegExp(`^\\S+ · \\S+$`));
  await expect(row.locator('.live')).not.toHaveClass(/\boff\b/);
  await expect(row.locator('.live')).not.toHaveAttribute('title', /./);
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(plan.hash as string));
  await expect(page.locator('[data-part-item="plan-history"]')).toHaveCount(3);
  await expect(page.locator('[data-part-item="plan-history"] .badge')).toHaveText([/./, /./, /./]);
  // The agent's text reads the mockup's in this locale (UI redesign 10.7, 3).
  await expect(page.locator('[data-part="plan-title"]')).toHaveText(text.titles.plan);
  await expect(page.locator('[data-part="plan-intent"]')).toHaveText(text.intent);
  await expect(page.locator('[data-part-item="plan-history"] > b')).toHaveText([text.titles.applied, text.titles.rejected, text.titles.stale]);
  await expect(page.locator('[data-part-item="plan-history"]').nth(1).locator('small')).toContainText(text.note);
  await expect(page.getByTestId(`plan-state-${hash8(applied)}`)).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId(`plan-state-${hash8(stale)}`)).toHaveAttribute('data-badge', 'stale');
  // The Plans button counts the one validated plan, as the mockup's does.
  await expect(page.getByTestId('plans-count')).toHaveText('1');
  // m5b-ui-composer: the box at the tab's foot reads the mockup's text, with no request shown.
  const composerText = 'Ask mix-assistant for a change…';
  const placeholder = locale.startsWith('zh') ? (mockupZhTable(fs.readFileSync(MOCKUP_HTML, 'utf8'))[composerText] ?? composerText) : composerText;
  await expect(page.locator('[data-part="composer"] textarea')).toBeEnabled();
  await expect(page.locator('[data-part="composer"] textarea')).toHaveAttribute('placeholder', placeholder);
  await expect(page.locator('.requests')).toHaveCount(0);

  // Vox Lead armed (m5b-ui-recording; the inputs were set before the plans).
  await engine.call('record.arm', { trackId: TRACK_IDS[4]!, armed: true });
  await expect(page.getByTestId(`track-record-${TRACK_IDS[4]!}`)).toHaveAttribute('aria-pressed', 'true');
  // The others can arm: no reason in their tooltip.
  await expect(page.getByTestId(`track-record-${TRACK_IDS[0]!}`)).not.toHaveAttribute('aria-disabled', 'true');

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
  // The mockup's session is saved: Save (Ctrl+S, the renderer's session.save) clears the saved mark (m5b-ui-project).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+KeyS');
  await expect
    .poll(() => page.evaluate(() => window.__siannClient!.answered().filter((r) => r.method === 'session.save' && r.code === null).length))
    .toBeGreaterThan(0);
  await expect(page.getByTestId('session-name')).not.toHaveAttribute('data-unsaved', 'true');
  // Toasts are transient (the plan's arrival): dismissed, they are not chrome.
  await page.evaluate(() => {
    const toasts = (window as unknown as { __siannToasts?: { getSnapshot(): ReadonlyArray<{ id: number }>; dismiss(id: number): void } }).__siannToasts;
    for (const toast of toasts?.getSnapshot() ?? []) toasts!.dismiss(toast.id);
  });
  await expect(page.getByTestId('toast')).toHaveCount(0);
  // Live values inside enforced boxes, masked in pixels only: the widths of the
  // mockup's "0 xruns" and "r39" need one xrun digit and two revision digits.
  // The count is whatever engine.status reports, not zero: the fake device's
  // real-time thread can miss a deadline on a loaded runner (Windows CI did).
  await expect(page.getByTestId('xruns')).toHaveText(/^\d$/);
  await expect
    .poll(async () => {
      const status = await engine.call('engine.status');
      return (await page.getByTestId('xruns').textContent()) === status.xruns;
    })
    .toBe(true);
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
}
