// The renderer's peak pyramid cache (docs/schemas/protocol-peaks-v0.md): one
// GET /v0/peaks/<hex> per contentHash with the UI token, a 202 retried under
// the session client's sync backoff (SYNC_RETRY_MS doubling up to
// SYNC_RETRY_MAX_MS), a 200 decoded once and kept. An injected fetch and
// scheduler: no network, no timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PeaksCache, type FetchLike } from '../../src/renderer/model/peaks-cache';
import { SYNC_RETRY_MAX_MS, SYNC_RETRY_MS } from '../../src/renderer/model/session-client';
import { readFixtureBytes } from './support/fixtures';

const HEX = 'ab'.repeat(32);
const HASH = `sha256:${HEX}`;

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly answer: (status: number, body?: Uint8Array | object) => void;
  readonly fail: (error: Error) => void;
}

function rig(endpoint: { port: number; token: string } | null = { port: 4321, token: 'tok' }) {
  const calls: Call[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean; fired: boolean }> = [];
  const fetch: FetchLike = (url, init) =>
    new Promise((resolve, reject) => {
      calls.push({
        url,
        headers: init.headers,
        answer: (status, body) => {
          const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body ?? {}));
          resolve({
            status,
            arrayBuffer: async () => bytes.slice().buffer,
            json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
          });
        },
        fail: reject,
      });
    });
  let current = endpoint;
  const cache = new PeaksCache({
    fetch,
    endpoint: () => current,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  let notified = 0;
  cache.subscribe(() => {
    notified += 1;
  });
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const fire = (ms: number) => {
    const due = pending().filter((t) => t.ms === ms);
    assert.equal(due.length, 1, `one pending ${ms} ms timer, have ${pending().map((t) => t.ms).join(', ')}`);
    due[0]!.fired = true;
    due[0]!.fn();
  };
  return { cache, calls, pending, fire, notified: () => notified, setEndpoint: (e: typeof endpoint) => (current = e) };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a pyramid is fetched once with the token and decoded', async () => {
  const r = rig();
  assert.equal(r.cache.get(HASH), null);
  assert.equal(r.cache.get(HASH), null);
  assert.equal(r.calls.length, 1, 'one request per hash');
  assert.equal(r.calls[0]!.url, `http://127.0.0.1:4321/v0/peaks/${HEX}`);
  assert.equal(r.calls[0]!.headers.Authorization, 'Bearer tok');
  r.calls[0]!.answer(200, readFixtureBytes('peaks', 'square-mono.peaks'));
  await turn();
  await turn();
  const pyramid = r.cache.get(HASH);
  assert.ok(pyramid);
  assert.equal(pyramid.frames, 5000);
  assert.equal(r.cache.state(HASH), 'ready');
  assert.ok(r.notified() >= 1);
  assert.equal(r.calls.length, 1, 'kept, not fetched again');
});

test('a 202 is retried under the sync backoff until it is 200', async () => {
  const r = rig();
  r.cache.get(HASH);
  r.calls[0]!.answer(202, { ok: false, error: { code: 'peaks_pending' } });
  await turn();
  assert.equal(r.cache.state(HASH), 'pending');
  r.fire(SYNC_RETRY_MS);
  assert.equal(r.calls.length, 2);
  r.calls[1]!.answer(202, { ok: false, error: { code: 'peaks_pending' } });
  await turn();
  r.fire(SYNC_RETRY_MS * 2);
  r.calls[2]!.answer(202, { ok: false, error: { code: 'peaks_pending' } });
  await turn();
  r.fire(SYNC_RETRY_MS * 4);
  r.calls[3]!.answer(200, readFixtureBytes('peaks', 'silence-mono.peaks'));
  await turn();
  await turn();
  assert.equal(r.cache.state(HASH), 'ready');
  assert.equal(r.pending().length, 0);
});

test('the backoff stops doubling at the sync maximum', async () => {
  const r = rig();
  r.cache.get(HASH);
  let delay = SYNC_RETRY_MS;
  for (let i = 0; i < 8; i += 1) {
    r.calls[i]!.answer(202, { ok: false, error: { code: 'peaks_pending' } });
    await turn();
    r.fire(delay);
    delay = Math.min(delay * 2, SYNC_RETRY_MAX_MS);
  }
  assert.equal(delay, SYNC_RETRY_MAX_MS);
});

test('a 404 is a failure with its code and is not retried', async () => {
  const r = rig();
  r.cache.get(HASH);
  r.calls[0]!.answer(404, { ok: false, error: { code: 'media_missing' } });
  await turn();
  await turn();
  assert.equal(r.cache.state(HASH), 'failed');
  assert.equal(r.cache.error(HASH), 'media_missing');
  assert.equal(r.pending().length, 0);
  assert.equal(r.cache.get(HASH), null);
  assert.equal(r.calls.length, 1);
});

test('bytes that do not decode are a failure', async () => {
  const r = rig();
  r.cache.get(HASH);
  r.calls[0]!.answer(200, new Uint8Array([1, 2, 3]));
  await turn();
  await turn();
  assert.equal(r.cache.state(HASH), 'failed');
  assert.equal(r.cache.error(HASH), 'decode_failed');
});

test('a network error (an engine restarting) is retried under the backoff', async () => {
  const r = rig();
  r.cache.get(HASH);
  r.calls[0]!.fail(new TypeError('Failed to fetch'));
  await turn();
  assert.equal(r.cache.state(HASH), 'pending');
  r.fire(SYNC_RETRY_MS);
  assert.equal(r.calls.length, 2);
});

test('without an engine nothing is fetched until one is announced', async () => {
  const r = rig(null);
  assert.equal(r.cache.get(HASH), null);
  assert.equal(r.calls.length, 0);
  r.setEndpoint({ port: 9, token: 't2' });
  r.cache.endpointChanged();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.url, `http://127.0.0.1:9/v0/peaks/${HEX}`);
  assert.equal(r.calls[0]!.headers.Authorization, 'Bearer t2');
});

test('a hash that is not sha256:<64 hex> is refused without a request', () => {
  const r = rig();
  assert.equal(r.cache.get('sha256:XYZ'), null);
  assert.equal(r.cache.get(HEX), null);
  assert.equal(r.calls.length, 0);
  assert.equal(r.cache.state('sha256:XYZ'), 'failed');
});
