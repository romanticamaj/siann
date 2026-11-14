// The connection phase of the window (m5-ui-connection; UI redesign spec 7
// P1-6 and 4.5 C8): pure over the previous phase and what the session client
// and its read model report. 'starting' until the first connection (no
// banner) while the shell's engine is on its way, bounded: a failed launch the
// shell reports, a failed first connection or the start outlasting STARTING_MS
// end it offline. Then 'online', and 'offline' from the first loss on, through the
// reconnect loop's disconnected / connecting alternation. A reconnect is
// offline -> online after an earlier connection, and names the recovered
// revision: the read model's once the reconnect's sync landed, or the auth
// reply's when nothing was missed and no sync runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionPhaseStore,
  STARTING_MS,
  initialPhase,
  reducePhase,
  type PhaseInput,
  type PhaseState,
} from '../../src/renderer/model/connection-phase';
import type { ClientState } from '../../src/renderer/model/session-client';

function input(over: Partial<PhaseInput>): PhaseInput {
  return { status: 'connecting', revision: null, syncCount: 0, snapshotRevision: null, connections: 0, startFailed: false, ...over };
}

function run(start: PhaseState, inputs: readonly PhaseInput[]): PhaseState[] {
  const out: PhaseState[] = [];
  let state = start;
  for (const next of inputs) {
    state = reducePhase(state, next);
    out.push(state);
  }
  return out;
}

// A first connection whose sync landed at r3.
function online(): PhaseState {
  const states = run(initialPhase('connecting'), [
    input({ status: 'connected', revision: 'r3' }),
    input({ status: 'connected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
  ]);
  return states[states.length - 1]!;
}

test('starting -> online gives no reconnect, also when the engine was not up yet (no endpoint)', () => {
  const start = initialPhase('connecting');
  assert.equal(start.phase, 'starting');
  assert.equal(start.reconnect, null);
  const states = run(start, [
    // The shell has no engine yet: connect(null) reports disconnected.
    input({ status: 'disconnected' }),
    input({ status: 'connecting' }),
    input({ status: 'connected', revision: 'r3' }),
    input({ status: 'connected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
  ]);
  assert.deepEqual(
    states.map((s) => s.phase),
    ['starting', 'starting', 'online', 'online'],
  );
  assert.ok(states.every((s) => s.reconnect === null));
});

test('online -> offline on a loss, and offline stays offline across the reconnect loop', () => {
  const states = run(online(), [
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connecting', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connecting', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
  ]);
  assert.deepEqual(new Set(states.map((s) => s.phase)), new Set(['offline']));
  assert.ok(states.every((s) => s.reconnect === null));
});

test('offline -> online after a sync: the reconnect names the snapshot revision once the sync landed', () => {
  const states = run(online(), [
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connecting', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    // A restarted engine: the auth reply's head is r5, the model is still at r3.
    input({ status: 'connected', revision: 'r5', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connected', revision: 'r5', syncCount: 2, snapshotRevision: 'r5' }),
    input({ status: 'connected', revision: 'r5', syncCount: 2, snapshotRevision: 'r6' }),
  ]);
  assert.equal(states[2]!.phase, 'online');
  assert.equal(states[2]!.reconnect, null, 'no reconnect before its sync landed');
  assert.deepEqual(states[3]!.reconnect, { revision: 'r5', count: 1 });
  // A later commit does not announce the reconnect again.
  assert.equal(states[4]!.reconnect, states[3]!.reconnect);
});

test('offline -> online with nothing missed: the reconnect names the auth reply revision without a sync', () => {
  const states = run(online(), [
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connecting', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
  ]);
  assert.equal(states[2]!.phase, 'online');
  assert.deepEqual(states[2]!.reconnect, { revision: 'r3', count: 1 });
  // A second loss and return counts again.
  const again = run(states[2]!, [
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connected', revision: 'r4', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connected', revision: 'r4', syncCount: 2, snapshotRevision: 'r4' }),
  ]);
  assert.deepEqual(again[2]!.reconnect, { revision: 'r4', count: 2 });
});

test('a loss while the reconnect sync runs goes offline and announces nothing', () => {
  const states = run(online(), [
    input({ status: 'disconnected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'connected', revision: 'r5', syncCount: 1, snapshotRevision: 'r3' }),
    input({ status: 'disconnected', revision: 'r5', syncCount: 1, snapshotRevision: 'r3' }),
  ]);
  assert.equal(states[2]!.phase, 'offline');
  assert.equal(states[2]!.reconnect, null);
});

test('a plain tab (no bridge: initial status disconnected) is offline from the start', () => {
  const start = initialPhase('disconnected');
  assert.equal(start.phase, 'offline');
  assert.equal(reducePhase(start, input({ status: 'disconnected' })).phase, 'offline');
});

test('starting -> offline when the shell reports a failed launch (a crash loop or giving up), with the banner state', () => {
  const states = run(initialPhase('connecting'), [
    input({ status: 'disconnected' }),
    // The shell's onChange(null): the launch failed.
    input({ status: 'disconnected', startFailed: true }),
    // The shell restarts it: the reconnect loop stays offline.
    input({ status: 'connecting', startFailed: true }),
    input({ status: 'disconnected', startFailed: true }),
  ]);
  assert.deepEqual(
    states.map((s) => s.phase),
    ['starting', 'offline', 'offline', 'offline'],
  );
  // The first connection after a failed start is not a reconnect.
  const up = run(states[3]!, [
    input({ status: 'connected', revision: 'r1', startFailed: true }),
    input({ status: 'connected', revision: 'r1', syncCount: 1, snapshotRevision: 'r1', startFailed: true }),
  ]);
  assert.deepEqual(
    up.map((s) => s.phase),
    ['online', 'online'],
  );
  assert.ok(up.every((s) => s.reconnect === null));
  // A later loss is a loss of the first connection, and its return a reconnect.
  const again = run(up[1]!, [
    input({ status: 'disconnected', revision: 'r1', syncCount: 1, snapshotRevision: 'r1', startFailed: true }),
    input({ status: 'connected', revision: 'r1', syncCount: 1, snapshotRevision: 'r1', startFailed: true }),
  ]);
  assert.equal(again[0]!.phase, 'offline');
  assert.deepEqual(again[1]!.reconnect, { revision: 'r1', count: 1 });
});

test('starting -> offline when a first connection to a reported engine fails before it connects', () => {
  const states = run(initialPhase('connecting'), [
    input({ status: 'connecting' }),
    // The socket opened (connections 1) and closed before the auth reply.
    input({ status: 'connecting', connections: 1 }),
    input({ status: 'disconnected', connections: 1 }),
  ]);
  assert.deepEqual(
    states.map((s) => s.phase),
    ['starting', 'starting', 'offline'],
  );
});

test('a failed-start report after the first connection changes nothing while connected', () => {
  const state = reducePhase(online(), input({ status: 'connected', revision: 'r3', syncCount: 1, snapshotRevision: 'r3', startFailed: true }));
  assert.equal(state.phase, 'online');
});

function fakeClient(status: ClientState['status']) {
  let state: ClientState = {
    status,
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
  const listeners = new Set<() => void>();
  return {
    client: {
      getState: () => state,
      subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
      model: { getSnapshot: () => null, subscribe: () => () => undefined },
    },
    set(patch: Partial<ClientState>) {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
  };
}

function manualSchedule() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fire() {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

test('the store goes offline when the shell reports no engine during the start (engineDown)', () => {
  const fake = fakeClient('connecting');
  const store = new ConnectionPhaseStore(fake.client);
  let notified = 0;
  store.subscribe(() => (notified += 1));
  // current() was null: the engine is not up yet.
  fake.set({ status: 'disconnected' });
  assert.equal(store.getSnapshot().phase, 'starting');
  store.engineDown();
  assert.equal(store.getSnapshot().phase, 'offline');
  assert.equal(notified, 1);
  store.destroy();
});

test('the store bounds the start: offline once it outlasts STARTING_MS, and the timer goes with the start', () => {
  const clock = manualSchedule();
  const fake = fakeClient('connecting');
  const store = new ConnectionPhaseStore(fake.client, { schedule: clock.schedule });
  assert.deepEqual(
    clock.timers.map((t) => t.ms),
    [STARTING_MS],
  );
  fake.set({ status: 'disconnected' });
  assert.equal(store.getSnapshot().phase, 'starting');
  clock.fire();
  assert.equal(store.getSnapshot().phase, 'offline');
  store.destroy();

  // A start that connects in time cancels the timer.
  const quick = manualSchedule();
  const ok = fakeClient('connecting');
  const second = new ConnectionPhaseStore(ok.client, { schedule: quick.schedule });
  ok.set({ status: 'connected', revision: 'r1', connections: 1 });
  assert.equal(second.getSnapshot().phase, 'online');
  assert.ok(quick.timers.every((t) => t.cancelled));
  second.destroy();

  // destroy() cancels it too, and a plain tab schedules none.
  const idle = manualSchedule();
  new ConnectionPhaseStore(fakeClient('connecting').client, { schedule: idle.schedule }).destroy();
  assert.equal(idle.timers.length, 1);
  assert.ok(idle.timers[0]!.cancelled);
  const tab = manualSchedule();
  new ConnectionPhaseStore(fakeClient('disconnected').client, { schedule: tab.schedule }).destroy();
  assert.equal(tab.timers.length, 0);
});

test('the store follows the client and its model and notifies on a phase change', () => {
  let state: ClientState = {
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
  let snapshot: { revision: string } | null = null;
  const clientListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const client = {
    getState: () => state,
    subscribe: (l: () => void) => (clientListeners.add(l), () => void clientListeners.delete(l)),
    model: {
      getSnapshot: () => snapshot,
      subscribe: (l: () => void) => (modelListeners.add(l), () => void modelListeners.delete(l)),
    },
  };
  const store = new ConnectionPhaseStore(client);
  let notified = 0;
  store.subscribe(() => (notified += 1));
  assert.equal(store.getSnapshot().phase, 'starting');
  const set = (patch: Partial<ClientState>) => {
    state = { ...state, ...patch };
    for (const l of [...clientListeners]) l();
  };
  set({ status: 'connected', revision: 'r1' });
  snapshot = { revision: 'r1' };
  set({ syncCount: 1 });
  assert.equal(store.getSnapshot().phase, 'online');
  set({ status: 'disconnected' });
  assert.equal(store.getSnapshot().phase, 'offline');
  set({ status: 'connected', revision: 'r2' });
  assert.equal(store.getSnapshot().reconnect, null);
  // The sync replaces the model first (model listeners), then counts.
  snapshot = { revision: 'r2' };
  for (const l of [...modelListeners]) l();
  set({ syncCount: 2 });
  assert.deepEqual(store.getSnapshot().reconnect, { revision: 'r2', count: 1 });
  assert.ok(notified >= 3);
  const before = notified;
  set({ error: 'unrelated' });
  assert.equal(notified, before, 'no notification without a change of phase');
  store.destroy();
  assert.equal(clientListeners.size, 0);
  assert.equal(modelListeners.size, 0);
});
