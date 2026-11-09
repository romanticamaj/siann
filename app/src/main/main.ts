// The Electron main process (architecture spec, "Process model"): serves the
// UI from siann://app (the protocol's app origin, kAppOrigin), starts and
// supervises siann-engine, and hands the renderer only {port, token} through
// the preload bridge on every launch. Quitting the app stops the engine and
// waits for it to exit.
//
// Environment:
//   SIANN_ENGINE_EXE          the engine executable (default: the packaged
//                             resources path, or the native dev build)
//   SIANN_SESSION_DIR         directory of the M0 session bundle
//                             Untitled.siann (default: <userData>/sessions)
//   SIANN_SHELL_BACKOFF_MS    first restart delay (default 250; cap 40x)
//   SIANN_SHELL_MAX_RESTARTS  consecutive restarts before giving up (default 5)
//   SIANN_SHELL_TEST=1        exposes the supervisor as globalThis.__siannShell

import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
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
const engineTestArgs =
  process.env.SIANN_SHELL_TEST === '1' ? process.env.SIANN_ENGINE_TEST_ARGS?.split(' ').filter(Boolean) : undefined;

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
  spawn: (exe, args) => spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

if (process.env.SIANN_SHELL_TEST === '1') {
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
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

void app.whenReady().then(() => {
  protocol.handle(APP_SCHEME, serveApp);
  // The window first: the engine is told its handle at launch.
  createWindow();
  supervisor.start();
});
