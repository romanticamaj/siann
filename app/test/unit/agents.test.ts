// The agents the engine knows (m5b-ui-plan-metadata; UI redesign 4.4; E-14,
// docs/schemas/protocol-engine-v0.md "engine.status" agents and
// protocol-events-v1.md agent.changed): parsed from engine.status, upserted by
// agent.changed, and the one the agent row shows, worded from the catalog.
// The tool list is read from protocol-mcp-v0.md's tool table, so a tool added
// there without a catalog entry fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { en, type Catalog } from '../../src/renderer/i18n/en';
import { translator } from '../../src/renderer/i18n/t';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { AgentStore, agentRow, parseAgent, parseAgents, shownAgent, toolWording, type Agent, type AgentClient } from '../../src/renderer/model/agents';
import type { ClientState } from '../../src/renderer/model/session-client';
import { settle, until } from './support/fakes';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES = path.join(ROOT, 'app', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const REDUCED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-reduced.json'), 'utf8')) as Capabilities;
const t = translator('en');

// The names in the first column of the "| Tool | Method | Scope | Arguments |" table.
function mcpTools(): string[] {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'schemas', 'protocol-mcp-v0.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const at = doc.findIndex((line) => /^\| Tool \| Method \|/.test(line));
  assert.ok(at >= 0, 'the tool table');
  const tools: string[] = [];
  for (const line of doc.slice(at + 2)) {
    const m = /^\| `([a-z_]+)` \|/.exec(line);
    if (!m) break;
    tools.push(m[1]!);
  }
  return tools;
}

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: `agent ${id}`,
  transport: 'mcp',
  connected: true,
  lastAction: null,
  lastActionAt: null,
  ...extra,
});

test('engine.status agents are parsed; malformed entries are dropped', () => {
  const status = {
    playing: false,
    agents: [
      { id: 'agt_1', name: 'mix-assistant', transport: 'mcp', connected: true, lastAction: 'submit_plan', lastActionAt: '2026-11-15T10:00:05Z' },
      { id: 'agt_2', name: 'MCP client', transport: 'mcp', connected: false, lastAction: null, lastActionAt: null },
      { id: 7, name: 'bad' },
      { id: 'agt_3', name: 'no connected flag', transport: 'mcp' },
    ],
  };
  assert.deepEqual(parseAgents(status), [
    { id: 'agt_1', name: 'mix-assistant', transport: 'mcp', connected: true, lastAction: 'submit_plan', lastActionAt: '2026-11-15T10:00:05Z' },
    { id: 'agt_2', name: 'MCP client', transport: 'mcp', connected: false, lastAction: null, lastActionAt: null },
  ]);
  assert.deepEqual(parseAgents({ playing: false }), []);
  assert.deepEqual(parseAgents(null), []);
  assert.equal(parseAgent({ id: 'agt_1' }), null);
});

test('the shown agent: the connected one with the newest lastActionAt, else the newest listed as disconnected, else none', () => {
  const a = agent('agt_a', { lastAction: 'play', lastActionAt: '2026-11-15T10:00:01Z' });
  const b = agent('agt_b', { lastAction: 'stop', lastActionAt: '2026-11-15T10:00:09Z' });
  const c = agent('agt_c', { connected: false, lastAction: 'locate', lastActionAt: '2026-11-15T10:00:30Z' });
  assert.equal(shownAgent([a, b, c])?.id, 'agt_b', 'connected wins over a newer disconnected one');
  // One connected agent that never acted still wins over a disconnected one.
  assert.equal(shownAgent([agent('agt_n'), c])?.id, 'agt_n');
  // Connected ones that never acted: the one that acted wins; else the last listed.
  assert.equal(shownAgent([agent('agt_n'), a])?.id, 'agt_a');
  const d = agent('agt_d', { connected: false, lastAction: 'play', lastActionAt: '2026-11-15T10:00:02Z' });
  assert.equal(shownAgent([d, { ...c }])?.id, 'agt_c', 'none connected: the newest');
  assert.equal(shownAgent([]), null);
});

test('the row reads connected or disconnected, then idle or the last tool in user wording, the time in the tooltip', () => {
  const idle = agentRow(agent('agt_1', { name: 'mix-assistant' }), t);
  assert.deepEqual(idle, { state: 'connected', name: 'mix-assistant', transport: 'MCP', text: 'connected · idle', title: null });
  const acted = agentRow(agent('agt_1', { name: 'mix-assistant', lastAction: 'submit_plan', lastActionAt: '2026-11-15T10:00:05Z' }), t);
  assert.equal(acted.state, 'connected');
  assert.equal(acted.text, `connected · ${toolWording('submit_plan', t)}`);
  assert.notEqual(toolWording('submit_plan', t), 'submit_plan', 'no tool name shown');
  assert.match(acted.title ?? '', /2026/, 'the time in the tooltip');
  const gone = agentRow(agent('agt_1', { connected: false, lastAction: 'play', lastActionAt: '2026-11-15T10:00:05Z' }), t);
  assert.equal(gone.state, 'disconnected');
  assert.match(gone.text, /^disconnected · /);
  const none = agentRow(null, t);
  assert.deepEqual(none, { state: 'none', name: null, transport: null, text: t('agent.none'), title: null });
  assert.equal(t('agent.none'), 'No agent connected');
});

test('every MCP tool of protocol-mcp-v0.md has a catalog entry in en, zh-Hant and zh-Hans; an unknown tool the generic wording', () => {
  const tools = mcpTools();
  assert.ok(tools.length >= 34, `${tools.length} tools`);
  assert.ok(tools.includes('submit_plan') && tools.includes('answer_request'));
  for (const [name, catalog] of [['en', en], ['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
    for (const tool of tools) {
      const key = `agent.tool.${tool}` as keyof Catalog;
      assert.equal(typeof catalog[key], 'string', `${name}: ${key}`);
      assert.notEqual((catalog[key] as string).trim(), '', `${name}: ${key}`);
    }
  }
  assert.equal(toolWording('no_such_tool', t), t('agent.tool.other'));
  // The prototype's own names are no tool.
  assert.equal(toolWording('toString', t), t('agent.tool.other'));
  assert.equal(toolWording('constructor', t), t('agent.tool.other'));
  for (const tool of tools) assert.equal(toolWording(tool, t), en[`agent.tool.${tool}` as keyof Catalog], tool);
});

class FakeClient implements AgentClient {
  state: ClientState = {
    status: 'connecting',
    sessionId: null,
    revision: null,
    about: null,
    lastSeq: null,
    syncCount: 0,
    connections: 0,
    error: null,
    legend: null,
    capabilities: null,
    epoch: 0,
  };
  readonly requests: string[] = [];
  status: () => unknown = () => ({ agents: [] });
  readonly #listeners = new Set<() => void>();
  readonly #events = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  getState(): ClientState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onEvent(type: string, fn: (event: Record<string, unknown>) => void): () => void {
    let set = this.#events.get(type);
    if (!set) this.#events.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  request(method: string): Promise<unknown> {
    this.requests.push(method);
    return method === 'engine.status' ? Promise.resolve(this.status()) : Promise.reject(new Error(method));
  }
  setState(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
  emit(event: Record<string, unknown>): void {
    for (const fn of [...(this.#events.get(String(event.type)) ?? [])]) fn(event);
  }
}

test('the store reads engine.status once connected, follows agent.changed by id, and is cleared when the engine goes away', async () => {
  const client = new FakeClient();
  client.status = () => ({ agents: [{ id: 'agt_1', name: 'mix-assistant', transport: 'mcp', connected: true, lastAction: null, lastActionAt: null }] });
  const store = new AgentStore();
  const detach = store.attach(client);
  assert.equal(store.getSnapshot().agents.length, 0);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  await until(() => store.getSnapshot().agents.length === 1, 'the agents of engine.status');
  assert.deepEqual(client.requests, ['engine.status']);

  // An update of a listed agent, by id, and a new one.
  client.emit({ type: 'agent.changed', agent: { id: 'agt_1', name: 'mix-assistant', transport: 'mcp', connected: true, lastAction: 'submit_plan', lastActionAt: '2026-11-15T10:00:05Z' } });
  client.emit({ type: 'agent.changed', agent: { id: 'agt_2', name: 'other', transport: 'mcp', connected: false, lastAction: null, lastActionAt: null } });
  assert.deepEqual(store.getSnapshot().agents.map((a) => [a.id, a.lastAction]), [
    ['agt_1', 'submit_plan'],
    ['agt_2', null],
  ]);
  client.emit({ type: 'agent.changed', agent: { id: 'agt_1' } });
  assert.equal(store.getSnapshot().agents.length, 2, 'a malformed event changes nothing');

  client.setState({ status: 'disconnected' });
  assert.deepEqual(store.getSnapshot().agents, [], 'cleared without an engine');
  detach();
  client.emit({ type: 'agent.changed', agent: { id: 'agt_9', name: 'x', transport: 'mcp', connected: true, lastAction: null, lastActionAt: null } });
  assert.deepEqual(store.getSnapshot().agents, [], 'detached');
});

test('an agent.changed that arrives while engine.status is answered is not lost', async () => {
  const client = new FakeClient();
  let resolve: (value: unknown) => void = () => undefined;
  client.request = (method: string) => {
    client.requests.push(method);
    return new Promise((r) => (resolve = r));
  };
  const store = new AgentStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  client.emit({ type: 'agent.changed', agent: { id: 'agt_1', name: 'm', transport: 'mcp', connected: true, lastAction: 'play', lastActionAt: '2026-11-15T10:00:09Z' } });
  resolve({ agents: [{ id: 'agt_1', name: 'm', transport: 'mcp', connected: true, lastAction: null, lastActionAt: null }] });
  await settle();
  assert.equal(store.getSnapshot().agents[0]?.lastAction, 'play');
});

test('nothing is requested and no agent is kept without features.agents', async () => {
  const client = new FakeClient();
  const store = new AgentStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: REDUCED });
  client.emit({ type: 'agent.changed', agent: { id: 'agt_1', name: 'm', transport: 'mcp', connected: true, lastAction: null, lastActionAt: null } });
  await settle();
  assert.deepEqual(client.requests, []);
  assert.deepEqual(store.getSnapshot().agents, []);
});
