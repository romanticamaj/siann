// Import audio end to end (m5b-ui-media; UI redesign UR-5, 3.2, 3.0;
// architecture spec, "Frontend" and Jobs v0, import): the real siann-engine
// on a 48 kHz session under SIANN_SHELL_TEST=1, files written by
// scripts/create-demo-audio.js. A drop from the OS is the window's own: CDP's
// Input.dispatchDragEvent with the files' absolute paths, so the renderer
// gets File objects whose path the preload bridge reads
// (webUtils.getPathForFile). The shell's file dialog is replaced in the main
// process (electronApp.evaluate over dialog.showOpenDialog, as
// project.spec.ts does). A Media tab row is dragged with the app's own drag
// type (support/toolbar.ts). Requests are read from window.__siannClient,
// the import's jobs from window.__siannMedia, the document from a second
// protocol client. Waits are condition polls, never sleeps.

import { expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { GUARD_REASON } from '../../src/renderer/model/edit-guard';
import { MEDIA_ROW_TYPE } from '../../src/renderer/model/media-bridge';
import { engineClient } from './support/engine-client';
import { launchElectron } from './support/launch';
import { agentFor, APP_DIR, exeFromEnv, MAIN, selectPlan } from './support/seed';
import { chooseGrid, dragMediaRow, openMedia } from './support/toolbar';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeWav } = require('../../../scripts/create-demo-audio.js') as { writeWav(file: string, frequency: number, seconds?: number, sampleRate?: number): void };

const RATE = 48000;
const BEAT = RATE / 2;

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

// A 48 kHz bundle with three tracks, and the demo files of this test.
function prepare(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-media-'));
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'Media', '--rate', String(RATE));
  for (const [id, name] of [['trk_a', 'Alpha'], ['trk_b', 'Beta'], ['trk_c', 'Gamma']]) cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: id, name, channels: 2 }));
  return bundle;
}

// A demo file (scripts/create-demo-audio.js) in the scratch directory.
function demo(name: string, frequency: number, seconds = 1, sampleRate = RATE): string {
  const dir = path.join(scratch, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeWav(file, frequency, seconds, sampleRate);
  return file;
}

async function launch(bundle: string, options: { capabilities?: string; languages?: readonly string[] } = {}): Promise<void> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  app = await launchElectron({
    args: [MAIN],
    cwd: APP_DIR,
    languages: options.languages,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: path.dirname(bundle),
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      ...(options.capabilities ? { SIANN_TEST_CAPABILITIES: options.capabilities } : {}),
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('about-track-count')).toHaveText('3');
}

async function revision(): Promise<number> {
  await expect(page.getByTestId('revision')).toHaveText(/^r\d+$/);
  return Number((await page.getByTestId('revision').textContent())!.slice(1));
}

interface ClipSeen {
  x: number;
  y: number;
  width: number;
  height: number;
  clipId: string;
  trackId: string;
  mediaId: string;
  position: string;
  title: string;
}

async function clips(): Promise<ClipSeen[]> {
  return page.evaluate(() => (window as unknown as { __siannTimeline: { clips(): ClipSeen[] } }).__siannTimeline.clips());
}

async function view(): Promise<{ lanesTop: number; laneHeight: number; laneHeights?: Record<string, number>; framesPerPixel: number; scrollFrames: string }> {
  return page.evaluate(() => (window as unknown as { __siannTimeline: { view(): never } }).__siannTimeline.view());
}

// The client point of a frame on a track's lane (or `below` the last lane).
async function lanePoint(trackId: string | 'below', frame: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('event-display').boundingBox())!;
  const v = await view();
  const order = await page.evaluate(() => (window as unknown as { __siannTimeline: { lanes(): string[] } }).__siannTimeline.lanes());
  let top = v.lanesTop;
  for (const id of order) {
    if (id === trackId) break;
    top += v.laneHeights?.[id] ?? v.laneHeight;
  }
  const height = trackId === 'below' ? v.laneHeight : (v.laneHeights?.[trackId] ?? v.laneHeight);
  // A few pixels in from the frame (snapped back by the Bar grid), so a drop
  // at frame 0 is clear of the track list's divider over the display's edge.
  return { x: box.x + (frame - Number(v.scrollFrames)) / v.framesPerPixel + 12, y: box.y + top + height / 2 };
}

// Files dropped from the OS at a client point: the window's own drag events
// through CDP. One session per window, kept open: detached at once after the
// drop, the drop's file data can be gone before the renderer reads it.
let cdpSession: { page: Page; session: CDPSession } | null = null;
async function dropFiles(files: readonly string[], at: { x: number; y: number }): Promise<void> {
  if (cdpSession?.page !== page) cdpSession = { page, session: await page.context().newCDPSession(page) };
  const data = { items: [], files: [...files], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdpSession.session.send('Input.dispatchDragEvent', { type, x: Math.round(at.x), y: Math.round(at.y), data });
  }
}

async function sent(method: string): Promise<number> {
  return page.evaluate((m) => window.__siannClient!.sent().filter((r) => r.method === m).length, method);
}

interface ImportSeen {
  name: string;
  progress: number | null;
}

async function placeholdersSeen(): Promise<ImportSeen[]> {
  return page.evaluate(() => (window as unknown as { __siannMedia: { seen(): ImportSeen[] } }).__siannMedia.seen());
}

async function jobResults(): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __siannMedia: { results(): Array<Record<string, unknown>> } }).__siannMedia.results());
}

async function mediaRows(): Promise<string[]> {
  return page.locator('[data-testid^="media-row-"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')!.slice('media-row-'.length)));
}

test('two files dropped on a track import and land on consecutive tracks at the snapped position, titled with their names', async () => {
  const bundle = prepare();
  const kick = demo('kick.wav', 110);
  const snare = demo('snare.wav', 220);
  await launch(bundle);
  await chooseGrid(page, 'beat');
  const before = await revision();
  // 1.3 beats in on Beta: the Beat grid snaps it to the second beat (frame 24000).
  await dropFiles([kick, snare], await lanePoint('trk_b', 1.3 * BEAT));
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  // Two media.add (the jobs) and two command.execute (the placements).
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 4}`);
  expect(await sent('media.import')).toBe(2);
  expect(await sent('command.execute')).toBe(2);
  // A placeholder per file, with its name, while it imported.
  expect((await placeholdersSeen()).map((p) => p.name)).toEqual(['kick.wav', 'snare.wav']);
  await expect(page.getByTestId(/^media-placeholder-/)).toHaveCount(0);
  await expect.poll(async () => (await clips()).length).toBe(2);
  const placed = (await clips()).sort((a, b) => a.trackId.localeCompare(b.trackId));
  expect(placed.map((c) => [c.trackId, c.position, c.title])).toEqual([
    ['trk_b', String(BEAT), 'kick.wav'],
    ['trk_c', String(BEAT), 'snare.wav'],
  ]);
  // The Media tab lists both.
  await openMedia(page);
  await expect(page.locator('[data-testid^="media-row-"]')).toHaveCount(2);

  // The same file again: the session holds its content, so the job ends
  // existing with no revision, and one more clip is placed with that media.
  const again = await revision();
  await dropFiles([kick], await lanePoint('trk_a', 2.2 * BEAT));
  await expect(page.getByTestId('clip-count')).toHaveText('3');
  await expect(page.getByTestId('revision')).toHaveText(`r${again + 1}`);
  await expect.poll(async () => (await jobResults()).length).toBe(3);
  expect((await jobResults()).at(-1)).toMatchObject({ existing: true });
  await expect(page.locator('[data-testid^="media-row-"]')).toHaveCount(2);
  const third = (await clips()).find((c) => c.trackId === 'trk_a')!;
  expect(third.mediaId).toBe(placed[0]!.mediaId);
  expect(third.title).toBe('kick.wav');

  // Undo: N undos remove the N clips of a drop; the media stay until further undos.
  await page.getByTestId('zone-project').click({ position: { x: 5, y: 5 } });
  for (let n = 0; n < 3; n += 1) await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect(page.getByTestId('clip-count')).toHaveText('0');
  await expect(page.locator('[data-testid^="media-row-"]')).toHaveCount(2);
});

test('files dropped below the last track get new tracks named after them', async () => {
  const bundle = prepare();
  const pad = demo('pad swell.wav', 330);
  await launch(bundle);
  const before = await revision();
  await dropFiles([pad], await lanePoint('below', 0));
  await expect(page.getByTestId('about-track-count')).toHaveText('4');
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 2}`);
  await expect.poll(async () => (await clips()).length).toBe(1);
  const [clip] = await clips();
  await expect(page.getByTestId(`track-header-${clip!.trackId}`)).toContainText('pad swell.wav');
});

test('Import in the Media tab opens the shell\'s dialog and lists the files; a 44.1 kHz file is converted into the 48 kHz session', async () => {
  const bundle = prepare();
  const a = demo('a.wav', 440);
  const b = demo('b44.wav', 550, 1, 44100);
  await launch(bundle);
  await app!.evaluate(({ dialog }, files) => {
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, [a, b]);
  await openMedia(page);
  const before = await revision();
  await page.getByTestId('media-import').click();
  await expect(page.locator('[data-testid^="media-row-"]')).toHaveCount(2);
  await expect(page.getByTestId('revision')).toHaveText(`r${before + 2}`);
  expect(await sent('command.execute')).toBe(0);
  // The jobs end done once polled after their commits.
  await expect.poll(async () => (await jobResults()).length).toBe(2);
  const converted = (await jobResults()).find((r) => r.name === 'b44.wav')!;
  expect(converted).toMatchObject({ converted: true, sampleRate: RATE });
  const row = page.getByTestId(`media-row-${String(converted.mediaId)}`);
  await expect(row).toContainText('48 kHz');
  await expect(row).toContainText('b44.wav');

  // Drag a row to the event display: one clip.place, one revision.
  const placed = await revision();
  await dragMediaRow(page, String(converted.mediaId), await lanePoint('trk_a', BEAT));
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  await expect(page.getByTestId('revision')).toHaveText(`r${placed + 1}`);

  // Rename in the tab: the clip's title and the info line follow.
  await row.getByTestId(`media-name-${String(converted.mediaId)}`).dblclick();
  const field = page.getByTestId('media-rename-input');
  await field.fill('Bell');
  await field.press('Enter');
  await expect.poll(async () => (await clips())[0]?.title).toBe('Bell');
  const clip = (await clips())[0]!;
  const box = (await page.getByTestId('event-display').boundingBox())!;
  await page.mouse.click(box.x + clip.x + clip.width / 2, box.y + clip.y + clip.height / 2);
  await expect(page.getByTestId('info-name')).toHaveText('Bell');

  // Remove is disabled for used media and removes an unused one.
  await expect(page.getByTestId(`media-remove-${String(converted.mediaId)}`)).toBeDisabled();
  const unused = (await mediaRows()).find((id) => id !== converted.mediaId)!;
  const removing = await revision();
  await page.getByTestId(`media-remove-${unused}`).click();
  await expect(page.locator('[data-testid^="media-row-"]')).toHaveCount(1);
  await expect(page.getByTestId('revision')).toHaveText(`r${removing + 1}`);
});

test('a file of another type is refused with a toast before any request; a truncated WAV fails with decode_failed', async () => {
  const bundle = prepare();
  const notes = path.join(scratch, 'notes.txt');
  fs.writeFileSync(notes, 'not audio');
  const broken = demo('broken.wav', 220);
  fs.truncateSync(broken, 200);
  await launch(bundle);
  const before = await revision();
  await dropFiles([notes], await lanePoint('trk_a', 0));
  await expect(page.getByTestId('toast-message').last()).toContainText('notes.txt');
  expect(await sent('media.import')).toBe(0);
  expect(await sent('job.status')).toBe(0);
  expect(await revision()).toBe(before);

  await dropFiles([broken], await lanePoint('trk_a', 0));
  await expect(page.getByTestId('toast-message').last()).toContainText('decode_failed');
  await expect(page.getByTestId('toast-message').last()).toContainText('broken.wav');
  await expect(page.getByTestId(/^media-placeholder-/)).toHaveCount(0);
  expect(await revision()).toBe(before);
  expect(await sent('command.execute')).toBe(0);
});

test('Ctrl+P and the event display\'s context menu open the Media tab, also from a collapsed right zone', async () => {
  const bundle = prepare();
  await launch(bundle);
  await expect(page.getByTestId('tab-right-plans')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+KeyP');
  await expect(page.getByTestId('tab-right-media')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('media-tab')).toBeVisible();
  // Collapse the right zone, then open it from the event display's menu.
  await page.getByTestId('zone-button-right').click();
  await expect(page.getByTestId('zone-right')).toBeHidden();
  const box = (await page.getByTestId('event-display').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height - 40, { button: 'right' });
  const menu = page.getByTestId('event-display-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('menu-open-media').click();
  await expect(page.getByTestId('zone-right')).toBeVisible();
  await expect(page.getByTestId('media-tab')).toBeVisible();
  // Back on Plans by its tab; Ctrl+P from the collapsed zone opens Media again.
  await page.getByTestId('tab-right-plans').click();
  await expect(page.getByTestId('media-tab')).toBeHidden();
  await page.getByTestId('zone-button-right').click();
  await expect(page.getByTestId('zone-right')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+KeyP');
  await expect(page.getByTestId('media-tab')).toBeVisible();
  // The Pool is gone.
  await expect(page.getByTestId('media-pool')).toHaveCount(0);
});

// The edit guard (UI redesign 4.5 C5): while a proposal is heard the media's
// import, rename and removal would commit onto main, so a drop on the event
// display sends no media.import and raises a toast with the guard's reason,
// a row dropped there sends no command, and the Media tab's Import, the row's
// drag, the rename and Remove are disabled with that reason; with main heard
// they are enabled again. Main's head does not move while heard.
test('while a proposal is heard the drop, Import, the row drag, rename and Remove are held with the reason', async () => {
  const bundle = prepare();
  const kick = demo('kick.wav', 110);
  const pad = demo('pad.wav', 330);
  const late = demo('late.wav', 440);
  await launch(bundle);
  const reason = translator('en')(GUARD_REASON);
  // A used media (kick, dropped) and an unused one (pad, imported).
  await dropFiles([kick], await lanePoint('trk_a', 0));
  await expect.poll(async () => (await clips()).length).toBe(1);
  await app!.evaluate(({ dialog }, files) => {
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, [pad]);
  await openMedia(page);
  await page.getByTestId('media-import').click();
  await expect(page.locator('[data-testid^="media-row-"]')).toHaveCount(2);
  const used = (await clips())[0]!.mediaId;
  const unused = (await mediaRows()).find((id) => id !== used)!;

  // Audition a plan: a proposal is heard.
  const agent = await agentFor(app!);
  const hash = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: 'trk_b', gainMilliDb: -600 }] })).hash as string;
  await page.getByTestId('tab-right-plans').click();
  await selectPlan(page, hash);
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('shell')).toHaveAttribute('data-hearing', 'proposal');
  const watcher = await engineClient(page);
  const head = async () => (await watcher.call('session.inspect')).revision as string;
  const mainHead = await head();
  const imports = await sent('media.import');
  const executes = await sent('command.execute');

  // The tab: Import, Remove, the drag and the rename are held, with the reason.
  await openMedia(page);
  await expect(page.getByTestId('media-import')).toBeDisabled();
  await expect(page.getByTestId('media-import')).toHaveAttribute('title', reason);
  for (const id of [used, unused]) {
    await expect(page.getByTestId(`media-remove-${id}`)).toBeDisabled();
    await expect(page.getByTestId(`media-remove-${id}`)).toHaveAttribute('title', reason);
    await expect(page.getByTestId(`media-row-${id}`)).not.toHaveAttribute('draggable', 'true');
  }
  await page.getByTestId(`media-name-${unused}`).dblclick();
  await expect(page.getByTestId('media-rename-input')).toHaveCount(0);
  await expect(page.getByTestId('media-search')).toBeEnabled();

  // The event display: a file dropped from the OS is refused with the reason, and a row dropped there sends nothing.
  await expect(page.getByTestId('event-display')).toHaveAttribute('data-drop-target', 'guarded');
  await dropFiles([late], await lanePoint('trk_c', 0));
  await expect(page.getByTestId('toast-message').last()).toContainText(reason);
  const at = await lanePoint('trk_b', BEAT);
  await page.evaluate(
    ({ id, x, y, type }) => {
      const target = document.querySelector('[data-testid="event-display"]')!;
      const data = new DataTransfer();
      data.setData(type, id);
      for (const name of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y }));
    },
    { id: unused, x: at.x, y: at.y, type: MEDIA_ROW_TYPE },
  );
  await watcher.call('session.inspect');
  expect(await sent('media.import')).toBe(imports);
  expect(await sent('command.execute')).toBe(executes);
  expect(await head()).toBe(mainHead);
  await expect(page.getByTestId('clip-count')).toHaveText('1');

  // With main heard everything is enabled again.
  await page.getByTestId('banner-hear-main').click();
  await expect(page.getByTestId('shell')).not.toHaveAttribute('data-hearing', 'proposal');
  await openMedia(page);
  await expect(page.getByTestId('media-import')).toBeEnabled();
  await expect(page.getByTestId(`media-remove-${unused}`)).toBeEnabled();
  await expect(page.getByTestId(`media-row-${unused}`)).toHaveAttribute('draggable', 'true');
  await expect(page.getByTestId('event-display')).toHaveAttribute('data-drop-target', 'media');
  watcher.close();
});

// The feature's ids (manifest: tab-media and plan-step-*-title): the Media tab,
// and the title of each plan step that names a clip, which the mockup wraps
// in plan-step-N-title (its step(), clip true) and the app wraps when the
// clip's media has a name. An agent submits a plan whose steps 2 and 3 name a
// clip (a place of the dropped file's media, a move of its clip) around a
// gain step and a track step that name none.
test('every id of the feature is in the window', async () => {
  const bundle = prepare();
  const kick = demo('kick.wav', 110);
  await launch(bundle);
  await expect(page.locator('[data-part="tab-media"]')).toHaveCount(1);
  await expect(page.locator('[data-part="tab-media"]')).toHaveClass('tab');
  await dropFiles([kick], await lanePoint('trk_a', 0));
  await expect.poll(async () => (await clips()).length).toBe(1);
  const [dropped] = await clips();
  const agent = await agentFor(app!);
  const hash = (await agent.tool('submit_plan', {
    steps: [
      { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -600 },
      { op: 'clip.place', clipId: 'clp_e2e_title', trackId: 'trk_b', mediaId: dropped!.mediaId, position: { domain: 'audio', value: String(4 * BEAT) }, sourceStart: '0', length: String(BEAT) },
      { op: 'clip.move', clipId: dropped!.clipId, position: { domain: 'audio', value: String(8 * BEAT) } },
      { op: 'track.rename', trackId: 'trk_c', name: 'Gamma 2' },
    ],
  })).hash as string;
  await page.getByTestId('tab-right-plans').click();
  await selectPlan(page, hash);
  const titles = page.locator('[data-region="right-zone"] [data-part^="plan-step-"][data-part$="-title"]');
  await expect(titles).toHaveCount(2);
  expect(await titles.evaluateAll((els) => els.map((el) => el.getAttribute('data-part')))).toEqual(['plan-step-2-title', 'plan-step-3-title']);
  for (const id of ['plan-step-2-title', 'plan-step-3-title']) {
    const title = page.locator(`[data-part="${id}"]`);
    await expect(title, id).toHaveCount(1);
    await expect(title, id).toContainText('kick.wav');
    // Inside its step's row, as the mockup's step() puts it.
    await expect(page.locator(`[data-part-item="plan-step"] [data-part="${id}"]`), id).toHaveCount(1);
  }
});

// Reduced capabilities (UI redesign 3.0): without media.import nothing of the
// feature is in the DOM, no drop target and no Pool, and the box after the
// Plans tab keeps --tab-media-empty-w, so the hearing switch sits where it
// does with full capabilities, in en and zh-TW.
for (const languages of [['en-US'], ['zh-TW']] as const) {
  test(`without media.import the Media tab's box stays empty and the tab row does not move (${languages[0]})`, async () => {
    const bundle = prepare();
    await launch(bundle, { languages });
    const full = (await page.getByTestId('plan-heard').boundingBox())!;
    const tab = (await page.locator('[data-part="tab-media"]').boundingBox())!;
    await app!.close();
    const caps = path.join(scratch, 'caps.json');
    const fixture = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'test', 'unit', 'fixtures', 'capabilities-full.json'), 'utf8')) as { methods: string[] };
    fixture.methods = fixture.methods.filter((m) => m !== 'media.import');
    fs.writeFileSync(caps, JSON.stringify(fixture));
    await launch(bundle, { capabilities: caps, languages });
    await expect(page.locator('[data-part="tab-media"]')).toHaveCount(0);
    await expect(page.getByTestId('tab-right-media')).toHaveCount(0);
    await expect(page.getByTestId('media-tab')).toHaveCount(0);
    await expect(page.getByTestId('media-pool')).toHaveCount(0);
    await expect(page.locator('[data-drop-target]')).toHaveCount(0);
    const empty = (await page.locator('.tab-media-empty').boundingBox())!;
    expect(Math.abs(empty.width - tab.width)).toBeLessThan(1);
    const reduced = (await page.getByTestId('plan-heard').boundingBox())!;
    expect(Math.abs(reduced.x - full.x)).toBeLessThan(1);
    // Ctrl+P and a drop send nothing.
    const before = await revision();
    await page.keyboard.press('ControlOrMeta+KeyP');
    await dropFiles([demo('x.wav', 100)], await lanePoint('trk_a', 0));
    expect(await sent('media.import')).toBe(0);
    expect(await revision()).toBe(before);
  });
}
