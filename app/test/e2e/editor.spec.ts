// A plugin editor owned by the real Electron window (m0-plugin-hosting acceptance
// item 3; architecture spec, "Process model"). The shell starts a desktop engine
// (SIANN_DESKTOP_ENGINE_EXE, a SIANN_WITH_JUCE build) told to open the plugin at
// SIANN_TEST_PLUGIN, and Windows itself says who owns the editor. Skips unless both
// variables are set; check-all --app sets them when the desktop preset is built.

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const OWNED_WINDOWS = path.join(__dirname, 'support', 'owned-windows.ps1');

const desktopEngine = process.env.SIANN_DESKTOP_ENGINE_EXE;
const plugin = process.env.SIANN_TEST_PLUGIN;

interface EngineWindow {
  window: string;
  owner: string;
  visible: boolean;
}

function windowsOf(pid: number): EngineWindow[] {
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OWNED_WINDOWS, '-ProcessId', String(pid)],
    { encoding: 'utf8' },
  );
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [window = '', owner = '', visible = ''] = line.trim().split(' ');
      return { window, owner, visible: visible === 'True' };
    });
}

let sessionDir = '';
let app: ElectronApplication | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('on Windows the plugin editor is owned by the Electron window, and shows', async () => {
  test.skip(process.platform !== 'win32', 'GWLP_HWNDPARENT is Windows; macOS editors float');
  test.skip(!desktopEngine || !plugin, 'set SIANN_DESKTOP_ENGINE_EXE and SIANN_TEST_PLUGIN');
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);

  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-editor-'));
  app = await electron.launch({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: desktopEngine!,
      SIANN_OPEN_EDITOR: plugin!,
      SIANN_SESSION_DIR: sessionDir,
      SIANN_SHELL_TEST: '1',
    },
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');

  const shellWindow = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readBigUInt64LE(0).toString(),
  );
  const pid = await app.evaluate(() => {
    return (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid();
  });
  expect(pid).not.toBeNull();

  // The ready line comes after the editor opened, and "connected" after that.
  const owned = windowsOf(pid!).filter((window) => window.owner === shellWindow);
  expect(owned).toHaveLength(1);
  expect(owned[0]!.visible).toBe(true);
});
