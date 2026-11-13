// The renderer's plan store (m5-plan-review; spec "Frontend", plan review;
// Protocol v0 item 25): plans keyed by hash in submission order, filled by
// plan.list, advanced by plan.changed, and the heard side from
// audition.changed and session.inspect. The client is a fake that records
// requests and plays events; no network, no timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ClientState } from '../../src/renderer/model/session-client';
import { PlanStore, type PlanClient, type PlanEvent } from '../../src/renderer/model/plan-store';
import { settle, until } from './support/fakes';

const H1 = 'sha256:' + '1'.repeat(64);
const H2 = 'sha256:' + '2'.repeat(64);
const H3 = 'sha256:' + '3'.repeat(64);

function planObject(hash: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'siann.plan.v1',
    hash,
    state,
    baseRevision: 'r2',
    steps: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -600 }],
    readSet: [],
    writeSet: [{ type: 'track', id: 'trk_a', hash: 'sha256:' + 'a'.repeat(64) }],
    stale: [],
    ...extra,
  };
}

class FakePlanClient implements PlanClient {
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
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  readonly #listeners = new Set<() => void>();
  readonly #events = new Map<string, Set<(event: PlanEvent) => void>>();
  getState(): ClientState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onEvent(type: string, fn: (event: PlanEvent) => void): () => void {
    let set = this.#events.get(type);
    if (!set) this.#events.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    const answer = this.answers.get(method);
    return answer ? Promise.resolve(answer(params)) : Promise.reject(new Error(`no answer for ${method}`));
  }
  setState(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
  emit(event: PlanEvent): void {
    for (const fn of [...(this.#events.get(event.type) ?? [])]) fn(event);
  }
  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

const changed = (plan: string, state: string, proposalBranch?: string): PlanEvent => ({
  schema: 'siann.event.v1',
  seq: '1',
  type: 'plan.changed',
  plan,
  state,
  ...(proposalBranch ? { proposalBranch } : {}),
});

test('fromList replaces the plans in submission order; the snapshot keeps its identity until a change', () => {
  const store = new PlanStore();
  const empty = store.getSnapshot();
  assert.deepEqual(empty.plans, []);
  assert.equal(empty.heard, null);
  let notified = 0;
  store.subscribe(() => (notified += 1));

  store.fromList({ plans: [planObject(H2, 'validated'), planObject(H1, 'approved', { proposalBranch: 'p1' })] });
  const first = store.getSnapshot();
  assert.notEqual(first, empty);
  assert.equal(notified, 1);
  assert.deepEqual(first.plans.map((p) => p.hash), [H2, H1], 'submission order, not hash order');
  assert.equal(first.byHash.get(H1)!.proposalBranch, 'p1');
  assert.equal(first.byHash.get(H2)!.state, 'validated');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.plans));
  assert.equal(store.getSnapshot(), first, 'stable identity');

  store.fromList({ plans: [planObject(H3, 'validated')] });
  assert.deepEqual(store.getSnapshot().plans.map((p) => p.hash), [H3], 'replaced, not merged');
  assert.equal(first.plans.length, 2, 'the old snapshot is unchanged');
});

test('an applied plan keeps the revision it landed at (appliedRevision)', () => {
  const store = new PlanStore();
  store.fromList({ plans: [planObject(H1, 'validated')] });
  assert.equal(store.getSnapshot().byHash.get(H1)!.appliedRevision, undefined);
  store.setStatus(planObject(H1, 'applied', { appliedRevision: 'r7' }));
  assert.equal(store.getSnapshot().byHash.get(H1)!.appliedRevision, 'r7');
  store.applyChanged(changed(H1, 'rolled_back'));
  assert.equal(store.getSnapshot().byHash.get(H1)!.appliedRevision, 'r7', 'kept through plan.changed');
});

test('applyChanged updates one plan, keeps the others, and marks an unknown hash as needing plan.status', () => {
  const store = new PlanStore();
  store.fromList({ plans: [planObject(H1, 'approved', { proposalBranch: 'p1' }), planObject(H2, 'validated')] });
  const before = store.getSnapshot();
  const untouched = before.byHash.get(H2);

  store.applyChanged(changed(H1, 'applied'));
  const after = store.getSnapshot();
  assert.equal(after.byHash.get(H1)!.state, 'applied');
  assert.equal(after.byHash.get(H1)!.proposalBranch, undefined, 'the link went with the merge');
  assert.equal(after.byHash.get(H2), untouched, 'the other plan keeps its identity');
  assert.equal(before.byHash.get(H1)!.state, 'approved', 'immutable');
  assert.deepEqual(after.needsStatus, []);

  store.applyChanged(changed(H3, 'validated'));
  assert.deepEqual(store.getSnapshot().needsStatus, [H3]);
  assert.equal(store.getSnapshot().byHash.has(H3), false, 'not invented from the event');

  // plan.status answers it: added in arrival order, no longer needed.
  store.setStatus(planObject(H3, 'validated'));
  assert.deepEqual(store.getSnapshot().plans.map((p) => p.hash), [H1, H2, H3]);
  assert.deepEqual(store.getSnapshot().needsStatus, []);

  // An event that changes nothing leaves the snapshot alone.
  const settled = store.getSnapshot();
  store.applyChanged(changed(H3, 'validated'));
  assert.equal(store.getSnapshot(), settled);
});

test('attach lists on connect and after every sync, fetches an unknown plan, and follows plan.changed', async () => {
  const client = new FakePlanClient();
  let listed = [planObject(H1, 'validated')];
  client.answers.set('plan.list', () => ({ plans: listed }));
  client.answers.set('plan.status', (params) => planObject(String(params.plan), 'validated'));
  client.answers.set('session.inspect', () => ({ revision: 'r2', heard: 'main' }));
  const store = new PlanStore();
  const detach = store.attach(client);
  assert.equal(client.count('plan.list'), 0, 'nothing while connecting');

  client.setState({ status: 'connected', sessionId: 'ses_1', syncCount: 1 });
  await until(() => store.getSnapshot().plans.length === 1, 'the first list');
  assert.equal(store.getSnapshot().heard, 'main');

  // Another sync (a gap or a reconnect) lists again: events may have been missed.
  listed = [planObject(H1, 'rejected'), planObject(H2, 'approved')];
  client.setState({ syncCount: 2 });
  await until(() => store.getSnapshot().plans.length === 2, 'the list after the sync');
  assert.equal(store.getSnapshot().byHash.get(H1)!.state, 'rejected');

  client.emit(changed(H2, 'approved', 'p1'));
  assert.equal(store.getSnapshot().byHash.get(H2)!.proposalBranch, 'p1');

  client.emit(changed(H3, 'validated'));
  await until(() => store.getSnapshot().byHash.has(H3), 'the unknown plan');
  assert.deepEqual(
    client.requests.filter((r) => r.method === 'plan.status').map((r) => r.params),
    [{ plan: H3 }],
  );

  // A commit can make plans stale: the list is read again.
  const lists = client.count('plan.list');
  client.emit({ schema: 'siann.event.v1', seq: '9', type: 'session.changed' });
  await until(() => client.count('plan.list') === lists + 1, 'the list after session.changed');

  detach();
  client.emit(changed(H1, 'applied'));
  client.setState({ syncCount: 3 });
  await settle();
  assert.equal(store.getSnapshot().byHash.get(H1)!.state, 'rejected', 'detached');
  assert.equal(client.count('plan.list'), lists + 1);
});

test('heard follows audition.changed and session.inspect, and is unknown while disconnected', async () => {
  const client = new FakePlanClient();
  client.answers.set('plan.list', () => ({ plans: [] }));
  client.answers.set('session.inspect', () => ({ revision: 'r2', heard: 'p2' }));
  const store = new PlanStore();
  store.attach(client);
  client.setState({ status: 'connected', sessionId: 'ses_1', syncCount: 1 });
  await until(() => store.getSnapshot().heard === 'p2', 'heard from session.inspect');

  client.emit({ schema: 'siann.event.v1', seq: '3', type: 'audition.changed', heard: 'main' });
  assert.equal(store.getSnapshot().heard, 'main');
  client.emit({ schema: 'siann.event.v1', seq: '4', type: 'audition.changed', heard: 'p3' });
  assert.equal(store.getSnapshot().heard, 'p3');

  client.setState({ status: 'disconnected' });
  assert.equal(store.getSnapshot().heard, null);

  // An engine without an auditioner reports no heard field.
  client.answers.set('session.inspect', () => ({ revision: 'r2' }));
  client.setState({ status: 'connected', syncCount: 2 });
  await until(() => client.count('session.inspect') === 2, 'the second inspect');
  await settle();
  assert.equal(store.getSnapshot().heard, null);
});

// m5-ui-plan-panel: the card's time, the toast's arrivals, and the re-read of
// the fields plan.changed does not carry (E-7).

async function connected(store: PlanStore, listed: () => unknown[], status: (hash: string) => unknown) {
  const client = new FakePlanClient();
  client.answers.set('plan.list', () => ({ plans: listed() }));
  client.answers.set('plan.status', (params) => status(String(params.plan)));
  client.answers.set('session.inspect', () => ({ revision: 'r2', heard: 'main' }));
  store.attach(client);
  client.setState({ status: 'connected', sessionId: 'ses_1', syncCount: 1 });
  await until(() => client.count('plan.list') === 1 && store.getSnapshot().heard === 'main', 'the first list');
  await settle();
  return client;
}

test('firstSeen: the injected clock when plan.changed taught the plan, none for the first list, kept across lists', async () => {
  let clock = 1_000;
  const store = new PlanStore({ now: () => clock });
  let listed = [planObject(H1, 'validated')];
  const client = await connected(store, () => listed, (hash) => planObject(hash, 'validated'));
  assert.equal(store.getSnapshot().firstSeen.has(H1), false, 'a plan of the first list has no time');

  clock = 2_500;
  client.emit(changed(H2, 'validated'));
  await until(() => store.getSnapshot().byHash.has(H2), 'the new plan');
  assert.equal(store.getSnapshot().firstSeen.get(H2), 2_500);

  clock = 9_000;
  listed = [planObject(H1, 'validated'), planObject(H2, 'approved')];
  client.setState({ syncCount: 2 });
  await until(() => store.getSnapshot().byHash.get(H2)?.state === 'approved', 'the second list');
  assert.equal(store.getSnapshot().firstSeen.get(H2), 2_500, 'kept across plan.list');
  assert.equal(store.getSnapshot().firstSeen.has(H1), false);
});

test('arrivals: a new validated plan from plan.changed, not the first list, a sub-plan or a held plan', async () => {
  const store = new PlanStore({ now: () => 0 });
  const arrived: string[] = [];
  store.onArrival((plan) => arrived.push(plan.hash));
  const client = await connected(
    store,
    () => [planObject(H1, 'validated')],
    (hash) => (hash === H3 ? planObject(H3, 'approved', { parentPlan: H2 }) : planObject(hash, 'validated')),
  );
  assert.deepEqual(arrived, [], 'nothing for the list on connect');

  client.emit(changed(H2, 'validated'));
  await until(() => store.getSnapshot().byHash.has(H2), 'the new plan');
  assert.deepEqual(arrived, [H2]);

  client.emit(changed(H3, 'approved'));
  await until(() => store.getSnapshot().byHash.has(H3), 'the sub-plan');
  client.emit(changed(H1, 'approved'));
  client.emit(changed(H2, 'rejected'));
  await settle();
  assert.deepEqual(arrived, [H2], 'a sub-plan and state changes raise none');
});

test('a held plan that becomes rejected or approved is re-read with plan.status (note and times)', async () => {
  const store = new PlanStore({ now: () => 0 });
  const client = await connected(
    store,
    () => [planObject(H1, 'validated'), planObject(H2, 'validated'), planObject(H3, 'approved')],
    (hash) =>
      hash === H1
        ? planObject(H1, 'rejected', { rejectionNote: 'too loud', rejectedAt: '2026-11-14T12:00:00Z' })
        : planObject(hash, 'approved', { approvedAt: '2026-11-14T12:00:00Z' }),
  );
  client.emit(changed(H1, 'rejected'));
  await until(() => store.getSnapshot().byHash.get(H1)?.rejectionNote === 'too loud', 'the note');
  assert.equal(store.getSnapshot().byHash.get(H1)!.raw.rejectedAt, '2026-11-14T12:00:00Z');
  client.emit(changed(H2, 'approved'));
  await until(() => store.getSnapshot().byHash.get(H2)?.raw.approvedAt !== undefined, 'approvedAt');
  assert.deepEqual(
    client.requests.filter((r) => r.method === 'plan.status').map((r) => r.params.plan),
    [H1, H2],
  );
  // A proposal of an approved plan or an apply is not a transition to re-read.
  client.emit(changed(H3, 'approved', 'p1'));
  client.emit(changed(H3, 'applied'));
  await settle();
  assert.equal(client.count('plan.status'), 2);
});
