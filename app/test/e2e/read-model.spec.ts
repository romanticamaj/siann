// The renderer's read model end to end (m5-read-model): a commit made by
// another protocol client reaches the renderer as a session.changed delta,
// with no reload, and a restarted engine is recovered through session.sync
// against the durable journal. Same launch as shell.spec.ts; waits are
// Playwright condition waits with bounded timeouts.

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
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-read-model-'));
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

type Reply = { requestId?: string; ok?: boolean; result?: Record<string, unknown>; error?: { code: string } };

let calls = 0;

// A second protocol client of the engine the renderer is on (the deviceId
// helper pattern of shell.spec.ts): its commits are not the renderer's.
async function engineClient() {
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
  return {
    async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      // A new id each time: the server answers a repeated one from its idempotency cache.
      const requestId = `req_read_model_${++calls}`;
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

const ADD_TRACK = { op: 'track.add', trackId: 'trk_e2e', name: 'E2E', channels: 2 };
const REMOVE_TRACK = { op: 'track.remove', trackId: 'trk_e2e' };

async function execute(command: Record<string, unknown>): Promise<string> {
  const client = await engineClient();
  try {
    const { commands } = (await client.call('command.list')) as { commands: string[] };
    expect(commands).toContain(command.op);
    const result = (await client.call('command.execute', { commands: [command] })) as { revision: { id: string } };
    return result.revision.id;
  } finally {
    client.close();
  }
}

async function synced(): Promise<void> {
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId('revision')).toHaveText(/^r\d+$/);
  await expect(page.getByTestId('sync-count')).toHaveText('1');
  await expect(page.getByTestId('track-count')).toHaveText('0');
}

test('a commit by another client reaches the renderer as a delta, without a reload', async () => {
  await synced();
  // A marker that a reload would wipe.
  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  const added = await execute(ADD_TRACK);
  await expect(page.getByTestId('revision')).toHaveText(added);
  await expect(page.getByTestId('track-count')).toHaveText('1');

  const removed = await execute(REMOVE_TRACK);
  await expect(page.getByTestId('revision')).toHaveText(removed);
  await expect(page.getByTestId('track-count')).toHaveText('0');

  // Deltas, not resyncs: one sync at connect, and the page was never reloaded.
  await expect(page.getByTestId('sync-count')).toHaveText('1');
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});

test('a restarted engine is recovered through session.sync against the durable journal', async () => {
  await synced();
  const added = await execute(ADD_TRACK);
  await expect(page.getByTestId('track-count')).toHaveText('1');
  await expect(page.getByTestId('revision')).toHaveText(added);
  const firstSession = (await page.getByTestId('session-id').textContent()) ?? '';
  const syncsBefore = Number(await page.getByTestId('sync-count').textContent());
  const firstPid = await enginePid();
  expect(firstPid).not.toBeNull();

  process.kill(firstPid!);

  await expect.poll(async () => isAlive(firstPid!)).toBe(false);
  await expect.poll(enginePid).not.toBe(firstPid);
  await expect.poll(enginePid).not.toBeNull();
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId('session-id')).toHaveText(/^ses_[0-9a-f]+$/);
  await expect(page.getByTestId('session-id')).not.toHaveText(firstSession);
  await expect.poll(async () => Number(await page.getByTestId('sync-count').textContent())).toBeGreaterThan(syncsBefore);
  await expect(page.getByTestId('track-count')).toHaveText('1');
  await expect(page.getByTestId('revision')).toHaveText(added);
});
