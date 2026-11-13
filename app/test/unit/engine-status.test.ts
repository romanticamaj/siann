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
import { ENGINE_STATUS_POLL_MS, EngineStatusStore, parseEngineStatus, statusFields } from '../../src/renderer/model/engine-status';
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

test('statusFields words the device, the latency in ms and the xruns', () => {
  const t = translator('en');
  const shown = statusFields(parseEngineStatus(device('7')), t);
  assert.deepEqual(shown, { device: 'fake', latency: '5.0 / 10.0 ms', xruns: '7' });
  const none = statusFields(parseEngineStatus({ device: null, deviceError: { code: 'device_lost', message: 'gone' }, xruns: '3' }), t);
  assert.deepEqual(none, { device: 'device_lost', latency: '', xruns: '3' });
  const unknown = statusFields(parseEngineStatus({ device: null, xruns: '0' }), t);
  assert.equal(unknown.device, t('status.noDevice'));
  assert.equal(parseEngineStatus('nonsense'), null);
});
