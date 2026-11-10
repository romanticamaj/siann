// The Electron main process (architecture spec, "Process model"): serves the
// UI from siann://app (the protocol's app origin, kAppOrigin), starts and
// supervises siann-engine, and hands the renderer only {port, token} through
// the preload bridge on every launch. Quitting the app stops the engine and
// waits for it to exit. One instance per user data directory: a second launch
// focuses the first window and quits before it starts an engine. Every
// permission and device is denied, and there are no devtools and no reload,
// packaged or not.
//
// Environment:
//   SIANN_ENGINE_EXE          the engine executable (default: the packaged
//                             resources path, or the native dev build)
//   SIANN_SESSION_DIR         directory of the M0 session bundle
//                             Untitled.siann (default: <userData>/sessions)
//   SIANN_SHELL_BACKOFF_MS    first restart delay (default 250; cap 40x)
//   SIANN_SHELL_MAX_RESTARTS  consecutive restarts before giving up (default 5)
//   SIANN_SHELL_READY_MS      how long a launch may take to write its ready line
//                             (default 30000)
//   SIANN_SHELL_STOP_GRACE_MS stdin EOF to SIGKILL on quit (default 5000)
//   SIANN_SHELL_KILL_GRACE_MS SIGTERM to SIGKILL on a failed launch, and SIGKILL
//                             to counting the engine gone (default 2000)
//   SIANN_SHELL_TEST=1        exposes the supervisor as globalThis.__siannShell
//   SIANN_USER_DATA           under SIANN_SHELL_TEST only: the user data directory
//                             (the single-instance lock lives there), so tests
//                             never meet the maintainer's running app
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
  type MenuItemConstructorOptions,
} from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { engineArgs, pluginRegistryFile } from './engine-args';
import { DEFAULT_BACKOFF, EngineSupervisor, type Backoff, type EngineGaveUp, type EngineReady } from './supervisor';

// native/libs/protocol/include/siann/protocol/protocol_server.hpp, kAppOrigin.
const APP_SCHEME = 'siann';
const APP_HOST = 'app';
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

const IPC_CURRENT = 'siann:engine:current';
const IPC_CHANGED = 'siann:engine:changed';

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

function sessionBundle(): string {
  const dir = process.env.SIANN_SESSION_DIR || path.join(app.getPath('userData'), 'sessions');
  return path.join(dir, 'Untitled.siann');
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
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
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
const engineTestArgs = underTest ? process.env.SIANN_ENGINE_TEST_ARGS?.split(' ').filter(Boolean) : undefined;

const supervisor = new EngineSupervisor({
  exe: engineExecutable(),
  args: () =>
    engineArgs({
      session: sessionBundle(),
      platform: process.platform,
      windowHandle: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getNativeWindowHandle() : null,
      backoff,
      pluginRegistry: pluginRegistryFile(app.getPath('userData')),
      testArgs: engineTestArgs,
    }),
  backoff,
  readyTimeoutMs: positiveInt('SIANN_SHELL_READY_MS'),
  stopGraceMs: positiveInt('SIANN_SHELL_STOP_GRACE_MS'),
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

// Role items without toggleDevTools, reload and forceReload (and no View menu,
// which holds them); the same menu packaged or not.
function applicationMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    ...(devtools ? [{ role: 'viewMenu' } as const] : []),
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

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
    width: 1100,
    height: 720,
    title: 'SIANN',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: devtools,
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
  void supervisor.stop().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

if (!primary) {
  // Another shell holds the lock and has been told (second-instance); no engine here.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    // Before any page loads: the renderer needs no permission, the engine owns audio.
    denyPermissions();
    Menu.setApplicationMenu(applicationMenu());
    protocol.handle(APP_SCHEME, serveApp);
    // The window first: the engine is told its handle at launch.
    createWindow();
    supervisor.start();
  });
}
