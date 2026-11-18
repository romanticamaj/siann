// The requests the "ask the agent" box shows (m5b-ui-composer; UI redesign
// 4.4; protocol-engine-v0.md "Agent requests", protocol-events-v1.md
// agent.request_changed): seeded from agent.requests once per connection
// (the open ones oldest first, then the last closed one), then following
// agent.request_changed through pending -> taken -> answered, declined,
// cancelled or expired. The shown set is every open request and under them
// the most recently closed one, until the next send or a dismissal. An
// answered request with a plan signals once that its plan is to be selected;
// one already answered when the list is loaded does not. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { translator } from '../../src/renderer/i18n/t';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { RequestStore, isOpen, requestStateKey, type RequestClient } from '../../src/renderer/model/request-store';
import type { AgentRequest, AgentRequestState, ClientState } from '../../src/renderer/model/session-client';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const REDUCED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-reduced.json'), 'utf8')) as Capabilities;

const AGENT = 'agt_00c0ffee00c0ffee';

function req(id: string, state: AgentRequestState, extra: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id,
    agentId: AGENT,
    text: `text of ${id}`,
    context: { selection: { tracks: [], clips: [] }, locators: null, cursor: '0', headRevision: 'r3' },
    state,
    createdAt: '2026-11-18T10:00:00Z',
    ...extra,
  };
}

class FakeClient implements RequestClient {
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
  };
  loads = 0;
  list: () => Promise<readonly AgentRequest[]> = async () => [];
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
  agentRequests(): Promise<readonly AgentRequest[]> {
    this.loads += 1;
    return this.list();
  }
  setState(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
  changed(request: AgentRequest): void {
    for (const fn of [...(this.#events.get('agent.request_changed') ?? [])]) fn({ type: 'agent.request_changed', request });
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ids = (store: RequestStore) => store.getSnapshot().shown.map((r) => `${r.id}:${r.state}`);

test('the store is seeded from agent.requests: the open ones oldest first, then the last closed one', async () => {
  const client = new FakeClient();
  client.list = async () => [req('arq_1', 'pending'), req('arq_2', 'taken'), req('arq_c1', 'declined'), req('arq_c2', 'answered', { message: 'done' })];
  const store = new RequestStore();
  store.attach(client);
  assert.equal(client.loads, 0, 'nothing is read before the engine is connected');
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  await tick();
  assert.equal(client.loads, 1);
  assert.deepEqual(ids(store), ['arq_1:pending', 'arq_2:taken', 'arq_c2:answered']);
  assert.deepEqual(store.getSnapshot().open.map((r) => r.id), ['arq_1', 'arq_2']);
  assert.equal(store.getSnapshot().closed?.id, 'arq_c2');
  // The same connection is not read again.
  client.setState({ revision: 'r4' });
  await tick();
  assert.equal(client.loads, 1);
});

test('the store follows agent.request_changed from pending through taken to answered, declined, cancelled and expired', async () => {
  const client = new FakeClient();
  const store = new RequestStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  await tick();
  client.changed(req('arq_1', 'pending'));
  assert.deepEqual(ids(store), ['arq_1:pending']);
  client.changed(req('arq_1', 'taken'));
  assert.deepEqual(ids(store), ['arq_1:taken']);
  client.changed(req('arq_2', 'pending'));
  client.changed(req('arq_3', 'pending'));
  client.changed(req('arq_4', 'pending'));
  client.changed(req('arq_1', 'answered', { message: 'Lowered it' }));
  assert.deepEqual(ids(store), ['arq_2:pending', 'arq_3:pending', 'arq_4:pending', 'arq_1:answered'], 'the closed one under the open ones');
  client.changed(req('arq_2', 'declined', { message: 'Not now' }));
  assert.deepEqual(ids(store), ['arq_3:pending', 'arq_4:pending', 'arq_2:declined'], 'the most recently closed one replaces the earlier');
  client.changed(req('arq_3', 'cancelled'));
  assert.deepEqual(ids(store), ['arq_4:pending', 'arq_3:cancelled']);
  client.changed(req('arq_4', 'expired'));
  assert.deepEqual(ids(store), ['arq_4:expired']);
  assert.equal(store.getSnapshot().closed?.state, 'expired');
});

test('a send adds the request and clears the shown closed one; dismiss clears it too', async () => {
  const client = new FakeClient();
  client.list = async () => [req('arq_c', 'declined')];
  const store = new RequestStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  await tick();
  assert.deepEqual(ids(store), ['arq_c:declined']);
  store.sent(req('arq_n', 'pending'));
  assert.deepEqual(ids(store), ['arq_n:pending']);
  // The event of the same request (before or after the reply) does not add it twice.
  client.changed(req('arq_n', 'pending'));
  assert.deepEqual(ids(store), ['arq_n:pending']);
  client.changed(req('arq_n', 'answered', { message: 'ok' }));
  assert.deepEqual(ids(store), ['arq_n:answered']);
  store.dismiss();
  assert.deepEqual(ids(store), []);
  assert.equal(store.getSnapshot().closed, null);
  // A reload on the same engine does not bring back what was dismissed or cleared by a send.
  client.list = async () => [req('arq_c', 'declined'), req('arq_n', 'answered', { message: 'ok' })];
  client.setState({ status: 'disconnected' });
  client.setState({ status: 'connected', connections: 2 });
  await tick();
  assert.deepEqual(ids(store), []);
});

test('a reconnect reloads from agent.requests, and an engine restart returns none', async () => {
  const client = new FakeClient();
  client.list = async () => [req('arq_1', 'pending')];
  const store = new RequestStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  await tick();
  assert.deepEqual(ids(store), ['arq_1:pending']);
  // The engine goes away: nothing is kept.
  client.setState({ status: 'disconnected' });
  assert.deepEqual(ids(store), []);
  // The same engine again: the request, now taken, is read back.
  client.list = async () => [req('arq_1', 'taken')];
  client.setState({ status: 'connected', connections: 2 });
  await tick();
  assert.equal(client.loads, 2);
  assert.deepEqual(ids(store), ['arq_1:taken']);
  // A restarted engine holds no requests.
  client.list = async () => [];
  client.setState({ status: 'disconnected' });
  client.setState({ status: 'connected', connections: 3 });
  await tick();
  assert.equal(client.loads, 3);
  assert.deepEqual(ids(store), []);
});

test('an event during the load is newer than its answer', async () => {
  const client = new FakeClient();
  let answer: (list: readonly AgentRequest[]) => void = () => undefined;
  client.list = () => new Promise((resolve) => (answer = resolve));
  const store = new RequestStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  client.changed(req('arq_1', 'taken'));
  answer([req('arq_1', 'pending')]);
  await tick();
  assert.deepEqual(ids(store), ['arq_1:taken']);
});

test('without agent.requests nothing is read and nothing is followed', async () => {
  const client = new FakeClient();
  const store = new RequestStore();
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: REDUCED });
  await tick();
  assert.equal(client.loads, 0);
  client.changed(req('arq_1', 'pending'));
  assert.deepEqual(ids(store), []);
});

test('an answered request with a plan signals its plan once; one already answered at load signals nothing', async () => {
  const client = new FakeClient();
  const plan = 'sha256:' + 'a'.repeat(64);
  const old = 'sha256:' + 'b'.repeat(64);
  client.list = async () => [req('arq_old', 'answered', { plan: old })];
  const store = new RequestStore();
  const selected: string[] = [];
  store.onSelectPlan((hash) => selected.push(hash));
  store.attach(client);
  client.setState({ status: 'connected', connections: 1, capabilities: FULL });
  await tick();
  assert.deepEqual(selected, [], 'loaded answered: no signal');
  client.changed(req('arq_old', 'answered', { plan: old }));
  assert.deepEqual(selected, [], 'a repeat of a closed request: no signal');
  client.changed(req('arq_1', 'pending'));
  client.changed(req('arq_1', 'taken'));
  assert.deepEqual(selected, []);
  client.changed(req('arq_1', 'answered', { plan }));
  assert.deepEqual(selected, [plan]);
  client.changed(req('arq_1', 'answered', { plan }));
  assert.deepEqual(selected, [plan], 'once');
  // Answered with a message, or declined: no plan to select.
  client.changed(req('arq_2', 'pending'));
  client.changed(req('arq_2', 'answered', { message: 'Done' }));
  client.changed(req('arq_3', 'pending'));
  client.changed(req('arq_3', 'declined', { message: 'No' }));
  assert.deepEqual(selected, [plan]);
});

test('the states read sent, taken, answered, declined, cancelled and expired; pending and taken are open', () => {
  const t = translator('en');
  const words = (['pending', 'taken', 'answered', 'declined', 'cancelled', 'expired'] as const).map((s) => t(requestStateKey(s)));
  assert.deepEqual(words, ['sent', 'taken', 'answered', 'declined', 'cancelled', 'expired']);
  assert.deepEqual((['pending', 'taken', 'answered', 'declined', 'cancelled', 'expired'] as const).map(isOpen), [true, true, false, false, false, false]);
  for (const state of ['pending', 'taken', 'answered', 'declined', 'cancelled', 'expired'] as const) assert.ok(requestStateKey(state) in en, state);
});
