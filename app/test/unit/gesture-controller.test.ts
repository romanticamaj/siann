// The renderer's fader gesture controller (protocol-gestures-v0.md, "Client
// rules"; spec "Gestures"): the read model's overlay moves at once, the engine
// hears gesture.begin, coalesced gesture.update (at most one in flight),
// gesture.hold at leaseMs / 2 while held still and one gesture.end with the last
// value; the overlay stays until the commit's session.changed applies, and an
// error or a disconnect cancels it. A fake client and a fake scheduler: no
// sockets, no timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionChanged, SyncChunk, TrackEntity } from '../../src/renderer/model/document';
import { GestureController, type GestureClient } from '../../src/renderer/model/gesture-controller';
import { documentHash, entityHash } from '../../src/renderer/model/hash';
import { parseRef } from '../../src/renderer/model/document';
import { ReadModel } from '../../src/renderer/model/read-model';
import { ProtocolError, type ConnectionStatus } from '../../src/renderer/model/session-client';
import { FakeScheduler, settle } from './support/fakes';
import { sequence } from './support/sequence';

const seq = sequence();
const REF = 'track:trk_1';
const TARGET = { ref: REF, param: 'gain' };

interface Call {
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

class FakeClient implements GestureClient {
  readonly model = new ReadModel();
  readonly calls: Call[] = [];
  #status: ConnectionStatus = 'connected';
  readonly #listeners = new Set<() => void>();

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => this.calls.push({ method, params, resolve, reject }));
  }
  getState(): { readonly status: ConnectionStatus } {
    return { status: this.#status };
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  disconnect(): void {
    this.#status = 'disconnected';
    for (const call of this.calls.splice(0)) call.reject(new ProtocolError('disconnected', 'the connection closed'));
    for (const listener of [...this.#listeners]) listener();
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  // The oldest unanswered call; answers it.
  answer(method: string, result: unknown = {}): Call {
    const index = this.calls.findIndex((c) => c.method === method);
    assert.notEqual(index, -1, `a pending ${method}`);
    const [call] = this.calls.splice(index, 1);
    call!.resolve(result);
    return call!;
  }
  fail(method: string, code: string): void {
    const index = this.calls.findIndex((c) => c.method === method);
    assert.notEqual(index, -1, `a pending ${method}`);
    const [call] = this.calls.splice(index, 1);
    call!.reject(new ProtocolError(code, `refused: ${code}`));
  }
}

async function rig(leaseMs = 1000) {
  const client = new FakeClient();
  await client.model.fromSync(seq.sync as unknown as SyncChunk[], seq.sessionId);
  const scheduler = new FakeScheduler();
  const controller = new GestureController({ client, schedule: scheduler.schedule });
  const began = async (ref = REF, field: 'gainMilliDb' | 'pan' = 'gainMilliDb') => {
    controller.begin(ref, field);
    client.answer('gesture.begin', { target: { ref, param: field === 'pan' ? 'pan' : 'gain' }, startValue: 0, leaseMs });
    await settle();
  };
  return { client, scheduler, controller, began };
}

function overlayValue(model: ReadModel): number | null {
  return model.getView().gesture?.value ?? null;
}

test('begin calls model.beginGesture and sends gesture.begin with the target', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  const gesture = client.model.getView().gesture;
  assert.equal(gesture?.ref, REF);
  assert.equal(gesture?.field, 'gainMilliDb');
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.begin', { target: TARGET }]]);
});

test('pan maps to the pan parameter', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'pan');
  assert.deepEqual(client.calls[0]!.params, { target: { ref: REF, param: 'pan' } });
  assert.equal(client.model.getView().gesture?.field, 'pan');
});

test('moves set the overlay at once and coalesce into one update in flight', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  controller.move(-1000);
  controller.move(-2000);
  assert.equal(overlayValue(client.model), -2000);
  assert.equal((client.model.select(REF) as TrackEntity).gainMilliDb, -2000);
  assert.deepEqual(client.methods(), ['gesture.begin']); // the begin is the one request in flight

  client.answer('gesture.begin', { target: TARGET, startValue: 0, leaseMs: 1000 });
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.update', { target: TARGET, value: -2000 }]]);

  for (const value of [-3000, -4000, -5000]) controller.move(value);
  assert.equal(overlayValue(client.model), -5000);
  assert.deepEqual(client.methods(), ['gesture.update']);
  client.answer('gesture.update');
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.update', { target: TARGET, value: -5000 }]]);
  assert.equal(controller.settled, false);
  client.answer('gesture.update');
  await settle();
  assert.deepEqual(client.calls, []);
  assert.equal(controller.settled, true); // the engine holds the newest value
});

test('gesture.hold goes out at leaseMs / 2 while the fader is held still', async () => {
  const { client, scheduler, controller, began } = await rig(1000);
  await began();
  controller.move(-1500);
  client.answer('gesture.update');
  await settle();
  scheduler.fire(500);
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.hold', { target: TARGET }]]);
  client.answer('gesture.hold');
  await settle();
  scheduler.fire(500);
  assert.deepEqual(client.methods(), ['gesture.hold']);
  client.answer('gesture.hold');
  await settle();
  // The end stops the holds.
  controller.end();
  client.answer('gesture.end', { target: TARGET, startValue: 0, value: -1500, revision: { id: 'r9', diff: [REF] } });
  await settle();
  assert.equal(scheduler.pending().length, 0);
});

test('end sends one gesture.end with the last value; the overlay stays until session.changed applies', async () => {
  const { client, controller, began } = await rig();
  await began();
  controller.move(-1000);
  controller.move(-2500); // waits behind the first update
  controller.end();
  assert.deepEqual(client.methods(), ['gesture.update']); // the end waits for the update in flight
  client.answer('gesture.update');
  await settle();
  // The pending move is carried by the end itself.
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.end', { target: TARGET, value: -2500 }]]);
  client.answer('gesture.end', { target: TARGET, startValue: 0, value: -2500, revision: { id: 'r4', diff: [REF] } });
  await settle();
  assert.deepEqual(client.calls, []);
  assert.equal(client.model.getView().gesture?.ended, true);
  assert.equal((client.model.select(REF) as TrackEntity).gainMilliDb, -2500);

  // The commit's session.changed: the overlay goes, the committed value shows.
  const base = client.model.getSnapshot()!;
  const track = { ...(base.entities[REF] as TrackEntity), gainMilliDb: -2500 };
  const hashes = { ...base.entityHashes, [REF]: await entityHash(track) };
  const leaves = Object.entries(hashes).map(([ref, hash]) => ({ ...parseRef(ref)!, entityHash: hash }));
  const event: SessionChanged = {
    seq: String(Number(base.seq) + 1),
    revision: 'r4',
    type: 'session.changed',
    documentHash: await documentHash(leaves),
    changedIds: [{ ref: REF, change: 'modified' }],
  };
  await client.model.applyChanged(event, [{ ref: REF, entity: track }]);
  assert.equal(client.model.getView().gesture, null);
  assert.equal((client.model.select(REF) as TrackEntity).gainMilliDb, -2500);
});

test('an end that commits nothing drops the overlay', async () => {
  const { client, controller, began } = await rig();
  await began();
  controller.move(-1000);
  client.answer('gesture.update');
  await settle();
  controller.end();
  client.answer('gesture.end', { target: TARGET, startValue: 0, value: -1000, revision: null });
  await settle();
  assert.equal(client.model.getView().gesture, null);
});

test('a gesture that never moved ends without a value and leaves no overlay', async () => {
  const { client, controller, began } = await rig();
  await began();
  controller.end();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.end', { target: TARGET }]]);
  assert.equal(client.model.getView().gesture, null);
});

for (const [method, code] of [
  ['gesture.begin', 'gesture_held'],
  ['gesture.update', 'invalid_params'],
  ['gesture.end', 'invalid_gain'],
] as const) {
  test(`a ${code} answer to ${method} cancels the overlay`, async () => {
    const { client, controller } = await rig();
    controller.begin(REF, 'gainMilliDb');
    controller.move(-1000);
    if (method !== 'gesture.begin') {
      client.answer('gesture.begin', { target: TARGET, startValue: 0, leaseMs: 1000 });
      await settle();
    }
    if (method === 'gesture.end') {
      client.answer('gesture.update');
      await settle();
      controller.end();
    }
    client.fail(method, code);
    await settle();
    assert.equal(client.model.getView().gesture, null);
    assert.equal((client.model.select(REF) as TrackEntity).gainMilliDb, 0);
    assert.equal(controller.active, false);
    // A new gesture can begin.
    controller.begin(REF, 'gainMilliDb');
    assert.equal(client.model.getView().gesture?.ref, REF);
  });
}

test('a disconnect cancels the overlay', async () => {
  const { client, controller, began } = await rig();
  await began();
  controller.move(-4000);
  assert.equal(overlayValue(client.model), -4000);
  client.disconnect();
  await settle();
  assert.equal(client.model.getView().gesture, null);
  assert.equal(controller.active, false);
});

test('cancel sends gesture.cancel and drops the overlay', async () => {
  const { client, controller, began } = await rig();
  await began();
  controller.move(-4000);
  client.answer('gesture.update');
  await settle();
  controller.cancel();
  assert.equal(client.model.getView().gesture, null);
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.cancel', { target: TARGET }]]);
});

// The engine holds one gesture per connection and target: a begin sent while an
// earlier gesture's lease is open there is refused with gesture_open. So a new
// gesture waits until the earlier one's end or cancel is on the wire.
test('a keyboard step before the previous step is answered waits behind its end', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  controller.move(-100);
  controller.end();
  // An auto-repeat step before gesture.begin #1 is answered.
  controller.begin(REF, 'gainMilliDb');
  controller.move(-200);
  controller.end();
  assert.deepEqual(client.methods(), ['gesture.begin']); // one begin open on the engine at a time
  assert.equal(overlayValue(client.model), -200);

  client.answer('gesture.begin', { target: TARGET, startValue: 0, leaseMs: 1000 });
  await settle();
  // Step 1's end, then step 2's begin, in that order on the socket.
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [
    ['gesture.end', { target: TARGET, value: -100 }],
    ['gesture.begin', { target: TARGET }],
  ]);
  client.answer('gesture.end', { target: TARGET, startValue: 0, value: -100, revision: { id: 'r5', diff: [REF] } });
  await settle();
  assert.equal(overlayValue(client.model), -200); // step 1's answer leaves step 2's overlay
  client.answer('gesture.begin', { target: TARGET, startValue: -100, leaseMs: 1000 });
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.end', { target: TARGET, value: -200 }]]);
  client.answer('gesture.end', { target: TARGET, startValue: -100, value: -200, revision: { id: 'r6', diff: [REF] } });
  await settle();
  assert.deepEqual(client.calls, []);
  assert.equal(controller.active, false);
});

test('a re-press while the previous gesture still has an update in flight ends that gesture first', async () => {
  const { client, controller, began } = await rig();
  await began();
  controller.move(-1000);
  controller.end(); // waits for the update in flight
  controller.begin(REF, 'gainMilliDb');
  controller.move(-3000);
  assert.deepEqual(client.methods(), ['gesture.update']);
  client.answer('gesture.update');
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [
    ['gesture.end', { target: TARGET, value: -1000 }],
    ['gesture.begin', { target: TARGET }],
  ]);
});

test('a gesture superseded while its begin is in flight is cancelled once the begin is answered', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  controller.move(-1000);
  controller.begin(REF, 'pan'); // no end: the first gesture is abandoned
  assert.deepEqual(client.methods(), ['gesture.begin']);
  assert.equal(client.model.getView().gesture?.field, 'pan');
  client.answer('gesture.begin', { target: TARGET, startValue: 0, leaseMs: 1000 });
  await settle();
  // The late answer opened a lease: it is cancelled, then the next begin goes out.
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [
    ['gesture.cancel', { target: TARGET }],
    ['gesture.begin', { target: { ref: REF, param: 'pan' } }],
  ]);
  assert.equal(client.model.getView().gesture?.field, 'pan');
});

test('cancel while the begin is in flight sends gesture.cancel once the begin is answered', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  controller.cancel();
  assert.equal(client.model.getView().gesture, null);
  assert.deepEqual(client.methods(), ['gesture.begin']);
  client.answer('gesture.begin', { target: TARGET, startValue: 0, leaseMs: 1000 });
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.cancel', { target: TARGET }]]);
});

test('a refused begin lets the gesture waiting behind it begin', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  controller.move(-100);
  controller.end();
  controller.begin(REF, 'gainMilliDb');
  controller.move(-200);
  controller.end();
  client.fail('gesture.begin', 'gesture_held');
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.begin', { target: TARGET }]]);
  assert.equal(overlayValue(client.model), -200);
  client.answer('gesture.begin', { target: TARGET, startValue: 0, leaseMs: 1000 });
  await settle();
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['gesture.end', { target: TARGET, value: -200 }]]);
});

test('a disconnect while a gesture waits drops it without sending its begin', async () => {
  const { client, controller } = await rig();
  controller.begin(REF, 'gainMilliDb');
  controller.end();
  controller.begin(REF, 'gainMilliDb');
  controller.move(-200);
  client.disconnect();
  await settle();
  assert.equal(controller.active, false);
  assert.equal(client.model.getView().gesture, null);
  assert.deepEqual(client.calls, []);
});
