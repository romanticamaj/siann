// The "ask the agent" box end to end (m5b-ui-composer; UI redesign 4.4, 2.1,
// 3.0; protocol-engine-v0.md "Agent requests", protocol-mcp-v0.md
// next_request and answer_request). The app runs the real siann-engine
// (SIANN_ENGINE_EXE) on the fake device under SIANN_SHELL_TEST=1, the bundle
// prepared with siann-cli (SIANN_CLI_EXE); an MCP client named mix-assistant
// is the agent, and a second protocol client watches the engine. Waits are
// Playwright condition waits, never sleeps.
//
// A request is sent from the box with the selected track and clip, taken by
// next_request, answered by a plan that the card then shows as needing
// review (the head revision unchanged until Approve), declined with a
// message, cancelled from its row, and answered with a message. An Enter that
// confirms an input-method composition sends nothing; from the box no
// transport, edit or tool command runs while the focus keys still move the
// focus. A 17th open request is refused agent_busy and its text stays. With
// no agent connected the box is disabled with its reason, and an agent's
// DELETE /v0/mcp expires its open request. Against capabilities without the
// feature the part is absent and its space stays.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { engineClient, type EngineClient } from './support/engine-client';
import { Agent, hash8, launchApp, seedBundle } from './support/seed';

const t = translator('en');
const AGENT_METHODS = ['agent.request', 'agent.cancel_request', 'agent.requests', 'agent.next_request', 'agent.answer_request'];

let scratch = '';
let sessionDir = '';
let app: ElectronApplication | undefined;
let page: Page;
let watcher: EngineClient | undefined;

type Request = { id: string; state: string; text: string; plan?: string; message?: string; context: { selection: { tracks: string[]; clips: string[] }; headRevision: string } };

test.beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-composer-'));
  sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_a', name: 'Drums' },
      { id: 'trk_b', name: 'Bass' },
    ],
    [{ id: 'clp_a', trackId: 'trk_a', at: 0.25 }],
  );
  await launch();
});

test.afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], env });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('about-track-count')).toHaveText('2');
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-visible', 'true');
  watcher = await engineClient(page, { events: true });
}

async function relaunch(env: Record<string, string> = {}): Promise<void> {
  watcher?.close();
  await app!.close();
  await launch(env);
}

async function mixAssistant(): Promise<Agent> {
  const ready = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } | null } }).__siannShell.current());
  if (!ready) throw new Error('the shell has no engine');
  const agent = new Agent(ready.port, ready.mcpToken);
  await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mix-assistant', version: '1' } });
  return agent;
}

const composer = () => page.locator('[data-part="composer"]');
const field = () => composer().locator('textarea');
const row = (id: string) => page.getByTestId(`request-${id}`);
const rowState = (id: string) => row(id).locator('.request-state');

async function requests(): Promise<Request[]> {
  return (await watcher!.call('agent.requests')).requests as Request[];
}

async function openRequests(): Promise<Request[]> {
  return (await requests()).filter((r) => r.state === 'pending' || r.state === 'taken');
}

// Types a request into the box and sends it with Enter; returns the engine's request.
async function send(text: string): Promise<Request> {
  const before = new Set((await requests()).map((r) => r.id));
  await field().click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await requests()).filter((r) => !before.has(r.id)).length).toBe(1);
  const sent = (await requests()).find((r) => !before.has(r.id))!;
  await expect(field()).toHaveValue('');
  await expect(rowState(sent.id)).toHaveText(t('composer.state.pending'));
  return sent;
}

async function clickClip(clipId: string): Promise<void> {
  const rects = async () =>
    page.evaluate(() => {
      const hooks = (window as unknown as { __siannTimeline?: { clips(): Array<{ clipId: string; x: number; y: number; width: number; height: number }> } }).__siannTimeline;
      if (!hooks) throw new Error('window.__siannTimeline is missing (SIANN_SHELL_TEST=1)');
      return hooks.clips();
    });
  await expect.poll(async () => (await rects()).some((r) => r.clipId === clipId)).toBe(true);
  const rect = (await rects()).find((r) => r.clipId === clipId)!;
  const canvas = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + rect.x + rect.width / 2, canvas.y + rect.y + rect.height / 2);
}

async function active(): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? (el.dataset.testid ?? el.tagName) : null;
  });
}

// What the shell's command listener made of the last key (window.__siannKeys under SIANN_SHELL_TEST=1).
async function lastCommandKey(): Promise<{ code: string; binding: string | null; ran: boolean } | null> {
  return page.evaluate(() => ((window as unknown as { __siannKeys?: { command?: { code: string; binding: string | null; ran: boolean } } }).__siannKeys?.command ?? null));
}

test('a request is sent, taken, answered by a plan the user then approves, declined, cancelled and answered with a message', async () => {
  test.setTimeout(120_000);
  // The part is in the window; no agent yet.
  await expect(composer()).toHaveCount(1);
  await expect(field()).toBeDisabled();
  const agent = await mixAssistant();
  await expect(field()).toBeEnabled();
  await expect(field()).toHaveAttribute('placeholder', t('composer.placeholder', { agent: 'mix-assistant' }));
  await expect(composer()).not.toHaveAttribute('title', /./);

  // Two plans first, the older one selected by its history row, so the
  // answered plan's selection is the box's doing.
  const older = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_mute', trackId: 'trk_b', mute: true }] })).hash as string;
  const newer = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_solo', trackId: 'trk_b', solo: true }] })).hash as string;
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(newer));
  await page.getByTestId(`plan-${hash8(older)}`).click();
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(older));

  // The selected clip (and so its track) goes with the request.
  await clickClip('clp_a');
  await field().click();
  await page.keyboard.type('Lower the');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('drums');
  await expect(field()).toHaveValue('Lower the\ndrums');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await requests()).length).toBe(1);
  const [first] = await requests();
  expect(first!.state).toBe('pending');
  expect(first!.text).toBe('Lower the\ndrums');
  expect(first!.context.selection).toEqual({ tracks: ['trk_a'], clips: ['clp_a'] });
  await expect(field()).toHaveValue('');
  await expect(rowState(first!.id)).toHaveText('sent');
  await expect(row(first!.id).getByTestId('request-cancel')).toBeVisible();

  // The agent takes it.
  const taken = (await agent.tool('next_request', { waitMs: 0 })).request as Request;
  expect(taken.id).toBe(first!.id);
  await expect(rowState(first!.id)).toHaveText('taken');

  // Answered by a plan: the card shows it as needing review, nothing committed.
  const commits = watcher!.ofType('session.changed').length;
  const answer = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -3000 }], request: first!.id })).hash as string;
  await expect(rowState(first!.id)).toHaveText('answered');
  await expect(page.getByTestId('plan-card')).toHaveAttribute('data-plan', hash8(answer));
  await expect(page.getByTestId(`plan-state-${hash8(answer)}`)).toHaveAttribute('data-state', 'validated');
  expect((await requests()).find((r) => r.id === first!.id)).toMatchObject({ state: 'answered', plan: answer });
  expect(watcher!.ofType('session.changed').length).toBe(commits);
  // Approve: the head advances by one revision.
  await page.getByTestId('plan-approve-apply').click();
  await expect(page.getByTestId(`plan-state-${hash8(answer)}`)).toHaveAttribute('data-state', 'applied');
  await expect.poll(() => watcher!.ofType('session.changed').length).toBe(commits + 1);
  expect(watcher!.ofType('session.changed').at(-1)!.revision).not.toBe(first!.context.headRevision);

  // A second request, declined with a message. The send clears the answered row.
  const second = await send('Make the bass louder');
  await expect(row(first!.id)).toHaveCount(0);
  await agent.tool('next_request', { waitMs: 0 });
  await agent.tool('answer_request', { request: second.id, decline: true, message: 'Not on the master bus' });
  await expect(rowState(second.id)).toHaveText('declined');
  await expect(row(second.id).locator('.request-message')).toHaveText('Not on the master bus');
  await expect(row(second.id).getByTestId('request-cancel')).toHaveCount(0);

  // A third, cancelled from its row.
  const third = await send('Widen the drums');
  await row(third.id).getByTestId('request-cancel').click();
  await expect(rowState(third.id)).toHaveText('cancelled');
  expect((await requests()).find((r) => r.id === third.id)!.state).toBe('cancelled');

  // A fourth, answered with a message only; dismissed afterwards.
  const fourth = await send('What changed?');
  await agent.tool('next_request', { waitMs: 0 });
  await agent.tool('answer_request', { request: fourth.id, message: 'Lowered the drums by 3 dB' });
  await expect(rowState(fourth.id)).toHaveText('answered');
  await expect(row(fourth.id).locator('.request-message')).toHaveText('Lowered the drums by 3 dB');
  await row(fourth.id).getByTestId('request-dismiss').click();
  await expect(row(fourth.id)).toHaveCount(0);
  await expect(page.getByTestId('agent-requests')).toHaveCount(0);
});

test('an Enter that confirms an input-method composition sends nothing, and its Escape keeps the focus in the box', async () => {
  await mixAssistant();
  await expect(field()).toBeEnabled();
  await field().click();
  await page.keyboard.type('鼓');
  const dispatch = (key: string) =>
    field().evaluate((el, k) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    }, key);
  // The Enter that confirms a composition, and the Escape that cancels one, as Chromium reports them.
  await dispatch('Enter');
  await dispatch('Escape');
  expect(await active()).toBe('TEXTAREA');
  await expect(field()).toHaveValue(/鼓/);
  expect(await requests()).toEqual([]);
  // A plain Enter sends.
  await field().focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await requests()).length).toBe(1);
});

test('from the box no transport, edit or tool command runs, Escape returns to the zone and F6 goes to the next one', async () => {
  await mixAssistant();
  await clickClip('clp_a');
  await field().click();
  // Numpad Enter first, on the empty box: it would send a text, never start the transport.
  for (const [key, code] of [
    ['NumpadEnter', 'NumpadEnter'],
    ['Space', 'Space'],
    ['Delete', 'Delete'],
    ['Digit1', 'Digit1'],
    ['Digit2', 'Digit2'],
    ['ControlOrMeta+KeyZ', 'KeyZ'],
  ] as const) {
    await page.keyboard.press(key);
    const seen = await lastCommandKey();
    expect(seen?.code, key).toBe(code);
    expect(seen?.binding, key).toBeNull();
    expect(seen?.ran, key).toBe(false);
    expect(await active(), key).toBe('TEXTAREA');
  }
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('about-track-count')).toHaveText('2');
  expect(await requests()).toEqual([]);
  // The focus keys.
  await page.keyboard.press('Escape');
  expect(await active()).toBe('zone-right');
  await field().click();
  await page.keyboard.press('F6');
  const next = await active();
  expect(next).toMatch(/^zone-/);
  expect(next).not.toBe('zone-right');
});

test('a 17th open request is refused agent_busy, shown, and its text stays in the box', async () => {
  test.setTimeout(120_000);
  await mixAssistant();
  const capabilities = (await watcher!.call('engine.capabilities')) as { limits: { agentRequestsPerAgent: number } };
  const limit = capabilities.limits.agentRequestsPerAgent;
  expect(limit).toBe(16);
  for (let n = 1; n <= limit; n += 1) {
    await field().click();
    await page.keyboard.type(`request ${n}`);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await openRequests()).length).toBe(n);
    await expect(field()).toHaveValue('');
  }
  await field().click();
  await page.keyboard.type('one more');
  await page.keyboard.press('Enter');
  const refusal = page.getByTestId('composer-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'agent_busy');
  await expect(refusal).toHaveText(`agent_busy: ${t('error.agent_busy')}`);
  await expect(field()).toHaveValue('one more');
  expect((await openRequests()).length).toBe(limit);
  // The list is bounded: the box stays at the foot of the tab.
  const zone = (await page.locator('[data-region="right-zone"]').boundingBox())!;
  const box = (await composer().boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(zone.y + zone.height + 0.5);
  await expect(page.getByTestId('agent-requests')).toHaveCSS('overflow-y', 'auto');
});

test('with no agent connected the box is disabled with its reason, and a disconnect expires the open request', async () => {
  await expect(field()).toBeDisabled();
  await expect(composer()).toHaveAttribute('title', t('composer.noAgent'));
  const agent = await mixAssistant();
  await expect(field()).toBeEnabled();
  const sent = await send('Lower the drums');
  await agent.end();
  await expect(rowState(sent.id)).toHaveText('expired');
  expect((await requests()).find((r) => r.id === sent.id)!.state).toBe('expired');
  await expect(field()).toBeDisabled();
  await expect(composer()).toHaveAttribute('title', t('composer.noAgent'));
});

test('a text over the limit is refused in the box and kept', async () => {
  await mixAssistant();
  const limit = ((await watcher!.call('engine.capabilities')) as { limits: { agentRequestTextChars: number } }).limits.agentRequestTextChars;
  await field().fill('鼓'.repeat(limit + 1));
  await field().press('Enter');
  await expect(page.getByTestId('composer-refusal')).toHaveAttribute('data-code', 'invalid_request_text');
  await expect(field()).toHaveValue('鼓'.repeat(limit + 1));
  expect(await requests()).toEqual([]);
  // At the limit it goes.
  await field().fill('鼓'.repeat(limit));
  await field().press('Enter');
  await expect.poll(async () => (await requests()).length).toBe(1);
  await expect(page.getByTestId('composer-refusal')).toHaveCount(0);
  // White space alone never sends.
  await field().fill('   ');
  await field().press('Enter');
  await expect(field()).toHaveValue('   ');
  expect((await requests()).length).toBe(1);
});

test('against capabilities without the feature the box is not in the DOM and its space stays empty', async () => {
  const parts = async () => {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [name, selector] of [
      ['right-tabs', '[data-part="right-tabs"]'],
      ['agent-row', '[data-part="agent-row"]'],
      ['p-scroll', '.plans .p-scroll'],
    ]) {
      out[name] = (await page.locator(selector).boundingBox())!;
    }
    return out;
  };
  const full = await parts();
  const box = (await composer().boundingBox())!;
  const margin = await composer().evaluate((el) => parseFloat(getComputedStyle(el).marginBottom));
  const capabilities = (await watcher!.call('engine.capabilities')) as { methods: string[]; features: Record<string, unknown> };
  const reduced = {
    ...capabilities,
    methods: capabilities.methods.filter((m) => !AGENT_METHODS.includes(m)),
    features: Object.fromEntries(Object.entries(capabilities.features).filter(([name]) => name !== 'agentRequests')),
  };
  const file = path.join(scratch, 'capabilities-without-agent-requests.json');
  fs.writeFileSync(file, JSON.stringify(reduced));
  await relaunch({ SIANN_TEST_CAPABILITIES: file });
  await expect(page.locator('[data-part="composer"]')).toHaveCount(0);
  await expect(page.locator('[data-region="right-zone"] textarea')).toHaveCount(0);
  const empty = page.locator('.composer-empty');
  await expect(empty).toHaveCount(1);
  await expect(empty).toHaveAttribute('aria-hidden', 'true');
  for (const attr of ['role', 'tabindex', 'data-part', 'title']) expect(await empty.getAttribute(attr), attr).toBeNull();
  await expect(empty).toHaveText('');
  const reducedParts = await parts();
  for (const [name, at] of Object.entries(full)) {
    for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(reducedParts[name]![side] - at[side]), `${name} ${side}`).toBeLessThanOrEqual(1);
  }
  // The empty box is the box with its bottom margin.
  const hold = (await empty.boundingBox())!;
  expect(Math.abs(hold.y - box.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(hold.height - (box.height + margin))).toBeLessThanOrEqual(1);
  // An agent connecting changes nothing.
  await mixAssistant();
  await expect(page.locator('[data-part="agent-row"] b')).toHaveText('mix-assistant');
  await expect(page.locator('[data-part="composer"]')).toHaveCount(0);
});
