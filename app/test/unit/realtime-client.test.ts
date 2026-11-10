// The renderer's realtime channel client (protocol-events-v1.md, "Realtime
// channel" and "meters.legend"): it authenticates with the session's token on
// /v1/realtime, decodes binary meter frames with the legend the SessionClient
// holds (auth reply, sync chunk, meters.legend events), keeps the newest
// reading per entity, ignores frames of another epoch, follows the command
// socket's reconnects, and notifies plain subscribers (no React). Fake sockets
// and a fake scheduler; frames come from fixtures/protocol/meter-frames.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SyncChunk } from '../../src/renderer/model/document';
import { RealtimeClient } from '../../src/renderer/model/realtime-client';
import { SessionClient, type EngineEndpoint } from '../../src/renderer/model/session-client';
import { FakeScheduler, FakeSocket, hexBytes, until, type Message } from './support/fakes';
import { readFixture } from './support/fixtures';
import { sequence } from './support/sequence';

const seq = sequence();
const frames = readFixture<{ meterFrames: Array<{ name: string; hex: string }> }>('protocol', 'meter-frames.json')
  .meterFrames;
const STEREO = hexBytes(frames[0]!.hex); // epoch 3: entity 0 [0.5, 0.25], entity 1 [1, 0.75]
const EPOCH_1 = hexBytes(frames[1]!.hex); // epoch 1, no entries

// The stereo frame cut to its first entry (entity 0) with new peaks.
function firstEntryOnly(peakLeft: number): Uint8Array {
  const out = STEREO.slice(0, 32 + 3 + 16);
  const view = new DataView(out.buffer);
  view.setUint16(30, 1, true);
  view.setFloat32(35, peakLeft, true);
  return out;
}

const LEGEND_3 = { epoch: '3', entities: ['master', 'track:trk_1'] };

interface Rig {
  session: SessionClient;
  realtime: RealtimeClient;
  scheduler: FakeScheduler;
  command: FakeSocket[];
  meters: FakeSocket[];
  script: { authMeters: unknown; syncMeters: unknown };
}

function rig(): Rig {
  const scheduler = new FakeScheduler();
  const command: FakeSocket[] = [];
  const meters: FakeSocket[] = [];
  const script = { authMeters: LEGEND_3 as unknown, syncMeters: LEGEND_3 as unknown };
  const endpoint: EngineEndpoint = { port: 4711, token: 'tok' };
  const serve = (socket: FakeSocket) => {
    let pinned: SyncChunk[] = [];
    socket.handler = (message: Message) => {
      const reply = (body: Message) => queueMicrotask(() => socket.deliver({ requestId: message.requestId, ...body }));
      if (message.type === 'auth') {
        queueMicrotask(() =>
          socket.deliver({
            type: 'auth',
            ok: true,
            sessionId: seq.sessionId,
            revision: seq.base.revision,
            documentHash: seq.base.documentHash,
            seq: seq.base.seq,
            meters: script.authMeters,
          }),
        );
        return;
      }
      if (message.method === 'session.sync') {
        const cursor = message.params?.cursor as string | undefined;
        if (!cursor) pinned = (seq.sync as unknown as SyncChunk[]).map((c) => ({ ...c, meters: script.syncMeters }));
        const index = cursor ? pinned.findIndex((_, i) => i > 0 && pinned[i - 1]!.next === cursor) : 0;
        reply({ ok: true, result: pinned[index] as unknown as Message });
      }
    };
  };
  const session = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      command.push(socket);
      serve(socket);
      return socket;
    },
    currentEndpoint: async () => endpoint,
    schedule: scheduler.schedule,
  });
  const realtime = new RealtimeClient({
    session,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      meters.push(socket);
      return socket;
    },
  });
  return { session, realtime, scheduler, command, meters, script };
}

async function connected(r: Rig): Promise<FakeSocket> {
  r.session.connect({ port: 4711, token: 'tok' });
  r.command[r.command.length - 1]!.onopen?.();
  await until(() => r.session.model.getSnapshot() !== null, 'the first sync');
  await until(() => r.meters.length > 0, 'the realtime socket');
  const socket = r.meters[r.meters.length - 1]!;
  socket.onopen?.();
  return socket;
}

test('authenticates with the token on ws://127.0.0.1:<port>/v1/realtime and asks for array buffers', async () => {
  const r = rig();
  const socket = await connected(r);
  assert.equal(socket.url, 'ws://127.0.0.1:4711/v1/realtime');
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.deepEqual(socket.sent, [{ type: 'auth', token: 'tok' }]);
});

test('the legend comes from the session client: auth reply, sync chunk and meters.legend events', async () => {
  const r = rig();
  r.script.authMeters = { epoch: '2', entities: ['master'] };
  r.script.syncMeters = LEGEND_3;
  r.session.connect({ port: 4711, token: 'tok' });
  const commandSocket = r.command[0]!;
  commandSocket.onopen?.();
  await until(() => r.session.getState().status === 'connected', 'connected');
  // The auth reply's legend first, then the sync's.
  await until(() => r.session.model.getSnapshot() !== null, 'the sync');
  assert.deepEqual(r.session.getState().legend, LEGEND_3);
  assert.deepEqual(r.realtime.legend(), LEGEND_3);

  const next = { epoch: '5', entities: ['master', 'track:trk_1', 'track:trk_2'] };
  commandSocket.deliver({
    schema: 'siann.event.v1',
    seq: String(Number(seq.base.seq) + 1),
    sessionId: seq.sessionId,
    revision: seq.base.revision,
    type: 'meters.legend',
    ...next,
  });
  await until(() => r.session.getState().legend?.epoch === '5', 'the meters.legend event');
  assert.deepEqual(r.session.getState().legend, next);
  assert.equal(r.session.getState().lastSeq, String(Number(seq.base.seq) + 1));
});

test('an auth reply legend is held before any sync', async () => {
  const r = rig();
  r.session.connect({ port: 4711, token: 'tok' });
  r.command[0]!.onopen?.();
  await until(() => r.session.getState().status === 'connected', 'connected');
  assert.deepEqual(r.session.getState().legend, LEGEND_3);
});

test('keeps the newest reading per entity and notifies subscribers', async () => {
  const r = rig();
  const socket = await connected(r);
  let notified = 0;
  const unsubscribe = r.realtime.subscribe(() => {
    notified += 1;
  });
  assert.equal(r.realtime.meter('master'), null);

  socket.deliverBinary(STEREO);
  assert.equal(notified, 1);
  assert.equal(r.realtime.frameCount(), 1);
  assert.equal(r.realtime.latest()?.entries.length, 2);
  assert.equal(r.realtime.latest()?.playheadSamples, '96000');
  assert.deepEqual(r.realtime.meter('master')?.peak, [0.5, 0.25]);
  assert.deepEqual(r.realtime.meter('track:trk_1')?.peak, [1, 0.75]);
  assert.deepEqual(r.realtime.meter('track:trk_1')?.rms, [0.5, 0.0625]);

  // A frame carrying only the master: the track keeps its last reading.
  socket.deliverBinary(firstEntryOnly(0.125));
  assert.equal(notified, 2);
  assert.deepEqual(r.realtime.meter('master')?.peak, [0.125, 0.25]);
  assert.deepEqual(r.realtime.meter('track:trk_1')?.peak, [1, 0.75]);
  assert.equal(r.realtime.meter('track:trk_nope'), null);

  unsubscribe();
  socket.deliverBinary(STEREO);
  assert.equal(notified, 2);
});

test('ignores a frame whose epoch is not the legend’s, a malformed frame and text', async () => {
  const r = rig();
  const socket = await connected(r);
  socket.deliverBinary(EPOCH_1);
  socket.deliverBinary(new Uint8Array([1, 2, 3]));
  socket.deliver({ type: 'auth' });
  assert.equal(r.realtime.frameCount(), 0);
  assert.equal(r.realtime.latest(), null);
  assert.equal(r.realtime.meter('master'), null);
  socket.deliverBinary(STEREO);
  assert.equal(r.realtime.frameCount(), 1);
});

test('a new legend epoch drops the readings of the old one', async () => {
  const r = rig();
  const socket = await connected(r);
  socket.deliverBinary(STEREO);
  r.command[0]!.deliver({
    schema: 'siann.event.v1',
    seq: String(Number(seq.base.seq) + 1),
    sessionId: seq.sessionId,
    revision: seq.base.revision,
    type: 'meters.legend',
    epoch: '4',
    entities: ['master'],
  });
  await until(() => r.session.getState().legend?.epoch === '4', 'the new legend');
  assert.equal(r.realtime.meter('master'), null);
  socket.deliverBinary(STEREO); // epoch 3
  assert.equal(r.realtime.meter('master'), null);
});

test('reconnects with the command socket and closes with it', async () => {
  const r = rig();
  const first = await connected(r);
  first.deliverBinary(STEREO);

  r.command[0]!.serverClose();
  assert.equal(first.closedByClient, true);
  assert.equal(r.realtime.latest(), null);
  assert.equal(r.meters.length, 1);

  r.scheduler.fire(250); // the session client's reconnect
  await until(() => r.command.length === 2, 'a new command socket');
  r.command[1]!.onopen?.();
  await until(() => r.meters.length === 2, 'a new realtime socket');
  const second = r.meters[1]!;
  second.onopen?.();
  assert.deepEqual(second.sent, [{ type: 'auth', token: 'tok' }]);
  second.deliverBinary(STEREO);
  assert.equal(r.realtime.latest()?.epoch, '3');

  // close() lets go of the realtime socket for good.
  r.realtime.close();
  assert.equal(second.closedByClient, true);
  r.session.connect({ port: 4711, token: 'tok' }, true);
  r.command[2]!.onopen?.();
  await until(() => r.session.getState().status === 'connected', 'connected again');
  assert.equal(r.meters.length, 2);
});
