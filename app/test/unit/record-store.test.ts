// The record state and its actions (m5b-ui-recording; UI redesign 3.1, 3.5;
// 10.11, 18 and 21; docs/schemas/protocol-engine-v0.md, "Recording";
// protocol-events-v1.md, "record.changed" and the auth reply's and
// session.sync's pendingTakes):
//
// - RecordStore reads engine.status at each connection and sync, follows
//   record.changed (whoever armed: another connection's change shows) and the
//   results of the transport and record methods; an engine.status asked before
//   a newer event is dropped; forgotten while the engine is away.
// - An early end (endedBy overflow, disk or device) is reported once per take.
// - The session client keeps pendingTakes from the auth reply and replaces it
//   with each sync's.
// - RecordController sends one record.arm per toggle, one transport.record per
//   Record, one track.set_input and one track.set_monitor per choice, and
//   record.recover_take for Keep and Discard; it says why a control is
//   disabled (no device, no input, nothing armed, recording) and sends nothing
//   then; a refusal becomes one toast.
//
// Runs the real SessionClient against a fake socket for the store, and a fake
// client for the controller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { refusalLine } from '../../src/renderer/i18n/errors';
import { translator } from '../../src/renderer/i18n/t';
import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { TrackEntity } from '../../src/renderer/model/document';
import { parseEngineStatus, type EngineStatus } from '../../src/renderer/model/engine-status';
import { parsePendingTakes } from '../../src/renderer/model/pending-takes';
import {
  RecordController,
  RecordStore,
  bindRecordCommands,
  earlyEndLine,
  nextMonitor,
  parseRecordState,
  recordGates,
  type RecordState,
} from '../../src/renderer/model/record';
import { ProtocolError, SessionClient, type ClientState, type EventMessage } from '../../src/renderer/model/session-client';
import { FakeScheduler, FakeSocket, settle, until, type Message } from './support/fakes';
import { sequence } from './support/sequence';
import { snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;

const ENDPOINT = { port: 4100, token: 'tok' };
const CAPS = { methods: ['engine.status', 'record.arm', 'transport.record', 'record.recover_take', 'session.sync'], features: { recording: true } };
const SEQUENCE = sequence();
const SYNC = SEQUENCE.sync;
const BASE = Number(SEQUENCE.base.seq);
const SESSION = SEQUENCE.sessionId;

const PENDING = [{ takeId: 'take_a1', trackId: 'trk_1', channels: 1, sampleRate: 48000, startFrame: '96000', endedBy: 'device', overflows: '0' }];

interface Engine {
  status: { recording: boolean; armed: string[] };
  pendingAuth: unknown;
  pendingSync: unknown;
  held: Message[];
  hold: boolean;
}

function connect(engine: Engine, onEarlyEnd?: (takeId: string, endedBy: string) => void) {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      socket.handler = (message) => {
        if (message.type === 'auth') {
          socket.deliver({ type: 'auth', ok: true, sessionId: SESSION, revision: SEQUENCE.base.revision, seq: SEQUENCE.base.seq, pendingTakes: engine.pendingAuth });
          return;
        }
        const reply = (result: unknown) => socket.deliver({ requestId: message.requestId, ok: true, result });
        if (message.method === 'engine.capabilities') reply(CAPS);
        else if (message.method === 'session.sync') {
          const cursor = message.params?.cursor;
          const chunk = cursor === undefined ? SYNC[0] : SYNC[SYNC.findIndex((c) => c.next === cursor) + 1];
          reply(cursor === undefined ? { ...chunk, pendingTakes: engine.pendingSync } : chunk);
        } else if (message.method === 'engine.status') {
          if (engine.hold) engine.held.push(message);
          else reply({ device: null, cycle: false, click: { enabled: false, gainMilliDb: -12000 }, ...engine.status });
        }
      };
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    currentEndpoint: async () => ENDPOINT,
    schedule: scheduler.schedule,
  });
  const store = new RecordStore(client, { onEarlyEnd: (take) => onEarlyEnd?.(take.takeId, take.endedBy ?? '') });
  client.connect(ENDPOINT);
  return { client, store, sockets, socket: () => sockets[sockets.length - 1]!, scheduler };
}

const changed = (seq: number, state: Partial<RecordState> & Record<string, unknown>) => ({
  schema: 'siann.event.v1',
  seq: String(BASE + seq),
  sessionId: SESSION,
  type: 'record.changed',
  recording: false,
  armed: [],
  takes: [],
  ...state,
});

test('parses the record state of record.arm, a transport result, engine.status and record.changed; anything else is null', () => {
  const take = { takeId: 'take_1', trackId: 'trk_1', startFrame: null, durableFrames: '0' };
  assert.deepEqual(parseRecordState({ recording: true, armed: ['trk_1'], takes: [take] }), {
    recording: true,
    armed: ['trk_1'],
    takes: [{ ...take, endedBy: null, overflows: null }],
  });
  // A transport result and engine.status carry no takes: null, kept by the store.
  assert.deepEqual(parseRecordState({ playing: true, position: '0', cycle: false, recording: false, armed: [] }), { recording: false, armed: [], takes: null });
  assert.equal(parseRecordState({ playing: true, cycle: false }), null);
  assert.equal(parseRecordState({ recording: 'yes', armed: [] }), null);
  assert.equal(parseRecordState({ recording: true, armed: [3] }), null);
  assert.equal(parseRecordState(null), null);
});

test('parses pendingTakes: a list of takes, null without the field', () => {
  assert.deepEqual(parsePendingTakes(PENDING), [{ takeId: 'take_a1', trackId: 'trk_1', channels: 1, sampleRate: 48000, startFrame: '96000', endedBy: 'device', overflows: '0' }]);
  assert.deepEqual(parsePendingTakes([{ takeId: 'take_b', trackId: null, channels: 2, sampleRate: 44100, startFrame: null }]), [
    { takeId: 'take_b', trackId: null, channels: 2, sampleRate: 44100, startFrame: null, endedBy: null, overflows: null },
  ]);
  assert.deepEqual(parsePendingTakes([{ trackId: 'x' }, 4]), []);
  assert.equal(parsePendingTakes(undefined), null);
});

test('seeded from engine.status at connect, then kept by record.changed and by results', async () => {
  const engine: Engine = { status: { recording: false, armed: ['trk_2'] }, pendingAuth: [], pendingSync: [], held: [], hold: false };
  const t = connect(engine);
  assert.equal(t.store.getSnapshot(), null);
  await until(() => t.store.getSnapshot() !== null, 'the first engine.status');
  assert.deepEqual(t.store.getSnapshot(), { recording: false, armed: ['trk_2'], takes: [] });
  // Another connection arms trk_1: the event says so.
  t.socket().deliver(changed(1, { armed: ['trk_1', 'trk_2'] }));
  await until(() => t.store.getSnapshot()?.armed.length === 2, 'record.changed');
  // A recording starts; the take's first frame arrives later.
  t.store.apply({ playing: true, position: '96000', cycle: false, click: { enabled: false, gainMilliDb: -12000 }, recording: true, armed: ['trk_1', 'trk_2'] });
  assert.equal(t.store.getSnapshot()?.recording, true);
  const take = { takeId: 'take_1', trackId: 'trk_1', startFrame: '96000', durableFrames: '0' };
  t.socket().deliver(changed(2, { recording: true, armed: ['trk_1', 'trk_2'], takes: [take] }));
  await until(() => t.store.getSnapshot()?.takes.length === 1, 'the take');
  // A result without takes keeps them.
  t.store.apply({ recording: true, armed: ['trk_1', 'trk_2'], playing: true, cycle: false });
  assert.equal(t.store.getSnapshot()?.takes[0]?.startFrame, '96000');
  let notified = 0;
  t.store.subscribe(() => (notified += 1));
  t.store.apply({ recording: true, armed: ['trk_1', 'trk_2'], takes: [take] });
  assert.equal(notified, 0, 'the same state tells nobody');
});

test('an engine.status asked before a newer record.changed is dropped; forgotten while away, read again after a reconnect', async () => {
  const engine: Engine = { status: { recording: false, armed: [] }, pendingAuth: [], pendingSync: [], held: [], hold: true };
  const t = connect(engine);
  await until(() => engine.held.length === 1, 'engine.status asked');
  t.socket().deliver(changed(1, { armed: ['trk_1'] }));
  await until(() => t.store.getSnapshot()?.armed[0] === 'trk_1', 'record.changed');
  t.socket().deliver({ requestId: engine.held[0]!.requestId, ok: true, result: { device: null, cycle: false, click: { enabled: false, gainMilliDb: 0 }, recording: false, armed: [] } });
  await settle();
  assert.deepEqual(t.store.getSnapshot()?.armed, ['trk_1']);
  engine.hold = false;
  engine.status = { recording: true, armed: ['trk_3'] };
  t.socket().serverClose();
  assert.equal(t.store.getSnapshot(), null);
  t.scheduler.fire(250);
  await until(() => t.store.getSnapshot()?.armed[0] === 'trk_3', 'the reconnect read');
  assert.equal(t.store.getSnapshot()?.recording, true);
});

test('an early end is reported once per take, with its reason; a stop is not', async () => {
  const ends: string[] = [];
  const engine: Engine = { status: { recording: true, armed: ['trk_1', 'trk_2'] }, pendingAuth: [], pendingSync: [], held: [], hold: false };
  const t = connect(engine, (takeId, endedBy) => ends.push(`${takeId}:${endedBy}`));
  await until(() => t.store.getSnapshot() !== null, 'engine.status');
  const ended = (endedBy: string, takeId: string, trackId: string) => ({ takeId, trackId, startFrame: '0', durableFrames: '48000', endedBy, overflows: '12' });
  t.socket().deliver(changed(1, { recording: false, armed: ['trk_1', 'trk_2'], takes: [ended('overflow', 'take_1', 'trk_1'), ended('overflow', 'take_2', 'trk_2')] }));
  await until(() => ends.length === 2, 'the early ends');
  // The same end again (another record.changed) is not reported twice.
  t.socket().deliver(changed(2, { recording: false, armed: [], takes: [ended('overflow', 'take_1', 'trk_1'), ended('overflow', 'take_2', 'trk_2')] }));
  await settle();
  assert.deepEqual(ends, ['take_1:overflow', 'take_2:overflow']);
  t.socket().deliver(changed(3, { recording: false, armed: [], takes: [ended('stop', 'take_3', 'trk_1')] }));
  await settle();
  assert.equal(ends.length, 2, 'a stop is no early end');
  // Each reason has its line, in every locale.
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t2 = translator(locale);
    const lines = ['overflow', 'disk', 'device'].map((reason) => earlyEndLine({ takeId: 'take_9', trackId: 'trk_1', startFrame: '0', durableFrames: '0', endedBy: reason, overflows: '3' }, 'Vox', t2));
    assert.equal(new Set(lines).size, 3, `${locale}: three reasons`);
    for (const line of lines) assert.ok(line.includes('Vox'), `${locale}: names the track: ${line}`);
  }
});

test('the session client keeps pendingTakes from the auth reply and replaces it with each sync\'s', async () => {
  const engine: Engine = { status: { recording: false, armed: [] }, pendingAuth: PENDING, pendingSync: PENDING, held: [], hold: false };
  const t = connect(engine);
  await until(() => (t.client.getState().pendingTakes ?? []).length === 1, 'the auth reply\'s pendingTakes');
  assert.equal(t.client.getState().pendingTakes?.[0]?.takeId, 'take_a1');
  await until(() => t.client.getState().syncCount === 1, 'the first sync');
  // A gap's sync lists none any more.
  engine.pendingSync = [];
  t.socket().deliver({ schema: 'siann.event.v1', seq: String(BASE + 5), sessionId: SESSION, type: 'plan.changed' });
  await until(() => t.client.getState().pendingTakes?.length === 0, 'the sync\'s pendingTakes');
});

// ---- the controller, on a fake client.

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const DEVICE = { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 256, outputLatencyFrames: 256, input: { id: 'fake', channels: 2, latencyFrames: 256 } };

function rig(options: { tracks?: TrackEntity[]; status?: EngineStatus | null; caps?: Capabilities; answer?: (method: string, params: Record<string, unknown>) => unknown; pending?: unknown } = {}) {
  const sent: Sent[] = [];
  const toasts: string[] = [];
  const tracks = options.tracks ?? [{ ...track('trk_1'), input: { port: 0, channels: 1 } }, track('trk_2')];
  const snapshot = snapshotOf(tracks.map((t) => t.id), tracks, [], []);
  const listeners = new Set<() => void>();
  const events = new Map<string, Set<(event: EventMessage) => void>>();
  let state: ClientState = {
    status: 'connected',
    sessionId: 'ses_1',
    revision: 'r1',
    about: null,
    lastSeq: '1',
    syncCount: 1,
    connections: 1,
    error: null,
    legend: null,
    capabilities: options.caps ?? FULL,
    epoch: 0,
    pendingTakes: parsePendingTakes(options.pending ?? []) ?? [],
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    const result = options.answer?.(method, params) ?? {};
    if (result instanceof Error) throw result;
    return result;
  };
  const client = {
    request,
    execute: (commands: readonly unknown[]) => request('command.execute', { commands }),
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    onEvent: (type: string, fn: (event: EventMessage) => void) => {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type)!.add(fn);
      return () => void events.get(type)!.delete(fn);
    },
  };
  const status = options.status === undefined ? parseEngineStatus({ device: DEVICE }) : options.status;
  const store = new RecordStore(client);
  const controller = new RecordController({
    client,
    model: { getSnapshot: () => snapshot },
    store,
    status: { getSnapshot: () => status, subscribe: () => () => undefined },
    capabilities: () => capabilitySelector(client.getState().capabilities),
    toasts: { push: (text: string) => toasts.push(text) },
    locale: () => 'en',
  });
  return {
    sent,
    toasts,
    store,
    controller,
    set(patch: Partial<ClientState>) {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn();
    },
    emit(type: string, fields: Record<string, unknown>) {
      for (const fn of [...(events.get(type) ?? [])]) fn({ schema: 'siann.event.v1', seq: '9', type, ...fields });
    },
  };
}

test('the gates: record enable and Record need features.recording and the methods, monitor features.monitoring and track.set_monitor, the input track.set_input', () => {
  assert.deepEqual(recordGates(capabilitySelector(FULL)), { record: true, monitor: true, input: true });
  const without = { ...FULL, features: { ...FULL.features, recording: false, monitoring: false } };
  assert.deepEqual(recordGates(capabilitySelector(without)), { record: false, monitor: false, input: false });
  const noMonitor = { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_monitor') };
  assert.equal(recordGates(capabilitySelector(noMonitor)).monitor, false);
  const noArm = { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'record.arm') };
  assert.equal(recordGates(capabilitySelector(noArm)).record, false);
  assert.deepEqual(recordGates(capabilitySelector(null)), { record: false, monitor: false, input: false });
});

test('arming sends one record.arm per toggle and follows the answer; disarming likewise', async () => {
  const r = rig({ answer: (method, params) => (method === 'record.arm' ? { recording: false, armed: params.armed ? [params.trackId] : [], takes: [] } : {}) });
  r.store.apply({ recording: false, armed: [], takes: [] });
  assert.equal(r.controller.armBlock('trk_1'), null);
  assert.equal(r.controller.toggleArm('trk_1'), true);
  await settle();
  assert.deepEqual(r.sent, [{ method: 'record.arm', params: { trackId: 'trk_1', armed: true } }]);
  assert.equal(r.controller.isArmed('trk_1'), true);
  assert.equal(r.controller.toggleArm('trk_1'), true);
  await settle();
  assert.deepEqual(r.sent.at(-1), { method: 'record.arm', params: { trackId: 'trk_1', armed: false } });
  assert.equal(r.controller.isArmed('trk_1'), false);
});

test('arming is blocked, with the reason, and sends nothing: no device, no input open, a track without an input or beyond the open one, recording', async () => {
  const noDevice = rig({ status: parseEngineStatus({ device: null, deviceError: { code: 'no_device' } }) });
  noDevice.store.apply({ recording: false, armed: [], takes: [] });
  assert.equal(noDevice.controller.armBlock('trk_1'), 'noDevice');
  const noInput = rig({ status: parseEngineStatus({ device: { ...DEVICE, input: null } }) });
  noInput.store.apply({ recording: false, armed: [], takes: [] });
  assert.equal(noInput.controller.armBlock('trk_1'), 'noInput');
  const r = rig({ tracks: [{ ...track('trk_1'), input: { port: 2, channels: 2 } }, track('trk_2')] });
  r.store.apply({ recording: false, armed: [], takes: [] });
  assert.equal(r.controller.armBlock('trk_2'), 'noTrackInput');
  assert.equal(r.controller.armBlock('trk_1'), 'inputUnavailable');
  assert.equal(r.controller.toggleArm('trk_2'), false);
  const recording = rig();
  recording.store.apply({ recording: true, armed: ['trk_1'], takes: [] });
  assert.equal(recording.controller.armBlock('trk_1'), 'recording');
  assert.equal(recording.controller.toggleArm('trk_1'), false);
  const disconnected = rig();
  disconnected.set({ status: 'disconnected' });
  assert.equal(disconnected.controller.armBlock('trk_1'), 'disconnected');
  await settle();
  for (const each of [noDevice, noInput, r, recording, disconnected]) assert.deepEqual(each.sent, []);
});

test('Record sends transport.record on and off, and is blocked with the reason: no device, no input, nothing armed', async () => {
  const r = rig({ answer: (method, params) => (method === 'transport.record' ? { playing: true, position: '0', cycle: false, click: { enabled: false, gainMilliDb: -12000 }, recording: params.enabled, armed: ['trk_1'] } : {}) });
  r.store.apply({ recording: false, armed: [], takes: [] });
  assert.equal(r.controller.recordBlock(), 'nothingArmed');
  assert.equal(r.controller.toggleRecord(), false);
  r.store.apply({ recording: false, armed: ['trk_1'], takes: [] });
  assert.equal(r.controller.recordBlock(), null);
  assert.equal(r.controller.toggleRecord(), true);
  await settle();
  assert.deepEqual(r.sent, [{ method: 'transport.record', params: { enabled: true } }]);
  assert.equal(r.store.getSnapshot()?.recording, true);
  // While recording, Record ends the take (and playback goes on).
  assert.equal(r.controller.toggleRecord(), true);
  await settle();
  assert.deepEqual(r.sent.at(-1), { method: 'transport.record', params: { enabled: false } });
  const noInput = rig({ status: parseEngineStatus({ device: { ...DEVICE, input: null } }) });
  noInput.store.apply({ recording: false, armed: ['trk_1'], takes: [] });
  assert.equal(noInput.controller.recordBlock(), 'noInput');
  const noDevice = rig({ status: parseEngineStatus({ device: null }) });
  noDevice.store.apply({ recording: false, armed: ['trk_1'], takes: [] });
  assert.equal(noDevice.controller.recordBlock(), 'noDevice');
});

test('a refused arm or Record is one toast with the engine\'s code', async () => {
  const r = rig({ answer: () => new ProtocolError('no_input', 'no input is open') });
  r.store.apply({ recording: false, armed: ['trk_1'], takes: [] });
  r.controller.toggleRecord();
  await settle();
  assert.deepEqual(r.toasts, [refusalLine('no_input', 'no input is open', 'en')]);
});

test('the input and the monitor are one command.execute each, from the document', async () => {
  const r = rig({ tracks: [{ ...track('trk_1'), input: { port: 0, channels: 1 } }, { ...track('trk_2'), monitor: 'auto' } as TrackEntity] });
  r.store.apply({ recording: false, armed: [], takes: [] });
  assert.equal(r.controller.setInput('trk_1', { port: 0, channels: 2 }), true);
  assert.equal(r.controller.setInput('trk_1', null), true);
  // The input already set sends nothing.
  assert.equal(r.controller.setInput('trk_1', { port: 0, channels: 1 }), false);
  assert.equal(r.controller.toggleMonitor('trk_1'), true);
  assert.equal(r.controller.toggleMonitor('trk_2'), true);
  await settle();
  assert.deepEqual(
    r.sent.map((s) => s.params.commands),
    [
      [{ op: 'track.set_input', trackId: 'trk_1', input: { port: 0, channels: 2 } }],
      [{ op: 'track.set_input', trackId: 'trk_1', input: null }],
      [{ op: 'track.set_monitor', trackId: 'trk_1', monitor: 'input' }],
      [{ op: 'track.set_monitor', trackId: 'trk_2', monitor: 'off' }],
    ],
  );
  assert.equal(nextMonitor('off'), 'input');
  assert.equal(nextMonitor('input'), 'off');
  assert.equal(nextMonitor('auto'), 'off');
  // A recorded track's input cannot change while it records (track_recording).
  const recording = rig();
  recording.store.apply({ recording: true, armed: ['trk_1'], takes: [] });
  assert.equal(recording.controller.inputBlock('trk_1'), 'recording');
  assert.equal(recording.controller.setInput('trk_1', null), false);
  assert.equal(recording.controller.inputBlock('trk_2'), null);
});

test('pending takes: Keep and Discard are record.recover_take, and a decided take leaves the list', async () => {
  const two = [...PENDING, { takeId: 'take_b2', trackId: 'trk_2', channels: 2, sampleRate: 48000, startFrame: '0' }];
  const r = rig({ pending: two, answer: (method, params) => (method === 'record.recover_take' ? (params.accept ? { revision: 'r9' } : { takeId: params.takeId, trashed: true }) : {}) });
  assert.deepEqual(r.controller.pendingTakes().map((p) => p.takeId), ['take_a1', 'take_b2']);
  let told = 0;
  r.controller.subscribePending(() => (told += 1));
  assert.equal(await r.controller.recoverTake('take_a1', true), true);
  assert.equal(await r.controller.recoverTake('take_b2', false), true);
  assert.deepEqual(r.sent, [
    { method: 'record.recover_take', params: { takeId: 'take_a1', accept: true } },
    { method: 'record.recover_take', params: { takeId: 'take_b2', accept: false } },
  ]);
  assert.deepEqual(r.controller.pendingTakes(), []);
  assert.ok(told >= 2);
  // A take being recorded now is not offered.
  const live = rig({ pending: PENDING });
  live.store.apply({ recording: true, armed: ['trk_1'], takes: [{ takeId: 'take_a1', trackId: 'trk_1', startFrame: null, durableFrames: '0' }] });
  assert.deepEqual(live.controller.pendingTakes(), []);
});

test('R arms the selected track (project scope) and Num * / Ctrl+Shift+R toggle Record (window); each declines when it would send nothing', async () => {
  const r = rig({ answer: (method, params) => (method === 'record.arm' ? { recording: false, armed: params.armed ? [params.trackId] : [], takes: [] } : {}) });
  r.store.apply({ recording: false, armed: [], takes: [] });
  const commands = new CommandRegistry();
  let selected: string | null = null;
  const off = bindRecordCommands(commands, r.controller, { selectedTrack: () => selected });
  assert.equal(commands.run('project', 'track.recordEnable'), false, 'no track selected');
  selected = 'trk_1';
  assert.equal(commands.run('project', 'track.recordEnable'), true);
  await settle();
  assert.deepEqual(r.sent, [{ method: 'record.arm', params: { trackId: 'trk_1', armed: true } }]);
  assert.equal(commands.run('window', 'transport.record'), true);
  await settle();
  assert.deepEqual(r.sent.at(-1), { method: 'transport.record', params: { enabled: true } });
  off();
  assert.equal(commands.run('window', 'transport.record'), false);
});
