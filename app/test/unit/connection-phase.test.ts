// The connection phase of the window (m5-ui-connection; UI redesign spec 7
// P1-6 and 4.5 C8): pure over the previous phase and what the session client
// and its read model report. 'starting' until the first connection (no
// banner), 'online', and 'offline' from the first loss on, through the
// reconnect loop's disconnected / connecting alternation. A reconnect is
// offline -> online after an earlier connection, and names the recovered
// revision: the read model's once the reconnect's sync landed, or the auth
// reply's when nothing was missed and no sync runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionPhaseStore,
  initialPhase,
  reducePhase,
  type PhaseInput,
  type PhaseState,
} from '../../src/renderer/model/connection-phase';
import type { ClientState } from '../../src/renderer/model/session-client';

function input(over: Partial<PhaseInput>): PhaseInput {
  return { status: 'connecting', revision: null, syncCount: 0, snapshotRevision: null, ...over };
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
