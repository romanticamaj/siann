// A plugin crash during playback (m4-crash-recovery; architecture spec, "Process
// model", Crash, and "Production-level criteria"): the shell starts the real
// siann-engine on the fake device, a client loads siann_hostile_plugin
// (SIANN_HOSTILE_PLUGIN_CLAP) and turns on its crash parameter through
// plugin.set_parameter while the transport plays. The engine aborts; the shell sees
// the exit and restarts it; the renderer reconnects and shows the recovered head;
// the new engine is stopped, the slot runs, and playing does not crash it again
// (the trigger was never durable). The deterministic core is in
// native/apps/engine/tests/engine_launch_test.cpp; this proves the shell's side.
// Skips unless SIANN_HOSTILE_PLUGIN_CLAP is set (check-all --app and the CI app job
// set it).

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

const hostilePlugin = process.env.SIANN_HOSTILE_PLUGIN_CLAP;

// The hostile plugin's "crash" parameter id (9000 - 11 * its index 10). The launch
// test "a plugin crash during playback ends the engine, and the relaunch recovers
// the session" reads it from the plugin and checks this value.
const CRASH_PARAMETER_ID = '8890';

type Reply = { requestId?: string; ok?: boolean; result?: Record<string, unknown>; error?: { code: string } };

let calls = 0;

// A protocol client of the engine the renderer is connected to.
async function engineClient(page: Page) {
  const endpoint = await page.evaluate(() =>
    (window as unknown as { siann: { engine: { current(): Promise<{ port: number; token: string } | null> } } }).siann.engine.current(),
  );
  if (endpoint === null) throw new Error('the renderer has no engine');
  const sessionId = (await page.getByTestId('session-id').textContent()) ?? '';
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
  const replies: string[] = [];
  let wake = () => {};
  let closed = false;
  socket.addEventListener('message', (event) => {
    replies.push(String(event.data));
    wake();
  });
  socket.addEventListener('close', () => {
    closed = true;
    wake();
  });
  const next = async (): Promise<Reply> => {
    while (replies.length === 0) {
      if (closed) throw new Error('the engine closed the socket');
      await new Promise<void>((resolve) => (wake = resolve));
    }
    return JSON.parse(replies.shift()!) as Reply;
  };
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  socket.send(JSON.stringify({ type: 'auth', token: endpoint.token }));
  await next();
  const send = (method: string, params: Record<string, unknown>): string => {
    // A new id each time: the server answers a repeated one from its idempotency cache.
    const requestId = `req_crash_${++calls}`;
    socket.send(JSON.stringify({ requestId, sessionId, method, params }));
    return requestId;
  };
  return {
    async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const requestId = send(method, params);
      for (;;) {
        const reply = await next();
        if (reply.requestId !== requestId) continue;
        if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
        return reply.result!;
      }
    },
    // A request whose reply may never come: the engine can end first.
    send,
    isClosed: () => closed,
    close: () => socket.close(),
  };
}

type Client = Awaited<ReturnType<typeof engineClient>>;

async function enginePid(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(() => {
    const shell = (globalThis as { __siannShell?: { pid(): number | null } }).__siannShell;
    return shell ? shell.pid() : null;
  });
}

// The playhead while playing, -1 before the transport runs: transport.play when it
// plays already reports where it is. Both engines start at 0, so a value above 0
// means the playhead advanced.
async function playhead(client: Client): Promise<number> {
  const state = await client.call('transport.play');
  return state.playing ? Number(state.position) : -1;
}

let sessionDir = '';
let app: ElectronApplication | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = '';
});

test('a plugin crash during playback restarts the engine and the renderer reconnects to the recovered session', async () => {
  test.skip(!hostilePlugin, 'set SIANN_HOSTILE_PLUGIN_CLAP to the built siann_hostile_plugin.clap');
  const engine = process.env.SIANN_ENGINE_EXE;
  if (!engine) throw new Error('set SIANN_ENGINE_EXE to the built siann-engine executable');
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);

  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-crash-'));
  // The plugin's build directory is a --plugin-dir, and the approval below lands in
  // this test's own <userData>/plugin-registry.json, which the restarted engine
  // reads (m5-plugin-registry).
  app = await electron.launch({
    args: [MAIN, `--user-data-dir=${path.join(sessionDir, 'user-data')}`],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: engine,
      SIANN_SESSION_DIR: sessionDir,
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake', '--plugin-dir', path.dirname(hostilePlugin!)]),
    },
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');
  const firstPid = await enginePid(app);
  expect(firstPid).not.toBeNull();

  // The supervisor's exit events, and every status the renderer shows from here on.
  await app.evaluate(() => {
    const shell = (globalThis as unknown as { __siannShell: NodeJS.EventEmitter }).__siannShell;
    const exits: unknown[] = [];
    (globalThis as unknown as { __siannExits: unknown[] }).__siannExits = exits;
    shell.on('exit', (exit: unknown) => exits.push(exit));
  });
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

  const client = await engineClient(page);
  let revision = '';
  let documentHash = '';
  let slotId = '';
  try {
    await client.call('command.execute', { commands: [{ op: 'track.add', trackId: 'trk_1', name: 'trk_1', channels: 2 }] });
    const approved = await client.call('plugin.approve', { format: 'clap', path: hostilePlugin!, approved: true });
    expect(approved.approved).toBe(true);
    const loaded = await client.call('plugin.instantiate', {
      trackId: 'trk_1',
      index: 0,
      descriptor: { format: 'clap', path: hostilePlugin! },
    });
    expect(loaded.state).toBe('done');
    slotId = (loaded.result as { slotId: string }).slotId;
    const inspect = await client.call('session.inspect');
    revision = inspect.revision as string;
    documentHash = inspect.documentHash as string;

    await expect.poll(() => playhead(client)).toBeGreaterThan(0);

    client.send('plugin.set_parameter', { slotId, paramId: CRASH_PARAMETER_ID, value: 1 });
    await expect.poll(() => client.isClosed()).toBe(true);
  } finally {
    client.close();
  }

  // The engine aborted: the supervisor saw exit code 3 (Windows) or SIGABRT, and
  // restarts it. The hostile plugin turns off no crash dialog itself, so exit code
  // 3 (not a dialog, not a WER fast-fail) is the engine's main() having done it.
  const exits = () => app!.evaluate(() => (globalThis as unknown as { __siannExits: unknown[] }).__siannExits);
  await expect.poll(async () => (await exits()).length).toBeGreaterThan(0);
  const exit = (await exits())[0] as { code: number | null; signal: string | null; restartInMs: number | null };
  if (process.platform === 'win32') {
    expect(exit.code).toBe(3);
  } else {
    expect(exit.signal).toBe('SIGABRT');
  }
  expect(exit.restartInMs).not.toBeNull();

  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses))
    .toContain('disconnected');
  await expect.poll(() => enginePid(app!)).not.toBe(firstPid);
  await expect.poll(() => enginePid(app!)).not.toBeNull();
  await expect(page.getByTestId('status')).toHaveText('connected');
  const statuses = await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  expect(statuses.indexOf('disconnected')).toBeLessThan(statuses.lastIndexOf('connected'));
  // The renderer shows the recovered head: the last durable revision.
  await expect(page.getByTestId('revision')).toHaveText(revision);

  const recovered = await engineClient(page);
  try {
    const sync = await recovered.call('session.sync');
    expect(sync.revision).toBe(revision);
    expect(sync.documentHash).toBe(documentHash);
    const status = (await recovered.call('engine.status')) as {
      playing: boolean;
      plugins: { slotId: string; state: string }[];
    };
    expect(status.playing).toBe(false);
    expect(status.plugins.find((plugin) => plugin.slotId === slotId)?.state).toBe('running');
    // The trigger was not durable: the recovered session plays.
    await expect.poll(() => playhead(recovered)).toBeGreaterThan(0);
    expect(recovered.isClosed()).toBe(false);
  } finally {
    recovered.close();
  }
});
