// Punch, pre-roll and count-in in the transport state (m5b-ui-recording; UI
// redesign 3.1; 10.11, 17 and 18; docs/schemas/protocol-engine-v0.md, "Punch,
// pre-roll and count-in"): read from engine.status, transport.changed and the
// transport methods' results beside cycle and the click; set with
// transport.set_punch {in, out}, transport.set_preroll {enabled, bars} and
// transport.set_count_in {enabled, bars}, bars an integer clamped to 1..8; I
// and O toggle the punch in and out; nothing without a device or the method.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { LoopClickController, TransportStateStore, bindLoopClickCommands, clampBars, parseTransportState, recordOptionGates } from '../../src/renderer/model/loop-click';
import type { ClientState, EventMessage } from '../../src/renderer/model/session-client';
import { settle } from './support/fakes';
import { sampleSnapshot } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

const OPTIONS = { punch: { in: true, out: false }, preroll: { enabled: false, bars: 1 }, countIn: { enabled: true, bars: 2 } };
const BASE = { cycle: false, click: { enabled: false, gainMilliDb: -12000 } };

function rig(options: { caps?: Capabilities; device?: boolean } = {}) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<() => void>();
  const events = new Map<string, Set<(event: EventMessage) => void>>();
  let status = { ...BASE, ...OPTIONS };
  const state: ClientState = {
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
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    if (method === 'engine.status') return { device: null, ...status };
    if (method === 'transport.set_punch') status = { ...status, punch: { in: params.in as boolean, out: params.out as boolean } };
    if (method === 'transport.set_preroll') status = { ...status, preroll: { enabled: params.enabled as boolean, bars: (params.bars as number) ?? status.preroll.bars } };
    if (method === 'transport.set_count_in') status = { ...status, countIn: { enabled: params.enabled as boolean, bars: (params.bars as number) ?? status.countIn.bars } };
    return { playing: false, position: '0', recording: false, armed: [], ...status };
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
  const store = new TransportStateStore(client);
  const controller = new LoopClickController({
    client,
    model: { getSnapshot: () => sampleSnapshot() },
    state: store,
    deviceReady: () => options.device !== false,
    capabilities: () => capabilitySelector(state.capabilities),
    toasts: { push: () => 0 },
    locale: () => 'en',
  });
  return {
    sent,
    store,
    controller,
    emit(type: string, fields: Record<string, unknown>) {
      for (const fn of [...(events.get(type) ?? [])]) fn({ schema: 'siann.event.v1', seq: '9', type, ...fields });
    },
  };
}

test('parses punch, pre-roll and count-in beside cycle and the click; null where the engine has none', () => {
  assert.deepEqual(parseTransportState({ device: null, xruns: '0', ...BASE, ...OPTIONS }), { ...BASE, ...OPTIONS });
  assert.deepEqual(parseTransportState({ type: 'transport.changed', ...BASE, ...OPTIONS }), { ...BASE, ...OPTIONS });
  // An engine before m5b-engine-punch-count-in: no such fields.
  assert.deepEqual(parseTransportState({ ...BASE }), { ...BASE });
  // A malformed option is null, the rest stays.
  assert.deepEqual(parseTransportState({ ...BASE, punch: { in: 'yes' }, preroll: { enabled: true, bars: 1.5 }, countIn: OPTIONS.countIn }), { ...BASE, punch: null, preroll: null, countIn: OPTIONS.countIn });
});

test('read from engine.status, kept by transport.changed and by the results', async () => {
  const r = rig();
  await settle();
  assert.deepEqual(r.store.getSnapshot()?.punch, { in: true, out: false });
  assert.deepEqual(r.store.getSnapshot()?.countIn, { enabled: true, bars: 2 });
  r.emit('transport.changed', { ...BASE, punch: { in: false, out: true }, preroll: { enabled: true, bars: 3 }, countIn: { enabled: false, bars: 2 } });
  assert.deepEqual(r.store.getSnapshot()?.punch, { in: false, out: true });
  assert.deepEqual(r.store.getSnapshot()?.preroll, { enabled: true, bars: 3 });
  let notified = 0;
  r.store.subscribe(() => (notified += 1));
  r.emit('transport.changed', { ...BASE, punch: { in: false, out: true }, preroll: { enabled: true, bars: 3 }, countIn: { enabled: false, bars: 2 } });
  assert.equal(notified, 0, 'the same state tells nobody');
});

test('the options send their methods with both flags or the bars; I and O toggle one punch flag', async () => {
  const r = rig();
  await settle();
  const commands = new CommandRegistry();
  bindLoopClickCommands(commands, r.controller, { cursor: () => null });
  assert.equal(commands.run('window', 'transport.punchIn'), true);
  await settle();
  assert.equal(commands.run('window', 'transport.punchOut'), true);
  await settle();
  assert.equal(r.controller.setPreroll(true), true);
  await settle();
  assert.equal(r.controller.setPrerollBars(4), true);
  await settle();
  assert.equal(r.controller.setCountIn(false), true);
  await settle();
  assert.equal(r.controller.setCountInBars(12), true);
  await settle();
  assert.deepEqual(
    r.sent.filter((s) => s.method !== 'engine.status'),
    [
      { method: 'transport.set_punch', params: { in: false, out: false } },
      { method: 'transport.set_punch', params: { in: false, out: true } },
      { method: 'transport.set_preroll', params: { enabled: true } },
      { method: 'transport.set_preroll', params: { enabled: true, bars: 4 } },
      { method: 'transport.set_count_in', params: { enabled: false } },
      // 12 is clamped to 8.
      { method: 'transport.set_count_in', params: { enabled: false, bars: 8 } },
    ],
  );
  assert.deepEqual(r.store.getSnapshot()?.countIn, { enabled: false, bars: 8 });
  // The bars already set send nothing.
  assert.equal(r.controller.setCountInBars(8), false);
});

test('bars are integers clamped to 1..8', () => {
  assert.equal(clampBars(0), 1);
  assert.equal(clampBars(-3), 1);
  assert.equal(clampBars(1), 1);
  assert.equal(clampBars(2.6), 3);
  assert.equal(clampBars(8), 8);
  assert.equal(clampBars(9), 8);
  assert.equal(clampBars(Number.NaN), 1);
});

test('nothing without a device, without the methods, or before the engine said its state', async () => {
  const noDevice = rig({ device: false });
  await settle();
  assert.equal(noDevice.controller.togglePunchIn(), false);
  assert.equal(noDevice.controller.setPreroll(true), false);
  const reduced = rig({ caps: REDUCED });
  await settle();
  assert.deepEqual(recordOptionGates(capabilitySelector(REDUCED)), { punch: false, preroll: false, countIn: false });
  assert.deepEqual(recordOptionGates(capabilitySelector(FULL)), { punch: true, preroll: true, countIn: true });
  assert.equal(reduced.controller.togglePunchOut(), false);
  assert.equal(reduced.controller.setCountIn(true), false);
  await settle();
  for (const r of [noDevice, reduced]) assert.deepEqual(r.sent.filter((s) => s.method !== 'engine.status'), []);
});

test('I then O before the first answer: the second request keeps the flag the first one set', async () => {
  const r = rig();
  await settle();
  assert.equal(r.controller.togglePunchIn(), true);
  assert.equal(r.controller.togglePunchOut(), true);
  await settle();
  assert.deepEqual(
    r.sent.filter((s) => s.method === 'transport.set_punch').map((s) => s.params),
    [{ in: false, out: false }, { in: false, out: true }],
  );
  assert.deepEqual(r.store.getSnapshot()?.punch, { in: false, out: true });
});
