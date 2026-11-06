// The Electron shell end to end (m0-electron-shell acceptance; M0 exit
// m0-exit-lifecycle): the app starts the real siann-engine
// (SIANN_ENGINE_EXE), the renderer connects with the token handshake, a
// killed engine is restarted and the renderer reconnects, and quitting the
// app ends the engine. Waits are Playwright condition waits with bounded
// timeouts; SIANN_SHELL_BACKOFF_MS keeps the restart fast.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

function engineExe(): string {
  const exe = process.env.SIANN_ENGINE_EXE;
  if (!exe) throw new Error('set SIANN_ENGINE_EXE to the built siann-engine executable');
  if (!fs.existsSync(exe)) throw new Error(`SIANN_ENGINE_EXE points at a missing file: ${exe}`);
  return exe;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let sessionDir: string;
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
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-shell-'));
  app = await electron.launch({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: engineExe(),
      SIANN_SESSION_DIR: sessionDir,
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
    },
  });
  page = await app.firstWindow();
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = '';
});

test('the renderer connects with the token handshake', async () => {
  expect(page.url()).toMatch(/^siann:\/\/app\//);
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId('session-id')).toHaveText(/^ses_[0-9a-f]+$/);
  await expect(page.getByTestId('revision')).toHaveText(/^r\d+$/);
  await expect(page.getByTestId('about')).toContainText('siann-engine');
  await expect(page.getByTestId('about')).toContainText(/(A?GPL)-\d\.\d-or-later/);
  // The new session was created where the shell was told.
  expect(fs.existsSync(path.join(sessionDir, 'Untitled.siann'))).toBe(true);

  // contextIsolation on, nodeIntegration off: no Node in the page.
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe('undefined');
  // The preload bridge exposes the engine endpoint and nothing else; the MCP
  // token stays in the main process.
  const bridge = await page.evaluate(async () => {
    const siann = (window as unknown as { siann: Record<string, Record<string, unknown>> }).siann;
    const engine = siann.engine as { current(): Promise<Record<string, unknown> | null> };
    const current = await engine.current();
    return { top: Object.keys(siann), engine: Object.keys(siann.engine), current: current ? Object.keys(current) : null };
  });
  expect(bridge.top).toEqual(['engine']);
  expect([...bridge.engine].sort()).toEqual(['current', 'onChange']);
  expect([...(bridge.current ?? [])].sort()).toEqual(['port', 'token']);
});

test('a killed engine is restarted and the renderer reconnects', async () => {
  await expect(page.getByTestId('status')).toHaveText('connected');
  const firstSession = await page.getByTestId('session-id').textContent();
  const firstPid = await enginePid();
  expect(firstPid).not.toBeNull();

  // Record every status the renderer shows from here on, so a short
  // "disconnected" between kill and reconnect is not missed.
  await page.evaluate(() => {
    const status = document.querySelector('[data-testid="status"]')!;
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    new MutationObserver(() => seen.push(status.textContent ?? '')).observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });

  process.kill(firstPid!);

  await expect.poll(async () => isAlive(firstPid!)).toBe(false);
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses))
    .toContain('disconnected');
  await expect.poll(enginePid).not.toBe(firstPid);
  await expect.poll(enginePid).not.toBeNull();
  await expect(page.getByTestId('status')).toHaveText('connected');
  // A new engine with a new per-launch token was accepted: the shell handed
  // the renderer the new pair.
  await expect(page.getByTestId('session-id')).toHaveText(/^ses_[0-9a-f]+$/);
  await expect(page.getByTestId('session-id')).not.toHaveText(firstSession ?? '');
  const statuses = await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  expect(statuses.indexOf('disconnected')).toBeLessThan(statuses.lastIndexOf('connected'));
});

test('quitting the app ends the engine', async () => {
  await expect(page.getByTestId('status')).toHaveText('connected');
  const pid = await enginePid();
  expect(pid).not.toBeNull();
  expect(isAlive(pid!)).toBe(true);

  await app.close();

  await expect.poll(() => isAlive(pid!)).toBe(false);
});
