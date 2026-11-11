// Plan review end to end (m5-plan-review, exit m5-exit-plan; spec "Frontend",
// plan review; Protocol v0 item 25): an agent submits a plan over MCP, and the
// renderer lists it, shows its diff against the current revision, and approves,
// rejects, partially approves, auditions, merges and applies it, each action
// one protocol request. The bundle (trk_a and trk_b) is prepared with siann-cli
// (SIANN_CLI_EXE); the app runs the real siann-engine (SIANN_ENGINE_EXE) on the
// fake device under SIANN_SHELL_TEST=1, which exposes the supervisor's ready
// line ({port, mcpToken}) to the test. The MCP client lives in the test; a
// second protocol client watches the engine. Waits are Playwright condition
// waits with bounded timeouts, never sleeps.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient, type EngineClient } from './support/engine-client';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

function exeFromEnv(name: string): string {
  const exe = process.env[name];
  if (!exe) throw new Error(`set ${name} to the built executable`);
  if (!fs.existsSync(exe)) throw new Error(`${name} points at a missing file: ${exe}`);
  return exe;
}

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

let scratch: string;
let app: ElectronApplication;
let page: Page;
let watcher: EngineClient;

// The MCP client of an agent (protocol-mcp-v0.md): JSON-RPC over POST /v0/mcp
// with the MCP token, under the default propose scope.
class Agent {
  #session = '';
  #id = 0;
  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${this.token}` };
    if (this.#session) headers['mcp-session-id'] = this.#session;
    const response = await fetch(`http://127.0.0.1:${this.port}/v0/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
    });
    expect(response.status).toBe(200);
    const session = response.headers.get('mcp-session-id');
    if (session) this.#session = session;
    return (await response.json()) as Record<string, unknown>;
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plan-review-e2e', version: '1' } });
    expect(this.#session).toMatch(/^mcp_/);
  }

  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.rpc('tools/call', { name, arguments: args });
    const result = reply.result as { isError: boolean; structuredContent: Record<string, unknown> };
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result.structuredContent;
  }
}

test.beforeEach(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-plans-'));
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'Plans', '--rate', '48000');
  for (const id of ['trk_a', 'trk_b']) cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: id, name: id, channels: 2 }));
  app = await electron.launch({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: path.dirname(bundle),
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: '--device fake',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveText('connected');
  await expect(page.getByTestId('track-count')).toHaveText('2');
  watcher = await engineClient(page, { events: true });
});

test.afterEach(async () => {
  watcher?.close();
  await app?.close().catch(() => undefined);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function agent(): Promise<Agent> {
  const ready = await app.evaluate(() => {
    const shell = (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } | null } }).__siannShell;
    return shell.current();
  });
  if (!ready) throw new Error('the shell has no engine');
  const client = new Agent(ready.port, ready.mcpToken);
  await client.initialize();
  return client;
}

const STEPS = [
  { op: 'track.add', trackId: 'trk_new', name: 'New', channels: 2 },
  { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -600 },
];

// The agent submits the plan; the UI lists it and the test selects it.
async function submitted(client: Agent): Promise<string> {
  const plan = await client.tool('submit_plan', { steps: STEPS });
  const hash = plan.hash as string;
  expect(plan.state).toBe('validated');
  await page.getByTestId(`plan-${hash8(hash)}`).click();
  return hash;
}

function hash8(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 8);
}

function stateBadge(hash: string) {
  return page.getByTestId(`plan-state-${hash8(hash)}`);
}

async function status(hash: string): Promise<Record<string, unknown>> {
  return watcher.call('plan.status', { plan: hash });
}

async function gainOfTrackA(): Promise<number> {
  const fetched = (await watcher.call('session.fetch', { refs: ['track:trk_a'] })) as { entities: Array<{ entity: { gainMilliDb: number } }> };
  return fetched.entities[0]!.entity.gainMilliDb;
}

test('an MCP-submitted plan is listed as validated with its diff against the current revision', async () => {
  const hash = await submitted(await agent());
  await expect(stateBadge(hash)).toHaveText('validated');
  const added = page.getByTestId('diff-track:trk_new');
  await expect(added).toHaveAttribute('data-kind', 'added');
  const gain = page.getByTestId('diff-track:trk_a');
  await expect(gain).toHaveAttribute('data-kind', 'modified');
  await expect(gain.getByTestId('diff-fields')).toHaveText('gainMilliDb: 0 → -600');
  await expect(page.getByTestId('diff-root:root')).toHaveAttribute('data-kind', 'modified');
  await expect(page.getByTestId('diff-root:root').getByTestId('diff-fields')).toContainText('trackOrder');
  await expect(page.getByTestId('step-0')).toContainText('Add track New');
  await expect(page.getByTestId('step-1')).toContainText('-6.00 dB');
  expect(await gainOfTrackA()).toBe(0);
});

test('Approve, Audition (the branch is heard, main unchanged), then Merge lands the plan', async () => {
  const hash = await submitted(await agent());
  await page.getByTestId('plan-approve').click();
  await expect(stateBadge(hash)).toHaveText('approved');
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('plan-heard')).toHaveText('p1');
  const proposed = await status(hash);
  expect(proposed.state).toBe('approved');
  expect(proposed.proposalBranch).toBe('p1');
  expect((await watcher.call('session.inspect')).heard).toBe('p1');
  await expect(page.getByTestId('track-count')).toHaveText('2');

  await page.getByTestId('plan-merge').click();
  await expect.poll(() => watcher.ofType('session.changed').some((e) => e.cause === 'branch-merge')).toBe(true);
  await expect(page.getByTestId('track-count')).toHaveText('3');
  await expect(stateBadge(hash)).toHaveText('applied');
  await expect(page.getByTestId('plan-heard')).toHaveText('main');
  expect((await status(hash)).state).toBe('applied');
});

test('Reject with a note', async () => {
  const hash = await submitted(await agent());
  await page.getByTestId('plan-note').fill('not now');
  await page.getByTestId('plan-reject').click();
  await expect(stateBadge(hash)).toHaveText('rejected');
  const rejected = await status(hash);
  expect(rejected.state).toBe('rejected');
  expect(rejected.rejectionNote).toBe('not now');
  await expect(page.getByTestId('track-count')).toHaveText('2');
});

test('Approve selected makes an approved sub-plan, rejects the original, and the sub-plan applies alone', async () => {
  const hash = await submitted(await agent());
  await expect(page.getByTestId('plan-approve-selected')).toBeDisabled();
  await page.getByTestId('step-0').getByRole('checkbox').check();
  await page.getByTestId('plan-approve-selected').click();
  await expect(stateBadge(hash)).toHaveText('rejected');
  const listed = (await watcher.call('plan.list')).plans as Array<Record<string, unknown>>;
  const sub = listed.find((p) => p.parentPlan === hash);
  expect(sub).toBeDefined();
  const subHash = sub!.hash as string;
  expect(sub!.state).toBe('approved');
  await expect(stateBadge(subHash)).toHaveText('approved');

  await page.getByTestId(`plan-${hash8(subHash)}`).click();
  await page.getByTestId('plan-apply').click();
  await expect(page.getByTestId('track-count')).toHaveText('3');
  await expect(stateBadge(subHash)).toHaveText('applied');
  expect(await gainOfTrackA()).toBe(0);
});

test('a commit to an entity of the plan marks its diff row stale, and Approve shows plan_stale', async () => {
  const hash = await submitted(await agent());
  await expect(page.getByTestId('diff-track:trk_a')).toHaveAttribute('data-stale', 'false');
  await watcher.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -300 }] });
  await expect(page.getByTestId('diff-track:trk_a')).toHaveAttribute('data-stale', 'true');
  await expect(page.getByTestId('diff-track:trk_new')).toHaveAttribute('data-stale', 'false');
  await page.getByTestId('plan-approve').click();
  await expect(page.getByTestId('plan-error')).toContainText('plan_stale');
  await expect(page.getByTestId('plan-error')).toContainText('track:trk_a');
  await expect(stateBadge(hash)).toHaveText('validated');
  expect((await status(hash)).state).toBe('validated');
});

test("the heard badge follows an agent's audition without a UI action", async () => {
  const client = await agent();
  await submitted(client);
  await page.getByTestId('plan-approve').click();
  await page.getByTestId('plan-audition').click();
  await expect(page.getByTestId('plan-heard')).toHaveText('p1');
  await page.getByTestId('plan-hear-main').click();
  await expect(page.getByTestId('plan-heard')).toHaveText('main');

  const heard = await client.tool('audition', { side: 'p1' });
  expect(heard.heard).toBe('p1');
  await expect(page.getByTestId('plan-heard')).toHaveText('p1');
  await expect(page.getByTestId('plan-hear-main')).toBeEnabled();
});
