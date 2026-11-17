// The Plans tab end to end (m5-ui-plan-panel, after m5-plan-review and exit
// m5-exit-plan; spec "Frontend", plan review; UI redesign section 4 and
// P1-5): an agent submits a plan over MCP, and the renderer raises a toast
// and the count on the Plans button without taking the focus or opening a
// zone, shows the plan as the tab's card in the mockup's wording (ported by
// m5-ui-port-plans: the count chips, the step rows, every earlier plan a
// history row; UI redesign 10.10, P1-13), and runs the state's actions:
// "Approve N of M" with every step ticked (plan.approve then plan.apply, one
// revision), with a subset (a sub-plan applied, the parent labelled split), Audition
// (approve, propose, hear: the card reads approved for audition and a banner
// stays visible whichever zones are open), Reject with a reason (the reason
// row opens with the first press), a step's disclosure, and a stale
// plan with its reason and a disabled primary. A refused apply leaves the
// plan approved with the refusal shown. The bundle is prepared with siann-cli
// (SIANN_CLI_EXE); the app runs the real siann-engine (SIANN_ENGINE_EXE) on
// the fake device under SIANN_SHELL_TEST=1. A second protocol client watches
// the engine. Waits are Playwright condition waits, never sleeps.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatDb, formatMilliDb } from '../../src/renderer/format';
import { planArrivedMessage } from '../../src/renderer/i18n/messages';
import { translator } from '../../src/renderer/i18n/t';
import { isolateName } from '../../src/renderer/plans/isolate';
import { engineClient, type EngineClient } from './support/engine-client';
import { launchElectron } from './support/launch';
import { selectPlan } from './support/seed';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');
const t = translator('en');

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
  for (const [id, name] of [
    ['trk_a', 'Keys'],
    ['trk_b', 'Bass'],
  ]) {
    cli('exec', bundle, JSON.stringify({ op: 'track.add', trackId: id, name, channels: 2 }));
  }
  app = await launchElectron({
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
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
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
  { op: 'track.add', trackId: 'trk_new', name: 'Pad', channels: 2 },
  { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -600 },
  { op: 'track.set_pan', trackId: 'trk_a', pan: -2000 },
  { op: 'track.set_mute', trackId: 'trk_b', mute: true },
  { op: 'track.rename', trackId: 'trk_b', name: 'Bass DI' },
];

function hash8(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 8);
}

// The tab's card, showing the plan with this hash.
function card(hash: string) {
  return page.locator(`[data-testid="plan-card"][data-plan="${hash8(hash)}"]`);
}

function stateBadge(hash: string) {
  return page.getByTestId(`plan-state-${hash8(hash)}`);
}

// The right zone shown (Ctrl+Alt+P's action, the Plans button).
async function showPlans(): Promise<void> {
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'true');
}

// The agent submits the plan; the test opens the Plans tab and selects it
// (the card already, by the default selection, or its history row).
async function submitted(client: Agent, steps: ReadonlyArray<Record<string, unknown>> = STEPS): Promise<string> {
  const plan = await client.tool('submit_plan', { steps });
  const hash = plan.hash as string;
  expect(plan.state).toBe('validated');
  await showPlans();
  await selectPlan(page, hash);
  await expect(card(hash)).toBeVisible();
  return hash;
}

async function status(hash: string): Promise<Record<string, unknown>> {
  return watcher.call('plan.status', { plan: hash });
}

async function focusedId(): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.testid ?? document.activeElement?.tagName ?? null);
}

test('a new plan raises a toast and the count without taking the focus; a collapsed right zone stays collapsed', async () => {
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) === 'true') await page.getByTestId('zone-button-right').click();
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'false');
  await page.getByTestId('locale-switch').focus();
  const before = await focusedId();
  expect(before).toBe('locale-switch');
  await expect(page.getByTestId('plans-count')).toHaveCount(0);

  const plan = await (await agent()).tool('submit_plan', { steps: STEPS });
  await expect(page.getByTestId('toast-message')).toHaveText(planArrivedMessage('en', { steps: STEPS.length }));
  await expect(page.getByTestId('toasts')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('plans-count')).toHaveText('1');
  expect(await focusedId()).toBe(before);
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'false');

  // The card, by the default selection, in user wording: the count chips, no
  // ids, no milli-dB, no raw pan.
  await showPlans();
  const hash = plan.hash as string;
  await expect(card(hash)).toBeVisible();
  await expect(page.locator('[data-part="plan-summary"] > span')).toHaveText(['+1 track', '3 mix', '1 edit']);
  await expect(card(hash)).toContainText(hash8(hash));
  await expect(stateBadge(hash)).toHaveText(t('badge.needsReview'));
  await expect(page.getByTestId('step-number-0')).toHaveText('1');
  await expect(page.getByTestId('step-text-0')).toContainText(`Add track ${isolateName('Pad')}`);
  await expect(page.getByTestId('step-text-1')).toHaveText(`${isolateName('Keys')} gain${formatDb(0)} → ${formatDb(-600)}`);
  await expect(page.getByTestId('step-text-2')).toHaveText(`${isolateName('Keys')} pan` + 'C → L20');
  await expect(page.locator('[data-part="plan-steps-head"]')).toContainText('Steps · 5 of 5 selected');
  const shown = await page.getByTestId('zone-right').innerText();
  for (const raw of ['trk_', 'gainMilliDb', '-600', '-2000', 'root:root']) expect(shown).not.toContain(raw);
  // A step's disclosure (a click on its text) shows its raw step, and the ref
  // and entity JSON of what it changes.
  await expect(page.getByTestId('step-text-1')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('step-text-1').click();
  await expect(page.getByTestId('step-text-1')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('step-raw-1')).toContainText('"gainMilliDb":-600');
  await expect(page.locator('[data-testid^="diff-raw-"]').first()).toContainText('track:trk_a');
  await page.getByTestId('step-text-1').click();
  await expect(page.getByTestId('step-raw-1')).toHaveCount(0);
});

test("every id of the Plans tab is in the window, and no id of a pending part", async () => {
  const client = await agent();
  const earlier = await submitted(client, STEPS.slice(1, 3));
  const hash = await submitted(client);
  // The newest plan awaiting a decision is the card; the earlier one a history row.
  await expect(card(hash)).toBeVisible();
  await expect(page.getByTestId(`plan-${hash8(earlier)}`)).toHaveClass(/\bhrow\b/);
  for (const id of [
    'right-tabs',
    'tab-plans',
    'hearing-switch',
    'plan-card',
    'plan-head',
    'plan-meta',
    'plan-badge',
    'plan-summary',
    'plan-steps',
    'plan-steps-head',
    'plan-actions',
    'plan-audition',
    'plan-approve',
    'plan-reject',
    'plan-history-head',
  ]) {
    await expect(page.locator(`[data-region="right-zone"] [data-part="${id}"]`), id).toHaveCount(1);
  }
  await expect(page.locator('[data-part-item="plan-step"]')).toHaveCount(STEPS.length);
  await expect(page.locator('[data-part-item="plan-history"]')).toHaveCount(1);
  for (const id of ['agent-row', 'plan-title', 'plan-intent', 'composer', 'tab-media', 'tab-meter']) {
    await expect(page.locator(`[data-part="${id}"]`), id).toHaveCount(0);
  }
  await expect(page.locator('[data-part^="plan-step-"][data-part$="-title"]')).toHaveCount(0);
  // The row under the pointer is hot, and only that one.
  await page.getByTestId('step-2').hover();
  await expect(page.getByTestId('step-2')).toHaveClass(/\bhot\b/);
  await expect(page.locator('.step.hot')).toHaveCount(1);
  // Clicking a history row makes it the card.
  await page.getByTestId(`plan-${hash8(earlier)}`).click();
  await expect(card(earlier)).toBeVisible();
  await expect(page.getByTestId(`plan-${hash8(hash)}`)).toHaveClass(/\bhrow\b/);
});

test('Approve 5 of 5 lands the plan as one revision', async () => {
  const hash = await submitted(await agent());
  const commits = watcher.ofType('session.changed').length;
  await expect(page.getByTestId('plan-approve-apply')).toHaveText('Approve 5 of 5');
  await page.getByTestId('plan-approve-apply').click();
  await expect(stateBadge(hash)).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId('track-count')).toHaveText('3');
  const applied = await status(hash);
  expect(applied.state).toBe('applied');
  await expect.poll(() => watcher.ofType('session.changed').length).toBe(commits + 1);
  expect(watcher.ofType('session.changed').at(-1)!.revision).toBe(applied.appliedRevision);
  // "applied at <revision>" is the badge's text (UI redesign 10.10, P1-13).
  await expect(stateBadge(hash)).toHaveText(t('badge.appliedAt', { revision: applied.appliedRevision as string }));
  await expect(page.getByTestId('plan-error')).toHaveCount(0);
});

test('a refused apply after the approval leaves the card approved and shows the refusal', async () => {
  const hash = await submitted(await agent());
  // Hold the renderer's plan.apply until another client has committed to an
  // entity of the plan, so the apply meets a stale plan.
  await page.evaluate(() => {
    const w = window as unknown as { __applyHeld?: boolean; __releaseApply?: () => void };
    const gate = new Promise<void>((resolve) => (w.__releaseApply = resolve));
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string' && data.includes('"method":"plan.apply"')) {
        w.__applyHeld = true;
        void gate.then(() => send.call(this, data));
        return;
      }
      send.call(this, data);
    };
  });
  await page.getByTestId('plan-approve-apply').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __applyHeld?: boolean }).__applyHeld === true)).toBe(true);
  expect((await status(hash)).state).toBe('approved');
  await watcher.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -300 }] });
  await page.evaluate(() => (window as unknown as { __releaseApply: () => void }).__releaseApply());

  await expect(page.getByTestId('plan-error')).toContainText('plan_stale');
  // The changed entity by its name; the engine's message and refs only behind the disclosure.
  await expect(page.getByTestId('plan-error')).toContainText('Keys');
  expect(await page.getByTestId('zone-right').innerText()).not.toContain('trk_');
  await page.getByTestId('plan-error-details').click();
  await expect(page.getByTestId('plan-error-raw')).toContainText('track:trk_a');
  await expect(stateBadge(hash)).toHaveAttribute('data-state', 'approved');
  await expect(stateBadge(hash)).toHaveText(t('badge.approved'));
  expect((await status(hash)).state).toBe('approved');
  await expect(page.getByTestId('track-count')).toHaveText('2');
});

test('Approve 3 of 5 applies a sub-plan and labels the parent split', async () => {
  const hash = await submitted(await agent());
  for (const index of [0, 1, 2, 3, 4]) await expect(page.getByTestId(`step-${index}`).getByRole('checkbox')).toBeChecked();
  await expect(page.getByTestId('steps-none')).toHaveText(t('plans.selectNone'));
  await page.getByTestId('step-2').getByRole('checkbox').uncheck();
  await page.getByTestId('step-4').getByRole('checkbox').uncheck();
  await expect(page.getByTestId('plan-approve-apply')).toHaveText('Approve 3 of 5');
  await expect(page.locator('[data-part="plan-steps-head"]')).toContainText('Steps · 3 of 5 selected');
  // The link selects all again, and then none.
  await page.getByTestId('steps-all').click();
  await expect(page.getByTestId('plan-approve-apply')).toHaveText('Approve 5 of 5');
  await page.getByTestId('steps-none').click();
  await expect(page.getByTestId('plan-approve-apply')).toBeDisabled();
  await expect(page.getByTestId('plan-approve-apply')).toHaveAttribute('title', t('actionReason.noneTicked'));
  for (const index of [0, 1, 3]) await page.getByTestId(`step-${index}`).getByRole('checkbox').check();
  await expect(page.getByTestId('plan-approve-apply')).toHaveText('Approve 3 of 5');
  await page.getByTestId('plan-approve-apply').click();
  // The card follows the sub-plan; the parent is a history row labelled split.
  await expect(stateBadge(hash)).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId(`plan-split-${hash8(hash)}`)).toHaveText('Split, 3 of 5 approved');
  const listed = (await watcher.call('plan.list')).plans as Array<Record<string, unknown>>;
  const sub = listed.find((p) => p.parentPlan === hash)!;
  expect(sub.steps).toEqual([STEPS[0], STEPS[1], STEPS[3]]);
  await expect(stateBadge(sub.hash as string)).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId('track-count')).toHaveText('3');
  expect((await status(sub.hash as string)).state).toBe('applied');
});

test('Audition from a validated plan: approved for audition, a banner from every zone, the switch and the status bar agree', async () => {
  const client = await agent();
  const hash = await submitted(client);
  await page.getByTestId('plan-audition').click();
  await expect(stateBadge(hash)).toHaveText(t('badge.approvedForAudition'));
  const proposed = await status(hash);
  expect(proposed.state).toBe('approved');
  const branch = proposed.proposalBranch as string;
  expect((await watcher.call('session.inspect')).heard).toBe(branch);
  await expect(page.getByTestId('hear-proposal')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('hear-main')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('status-heard')).toHaveText(t('status.hearProposal'));
  await expect(page.getByTestId('track-count')).toHaveText('2');

  // The banner: with the lower zone on the MixConsole, and with it collapsed.
  const banner = page.getByTestId('audition-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`Add track ${isolateName('Pad')}`);
  if ((await page.getByTestId('zone-lower').getAttribute('data-visible')) !== 'true') await page.getByTestId('zone-button-lower').click();
  await page.getByTestId('tab-lower-mixconsole').click();
  await expect(page.getByTestId('mixer')).toBeVisible();
  await expect(banner).toBeVisible();
  await page.getByTestId('zone-button-lower').click();
  await expect(page.getByTestId('zone-lower')).toHaveAttribute('data-visible', 'false');
  await expect(banner).toBeVisible();

  await page.getByTestId('banner-hear-main').click();
  await expect(page.getByTestId('hear-main')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('status-heard')).toHaveText(t('status.hearMain'));
  await expect(banner).toHaveCount(0);

  // An agent's audition flips the switch without a UI action.
  const heard = await client.tool('audition', { side: branch });
  expect(heard.heard).toBe(branch);
  await expect(page.getByTestId('hear-proposal')).toHaveAttribute('aria-pressed', 'true');
  await expect(banner).toBeVisible();
  await page.getByTestId('plan-merge').click();
  await expect(stateBadge(hash)).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId('track-count')).toHaveText('3');
  await expect(banner).toHaveCount(0);
});

test('Reject opens the reason row; Enter sends the reason, which the card shows', async () => {
  const hash = await submitted(await agent());
  // A resting card has no reason row; the first press of Reject opens it with the focus in it.
  await expect(page.getByTestId('plan-note')).toHaveCount(0);
  await page.getByTestId('plan-reject').click();
  await expect(page.getByTestId('plan-note')).toBeFocused();
  // Escape closes it without rejecting.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('plan-note')).toHaveCount(0);
  expect((await status(hash)).state).toBe('validated');
  await page.getByTestId('plan-reject').click();
  await page.getByTestId('plan-note').fill('Keep the bass dry');
  await page.keyboard.press('Enter');
  await expect(stateBadge(hash)).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId(`plan-reason-${hash8(hash)}`)).toHaveText(t('history.rejected', { note: isolateName('Keep the bass dry') }));
  await expect(page.getByTestId('plan-note')).toHaveCount(0);
  const rejected = await status(hash);
  expect(rejected.rejectionNote).toBe('Keep the bass dry');
  await expect(page.getByTestId('track-count')).toHaveText('2');
});

test('a stale plan shows the stale badge, the reason in user units and a disabled primary', async () => {
  const hash = await submitted(await agent());
  await expect(page.getByTestId(`plan-stale-${hash8(hash)}`)).toHaveCount(0);
  await watcher.call('command.execute', { commands: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -300 }] });
  await expect(page.getByTestId(`plan-stale-${hash8(hash)}`)).toHaveText(t('badge.stale'));
  await expect(page.getByTestId('plan-stale-reasons')).toContainText(`${isolateName('Keys')}: volume was ${formatMilliDb(0)}, now ${formatMilliDb(-300)}`);
  const primary = page.getByTestId('plan-approve-apply');
  await expect(primary).toBeDisabled();
  await expect(primary).toHaveAttribute('title', t('actionReason.stale'));
  await expect(page.getByTestId('plan-reject')).toBeEnabled();
  await expect(stateBadge(hash)).toHaveAttribute('data-state', 'validated');
});
