// The protocol client that feeds the read model (protocol-events-v1.md,
// "Client read model"; spec "Process model": a renderer that keeps a read
// model resyncs on reconnect as in Protocol v0 item 11). A fake socket and a
// fake scheduler: no network, no timers, no wall clock. The fake server
// answers from fixtures/protocol/read-model-sequence.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SyncChunk } from '../../src/renderer/model/document';
import {
  ProtocolError,
  SessionClient,
  type ClientState,
  type EngineEndpoint,
  type SocketLike,
} from '../../src/renderer/model/session-client';
import { sequence, type SequenceStep } from './support/sequence';

const seq = sequence();
const SESSION = seq.sessionId;

type Message = Record<string, unknown> & { requestId?: string; method?: string; params?: Record<string, unknown> };

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Message[] = [];
  closedByClient = false;
  handler: ((message: Message) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    const message = JSON.parse(data) as Message;
    this.sent.push(message);
    this.handler?.(message);
  }
  close(): void {
    this.closedByClient = true;
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverClose(): void {
    this.onclose?.();
  }
  requests(method: string): Message[] {
    return this.sent.filter((m) => m.method === method);
  }
}

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

class FakeScheduler {
  readonly timers: Timer[] = [];
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer: Timer = { fn, ms, cancelled: false, fired: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  pending(): Timer[] {
    return this.timers.filter((t) => !t.cancelled && !t.fired);
  }
  fire(ms: number): void {
    const matching = this.pending().filter((t) => t.ms === ms);
    assert.equal(matching.length, 1, `one pending ${ms} ms timer`);
    matching[0]!.fired = true;
    matching[0]!.fn();
  }
}

// Lets promise chains (WebCrypto digests, the client's queue) run: polls a
// condition across event-loop turns, never a wall-clock wait.
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// A document as session.sync chunks of 2 (the server's order: root, media,
// tracks, clips, plugin slots, each in id order).
function chunksOf(document: SequenceStep['document'], revision: string, seqText: string, documentHash: string): SyncChunk[] {
  const order: Array<[string, Record<string, unknown>]> = [['root', document.root]];
  for (const table of ['media', 'tracks', 'clips', 'pluginSlots'] as const) {
    for (const row of [...document[table]].sort((a, b) => (a.id < b.id ? -1 : 1))) order.push([table, row]);
  }
  const chunks: SyncChunk[] = [];
  for (let i = 0; i < order.length; i += 2) {
    const chunk: Record<string, unknown> = { media: [], tracks: [], clips: [] };
    for (const [table, row] of order.slice(i, i + 2)) {
      if (table === 'root') chunk.root = row;
      else ((chunk[table] ??= []) as unknown[]).push(row);
    }
    const end = Math.min(i + 2, order.length);
    chunks.push({
      revision,
      seq: seqText,
      documentHash,
      entities: order.length,
      meters: null,
      chunk: chunk as SyncChunk['chunk'],
      next: end < order.length ? `sync_9:${end}` : null,
    });
  }
  return chunks;
}

interface ServerScript {
  sessionId: string;
  authSeq: string;
  // The chunks the next session.sync serves.
  sync: SyncChunk[];
  fetch: (params: Record<string, unknown>) => Message;
  holdSync: boolean;
  held: Array<() => void>;
  // The next this-many session.sync starts answer internal_error.
  failSyncs: number;
  other: (message: Message) => Message | null;
}

// The engine's side of one connection.
function serve(socket: FakeSocket, script: ServerScript): void {
  let pinned: SyncChunk[] = [];
  socket.handler = (message) => {
    const reply = (body: Message) => queueMicrotask(() => socket.deliver({ requestId: message.requestId, ...body }));
    if (message.type === 'auth') {
      queueMicrotask(() =>
        socket.deliver({
          type: 'auth',
          ok: message.token === 'tok',
          sessionId: script.sessionId,
          revision: script.sync[0]?.revision ?? 'r0',
          documentHash: script.sync[0]?.documentHash,
          seq: script.authSeq,
          meters: null,
          about: { name: 'siann-engine', version: '0.1.0', license: 'GPL-2.0-or-later', source: { commit: 'f'.repeat(40) } },
        }),
      );
      return;
    }
    if (message.sessionId !== script.sessionId) {
      reply({ ok: false, error: { code: 'session_mismatch', message: 'wrong session' } });
      return;
    }
    if (message.method === 'session.sync') {
      const cursor = message.params?.cursor as string | undefined;
      if (!cursor && script.failSyncs > 0) {
        script.failSyncs -= 1;
        reply({ ok: false, error: { code: 'internal_error', message: 'transient' } });
        return;
      }
      if (!cursor) pinned = script.sync;
      const index = cursor ? pinned.findIndex((_, i) => i > 0 && pinned[i - 1]!.next === cursor) : 0;
      const answer = () => reply({ ok: true, result: pinned[index] as unknown as Message });
      if (script.holdSync && !cursor) script.held.push(answer);
      else answer();
      return;
    }
    if (message.method === 'session.fetch') {
      reply(script.fetch(message.params ?? {}));
      return;
    }
    const other = script.other(message);
    if (other) reply(other);
  };
}

// Answers session.fetch from the fixture: the step whose event revision it names.
function fixtureFetch(params: Record<string, unknown>): Message {
  const step = seq.steps.find((s) => s.event.revision === params.revision);
  if (!step) return { ok: false, error: { code: 'revision_unavailable', message: 'not kept' } };
  assert.deepEqual(params.refs, step.fetch.params.refs);
  return { ok: true, result: step.fetch.result as unknown as Message };
}

function rig(overrides: Partial<ServerScript> = {}) {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  let endpoint: EngineEndpoint | null = { port: 1, token: 'tok' };
  const script: ServerScript = {
    sessionId: SESSION,
    authSeq: seq.base.seq,
    sync: seq.sync as unknown as SyncChunk[],
    fetch: fixtureFetch,
    holdSync: false,
    held: [],
    failSyncs: 0,
    other: () => null,
    ...overrides,
  };
  const states: ClientState[] = [];
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      serve(socket, script);
      return socket;
    },
    currentEndpoint: async () => endpoint,
    schedule: scheduler.schedule,
  });
  client.subscribe(() => states.push(client.getState()));
  const last = () => sockets[sockets.length - 1]!;
  const setEndpoint = (next: EngineEndpoint | null) => {
    endpoint = next;
  };
  return { client, scheduler, sockets, script, states, last, setEndpoint };
}

async function connected(r: ReturnType<typeof rig>, endpoint: EngineEndpoint = { port: 1, token: 'tok' }): Promise<FakeSocket> {
  r.client.connect(endpoint);
  const socket = r.last();
  socket.onopen?.();
  await until(() => r.client.getState().status === 'connected', 'connected');
  return socket;
}

async function synced(r: ReturnType<typeof rig>): Promise<FakeSocket> {
  const socket = await connected(r);
  await until(() => r.client.model.getSnapshot() !== null, 'the first sync');
  return socket;
}

const event = (i: number) => structuredClone(seq.steps[i]!.event);

test('(1) connect authenticates with events, syncs every chunk at one revision and takes the sync seq', async () => {
  const r = rig();
  r.client.connect({ port: 4711, token: 'tok' });
  const socket = r.last();
  assert.equal(socket.url, 'ws://127.0.0.1:4711/');
  assert.equal(r.client.getState().status, 'connecting');
  socket.onopen?.();
  assert.deepEqual(socket.sent[0], { type: 'auth', token: 'tok', events: true });
  await until(() => r.client.model.getSnapshot() !== null, 'the sync');
  const syncs = socket.requests('session.sync');
  assert.deepEqual(syncs.map((m) => m.params), [{}, { cursor: 'sync_1:2' }, { cursor: 'sync_1:4' }, { cursor: 'sync_1:6' }]);
  for (const m of syncs) assert.equal(m.sessionId, SESSION);
  const snapshot = r.client.model.getSnapshot()!;
  assert.equal(snapshot.revision, seq.base.revision);
  assert.equal(snapshot.documentHash, seq.base.documentHash);
  const state = r.client.getState();
  assert.equal(state.status, 'connected');
  assert.equal(state.sessionId, SESSION);
  assert.equal(state.lastSeq, seq.base.seq);
  assert.equal(state.syncCount, 1);
  assert.equal(state.about?.name, 'siann-engine');
});

test('(2) a session.changed in sequence fetches at the event revision and applies the delta', async () => {
  const r = rig();
  const socket = await synced(r);
  for (let i = 0; i < seq.steps.length; i += 1) {
    socket.deliver(event(i));
    await until(() => r.client.model.getSnapshot()!.revision === seq.steps[i]!.event.revision, `step ${i}`);
    assert.equal(r.client.model.getSnapshot()!.documentHash, seq.steps[i]!.documentHash);
    assert.equal(r.client.getState().lastSeq, seq.steps[i]!.event.seq);
  }
  const fetches = socket.requests('session.fetch');
  assert.deepEqual(fetches.map((m) => m.params), seq.steps.map((s) => s.fetch.params));
  assert.equal(r.client.getState().syncCount, 1, 'no sync for an in-sequence stream');
  assert.equal(r.client.model.getSnapshot()!.entities['track:trk_3'], undefined);
});

test('(3) an event with seq <= lastSeq is ignored', async () => {
  const r = rig();
  const socket = await synced(r);
  socket.deliver(event(0));
  await until(() => r.client.getState().lastSeq === '8', 'step 0');
  const applied = r.client.model.getSnapshot();
  socket.deliver(event(0));
  socket.deliver({ ...event(1), seq: '5' });
  await settle();
  assert.equal(socket.requests('session.fetch').length, 1);
  assert.equal(r.client.model.getSnapshot(), applied);
  assert.equal(r.client.getState().syncCount, 1);
});

test('(4) a gap syncs once; events that arrive during the sync are buffered and filtered by its seq', async () => {
  const r = rig();
  const socket = await synced(r);
  // The engine is at step 1 (seq 9) when it pins the sync.
  const step1 = seq.steps[1]!;
  r.script.sync = chunksOf(step1.document, step1.event.revision, step1.event.seq, step1.documentHash);
  r.script.holdSync = true;
  socket.deliver(event(1)); // seq 9 after lastSeq 7: a gap
  await until(() => r.script.held.length === 1, 'the gap sync');
  socket.deliver(event(0)); // seq 8, older than the sync: dropped afterwards
  socket.deliver(event(2)); // seq 10: applied after the sync
  await settle();
  assert.equal(socket.requests('session.fetch').length, 0, 'nothing is applied while the sync runs');
  r.script.holdSync = false;
  r.script.held.shift()!();
  await until(() => r.client.model.getSnapshot()!.revision === seq.steps[2]!.event.revision, 'step 2 after the sync');
  assert.equal(r.client.model.getSnapshot()!.documentHash, seq.steps[2]!.documentHash);
  assert.equal(socket.requests('session.sync').filter((m) => !m.params?.cursor).length, 2, 'the first sync and exactly one more');
  assert.deepEqual(socket.requests('session.fetch').map((m) => m.params?.revision), ['r6']);
  assert.equal(r.client.getState().lastSeq, '10');
  assert.equal(r.client.getState().syncCount, 2);
});

test('(5) a fetch answering revision_unavailable syncs instead', async () => {
  const step0 = seq.steps[0]!;
  const r = rig({ fetch: () => ({ ok: false, error: { code: 'revision_unavailable', message: 'pruned' } }) });
  const socket = await synced(r);
  r.script.sync = chunksOf(step0.document, step0.event.revision, step0.event.seq, step0.documentHash);
  socket.deliver(event(0));
  await until(() => r.client.getState().syncCount === 2, 'the resync');
  assert.equal(r.client.model.getSnapshot()!.documentHash, step0.documentHash);
  assert.equal(r.client.getState().lastSeq, '8');
});

test('(6) a delta whose recomputed documentHash differs from the event syncs (a divergent model is never trusted)', async () => {
  const step0 = seq.steps[0]!;
  const r = rig({
    fetch: (params) => {
      const answer = structuredClone(fixtureFetch(params)) as { ok: true; result: { entities: Array<{ entity?: { name?: string } }> } };
      const trackAnswer = answer.result.entities.find((e) => e.entity?.name === 'Vox')!;
      trackAnswer.entity!.name = 'Tampered';
      return answer as unknown as Message;
    },
  });
  const socket = await synced(r);
  const base = r.client.model.getSnapshot();
  r.script.sync = chunksOf(step0.document, step0.event.revision, step0.event.seq, step0.documentHash);
  r.script.holdSync = true;
  socket.deliver(event(0));
  await until(() => r.script.held.length === 1, 'the resync');
  assert.equal(r.client.model.getSnapshot(), base, 'the divergent delta was not applied');
  r.script.holdSync = false;
  r.script.held.shift()!();
  await until(() => r.client.getState().syncCount === 2, 'the resync');
  const snapshot = r.client.model.getSnapshot()!;
  assert.equal(snapshot.documentHash, step0.documentHash);
  assert.equal((snapshot.entities['track:trk_3'] as { name: string }).name, 'Vox');
});

test('(7) session.opened syncs the new session and later requests carry its id', async () => {
  const r = rig();
  const socket = await synced(r);
  const NEW = 'ses_0000000000000bee';
  r.script.sessionId = NEW;
  // The new session's sync is pinned at the event's seq.
  r.script.sync = chunksOf(seq.base.document, 'r3', '8', seq.base.documentHash);
  socket.deliver({ schema: 'siann.event.v1', seq: '8', sessionId: NEW, revision: 'r3', type: 'session.opened', documentHash: seq.base.documentHash });
  await until(() => r.client.getState().syncCount === 2, 'the sync of the opened session');
  assert.equal(r.client.getState().sessionId, NEW);
  const syncs = socket.requests('session.sync');
  assert.ok(syncs.slice(4).every((m) => m.sessionId === NEW));
  // Later events and requests belong to the new session.
  socket.deliver({ ...event(1), seq: '9', sessionId: NEW, revision: 'r4', documentHash: seq.base.documentHash, changedIds: [] });
  await until(() => r.client.getState().lastSeq === '9', 'the next event');
  const status = r.client.request('engine.status', {});
  const sent = socket.sent[socket.sent.length - 1]!;
  assert.equal(sent.sessionId, NEW);
  socket.deliver({ requestId: sent.requestId, ok: true, result: { device: null } });
  assert.deepEqual(await status, { device: null });
});

test('(8) a reconnect syncs only when it missed events or reached another engine', async () => {
  const r = rig();
  const first = await synced(r);
  const syncRequests = () => r.sockets.reduce((n, s) => n + s.requests('session.sync').filter((m) => !m.params?.cursor).length, 0);
  assert.equal(syncRequests(), 1);

  // The engine closes the socket: disconnected, and a retry is scheduled.
  first.serverClose();
  assert.equal(r.client.getState().status, 'disconnected');
  assert.equal(r.scheduler.pending().length, 1);
  // The shell announces an endpoint (onChange): same session, no missed event.
  await connected(r, { port: 2, token: 'tok' });
  assert.equal(r.scheduler.pending().length, 0, 'the connect cancelled the retry');
  await settle();
  assert.equal(syncRequests(), 1, 'auth seq == lastSeq and the same session: no sync');
  assert.equal(r.client.getState().syncCount, 1);

  // Missed events while away: auth seq > lastSeq.
  r.last().serverClose();
  r.script.authSeq = '9';
  r.script.sync = chunksOf(seq.steps[1]!.document, 'r5', '9', seq.steps[1]!.documentHash);
  await connected(r, { port: 3, token: 'tok' });
  await until(() => r.client.getState().syncCount === 2, 'the sync after missed events');
  assert.equal(r.client.model.getSnapshot()!.documentHash, seq.steps[1]!.documentHash);
  assert.equal(r.client.getState().lastSeq, '9');

  // An engine restart: a new session id (its seq starts again), through the
  // scheduled retry, which asks the shell for the current endpoint.
  r.last().serverClose();
  r.script.sessionId = 'ses_00000000000000aa';
  r.script.authSeq = '0';
  r.script.sync = chunksOf(seq.steps[1]!.document, 'r5', '0', seq.steps[1]!.documentHash);
  r.setEndpoint({ port: 5, token: 'tok' });
  r.scheduler.fire(250);
  await until(() => r.sockets.length === 4 && r.last().url === 'ws://127.0.0.1:5/', 'the retry');
  r.last().onopen?.();
  await until(() => r.client.getState().syncCount === 3, 'the sync of the restarted engine');
  assert.equal(r.client.getState().sessionId, 'ses_00000000000000aa');
  assert.equal(r.client.getState().lastSeq, '0');
  // Events of the new engine continue from its seq.
  r.last().deliver({ ...event(0), seq: '1', sessionId: 'ses_00000000000000aa', revision: 'r6', documentHash: seq.steps[1]!.documentHash, changedIds: [] });
  await until(() => r.client.getState().lastSeq === '1', 'an event of the new engine');
});

test('(9) every request settles once by a unique requestId; status follows the socket', async () => {
  const r = rig();
  const socket = await synced(r);
  const a = r.client.request('engine.status', {});
  const b = r.client.request('engine.about', {});
  const [ma, mb] = socket.sent.slice(-2);
  socket.deliver({ requestId: mb!.requestId, ok: true, result: { which: 'b' } });
  socket.deliver({ requestId: ma!.requestId, ok: false, error: { code: 'internal_error', message: 'boom' } });
  socket.deliver({ requestId: ma!.requestId, ok: true, result: { which: 'late duplicate' } });
  assert.deepEqual(await b, { which: 'b' });
  await assert.rejects(a, (e: unknown) => e instanceof ProtocolError && e.code === 'internal_error');
  const ids = socket.sent.filter((m) => m.requestId !== undefined).map((m) => m.requestId);
  assert.equal(new Set(ids).size, ids.length, 'requestIds are unique');
  // Two clients never share an id (the server's idempotency cache is per session).
  const other = rig();
  const otherSocket = await synced(other);
  const otherIds = new Set(otherSocket.sent.map((m) => m.requestId).filter(Boolean));
  assert.ok(ids.every((id) => !otherIds.has(id)));

  // A request in flight when the socket closes is rejected.
  const pending = r.client.request('engine.status', {});
  socket.serverClose();
  await assert.rejects(pending, (e: unknown) => e instanceof ProtocolError && e.code === 'disconnected');
  await assert.rejects(r.client.request('engine.status', {}), (e: unknown) => e instanceof ProtocolError && e.code === 'disconnected');
  const statuses = r.states.map((s) => s.status).filter((s, i, all) => i === 0 || all[i - 1] !== s);
  assert.deepEqual(statuses, ['connecting', 'connected', 'disconnected']);
  // A failed authentication is disconnected too, and so is a null endpoint.
  const bad = rig();
  bad.client.connect({ port: 9, token: 'wrong' });
  bad.last().onopen?.();
  await until(() => bad.client.getState().status === 'disconnected', 'auth refused');
  bad.client.connect(null);
  assert.equal(bad.client.getState().status, 'disconnected');
  // The same endpoint again does not reconnect a live socket.
  const same = rig();
  same.client.connect({ port: 1, token: 'tok' });
  same.client.connect({ port: 1, token: 'tok' });
  assert.equal(same.sockets.length, 1);
});

test('(10) execute sends the commands with expectedRevision and leaves the snapshot to session.changed', async () => {
  const commands = [{ op: 'track.add', id: 'trk_3', name: 'Vox' }];
  const r = rig({
    other: (message) =>
      message.method === 'command.execute'
        ? { ok: true, result: { revision: { id: 'r4', parents: ['r3'], documentHash: seq.steps[0]!.documentHash, diff: ['track:trk_3'] } } }
        : null,
  });
  const socket = await synced(r);
  const before = r.client.model.getSnapshot();
  const result = (await r.client.execute(commands, 'r3')) as { revision: { id: string } };
  assert.equal(result.revision.id, 'r4');
  const sent = socket.requests('command.execute')[0]!;
  assert.deepEqual(sent.params, { commands });
  assert.equal(sent.expectedRevision, 'r3');
  assert.equal(sent.sessionId, SESSION);
  assert.equal(r.client.model.getSnapshot(), before, 'no optimistic structural change');
  socket.deliver(event(0));
  await until(() => r.client.model.getSnapshot()!.revision === 'r4', 'the session.changed');
  assert.ok(r.client.model.getSnapshot()!.entities['track:trk_3']);
  // Without expectedRevision the envelope has none; an error rejects.
  r.script.other = () => ({ ok: false, error: { code: 'revision_mismatch', message: 'head moved' } });
  await assert.rejects(r.client.execute(commands), (e: unknown) => e instanceof ProtocolError && e.code === 'revision_mismatch');
  assert.equal(socket.requests('command.execute')[1]!.expectedRevision, undefined);
});

test('(11) a failed sync after an engine restart never leaves the seq of the old engine filtering the new engine', async () => {
  const r = rig();
  const first = await synced(r);
  first.deliver(event(0));
  first.deliver(event(1));
  await until(() => r.client.getState().lastSeq === '9', 'the old engine at seq 9');
  const NEW = 'ses_00000000000000aa';
  const newSync = () => r.last().requests('session.sync').filter((m) => !m.params?.cursor).length;

  // The restart: a new session whose seq starts again, and whose first sync fails.
  first.serverClose();
  r.script.sessionId = NEW;
  r.script.authSeq = '0';
  r.script.sync = chunksOf(seq.steps[1]!.document, 'r5', '0', seq.steps[1]!.documentHash);
  r.script.failSyncs = 1;
  await connected(r, { port: 2, token: 'tok' });
  await until(() => r.client.getState().error !== null, 'the failed sync');
  await settle();
  assert.equal(r.client.getState().sessionId, NEW);
  assert.equal(r.client.getState().lastSeq, null, 'the model is not in step with the new session');
  assert.equal(r.client.getState().syncCount, 1);

  // An event of the new engine (seq 1, below the old lastSeq 9) is not dropped:
  // the model is behind, so it syncs and then applies the event.
  r.last().deliver({ ...event(0), seq: '1', sessionId: NEW, revision: 'r6', documentHash: seq.steps[1]!.documentHash, changedIds: [] });
  await until(() => r.client.getState().lastSeq === '1', 'an event of the new engine');
  assert.equal(r.client.getState().syncCount, 2);
  assert.equal(r.client.getState().error, null);
  assert.equal(r.client.model.getSnapshot()!.documentHash, seq.steps[1]!.documentHash);
  assert.equal(newSync(), 2, 'the failed sync and the one the event started');
  // The event's sync succeeded: the scheduled retry was cancelled.
  assert.equal(r.scheduler.pending().length, 0);
});

test('(12) a failed sync retries under a backoff without waiting for an event', async () => {
  const r = rig({ failSyncs: 2 });
  await connected(r);
  await until(() => r.client.getState().error !== null, 'the failed first sync');
  await settle();
  assert.equal(r.client.model.getSnapshot(), null);
  assert.equal(r.client.getState().lastSeq, null);
  // The first retry: 250 ms; it fails again, so the next waits twice as long.
  r.scheduler.fire(250);
  await until(() => r.last().requests('session.sync').length === 2, 'the first retry');
  await settle();
  assert.equal(r.client.model.getSnapshot(), null);
  r.scheduler.fire(500);
  await until(() => r.client.model.getSnapshot() !== null, 'the second retry');
  assert.equal(r.client.getState().syncCount, 1);
  assert.equal(r.client.getState().lastSeq, seq.base.seq);
  assert.equal(r.client.getState().error, null);
  assert.equal(r.scheduler.pending().length, 0, 'no retry after a sync that succeeded');

  // A retry pending when the socket closes is cancelled with the connection.
  const s = rig({ failSyncs: 1 });
  const socket = await connected(s);
  await until(() => s.scheduler.pending().length === 1, 'the scheduled retry');
  socket.serverClose();
  const pending = s.scheduler.pending();
  assert.equal(pending.length, 1, 'only the reconnect remains');
  assert.equal(pending[0]!.ms, 250);
  s.scheduler.fire(250);
  await until(() => s.sockets.length === 2, 'the reconnect');
  s.last().onopen?.();
  await until(() => s.client.model.getSnapshot() !== null, 'the sync on the new connection');
  assert.equal(s.sockets[0]!.requests('session.sync').length, 1, 'the closed connection never retried');
});

test('(13) a resync drops an ended gesture whose commit it never saw; a held one stays only in the same session', async () => {
  const r = rig();
  const socket = await synced(r);
  const model = r.client.model;
  const step1 = seq.steps[1]!;
  const gainIn = (document: SequenceStep['document']) =>
    (document.tracks.find((t) => t.id === 'trk_1') as unknown as { gainMilliDb: number }).gainMilliDb;
  const shownGain = () => (model.select('track:trk_1') as unknown as { gainMilliDb: number }).gainMilliDb;

  // The fader is released; its gesture.end commit is lost in a gap.
  model.beginGesture('track:trk_1', 'gainMilliDb');
  model.setGesture(-9000);
  model.endGesture();
  r.script.sync = chunksOf(step1.document, step1.event.revision, step1.event.seq, step1.documentHash);
  socket.deliver(event(1)); // seq 9 after lastSeq 7: a gap
  await until(() => r.client.getState().syncCount === 2, 'the gap sync');
  assert.equal(model.getView().gesture, null, 'the sync is the engine truth: no ended overlay on top of it');
  assert.equal(shownGain(), gainIn(step1.document));

  // A held fader survives a gap sync of the same session.
  model.beginGesture('track:trk_1', 'gainMilliDb');
  model.setGesture(-7000);
  r.script.sync = chunksOf(step1.document, 'r9', '12', step1.documentHash);
  socket.deliver({ ...event(1), seq: '12', revision: 'r9', changedIds: [] });
  await until(() => r.client.getState().syncCount === 3, 'the second gap sync');
  assert.equal(shownGain(), -7000);

  // session.opened: another session, so the held gesture goes too.
  const NEW = 'ses_0000000000000bee';
  r.script.sessionId = NEW;
  r.script.sync = chunksOf(step1.document, 'r3', '13', step1.documentHash);
  socket.deliver({ schema: 'siann.event.v1', seq: '13', sessionId: NEW, revision: 'r3', type: 'session.opened', documentHash: step1.documentHash });
  await until(() => r.client.getState().syncCount === 4, 'the sync of the opened session');
  assert.equal(model.getView().gesture, null);
  assert.equal(shownGain(), gainIn(step1.document));
});
