// The Electron main process (architecture spec, "Process model"): serves the
// UI from siann://app (the protocol's app origin, kAppOrigin), starts and
// supervises siann-engine, and hands the renderer only {port, token} through
// the preload bridge on every launch. Quitting the app stops the engine and
// waits for it to exit. One instance per user data directory: a second launch
// focuses the first window and quits before it starts an engine. Every
// permission and device is denied, and there are no devtools and no reload,
// packaged or not.
//
// Projects (m5b-ui-project; architecture spec, "Session at launch"): the
// engine is launched on the bundle projects.ts chooses (SIANN_SESSION_DIR,
// the bundle opened last, the adopted M0 default, or the scratch bundle with
// the renderer's start view), and on the current bundle after a restart. The
// renderer reports each bundle the engine created or opened (the protocol
// names none), and the shell records it in <userData>/recent-projects.json.
// The folder dialogs are the shell's, behind the preload bridge. The
// application menu is built from the renderer's model (menu.ts): labels from
// its catalogs, accelerators shown and not registered, clicks sent back as
// command ids. Every IPC handler checks that the sender is the window's
// siann://app page, and a path that it is an absolute string.
//
// Environment:
//   SIANN_ENGINE_EXE          the engine executable (default: the packaged
//                             resources path, or the native dev build)
//   SIANN_SESSION_DIR         tests: the engine runs on <dir>/Untitled.siann and
//                             the renderer shows no start view (default: the
//                             bundle opened last, or the scratch bundle)
//   SIANN_SHELL_BACKOFF_MS    first restart delay (default 250; cap 40x)
//   SIANN_SHELL_MAX_RESTARTS  consecutive restarts before giving up (default 5)
//   SIANN_SHELL_READY_MS      how long a launch may take to write its ready line
//                             (default 30000)
//   SIANN_SHELL_STOP_GRACE_MS stdin EOF to SIGKILL on quit (default 5000)
//   SIANN_SHELL_KILL_GRACE_MS SIGTERM to SIGKILL on a failed launch, and SIGKILL
//                             to counting the engine gone (default 2000)
//   SIANN_SHELL_TEST=1        exposes the supervisor as globalThis.__siannShell,
//                             and the renderer's timeline as window.__siannTimeline
//   SIANN_USER_DATA           under SIANN_SHELL_TEST only: the user data directory
//                             (the single-instance lock lives there), so tests
//                             never meet the maintainer's running app
//   SIANN_TEST_LANGS          under SIANN_SHELL_TEST only: comma-separated system
//                             languages the renderer's locale detection reads
//                             instead of navigator.languages (e2e pin)
//   SIANN_TEST_CAPABILITIES   under SIANN_SHELL_TEST only: a JSON file whose
//                             object the renderer's session client uses in
//                             place of the engine's engine.capabilities answer
//                             (an engine that lacks methods; m5-ui-loop-click)
//   SIANN_SHELL_PROFILING=1   under SIANN_SHELL_TEST only: serves the profiling
//                             bundle (react-dom/profiling) as renderer.js, so the
//                             renderer's root <Profiler> counts React commits
//   SIANN_SHELL_DEVTOOLS=1    devtools, the View menu's reload and the keys back,
//                             for debugging

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { engineArgs, engineTestArgs, fidelityEnvironmentArgs, pluginRegistryFile, testCapabilitiesArgs } from './engine-args';
import { focusFirstWindow } from './focus';
import { chosenPaths, mediaDialogOptions, mediaFormats, mediaLabel } from './media';
import { menuTemplate, parseMenuModel, type MenuModel } from './menu';
import { addRecent, bundleName, isBundlePath, launchSession, recentFile, scratchBundle, serializeRecent, type ProjectsFs } from './projects';
import { rendererRequestPath } from './serve';
import { DEFAULT_BACKOFF, EngineSupervisor, type Backoff, type EngineGaveUp, type EngineReady } from './supervisor';

// native/libs/protocol/include/siann/protocol/protocol_server.hpp, kAppOrigin.
const APP_SCHEME = 'siann';
const APP_HOST = 'app';
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

const IPC_CURRENT = 'siann:engine:current';
const IPC_CHANGED = 'siann:engine:changed';
const IPC_PROJECT_STATE = 'siann:project:state';
const IPC_PROJECT_CHOOSE_NEW = 'siann:project:choose-new';
const IPC_PROJECT_CHOOSE_OPEN = 'siann:project:choose-open';
const IPC_PROJECT_OPENED = 'siann:project:opened';
const IPC_PROJECT_CHANGED = 'siann:project:changed';
const IPC_MEDIA_CHOOSE = 'siann:media:choose';
const IPC_MENU_SET = 'siann:menu:set';
const IPC_MENU_COMMAND = 'siann:menu:command';
const BUNDLE_EXTENSION = 'siann';
// Under SIANN_SHELL_TEST=1 only: when the first ready line was read (epoch ms),
// the start of the perf scenario's cold start (UI redesign spec 5.6).
const IPC_TEST_READY_AT = 'siann:test:engine-ready-at';

// app/ (this file is app/dist/src/main/main.js).
const APP_DIR = path.resolve(__dirname, '..', '..', '..');
// Static files first, then the compiled renderer scripts.
const RENDERER_ROOTS = [path.join(APP_DIR, 'renderer'), path.join(APP_DIR, 'dist', 'src', 'renderer')];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

interface EngineEndpoint {
  port: number;
  token: string;
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const underTest = process.env.SIANN_SHELL_TEST === '1';
const devtools = process.env.SIANN_SHELL_DEVTOOLS === '1';

if (underTest && process.env.SIANN_USER_DATA) app.setPath('userData', process.env.SIANN_USER_DATA);
// Before whenReady (spec, "Process model", Single instance): two shells would run
// two engines on one session bundle.
const primary = app.requestSingleInstanceLock();

function engineExecutable(): string {
  const fromEnv = process.env.SIANN_ENGINE_EXE;
  if (fromEnv) return fromEnv;
  const name = process.platform === 'win32' ? 'siann-engine.exe' : 'siann-engine';
  if (app.isPackaged) return path.join(process.resourcesPath, name);
  return path.join(APP_DIR, '..', 'native', 'build', 'dev', 'apps', 'engine', name);
}

const projectsFs: ProjectsFs = {
  readText: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  },
  isFile: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

// The bundle the engine serves: the launch choice, then each one the renderer reports.
const launchChoice = launchSession({ sessionDir: process.env.SIANN_SESSION_DIR || undefined, userData: app.getPath('userData'), fs: projectsFs });
let currentBundle = launchChoice.bundle;
let startView = launchChoice.startView;
let recent = launchChoice.recent;

function writeRecent(): void {
  try {
    projectsFs.writeText(recentFile(app.getPath('userData')), serializeRecent(recent));
  } catch {
    // The record is a convenience: a read-only user data directory loses it, not the session.
  }
}
if (launchChoice.write && primary) writeRecent();

function sessionBundle(): string {
  return currentBundle;
}

function projectState(): { current: string | null; startView: boolean; recent: Array<{ path: string; name: string }> } {
  return {
    current: startView ? null : currentBundle,
    startView,
    recent: recent.map((bundle) => ({ path: bundle, name: bundleName(bundle) })),
  };
}

function positiveInt(name: string): number | undefined {
  const text = process.env[name];
  if (text === undefined || text === '') return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function backoffFromEnv(): Backoff {
  const backoff: Backoff = { ...DEFAULT_BACKOFF };
  const initial = positiveInt('SIANN_SHELL_BACKOFF_MS');
  if (initial !== undefined) {
    backoff.initialMs = initial;
    backoff.maxMs = initial * 40;
  }
  const maxRestarts = positiveInt('SIANN_SHELL_MAX_RESTARTS');
  if (maxRestarts !== undefined) backoff.maxRestarts = maxRestarts;
  return backoff;
}

function endpointOf(ready: EngineReady | null): EngineEndpoint | null {
  return ready ? { port: ready.port, token: ready.token } : null;
}

// Serves siann://app/<path> from RENDERER_ROOTS; nothing outside them.
async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
  const relative = rendererRequestPath(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname), process.env);
  if (relative === null) return new Response('not found', { status: 404 });
  for (const root of RENDERER_ROOTS) {
    const file = path.resolve(root, `.${relative}`);
    if (file !== root && !file.startsWith(root + path.sep)) continue;
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' },
      });
    } catch {
      // try the next root
    }
  }
  return new Response('not found', { status: 404 });
}

const backoff = backoffFromEnv();
const testArgs = underTest ? engineTestArgs(process.env.SIANN_ENGINE_TEST_ARGS) : undefined;

const supervisor = new EngineSupervisor({
  exe: engineExecutable(),
  args: () =>
    engineArgs({
      session: sessionBundle(),
      platform: process.platform,
      windowHandle: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getNativeWindowHandle() : null,
      backoff,
      pluginRegistry: pluginRegistryFile(app.getPath('userData')),
      testArgs,
    }),
  backoff,
  readyTimeoutMs: positiveInt('SIANN_SHELL_READY_MS'),
  stopGraceMs: positiveInt('SIANN_SHELL_STOP_GRACE_MS'),
  // Epoch ms at sub-ms resolution, the clock the renderer's
  // performance.timeOrigin is on.
  now: () => performance.timeOrigin + performance.now(),
  killGraceMs: positiveInt('SIANN_SHELL_KILL_GRACE_MS'),
  spawn: (exe, args) => spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

if (underTest) {
  (globalThis as { __siannShell?: EngineSupervisor }).__siannShell = supervisor;
}

let mainWindow: BrowserWindow | null = null;

function notifyRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANGED, endpointOf(supervisor.current()));
}

supervisor.on('ready', notifyRenderer);
supervisor.on('exit', notifyRenderer);
supervisor.on('protocol-error', notifyRenderer);
supervisor.on('gave-up', (info: EngineGaveUp) => {
  notifyRenderer();
  const detail = [`exit code: ${info.code ?? info.signal ?? 'unknown'}`, '', ...info.stderr].join('\n');
  void dialog.showMessageBox({ type: 'error', title: 'SIANN', message: 'The SIANN engine keeps stopping.', detail });
});

ipcMain.handle(IPC_CURRENT, () => endpointOf(supervisor.current()));
if (underTest) ipcMain.handle(IPC_TEST_READY_AT, () => supervisor.firstReadyAt());

// Only the window's own page, served from siann://app, reaches the project and menu handlers.
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && url.startsWith(`${APP_SCHEME}://${APP_HOST}/`);
}

function notifyProject(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_PROJECT_CHANGED, projectState());
}

ipcMain.handle(IPC_PROJECT_STATE, (event) => (fromApp(event) ? projectState() : null));

// New: a folder that does not exist yet, named <name>.siann unless the user gave an extension.
ipcMain.handle(IPC_PROJECT_CHOOSE_NEW, async (event) => {
  if (!fromApp(event) || !mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), `Untitled.${BUNDLE_EXTENSION}`),
    filters: [{ name: 'SIANN', extensions: [BUNDLE_EXTENSION] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  const chosen = result.canceled ? undefined : result.filePath;
  if (!isBundlePath(chosen)) return null;
  return path.extname(chosen) === '' ? `${chosen}.${BUNDLE_EXTENSION}` : chosen;
});

// Open: an existing bundle's folder.
ipcMain.handle(IPC_PROJECT_CHOOSE_OPEN, async (event) => {
  if (!fromApp(event) || !mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  const chosen = result.canceled ? undefined : result.filePaths[0];
  return isBundlePath(chosen) ? chosen : null;
});

// The Media tab's Import (m5b-ui-media): one or more audio files of the
// formats the engine lists, absolute paths only; [] when cancelled.
ipcMain.handle(IPC_MEDIA_CHOOSE, async (event, request: unknown) => {
  if (!fromApp(event) || !mainWindow) return [];
  const asked = (typeof request === 'object' && request !== null ? request : {}) as { formats?: unknown; label?: unknown };
  const options = mediaDialogOptions(mediaFormats(asked.formats), mediaLabel(asked.label));
  const result = await dialog.showOpenDialog(mainWindow, { properties: [...options.properties], filters: options.filters });
  return chosenPaths(result);
});

// The engine created or opened the bundle: it is the current one (an engine
// restart opens it) and the newest of the record.
ipcMain.on(IPC_PROJECT_OPENED, (event, bundle: unknown) => {
  if (!fromApp(event) || !isBundlePath(bundle)) return;
  currentBundle = path.resolve(bundle);
  startView = false;
  recent = addRecent(recent, currentBundle, scratchBundle(app.getPath('userData')));
  writeRecent();
  notifyProject();
});

let menuModel: MenuModel | null = null;

function applyMenu(): void {
  const template = menuTemplate(menuModel, {
    platform: process.platform,
    devtools,
    send: (command) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_MENU_COMMAND, command);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on(IPC_MENU_SET, (event, value: unknown) => {
  if (!fromApp(event)) return;
  const model = parseMenuModel(value);
  if (!model) return;
  menuModel = model;
  applyMenu();
});


// F12 and Ctrl/Cmd+Shift+I (devtools), Ctrl/Cmd+R (and with Shift) and F5 (reload).
function isDevtoolsOrReloadKey(input: Electron.Input): boolean {
  const key = input.key.toLowerCase();
  const command = input.control || input.meta;
  return key === 'f12' || key === 'f5' || (command && input.shift && key === 'i') || (command && key === 'r');
}

function denyPermissions(): void {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setDevicePermissionHandler(() => false);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    // The redesign's reference size; the shell lays out down to 960x600 (UI
    // redesign spec 2.4).
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    useContentSize: true,
    title: 'SIANN',
    webPreferences: {
      // Meters and the transport keep running behind a plugin editor window
      // (spec 5.7); the draw loops still stop when the page is hidden.
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: devtools,
      // The renderer's test hooks (window.__siannTimeline, window.__siannLocale)
      // and the pinned system languages, under SIANN_SHELL_TEST=1 only.
      additionalArguments: underTest
        ? [
            '--siann-test-hooks',
            ...(process.env.SIANN_TEST_LANGS ? [`--siann-test-langs=${process.env.SIANN_TEST_LANGS}`] : []),
            ...testCapabilitiesArgs(process.env, (file) => fs.readFileSync(file, 'utf8')),
            // The fidelity run's device and build (m5-ui-alignment-chrome).
            ...fidelityEnvironmentArgs(process.env),
          ]
        : [],
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!devtools && isDevtoolsOrReloadKey(input)) event.preventDefault();
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(APP_URL);
}

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  // Stop the engine first; stop() is bounded even if the engine never exits.
  event.preventDefault();
  quitting = true;
  // The renderer's localStorage (the UI locale, siann.locale) is written lazily:
  // flush it before the process goes. (A second instance quits before ready,
  // when there is no session to touch.)
  if (app.isReady()) session.defaultSession.flushStorageData();
  void supervisor.stop().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

if (!primary) {
  // Another shell holds the lock and has been told (second-instance); no engine here.
  app.quit();
} else {
  app.on('second-instance', () => focusFirstWindow(app, mainWindow, process.platform));

  void app.whenReady().then(() => {
    // Before any page loads: the renderer needs no permission, the engine owns audio.
    denyPermissions();
    // Role items without toggleDevTools, reload and forceReload (and no View
    // menu, which holds them) until the renderer sends its model; the same
    // menu packaged or not.
    applyMenu();
    protocol.handle(APP_SCHEME, serveApp);
    // The window first: the engine is told its handle at launch.
    createWindow();
    supervisor.start();
  });
}
