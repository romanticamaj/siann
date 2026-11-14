// The shell's hardening end to end (m5-shell-hardening; architecture spec, "Process
// model"): one instance per user data directory, every permission and device
// denied, no devtools and no reload, window.open denied and navigation held to
// siann://app/. The app runs as shell.spec.ts runs it, with the real siann-engine
// (SIANN_ENGINE_EXE) and SIANN_SHELL_TEST=1, and its own user data directory
// (SIANN_USER_DATA), so the single-instance lock never meets the maintainer's
// running app. Waits are Playwright condition waits or waits on a process, bounded.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchElectron } from './support/launch';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

function engineExe(): string {
  const exe = process.env.SIANN_ENGINE_EXE;
  if (!exe) throw new Error('set SIANN_ENGINE_EXE to the built siann-engine executable');
  if (!fs.existsSync(exe)) throw new Error(`SIANN_ENGINE_EXE points at a missing file: ${exe}`);
  return exe;
}

let scratch: string;
let env: Record<string, string>;
let app: ElectronApplication;
let page: Page;

async function enginePid(): Promise<number | null> {
  return app.evaluate(() => {
    const shell = (globalThis as { __siannShell?: { pid(): number | null } }).__siannShell;
    return shell ? shell.pid() : null;
  });
}

test.beforeEach(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-hardening-'));
  env = {
    ...(process.env as Record<string, string>),
    SIANN_ENGINE_EXE: engineExe(),
    SIANN_SESSION_DIR: path.join(scratch, 'sessions'),
    SIANN_USER_DATA: path.join(scratch, 'user-data'),
    SIANN_SHELL_BACKOFF_MS: '50',
    SIANN_SHELL_TEST: '1',
    SIANN_ENGINE_TEST_ARGS: '--device fake',
  };
  delete env.SIANN_SHELL_DEVTOOLS;
  // Chromium's fake capture devices: without a microphone getUserMedia fails with
  // NotFoundError before any permission is asked (CI runners have none).
  app = await launchElectron({ args: ['--use-fake-device-for-media-stream', MAIN], cwd: APP_DIR, env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

// Whether this environment lets the app take window activation at all. A bare
// Electron app Playwright launches from a launchd Aqua agent on macOS 15 never
// becomes key, whatever it calls (win.focus(), app.focus({steal: true}),
// setAlwaysOnTop + moveTop): there no fix can make isFocused() true. The probe is a
// fresh window the main process creates, asks for focus by every route, and
// destroys; it is focusable exactly when the environment grants activation.
async function canFocusAWindow(): Promise<boolean> {
  return app.evaluate(
    ({ app: electronApp, BrowserWindow }) =>
      new Promise<boolean>((resolve) => {
        const probe = new BrowserWindow({ width: 200, height: 120, show: false });
        const done = (focused: boolean) => {
          clearTimeout(timer);
          if (!probe.isDestroyed()) probe.destroy();
          resolve(focused);
        };
        const timer = setTimeout(() => done(!probe.isDestroyed() && probe.isFocused()), 3_000);
        probe.once('focus', () => done(true));
        probe.show();
        if (process.platform === 'darwin') electronApp.focus({ steal: true });
        probe.focus();
      }),
  );
}

test('a second launch exits 0 without an engine, and the first window is focused', async () => {
  const pid = await enginePid();
  expect(pid).not.toBeNull();
  // Probe first, so the probe window is gone before the first window is wrapped.
  const checksFocus = process.platform === 'win32' || process.platform === 'darwin';
  const focusable = checksFocus && (await canFocusAWindow());
  // Count the holder's focus() calls and any ready line from here on.
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __focusCalls: number; __readies: number; __siannShell: NodeJS.EventEmitter };
    const win = BrowserWindow.getAllWindows()[0]!;
    g.__focusCalls = 0;
    g.__readies = 0;
    const focus = win.focus.bind(win);
    win.focus = () => {
      g.__focusCalls += 1;
      focus();
    };
    g.__siannShell.on('ready', () => {
      g.__readies += 1;
    });
  });

  // The second instance gets a session directory of its own: an engine it started
  // would create its bundle there.
  const secondSessions = path.join(scratch, 'second-sessions');
  const electronExe = require('electron') as unknown as string;
  const second = spawn(electronExe, [MAIN], {
    cwd: APP_DIR,
    env: { ...env, SIANN_SESSION_DIR: secondSessions },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error('the second instance did not exit in 30 s'));
    }, 30_000);
    second.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  expect(code).toBe(0);
  expect(fs.existsSync(secondSessions)).toBe(false);

  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __focusCalls: number }).__focusCalls))
    .toBe(1);
  expect(await enginePid()).toBe(pid);
  expect(await app.evaluate(() => (globalThis as unknown as { __readies: number }).__readies)).toBe(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  // Linux CI runs xvfb without a window manager, so focus() is the evidence there.
  // Where the probe could not focus a window, neither can the fix: focus() stays the
  // evidence and the skip is recorded. Wherever the probe succeeds the check is strict.
  if (checksFocus) {
    if (!focusable) {
      test.info().annotations.push({ type: 'skip-reason', description: 'environment cannot grant window activation' });
      return;
    }
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()))
      .toBe(true);
  }
});

test('every permission is denied', async () => {
  const media = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    } catch (error) {
      return (error as DOMException).name;
    }
  });
  expect(media).toBe('NotAllowedError');
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied');
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state)).toBe(
    'denied',
  );
});

// A key as the window receives one: sendInputEvent goes through before-input-event
// and, unhandled, the menu's accelerators, which Playwright's keyboard (CDP input)
// bypasses.
async function press(keyCode: string, modifiers: Array<'control' | 'shift'> = []): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, key) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers: key.modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode, modifiers: key.modifiers });
    },
    { keyCode, modifiers },
  );
}

test('no devtools and no reload: the menu, the preference and the keys', async () => {
  const roles = await app.evaluate(({ Menu }) => {
    const found: string[] = [];
    const walk = (menu: Electron.Menu | null) => {
      for (const item of menu?.items ?? []) {
        if (item.role) found.push(String(item.role).toLowerCase());
        walk(item.submenu ?? null);
      }
    };
    walk(Menu.getApplicationMenu());
    return found;
  });
  expect(roles.length).toBeGreaterThan(0);
  for (const role of ['toggledevtools', 'reload', 'forcereload']) expect(roles).not.toContain(role);

  // Every key goes through before-input-event: the main process records each one
  // (and any devtools window opening), so the test knows when a key has arrived.
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __keys: string[]; __devtoolsOpened: number };
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    g.__keys = [];
    g.__devtoolsOpened = 0;
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown') g.__keys.push(input.key);
    });
    contents.on('devtools-opened', () => {
      g.__devtoolsOpened += 1;
    });
  });
  const keys = () => app.evaluate(() => (globalThis as unknown as { __keys: string[] }).__keys);

  // getLastWebPreferences() does not report devTools, so ask for devtools: a window
  // with devTools false ignores openDevTools(). Opening is asynchronous; the
  // bounded wait is on an event that must not come.
  const opened = await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<boolean>((resolve) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        const timer = setTimeout(() => resolve(contents.isDevToolsOpened()), 2_000);
        contents.once('devtools-opened', () => {
          clearTimeout(timer);
          contents.closeDevTools();
          resolve(true);
        });
        contents.openDevTools({ mode: 'detach' });
      }),
  );
  expect(opened).toBe(false);

  await press('F12');
  await press('I', ['control', 'shift']);
  await expect.poll(keys).toEqual(expect.arrayContaining(['F12', 'I']));

  // A reload would drop the marker and start the connection count again.
  const connections = await page.getByTestId('connections').textContent();
  expect(Number(connections)).toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as { __marker: number }).__marker = 1;
  });
  await press('R', ['control']);
  await press('F5');
  await press('R', ['control', 'shift']);
  await expect.poll(keys).toEqual(expect.arrayContaining(['F12', 'I', 'F5']));
  await expect.poll(async () => (await keys()).filter((key) => key.toLowerCase() === 'r').length).toBe(2);
  await expect(page.getByTestId('status')).toHaveText('connected');
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await expect(page.getByTestId('connections')).toHaveText(connections ?? '');
  expect(
    await app.evaluate(({ BrowserWindow }) => ({
      opened: BrowserWindow.getAllWindows()[0]!.webContents.isDevToolsOpened(),
      events: (globalThis as unknown as { __devtoolsOpened: number }).__devtoolsOpened,
    })),
  ).toEqual({ opened: false, events: 0 });
});

test('window.open is denied, and navigation stays under siann://app/', async () => {
  expect(await page.evaluate(() => window.open('https://example.com') === null)).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  // Record what the main process is asked to navigate to.
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __navigations: string[] };
    g.__navigations = [];
    BrowserWindow.getAllWindows()[0]!.webContents.on('will-navigate', (_event, url) => g.__navigations.push(url));
  });
  const navigations = () => app.evaluate(() => (globalThis as unknown as { __navigations: string[] }).__navigations);

  await page.evaluate(() => {
    (window as unknown as { __marker: number }).__marker = 1;
    location.assign('https://example.com/');
  });
  await expect.poll(navigations).toContain('https://example.com/');
  // The same document: Playwright's locators would wait on the cancelled navigation,
  // so the page is read with evaluate.
  expect(page.url()).toMatch(/^siann:\/\/app\//);
  expect(
    await page.evaluate(() => ({
      marker: (window as unknown as { __marker?: number }).__marker,
      href: location.href,
      status: document.querySelector('[data-testid="status"]')?.textContent,
    })),
  ).toEqual({ marker: 1, href: 'siann://app/index.html', status: 'connected' });

  await page.evaluate(() => location.assign('siann://app/index.html?nav=1')).catch(() => undefined);
  await page.waitForURL('siann://app/index.html?nav=1');
  expect(await navigations()).toContain('siann://app/index.html?nav=1');
  await expect(page.getByTestId('status')).toHaveText('connected');
});

test("the CSP lets the renderer reach only 127.0.0.1: another origin's fetch is blocked", async () => {
  await page.evaluate(() => {
    const g = window as unknown as { __violations: string[] };
    g.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      g.__violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  const outcome = (url: string) =>
    page.evaluate(async (target) => {
      try {
        await fetch(target);
        return 'fetched';
      } catch (error) {
        return (error as Error).name;
      }
    }, url);
  // Another origin: refused before any request leaves (a TypeError, and a connect-src violation).
  expect(await outcome('https://example.com/')).toBe('TypeError');
  expect(await outcome('http://localhost:9/')).toBe('TypeError');
  const violations = () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
  await expect
    .poll(violations)
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^connect-src https:\/\/example\.com/),
        expect.stringMatching(/^connect-src http:\/\/localhost:9/),
      ]),
    );
  // The engine's own HTTP route on 127.0.0.1 is allowed (the peaks route, Protocol v0 item 23).
  const endpoint = await page.evaluate(() =>
    (window as unknown as { siann: { engine: { current(): Promise<{ port: number; token: string } | null> } } }).siann.engine.current(),
  );
  expect(endpoint).not.toBeNull();
  const before = (await violations()).length;
  const status = await page.evaluate(
    async ({ port, token }) =>
      (await fetch(`http://127.0.0.1:${port}/v0/peaks/${'0'.repeat(64)}`, { headers: { Authorization: `Bearer ${token}` } })).status,
    endpoint!,
  );
  expect(status).toBe(404);
  expect((await violations()).length).toBe(before);
});
