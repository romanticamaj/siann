// A plugin editor owned by the real Electron window (m0-plugin-hosting acceptance
// item 3; architecture spec, "Process model"). The shell starts a desktop engine
// (SIANN_DESKTOP_ENGINE_EXE, a SIANN_WITH_JUCE build); the test opens the plugin at
// SIANN_TEST_PLUGIN through the protocol, as a client does since M4
// (m4-plugin-node: command.execute track.add, plugin.instantiate, then
// plugin.open_editor), and Windows itself says who owns the editor. Skips unless both
// variables are set; check-all --app sets them when the desktop preset is built.
//
// The same for a CLAP editor (m5-clap-editor-window): SIANN_TEST_PLUGIN_CLAP names
// siann_test_plugin's CLAP, whose gui extension embeds into the window the desktop
// engine supplies.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const OWNED_WINDOWS = path.join(__dirname, 'support', 'owned-windows.ps1');

const desktopEngine = process.env.SIANN_DESKTOP_ENGINE_EXE;

// The format a plugin path names, by its extension.
const FORMATS: Record<string, string> = { '.vst3': 'vst3', '.component': 'au', '.clap': 'clap' };

const CASES = [
  { name: 'plugin editor', variable: 'SIANN_TEST_PLUGIN' },
  { name: 'CLAP editor', variable: 'SIANN_TEST_PLUGIN_CLAP' },
];

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

type Reply = { requestId?: string; ok?: boolean; result?: Record<string, unknown>; error?: { code: string } };

// A protocol client of the engine the renderer is connected to, with the
// {port, token} the preload bridge gives the renderer.
async function engineClient(page: Page) {
  const endpoint = await page.evaluate(() =>
    (window as unknown as { siann: { engine: { current(): Promise<{ port: number; token: string } | null> } } }).siann.engine.current(),
  );
  if (endpoint === null) throw new Error('the renderer has no engine');
  const sessionId = (await page.getByTestId('session-id').textContent()) ?? '';
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
  const replies: string[] = [];
  let wake = () => {};
  socket.addEventListener('message', (event) => {
    replies.push(String(event.data));
    wake();
  });
  const next = async (): Promise<Reply> => {
    while (replies.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    return JSON.parse(replies.shift()!) as Reply;
  };
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  socket.send(JSON.stringify({ type: 'auth', token: endpoint.token }));
  await next();
  let calls = 0;
  return {
    async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      const requestId = `req_editor_${++calls}`;
      socket.send(JSON.stringify({ requestId, sessionId, method, params }));
      for (;;) {
        const reply = await next();
        if (reply.requestId !== requestId) continue;
        if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
        return reply.result!;
      }
    },
    close: () => socket.close(),
  };
}

let sessionDir = '';
let app: ElectronApplication | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
});

for (const { name, variable } of CASES) {
  test(`on Windows the ${name} is owned by the Electron window, and shows`, async () => {
    const plugin = process.env[variable];
    test.skip(process.platform !== 'win32', 'GWLP_HWNDPARENT is Windows; macOS editors float');
    test.skip(!desktopEngine || !plugin, `set SIANN_DESKTOP_ENGINE_EXE and ${variable}`);
    if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
    const format = FORMATS[path.extname(plugin!).toLowerCase()];
    if (!format) throw new Error(`${variable} names no plugin format: ${plugin}`);

    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-editor-'));
    // The plugin's directory is a --plugin-dir and the test approves it, in its own
    // <userData>/plugin-registry.json (m5-plugin-registry).
    app = await electron.launch({
      args: [MAIN, `--user-data-dir=${path.join(sessionDir, 'user-data')}`],
      cwd: APP_DIR,
      env: {
        ...process.env,
        SIANN_ENGINE_EXE: desktopEngine!,
        SIANN_SESSION_DIR: sessionDir,
        SIANN_SHELL_TEST: '1',
        SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--plugin-dir', path.dirname(plugin!)]),
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

    const client = await engineClient(page);
    try {
      await client.call('command.execute', {
        commands: [{ op: 'track.add', trackId: 'trk_editor', name: 'Editor', channels: 2 }],
      });
      await client.call('plugin.approve', { format, path: plugin!, approved: true });
      const loaded = await client.call('plugin.instantiate', {
        trackId: 'trk_editor',
        index: 0,
        descriptor: { format, path: plugin! },
      });
      expect(loaded.state).toBe('done');
      const slotId = (loaded.result as { slotId: string }).slotId;
      const opened = await client.call('plugin.open_editor', { slotId });
      expect(opened.editorOpen).toBe(true);

      const owned = windowsOf(pid!).filter((window) => window.owner === shellWindow);
      expect(owned).toHaveLength(1);
      expect(owned[0]!.visible).toBe(true);
      expect(opened.nativeHandle).toBe(owned[0]!.window);
    } finally {
      client.close();
    }
  });
}
