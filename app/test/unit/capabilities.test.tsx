// The capability rule of UI redesign spec 3.0 (m5-ui-shell): a control whose
// method or feature engine.capabilities does not list is not rendered. The
// selector answers has(method) and feature(name) over the engine's reply
// (fixtures copied from the protocol server's capabilitiesJson: the full one,
// and a reduced one without the plan actions, proposals and gestures);
// Capable renders its children only when the method is listed, and nothing
// while the capabilities are unknown. The session client asks for
// engine.capabilities once per connection after auth and keeps the last
// known value across a reconnect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { SessionClient } from '../../src/renderer/model/session-client';
import { Capable, CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { FakeScheduler, FakeSocket, until } from './support/fakes';

// dist/test/unit -> app/test/unit/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

test('has(method) and feature(name) over the full and the reduced capabilities', () => {
  const full = capabilitySelector(FULL);
  const reduced = capabilitySelector(REDUCED);
  for (const method of ['plan.approve', 'plan.apply', 'plan.propose', 'audition.hear', 'proposal.merge', 'gesture.begin']) {
    assert.equal(full.has(method), true, method);
    assert.equal(reduced.has(method), false, method);
  }
  assert.equal(reduced.has('plan.reject'), true);
  assert.equal(full.has('transport.set_cycle'), false, 'a method no engine lists yet');
  assert.equal(full.feature('gestures'), true);
  assert.equal(reduced.feature('gestures'), false);
  assert.equal(full.feature('plugins'), false, 'false is absent');
  assert.equal(capabilitySelector({ ...FULL, features: { plugins: { formats: ['clap'], flags: [] } } }).feature('plugins'), true);
  assert.equal(full.feature('locators'), false);
  const none = capabilitySelector(null);
  assert.equal(none.has('engine.about'), false);
  assert.equal(none.feature('plans'), false);
});

test('Capable renders nothing for an absent method and while the capabilities are unknown', () => {
  const render = (caps: Capabilities | null, method: string) =>
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={caps}>
        <Capable method={method}>
          <button type="button" data-testid="control" />
        </Capable>
      </CapabilitiesContext.Provider>,
    );
  assert.equal(render(FULL, 'plan.approve'), '<button type="button" data-testid="control"></button>');
  assert.equal(render(REDUCED, 'plan.approve'), '');
  assert.equal(render(null, 'plan.approve'), '');
  assert.equal(render(REDUCED, 'plan.reject'), '<button type="button" data-testid="control"></button>');
});

// The engine's side: auth, then engine.capabilities from `answer`; nothing else is answered.
function engine(socket: FakeSocket, answer: () => Record<string, unknown>) {
  socket.handler = (message) => {
    if (message.type === 'auth') {
      queueMicrotask(() =>
        socket.deliver({ type: 'auth', ok: true, sessionId: 'ses_0000000000000001', revision: 'r1', seq: '1', meters: null, about: FULL.about }),
      );
      return;
    }
    if (message.method === 'engine.capabilities') {
      queueMicrotask(() => socket.deliver({ requestId: message.requestId, ...answer() }));
    }
  };
}

test('the session client asks for engine.capabilities once per connection and keeps the last value across a reconnect', async () => {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  let reply: Record<string, unknown> = { ok: true, result: FULL };
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      engine(socket, () => reply);
      sockets.push(socket);
      return socket;
    },
    currentEndpoint: async () => ({ port: 1, token: 'tok' }),
    schedule: scheduler.schedule,
  });
  assert.equal(client.getState().capabilities, null);
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => client.getState().capabilities !== null, 'the capabilities');
  assert.deepEqual(client.getState().capabilities, FULL);
  assert.equal(sockets[0]!.requests('engine.capabilities').length, 1);

  // The engine goes away and comes back: the last value stays until the new one.
  sockets[0]!.serverClose();
  assert.equal(client.getState().status, 'disconnected');
  assert.deepEqual(client.getState().capabilities, FULL, 'kept while disconnected');
  reply = { ok: true, result: REDUCED };
  scheduler.fire(250);
  await until(() => sockets.length === 2, 'the reconnect');
  const second = sockets[1]!;
  second.onopen?.();
  await until(() => client.getState().status === 'connected', 'connected again');
  await until(() => client.getState().capabilities?.methods?.length === REDUCED.methods?.length, 'the new value');
  assert.deepEqual(client.getState().capabilities, REDUCED);
  assert.equal(second.requests('engine.capabilities').length, 1, 'once per connection');

  // A refused request keeps the last known value.
  reply = { ok: false, error: { code: 'internal_error', message: 'no' } };
  second.serverClose();
  scheduler.fire(250);
  await until(() => sockets.length === 3, 'the second reconnect');
  sockets[2]!.onopen?.();
  await until(() => sockets[2]!.requests('engine.capabilities').length === 1, 'asked on the third connection');
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(client.getState().capabilities, REDUCED);
});
