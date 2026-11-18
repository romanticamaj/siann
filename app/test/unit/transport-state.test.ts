// The cycle flag and the click as the engine says them (m5-ui-loop-click;
// docs/schemas/protocol-engine-v0.md, "Cycle and click"; protocol-events-v1.md,
// "transport.changed"): read from engine.status after the auth, kept by
// transport.changed and by the transport methods' results, forgotten while
// the engine is away and read again after a reconnect and after a sync. Runs
// the real SessionClient against a fake socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TransportStateStore, parseTransportState } from '../../src/renderer/model/loop-click';
import { SessionClient } from '../../src/renderer/model/session-client';
import { FakeScheduler, FakeSocket, settle, until, type Message } from './support/fakes';
import { sequence } from './support/sequence';

const ENDPOINT = { port: 4100, token: 'tok' };
const CAPS = { methods: ['engine.status', 'transport.set_cycle', 'transport.set_click', 'session.sync'], features: { cycle: true, click: true } };
// A real sync (fixtures/protocol/read-model-sequence.json): its chunks hash to its documentHash.
const SEQUENCE = sequence();
const SYNC = SEQUENCE.sync;
const BASE = Number(SEQUENCE.base.seq);
const SESSION = SEQUENCE.sessionId;

function syncChunk(cursor: unknown): unknown {
  if (cursor === undefined) return SYNC[0];
  return SYNC[SYNC.findIndex((chunk) => chunk.next === cursor) + 1];
}

interface Engine {
  status: { cycle: boolean; click: { enabled: boolean; gainMilliDb: number } };
  // engine.status requests, held until the test answers them.
  held: Message[];
  hold: boolean;
}

function connect(engine: Engine) {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      socket.handler = (message) => {
        if (message.type === 'auth') {
          socket.deliver({ type: 'auth', ok: true, sessionId: SESSION, revision: SEQUENCE.base.revision, seq: SEQUENCE.base.seq });
          return;
        }
        const reply = (result: unknown) => socket.deliver({ requestId: message.requestId, ok: true, result });
        if (message.method === 'engine.capabilities') reply(CAPS);
        else if (message.method === 'session.sync') reply(syncChunk(message.params?.cursor));
        else if (message.method === 'engine.status') {
          if (engine.hold) engine.held.push(message);
          else reply({ device: null, ...engine.status });
        }
      };
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    currentEndpoint: async () => ENDPOINT,
    schedule: scheduler.schedule,
  });
  const store = new TransportStateStore(client);
  client.connect(ENDPOINT);
  return { client, store, sockets, socket: () => sockets[sockets.length - 1]!, scheduler };
}

const event = (seq: number, cycle: boolean, enabled = false, gainMilliDb = -12000) => ({
  schema: 'siann.event.v1',
  seq: String(BASE + seq),
  sessionId: SESSION,
  type: 'transport.changed',
  cycle,
  click: { enabled, gainMilliDb },
});

test('parses engine.status, a method result and the event; anything else is null', () => {
  const state = { cycle: true, click: { enabled: false, gainMilliDb: -12000 } };
  assert.deepEqual(parseTransportState({ device: null, xruns: '0', ...state }), state);
  assert.deepEqual(parseTransportState({ playing: false, position: '0', ...state }), state);
  assert.deepEqual(parseTransportState({ type: 'transport.changed', ...state }), state);
  assert.equal(parseTransportState({ cycle: 'yes', click: state.click }), null);
  assert.equal(parseTransportState({ cycle: true }), null);
  assert.equal(parseTransportState(null), null);
});

test('seeded from engine.status, then kept by transport.changed and by method results', async () => {
  const engine: Engine = { status: { cycle: true, click: { enabled: false, gainMilliDb: -6000 } }, held: [], hold: false };
  const t = connect(engine);
  assert.equal(t.store.getSnapshot(), null);
  await until(() => t.store.getSnapshot() !== null, 'the first engine.status');
  assert.deepEqual(t.store.getSnapshot(), engine.status);
  let notified = 0;
  t.store.subscribe(() => (notified += 1));
  t.socket().deliver(event(1, false, true, -6000));
  await until(() => t.store.getSnapshot()?.cycle === false, 'transport.changed');
  assert.deepEqual(t.store.getSnapshot(), { cycle: false, click: { enabled: true, gainMilliDb: -6000 } });
  t.store.apply({ playing: false, position: '0', cycle: true, click: { enabled: true, gainMilliDb: -24000 } });
  assert.deepEqual(t.store.getSnapshot(), { cycle: true, click: { enabled: true, gainMilliDb: -24000 } });
  // The same state again tells nobody.
  const before = notified;
  t.store.apply({ cycle: true, click: { enabled: true, gainMilliDb: -24000 } });
  assert.equal(notified, before);
});

test('an engine.status asked before a newer event is dropped', async () => {
  const engine: Engine = { status: { cycle: false, click: { enabled: false, gainMilliDb: -12000 } }, held: [], hold: true };
  const t = connect(engine);
  await until(() => engine.held.length === 1, 'engine.status asked');
  t.socket().deliver(event(1, true));
  await until(() => t.store.getSnapshot()?.cycle === true, 'transport.changed');
  // The old answer (cycle off) arrives afterwards.
  t.socket().deliver({ requestId: engine.held[0]!.requestId, ok: true, result: { device: null, ...engine.status } });
  await settle();
  assert.equal(t.store.getSnapshot()?.cycle, true);
});

test('forgotten while the engine is away, read again after a reconnect and after a sync', async () => {
  const engine: Engine = { status: { cycle: false, click: { enabled: false, gainMilliDb: -12000 } }, held: [], hold: false };
  const t = connect(engine);
  await until(() => t.store.getSnapshot() !== null, 'the first engine.status');
  await settle();
  const asked = () => t.sockets.flatMap((s) => s.requests('engine.status')).length;
  const first = asked();
  assert.ok(first >= 1);
  // The engine goes away: unknown.
  engine.status = { cycle: true, click: { enabled: true, gainMilliDb: -3000 } };
  t.socket().serverClose();
  assert.equal(t.store.getSnapshot(), null);
  // It comes back (another state, set while the client was away): read again.
  t.scheduler.fire(250);
  await until(() => t.store.getSnapshot()?.cycle === true, 'the reconnect read');
  assert.deepEqual(t.store.getSnapshot(), engine.status);
  await settle();
  const second = asked();
  assert.ok(second > first);
  // A gap's sync (the events it covered are never handed over): read again.
  engine.status = { cycle: false, click: { enabled: true, gainMilliDb: -3000 } };
  t.socket().deliver({ schema: 'siann.event.v1', seq: String(BASE + 5), sessionId: SESSION, type: 'plan.changed' });
  await until(() => t.store.getSnapshot()?.cycle === false, 'the read after the sync');
  assert.ok(asked() > second);
});

// The session client's test hooks (m5-ui-loop-click): a capabilities answer
// given at construction (SIANN_TEST_CAPABILITIES under SIANN_SHELL_TEST=1)
// replaces the engine's, and answered() logs each answer with its error code.
test('the session client uses the given capabilities in place of the engine\'s and logs every answer', async () => {
  const given = { methods: ['engine.status'], features: {} };
  const client = new SessionClient({
    createSocket: (url) => {
      const s = new FakeSocket(url);
      s.handler = (message) => {
        const reply = (body: Record<string, unknown>) => s.deliver({ requestId: message.requestId, ...body });
        if (message.type === 'auth') s.deliver({ type: 'auth', ok: true, sessionId: SESSION, revision: SEQUENCE.base.revision, seq: SEQUENCE.base.seq });
        else if (message.method === 'engine.capabilities') reply({ ok: true, result: CAPS });
        else if (message.method === 'session.sync') reply({ ok: true, result: syncChunk(message.params?.cursor) });
        else if (message.method === 'command.execute') reply({ ok: false, error: { code: 'invalid_locators', message: 'no' } });
      };
      queueMicrotask(() => s.onopen?.());
      return s;
    },
    currentEndpoint: async () => ENDPOINT,
    schedule: new FakeScheduler().schedule,
    capabilities: given,
  });
  client.connect(ENDPOINT);
  await until(() => client.getState().capabilities !== null, 'capabilities');
  assert.equal(client.getState().capabilities, given);
  await client.execute([{ op: 'session.set_locators', left: '2', right: '1' }]).catch(() => undefined);
  const answers = client.answered();
  assert.equal(answers.find((a) => a.method === 'engine.capabilities')?.code, null);
  assert.deepEqual(
    answers.filter((a) => a.method === 'command.execute').map((a) => a.code),
    ['invalid_locators'],
  );
});
