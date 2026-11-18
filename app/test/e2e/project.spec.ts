// Projects end to end (m5b-ui-project; UI redesign UR-4; architecture spec,
// "Process model", "Session at launch"): the real siann-engine on the fake
// device under SIANN_SHELL_TEST=1, a temporary user data directory
// (SIANN_USER_DATA) and, unlike every other spec, no SIANN_SESSION_DIR, so the
// shell chooses the bundle itself: the one opened last, or the scratch bundle
// with the start view. The shell's folder dialogs are replaced in the main
// process (electronApp.evaluate over dialog.showSaveDialog and
// showOpenDialog), so New and Open run without a person. Requests the
// renderer sent are read from window.__siannClient.sent(); a second protocol
// client (support/engine-client) edits and reads the engine. Waits are
// condition polls, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchElectron } from './support/launch';
import { APP_DIR, exeFromEnv, MAIN } from './support/seed';

const MOD = 'ControlOrMeta';
const RATE = 48000;

let scratch = '';
let userData = '';
let app: ElectronApplication | undefined;
let page: Page;
let holder: ChildProcess | undefined;
const clients: EngineClient[] = [];

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-project-'));
  userData = path.join(scratch, 'user-data');
});

test.afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await app?.close().catch(() => undefined);
  app = undefined;
  if (holder && holder.exitCode === null) {
    holder.stdin?.end();
    holder.kill();
    await new Promise((resolve) => holder!.once('exit', resolve));
  }
  holder = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

// The app without SIANN_SESSION_DIR (unless `sessionDir` is given, test g).
async function launch(options: { sessionDir?: string; languages?: readonly string[]; extraEngineArgs?: readonly string[] } = {}): Promise<void> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
    SIANN_USER_DATA: userData,
    SIANN_SHELL_BACKOFF_MS: '50',
    SIANN_SHELL_TEST: '1',
    SIANN_ENGINE_TEST_ARGS: ['--device', 'fake', ...(options.extraEngineArgs ?? [])].join(' '),
  };
  delete env.SIANN_SESSION_DIR;
  if (options.sessionDir) env.SIANN_SESSION_DIR = options.sessionDir;
  app = await launchElectron({ args: [MAIN], cwd: APP_DIR, languages: options.languages ?? ['en-US'], env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
}

async function quit(): Promise<void> {
  for (const c of clients.splice(0)) c.close();
  await app!.close();
  app = undefined;
}

// The shell's dialogs answer `bundle` (or cancel with null) from now on.
async function dialogsAnswer(answers: { save?: string | null; open?: string | null }): Promise<void> {
  await app!.evaluate(({ dialog }, { save, open }) => {
    const d = dialog as unknown as Record<string, unknown>;
    if (save !== undefined) d.showSaveDialog = async () => (save === null ? { canceled: true } : { canceled: false, filePath: save });
    if (open !== undefined) d.showOpenDialog = async () => (open === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [open] });
  }, answers);
}

async function sent(method: string): Promise<number> {
  return page.evaluate((m) => window.__siannClient!.sent().filter((r) => r.method === m).length, method);
}

async function client(): Promise<EngineClient> {
  const c = await engineClient(page);
  clients.push(c);
  return c;
}

async function windowTitle(): Promise<string> {
  return app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());
}

interface MenuItemSeen {
  readonly label: string;
  readonly accelerator: string | null;
  readonly registerAccelerator: boolean;
}

async function menuItem(id: string): Promise<MenuItemSeen | null> {
  return app!.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    return item ? { label: item.label, accelerator: (item.accelerator as string | undefined) ?? null, registerAccelerator: item.registerAccelerator } : null;
  }, id);
}

async function menuLabels(): Promise<string[]> {
  return app!.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label));
}

async function clickMenu(id: string): Promise<void> {
  await app!.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById(itemId)!;
    item.click();
  }, id);
}

async function sessionName(name: string): Promise<void> {
  await expect(page.getByTestId('session-name')).toHaveAttribute('title', name);
}

async function newProject(bundle: string): Promise<void> {
  await dialogsAnswer({ save: bundle });
  await page.keyboard.press(`${MOD}+KeyN`);
  await sessionName(path.basename(bundle, '.siann'));
  await expect(page.getByTestId('start-view')).toHaveCount(0);
}

async function addTrack(c: EngineClient, trackId: string, name: string): Promise<void> {
  await c.call('command.execute', { commands: [{ op: 'track.add', trackId, name, channels: 2 }] });
  await expect(page.getByTestId(`track-header-${trackId}`)).toBeVisible();
}

async function view(): Promise<{ framesPerPixel: number; scrollFrames: string }> {
  return page.evaluate(() => (window.__siannTimeline as unknown as { view(): { framesPerPixel: number; scrollFrames: string } }).view());
}

async function focusProject(): Promise<void> {
  const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 20, canvas.y + canvas.height - 10);
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

test('(a) a first launch shows the start view; Ctrl+N creates the bundle; Open drops the old session\'s selection and zoom', async () => {
  await launch();
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect(page.getByTestId('start-new')).toHaveText(en['menu.newProject']);
  await expect(page.getByTestId('start-open')).toHaveText(en['menu.open']);
  await expect(page.getByText(en['start.noRecent'])).toBeVisible();
  // The scratch bundle is nobody's project: no name in the top bar.
  await sessionName('');
  expect(await windowTitle()).toBe(en['app.title']);

  const alpha = path.join(scratch, 'Alpha.siann');
  await newProject(alpha);
  expect(fs.existsSync(path.join(alpha, 'session.json'))).toBe(true);
  expect((await page.evaluate(() => window.__siannClient!.sent().filter((r) => r.method === 'session.create').map((r) => r.params)))).toEqual([{ path: alpha }]);
  await expect(page.getByTestId('session-name')).toContainText('Alpha');
  await expect.poll(windowTitle).toContain('Alpha');
  await addTrack(await client(), 'trk_x', 'Same id');

  const beta = path.join(scratch, 'Beta.siann');
  await newProject(beta);
  await addTrack(await client(), 'trk_x', 'Same id');
  // Beta: the track selected and the event display zoomed in.
  await page.getByTestId('track-name-trk_x').click();
  await expect(page.getByTestId('track-header-trk_x')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('inspector-track')).toHaveText('Same id');
  const before = await view();
  await focusProject();
  await page.keyboard.press('KeyH');
  await expect.poll(async () => (await view()).framesPerPixel).toBeLessThan(before.framesPerPixel);

  // Open Alpha: its track has the same id, so only the new session drops the selection.
  await dialogsAnswer({ open: alpha });
  await page.keyboard.press(`${MOD}+KeyO`);
  await sessionName('Alpha');
  await expect.poll(windowTitle).toContain('Alpha');
  await expect(page.getByTestId('track-header-trk_x')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('inspector-track')).toHaveCount(0);
  await expect.poll(async () => (await view()).framesPerPixel).toBe(before.framesPerPixel);
});

test('(b) a relaunch starts on the bundle opened last; once it is gone, on the start view', async () => {
  await launch();
  const song = path.join(scratch, 'Song.siann');
  await newProject(song);
  await quit();

  await launch();
  await sessionName('Song');
  await expect(page.getByTestId('start-view')).toHaveCount(0);
  const record = JSON.parse(fs.readFileSync(path.join(userData, 'recent-projects.json'), 'utf8')) as { schema: string; recent: string[] };
  expect(record).toEqual({ schema: 'siann.recent.v1', recent: [song] });
  await quit();

  fs.rmSync(song, { recursive: true, force: true });
  await launch();
  await expect(page.getByTestId('start-view')).toBeVisible();
  await sessionName('');
});

test('(c) the native menu: File and Studio items in en and zh-TW, accelerators shown and not registered, clicks run the commands, Open Recent opens', async () => {
  await launch();
  const first = path.join(scratch, 'First.siann');
  const second = path.join(scratch, 'Second.siann');
  await newProject(first);
  await newProject(second);

  await expect.poll(menuLabels).toEqual(expect.arrayContaining([en['menu.file'], en['menu.studio']]));
  const rows: Array<[string, string, string | null]> = [
    ['project.new', en['menu.newProject'], 'CmdOrCtrl+N'],
    ['project.open', en['menu.open'], 'CmdOrCtrl+O'],
    ['project.save', en['menu.save'], 'CmdOrCtrl+S'],
    ['studio.setup', en['menu.studioSetup'], null],
  ];
  for (const [id, label, accelerator] of rows) {
    await expect.poll(() => menuItem(id)).toEqual({ label, accelerator, registerAccelerator: false });
  }
  await expect.poll(async () => (await menuItem('project.openRecent.1'))?.label).toBe(second);
  await expect.poll(async () => (await menuItem('project.openRecent.2'))?.label).toBe(first);

  // One Ctrl+S, one session.save: the menu's accelerator is not a second key layer.
  const saves = await sent('session.save');
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect.poll(() => sent('session.save')).toBe(saves + 1);
  // A menu click runs the command.
  await clickMenu('project.save');
  await expect.poll(() => sent('session.save')).toBe(saves + 2);
  await clickMenu('project.openRecent.2');
  await sessionName('First');
  await expect.poll(async () => (await menuItem('project.openRecent.1'))?.label).toBe(first);
  expect(await sent('session.save')).toBe(saves + 2);

  // The labels follow the renderer's locale.
  await page.evaluate(() => window.__siannLocale!.setLocale('zh-Hant'));
  await expect.poll(async () => (await menuItem('project.new'))?.label).toBe(zhHant['menu.newProject']);
  await expect.poll(menuLabels).toEqual(expect.arrayContaining([zhHant['menu.file'], zhHant['menu.studio']]));
  expect((await menuItem('project.new'))?.accelerator).toBe('CmdOrCtrl+N');
});

test('(d) opening a bundle another engine holds shows the lock refusal with its path; the old session stays', async () => {
  // Bundle B, served by a second siann-engine process.
  const held = path.join(scratch, 'Held.siann');
  holder = spawn(exeFromEnv('SIANN_ENGINE_EXE'), ['--session', held, '--device', 'fake'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    holder!.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes('\n')) resolve();
    });
    holder!.once('exit', (code) => reject(new Error(`the holding engine exited: ${code}`)));
  });
  expect(fs.existsSync(path.join(held, 'lock'))).toBe(true);

  await launch();
  await newProject(path.join(scratch, 'Mine.siann'));
  await dialogsAnswer({ open: held });
  await page.keyboard.press(`${MOD}+KeyO`);
  const line = `session_locked: ${en['project.locked'].replace('{path}', held)}`;
  await expect(page.getByTestId('toast-message').filter({ hasText: held })).toHaveText(line);
  await sessionName('Mine');
  expect(await page.evaluate(() => window.__siannClient!.answered().filter((r) => r.method === 'session.open').map((r) => r.code))).toEqual(['session_locked']);
});

test('(e) the saved mark: an edit marks the title and the top bar, Save clears it; quitting unsaved loses nothing and reopens unmarked', async () => {
  await launch();
  const bundle = path.join(scratch, 'Marked.siann');
  await newProject(bundle);
  const name = page.getByTestId('session-name');
  await expect(name).not.toHaveAttribute('data-unsaved', 'true');
  await addTrack(await client(), 'trk_a', 'A');
  await expect(name).toHaveAttribute('data-unsaved', 'true');
  await expect(name).toContainText(en['session.unsavedMark']);
  await expect.poll(windowTitle).toContain(`Marked ${en['session.unsavedMark']}`);
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect(name).not.toHaveAttribute('data-unsaved', 'true');
  await expect.poll(windowTitle).not.toContain(en['session.unsavedMark']);

  // An edit, then quit without Save: no prompt, and the edit is there after a relaunch, unmarked.
  await addTrack(await client(), 'trk_b', 'B');
  await expect(name).toHaveAttribute('data-unsaved', 'true');
  await quit();
  await launch();
  await sessionName('Marked');
  await expect(page.getByTestId('track-header-trk_b')).toBeVisible();
  await expect(page.getByTestId('session-name')).not.toHaveAttribute('data-unsaved', 'true');
});

// A mono 16-bit WAV of one second.
function writeWav(file: string): void {
  const data = Buffer.alloc(RATE * 2);
  for (let i = 0; i < RATE; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i * 2);
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

async function documentHash(c: EngineClient): Promise<string> {
  return (await c.call('session.sync', {})).documentHash as string;
}

test('(f) criterion B: New, two tracks, clips, a gain, locators, Save, quit, relaunch: the same document hash', async () => {
  await launch();
  const bundle = path.join(scratch, 'Round Trip.siann');
  await newProject(bundle);
  const c = await client();
  await addTrack(c, 'trk_1', 'One');
  await addTrack(c, 'trk_2', 'Two');
  const wav = path.join(scratch, 'tone.wav');
  writeWav(wav);
  const job = await c.call('media.import', { path: wav, clientImportId: 'e2e-project-1' });
  let mediaId = '';
  await expect
    .poll(async () => {
      const status = await c.call('job.status', { jobId: job.jobId as string });
      if (status.state === 'failed') throw new Error(JSON.stringify(status));
      mediaId = ((status.result as { mediaId?: string } | undefined)?.mediaId) ?? '';
      return status.state;
    })
    .toBe('done');
  const place = (clipId: string, trackId: string, at: number) => ({
    op: 'clip.place',
    clipId,
    trackId,
    mediaId,
    position: { domain: 'audio', value: String(at) },
    sourceStart: '0',
    length: String(RATE),
  });
  await c.call('command.execute', { commands: [place('clp_1', 'trk_1', 0), place('clp_2', 'trk_2', RATE)] });
  await c.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_2', gainMilliDb: -6000 }] });
  await c.call('command.execute', { commands: [{ op: 'session.set_locators', left: String(RATE / 2), right: String(3 * RATE) }] });
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  await expect(page.getByTestId('session-name')).toHaveAttribute('data-unsaved', 'true');
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect(page.getByTestId('session-name')).not.toHaveAttribute('data-unsaved', 'true');
  const saved = await documentHash(c);
  await quit();

  await launch();
  await sessionName('Round Trip');
  expect(await documentHash(await client())).toBe(saved);
  await expect(page.getByTestId('clip-count')).toHaveText('2');
});

test('(g) SIANN_SESSION_DIR still opens <dir>/Untitled.siann with no start view', async () => {
  const dir = path.join(scratch, 'sessions');
  await launch({ sessionDir: dir });
  await expect(page.getByTestId('start-view')).toHaveCount(0);
  await sessionName('Untitled');
  expect(fs.existsSync(path.join(dir, 'Untitled.siann', 'session.json'))).toBe(true);
  // A cancelled New sends nothing.
  await dialogsAnswer({ save: null });
  const creates = await sent('session.create');
  await page.keyboard.press(`${MOD}+KeyN`);
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect.poll(() => sent('session.save')).toBeGreaterThan(0);
  expect(await sent('session.create')).toBe(creates);
});
