// What the status bar shows of engine.status (UI redesign spec 2.1, "Status
// bar": device and latency, xruns; 3.0: "the status bar shows xruns, which
// engine.status has"). The EngineStatusStore asks engine.status once the
// client is connected and engine.capabilities lists the method, then again
// every ENGINE_STATUS_POLL_MS on the injected scheduler; it forgets the
// answer when the engine goes away, and never asks an engine that does not
// list the method. statusFields words what it holds: the device id (or the
// device error's code, or none), the input and output latency in ms, and the
// xrun count exactly as the engine reports it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translator } from '../../src/renderer/i18n/t';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { ENGINE_STATUS_POLL_MS, EngineStatusStore, parseEngineLoad, parseEngineStatus, statusFields } from '../../src/renderer/model/engine-status';
import { SessionClient } from '../../src/renderer/model/session-client';
import { FakeScheduler, FakeSocket, settle, until } from './support/fakes';

const WITH_STATUS: Capabilities = { methods: ['engine.capabilities', 'engine.status'], features: {} };
const WITHOUT_STATUS: Capabilities = { methods: ['engine.capabilities'], features: {} };

function device(xruns: string) {
  return {
    device: { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 240, outputLatencyFrames: 480 },
    playing: false,
    xruns,
    maxCallbackMicros: 0,
    unmeasuredCallbacks: '0',
    underruns: '0',
    srcUnderruns: '0',
    plugins: [],
  };
}

function engine(socket: FakeSocket, capabilities: Capabilities, status: () => unknown) {
  socket.handler = (message) => {
    if (message.type === 'auth') {
      queueMicrotask(() => socket.deliver({ type: 'auth', ok: true, sessionId: 'ses_0000000000000001', revision: 'r1', seq: '1', meters: null }));
      return;
    }
    if (message.method === 'engine.capabilities') queueMicrotask(() => socket.deliver({ requestId: message.requestId, ok: true, result: capabilities }));
    if (message.method === 'engine.status') queueMicrotask(() => socket.deliver({ requestId: message.requestId, ok: true, result: status() }));
  };
}

function setup(capabilities: Capabilities) {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  let xruns = 0;
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      engine(socket, capabilities, () => device(String(xruns)));
      sockets.push(socket);
      return socket;
    },
    currentEndpoint: async () => ({ port: 1, token: 'tok' }),
    schedule: scheduler.schedule,
  });
  const store = new EngineStatusStore({ client, schedule: scheduler.schedule });
  return { scheduler, sockets, client, store, bump: () => (xruns += 1) };
}

test('engine.status is asked once connected, polled on the scheduler, and forgotten when the engine goes away', async () => {
  const { scheduler, sockets, client, store, bump } = setup(WITH_STATUS);
  assert.equal(store.getSnapshot(), null);
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => store.getSnapshot() !== null, 'the first engine.status');
  assert.equal(store.getSnapshot()?.xruns, '0');
  assert.equal(store.getSnapshot()?.device?.id, 'fake');
  assert.equal(sockets[0]!.requests('engine.status').length, 1);

  bump();
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => store.getSnapshot()?.xruns === '1', 'the polled engine.status');
  assert.equal(sockets[0]!.requests('engine.status').length, 2);

  sockets[0]!.serverClose();
  assert.equal(store.getSnapshot(), null, 'unknown while disconnected');
  assert.equal(
    scheduler.pending().filter((timer) => timer.ms === ENGINE_STATUS_POLL_MS).length,
    0,
    'no poll is left scheduled for the old engine',
  );
  store.destroy();
});

// m5-ui-mixer (UI redesign spec 5.6): zero React commits while playing with
// no edits, so a poll whose answer reads the same keeps the snapshot and
// tells no listener.
test('a poll that answers the same values keeps the snapshot and notifies nobody', async () => {
  const { scheduler, sockets, client, store, bump } = setup(WITH_STATUS);
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => store.getSnapshot() !== null, 'the first engine.status');
  const first = store.getSnapshot();
  let heard = 0;
  store.subscribe(() => (heard += 1));
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => sockets[0]!.requests('engine.status').length === 2, 'the second poll');
  await settle();
  assert.equal(store.getSnapshot(), first, 'the same object');
  assert.equal(heard, 0);
  bump();
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => store.getSnapshot()?.xruns === '1', 'a changed answer');
  assert.equal(heard, 1);
  store.destroy();
});

test('an engine whose capabilities do not list engine.status is never asked', async () => {
  const { sockets, client, store } = setup(WITHOUT_STATUS);
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => client.getState().capabilities !== null, 'the capabilities');
  await settle();
  assert.equal(sockets[0]!.requests('engine.status').length, 0);
  assert.equal(store.getSnapshot(), null);
  store.destroy();
});

// The mockup's device segment (UI redesign 2.1, 10.7, 1): "type · name · kHz /
// buffer · latency ms", one latency, the round trip (input plus output).
const SCARLETT = {
  device: { id: 'ASIO/Scarlett 4i4', sampleRate: 48000, bufferFrames: 128, inputLatencyFrames: 128, outputLatencyFrames: 128 },
  xruns: '0',
};

test('statusFields words the device as the mockup does, in every locale', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    // (128 + 128) frames at 48 kHz: 5.333 ms, one decimal.
    assert.deepEqual(statusFields(parseEngineStatus(SCARLETT), t), {
      type: 'ASIO',
      name: 'Scarlett 4i4',
      rate: '48 kHz',
      buffer: '128',
      latency: '5.3 ms',
      xruns: '0',
    }, locale);
    // 44.1 kHz keeps its decimal; 240 + 480 frames at 44.1 kHz is 16.3 ms.
    const cd = statusFields(parseEngineStatus({ ...SCARLETT, device: { ...SCARLETT.device, sampleRate: 44100, inputLatencyFrames: 240, outputLatencyFrames: 480 } }), t);
    assert.equal(cd.rate, '44.1 kHz', locale);
    assert.equal(cd.latency, '16.3 ms', locale);
    // An id without a slash is shown once, as the name.
    const fake = statusFields(parseEngineStatus(device('7')), t);
    assert.deepEqual(fake, { type: null, name: 'fake', rate: '48 kHz', buffer: '256', latency: '15.0 ms', xruns: '7' }, locale);
    // Only the first slash separates: a name may hold one.
    assert.equal(statusFields(parseEngineStatus({ ...SCARLETT, device: { ...SCARLETT.device, id: 'Windows Audio/Speakers / Headphones' } }), t).name, 'Speakers / Headphones');
    // No device: the device error's code, or the catalog's "no device"; nothing else.
    const none = statusFields(parseEngineStatus({ device: null, deviceError: { code: 'device_lost', message: 'gone' }, xruns: '3' }), t);
    assert.deepEqual(none, { type: null, name: 'device_lost', rate: '', buffer: '', latency: '', xruns: '3' }, locale);
    const unknown = statusFields(parseEngineStatus({ device: null, xruns: '0' }), t);
    assert.equal(unknown.name, t('status.noDevice'), locale);
    assert.equal(unknown.type, null);
  }
  assert.equal(parseEngineStatus('nonsense'), null);
  assert.equal(parseEngineStatus(SCARLETT)?.device?.bufferFrames, 128);
});

// m5b-ui-inserts-master: a slot shows its plugin's state with the engine's
// code (docs/schemas/protocol-plugins-v0.md, "engine.status plugins[]").
const PLUGINS = [
  { slotId: 'slt_1', trackId: 'trk_1', format: 'clap', uid: 'org.siann.test-plugin', state: 'running', capabilities: {}, latencyFrames: 64, tailFrames: 0, callbacks: '1', xruns: '0' },
  { slotId: 'slt_2', trackId: 'trk_1', format: 'clap', uid: 'org.x', state: 'missing', error: { code: 'plugin_not_approved', message: 'not approved' }, capabilities: null },
  { slotId: 'slt_3', busId: 'bus_1', format: 'clap', uid: 'org.y', state: 'running', error: { code: 'state_missing', message: 'default state' } },
  { slotId: 42, state: 'running' },
];

test('engine.status plugins[] by slot: state, owner and the error code and message', async () => {
  const status = parseEngineStatus({ ...SCARLETT, plugins: PLUGINS })!;
  assert.deepEqual(status.plugins.map((p) => p.slotId), ['slt_1', 'slt_2', 'slt_3'], 'a row without a string slotId is dropped');
  assert.deepEqual(status.plugins[0], { slotId: 'slt_1', trackId: 'trk_1', busId: null, format: 'clap', uid: 'org.siann.test-plugin', state: 'running', error: null });
  assert.deepEqual(status.plugins[1]!.error, { code: 'plugin_not_approved', message: 'not approved' });
  assert.equal(status.plugins[1]!.state, 'missing');
  assert.equal(status.plugins[2]!.busId, 'bus_1');
  assert.deepEqual(parseEngineStatus(SCARLETT)!.plugins, [], 'none without the field');

  // The store answers by slot id.
  const { sockets, client, store } = setup(WITH_STATUS);
  assert.equal(store.plugin('slt_1'), null, 'unknown before the first answer');
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => store.getSnapshot() !== null, 'the first engine.status');
  assert.equal(store.plugin('slt_1'), null, 'an engine.status without the slot');
  store.destroy();
  const withSlots = parseEngineStatus({ ...device('0'), plugins: PLUGINS })!;
  const lookup = new EngineStatusStore({ client, schedule: () => () => undefined });
  (lookup as unknown as { getSnapshot: () => unknown }).getSnapshot = () => withSlots;
  assert.equal(lookup.plugin('slt_2')?.error?.code, 'plugin_not_approved');
  assert.equal(lookup.plugin('slt_9'), null);
  lookup.destroy();
});

// m5b-ui-meter (UR-14, acceptance 1; protocol-engine-v0.md: load {average,
// peak}): the DSP load changes every poll, so it stays out of the snapshot
// React reads (spec 5.6: no commit while playing) and is published on a
// channel of its own, only to an engine that lists features.load.
const WITH_LOAD: Capabilities = { methods: ['engine.capabilities', 'engine.status'], features: { load: true } };

function loadSetup(capabilities: Capabilities) {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  const answer: { load: unknown } = { load: { average: 0.12, peak: 0.31 } };
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      engine(socket, capabilities, () => ({ ...device('0'), ...(answer.load === undefined ? {} : { load: answer.load }) }));
      sockets.push(socket);
      return socket;
    },
    currentEndpoint: async () => ({ port: 1, token: 'tok' }),
    schedule: scheduler.schedule,
  });
  const store = new EngineStatusStore({ client, schedule: scheduler.schedule });
  return { scheduler, sockets, client, store, answer };
}

test('parseEngineLoad reads load {average, peak}, and nothing else', () => {
  assert.deepEqual(parseEngineLoad({ load: { average: 0.12, peak: 0.31 } }), { average: 0.12, peak: 0.31 });
  assert.deepEqual(parseEngineLoad({ load: { average: 1.4, peak: 2 } }), { average: 1.4, peak: 2 }, 'past the deadline is kept');
  assert.equal(parseEngineLoad({ load: null }), null);
  assert.equal(parseEngineLoad({ xruns: '0' }), null, 'no field');
  assert.equal(parseEngineLoad({ load: { average: 'x', peak: 0 } }), null);
  assert.equal(parseEngineLoad({ load: { average: 0.1 } }), null);
  assert.equal(parseEngineLoad('nonsense'), null);
  // The snapshot does not carry it.
  assert.ok(!('load' in (parseEngineStatus({ ...device('0'), load: { average: 0.1, peak: 0.2 } }) as object)));
});

test('the store publishes the load on its own channel, and a poll that changes only the load tells no snapshot listener', async () => {
  const { scheduler, sockets, client, store, answer } = loadSetup(WITH_LOAD);
  assert.equal(store.getLoad(), null);
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => store.getLoad() !== null, 'the first load');
  assert.deepEqual(store.getLoad(), { average: 0.12, peak: 0.31 });
  const snapshot = store.getSnapshot();
  let snapshots = 0;
  let loads = 0;
  store.subscribe(() => (snapshots += 1));
  const off = store.subscribeLoad(() => (loads += 1));
  answer.load = { average: 0.5, peak: 0.75 };
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => store.getLoad()?.average === 0.5, 'the polled load');
  await settle();
  assert.equal(loads, 1);
  assert.equal(snapshots, 0, 'the zero-commit rule: the snapshot did not change');
  assert.equal(store.getSnapshot(), snapshot);
  // The same load again: nobody is told.
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => sockets[0]!.requests('engine.status').length === 3, 'the third poll');
  await settle();
  assert.equal(loads, 1);
  // A poll without the field: the load is unknown.
  answer.load = undefined;
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => store.getLoad() === null, 'no load field');
  assert.equal(loads, 2);
  // Gone with the engine.
  answer.load = { average: 0.2, peak: 0.3 };
  scheduler.fire(ENGINE_STATUS_POLL_MS);
  await until(() => store.getLoad() !== null, 'the load again');
  sockets[0]!.serverClose();
  assert.equal(store.getLoad(), null, 'unknown while disconnected');
  off();
  store.destroy();
});

test('without features.load the store publishes no load, though engine.status answers one', async () => {
  const { sockets, client, store } = loadSetup(WITH_STATUS);
  let loads = 0;
  store.subscribeLoad(() => (loads += 1));
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => store.getSnapshot() !== null, 'the first engine.status');
  await settle();
  assert.equal(store.getLoad(), null);
  assert.equal(loads, 0);
  store.destroy();
});
