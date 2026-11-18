// The locator, cycle and click commands (m5-ui-loop-click; UI redesign spec
// 3.1, 3.2): what LoopClickController and its key bindings send on a fake
// client. One command.execute with session.set_locators {left, right}
// (decimal strings) per edit, none for an edit that would be refused or that
// changes nothing; Loop Selection sends set_locators, set_cycle on, locate
// to the left locator and play, in that order; the transport methods need a
// device (the engine answers no_device), session.set_locators does not; a
// refusal becomes a toast worded by refusalLine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { refusalLine } from '../../src/renderer/i18n/errors';
import { CommandRegistry, type CommandId } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { LocatorsEntity } from '../../src/renderer/model/document';
import { LoopClickController, TransportStateStore, bindLoopClickCommands } from '../../src/renderer/model/loop-click';
import type { Snapshot } from '../../src/renderer/model/read-model';
import { ProtocolError, type ClientState, type EventMessage } from '../../src/renderer/model/session-client';
import { settle } from './support/fakes';
import { sampleSnapshot } from './support/timeline';

// dist/test/unit -> app/test/unit/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function fakeClient(answer: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {
  const sent: Sent[] = [];
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
    capabilities: FULL,
    epoch: 0,
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    const result = answer(method, params);
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    sent,
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
    set(patch: Partial<ClientState>) {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn();
    },
    emit(type: string, fields: Record<string, unknown>) {
      for (const fn of [...(events.get(type) ?? [])]) fn({ schema: 'siann.event.v1', seq: '9', type, ...fields });
    },
  };
}

const STATUS = { cycle: false, click: { enabled: false, gainMilliDb: -12000 } };

function withLocators(left: string, right: string): Snapshot {
  const locators: LocatorsEntity = { schema: 'siann.entity.locators.v1', id: 'locators', left, right };
  return { ...sampleSnapshot(), locators };
}

function setup(options: { device?: boolean; snapshot?: Snapshot | null; answer?: (method: string, params: Record<string, unknown>) => unknown } = {}) {
  const client = fakeClient(options.answer ?? ((method) => (method === 'engine.status' ? STATUS : method.startsWith('transport.') ? { playing: false, position: '0', ...STATUS } : {})));
  let snapshot = options.snapshot === undefined ? sampleSnapshot() : options.snapshot;
  const state = new TransportStateStore(client);
  const toasts: string[] = [];
  let device = options.device ?? true;
  const controller = new LoopClickController({
    client,
    model: { getSnapshot: () => snapshot },
    state,
    deviceReady: () => device,
    capabilities: () => capabilitySelector(client.getState().capabilities),
    toasts: { push: (text) => toasts.push(text) },
    locale: () => 'en',
  });
  return {
    client,
    state,
    controller,
    toasts,
    setSnapshot(next: Snapshot | null) {
      snapshot = next;
    },
    setDevice(next: boolean) {
      device = next;
    },
    // What went out after the store's engine.status read.
    sent: () => client.sent.filter((s) => s.method !== 'engine.status'),
  };
}

const setLocators = (left: string, right: string) => ({ method: 'command.execute', params: { commands: [{ op: 'session.set_locators', left, right }] } });

test('one command.execute with session.set_locators {left, right} as decimal strings per edit', async () => {
  const t = setup();
  await settle();
  assert.equal(await t.controller.setLocators({ left: 4800n, right: 96000n }), true);
  assert.deepEqual(t.sent(), [setLocators('4800', '96000')]);
});

test('an edit that would be refused or changes nothing sends nothing', async () => {
  const t = setup({ snapshot: withLocators('1000', '2000') });
  await settle();
  assert.equal(await t.controller.setLocators(null), false);
  // The range already set.
  assert.equal(await t.controller.setLocators({ left: 1000n, right: 2000n }), false);
  // Left at or after right.
  assert.equal(await t.controller.setLeftAt(2000n), false);
  assert.equal(await t.controller.setRightAt(500n), false);
  assert.deepEqual(t.sent(), []);
  // No locators: the left one sends nothing, the right one 0..position.
  t.setSnapshot(sampleSnapshot());
  assert.equal(await t.controller.setLeftAt(500n), false);
  assert.equal(await t.controller.setRightAt(0n), false);
  assert.deepEqual(t.sent(), []);
  assert.equal(await t.controller.setRightAt(48000n), true);
  assert.deepEqual(t.sent(), [setLocators('0', '48000')]);
});

test('Alt+P sends set_locators, set_cycle on, locate to the left locator and play, in that order', async () => {
  const t = setup();
  await settle();
  t.controller.useSelection(() => ({ start: 4800n, end: 72000n }));
  assert.equal(t.controller.loopSelection(), true);
  await settle();
  assert.deepEqual(t.sent(), [
    setLocators('4800', '72000'),
    { method: 'transport.set_cycle', params: { enabled: true } },
    { method: 'transport.locate', params: { frames: '4800' } },
    { method: 'transport.play', params: {} },
  ]);
});

test('Alt+P sends nothing without a device, and P still sets the locators', async () => {
  const t = setup({ device: false });
  await settle();
  t.controller.useSelection(() => ({ start: 4800n, end: 72000n }));
  assert.equal(t.controller.loopSelection(), false);
  await settle();
  assert.deepEqual(t.sent(), []);
  assert.equal(t.controller.locatorsToSelection(), true);
  await settle();
  assert.deepEqual(t.sent(), [setLocators('4800', '72000')]);
});

test('P and Alt+P with no selection send nothing', async () => {
  const t = setup();
  await settle();
  assert.equal(t.controller.locatorsToSelection(), false);
  t.controller.useSelection(() => null);
  assert.equal(t.controller.loopSelection(), false);
  await settle();
  assert.deepEqual(t.sent(), []);
});

test('cycle, the click and its level send their method with a device and nothing without one', async () => {
  const t = setup();
  await settle();
  assert.equal(t.controller.toggleCycle(), true);
  assert.equal(t.controller.toggleClick(), true);
  assert.equal(t.controller.setClickLevel(-24000), true);
  await settle();
  assert.deepEqual(t.sent(), [
    { method: 'transport.set_cycle', params: { enabled: true } },
    { method: 'transport.set_click', params: { enabled: true } },
    { method: 'transport.set_click', params: { enabled: false, gainMilliDb: -24000 } },
  ]);
  // Outside [-60000, 0], not an integer, or the level it has: nothing.
  const before = t.sent().length;
  for (const gain of [-60001, 1, -1.5, -12000]) assert.equal(t.controller.setClickLevel(gain), false, String(gain));
  assert.equal(t.controller.setClickLevel(-60000), true);
  assert.equal(t.controller.setClickLevel(0), true);
  await settle();
  assert.equal(t.sent().length, before + 2);

  const none = setup({ device: false });
  await settle();
  assert.equal(none.controller.toggleCycle(), false);
  assert.equal(none.controller.toggleClick(), false);
  assert.equal(none.controller.setClickLevel(-24000), false);
  await settle();
  assert.deepEqual(none.sent(), []);
});

test('go to the left or right locator locates there, and does nothing without locators or a device', async () => {
  const t = setup({ snapshot: withLocators('48000', '144000') });
  await settle();
  assert.equal(t.controller.goToLeft(), true);
  assert.equal(t.controller.goToRight(), true);
  await settle();
  assert.deepEqual(t.sent(), [
    { method: 'transport.locate', params: { frames: '48000' } },
    { method: 'transport.locate', params: { frames: '144000' } },
  ]);
  t.setSnapshot(sampleSnapshot());
  assert.equal(t.controller.goToLeft(), false);
  assert.equal(t.controller.goToRight(), false);
  t.setSnapshot(withLocators('48000', '144000'));
  t.setDevice(false);
  assert.equal(t.controller.goToLeft(), false);
  await settle();
  assert.equal(t.sent().length, 2);
});

test('a refusal becomes one toast worded by refusalLine', async () => {
  const t = setup({
    answer: (method) =>
      method === 'engine.status' ? STATUS : method === 'command.execute' ? new ProtocolError('invalid_locators', 'left must be before right') : new ProtocolError('no_device', 'no device runs'),
  });
  await settle();
  await t.controller.setLocators({ left: 1n, right: 2n });
  t.controller.toggleCycle();
  await settle();
  assert.deepEqual(t.toasts, [refusalLine('invalid_locators', 'left must be before right', 'en'), refusalLine('no_device', 'no device runs', 'en')]);
});

test('without the methods in engine.capabilities nothing is sent', async () => {
  const t = setup({ snapshot: withLocators('48000', '144000') });
  t.client.set({ capabilities: read('capabilities-reduced.json') });
  await settle();
  t.controller.useSelection(() => ({ start: 4800n, end: 72000n }));
  assert.equal(await t.controller.setLocators({ left: 1n, right: 2n }), false);
  assert.equal(t.controller.toggleCycle(), false);
  assert.equal(t.controller.toggleClick(), false);
  assert.equal(t.controller.locatorsToSelection(), false);
  assert.equal(t.controller.loopSelection(), false);
  assert.equal(t.controller.goToLeft(), false);
  await settle();
  assert.deepEqual(t.client.sent.filter((s) => s.method.startsWith('transport.') || s.method === 'command.execute'), []);
});

test('the keys: each runs its command and declines when it would send nothing', async () => {
  const t = setup({ snapshot: withLocators('48000', '144000') });
  await settle();
  const commands = new CommandRegistry();
  let cursor: string | null = '96000';
  bindLoopClickCommands(commands, t.controller, { cursor: () => cursor });
  const run = (id: CommandId) => commands.run('window', id);
  assert.equal(run('transport.toLeftLocator'), true);
  assert.equal(run('transport.toRightLocator'), true);
  assert.equal(run('transport.cycleToggle'), true);
  assert.equal(run('transport.metronomeToggle'), true);
  // Ctrl+Num 1 / Ctrl+Num 2: the locators to the cursor.
  assert.equal(run('transport.setLeftLocator'), true);
  await settle();
  assert.deepEqual(t.sent(), [
    { method: 'transport.locate', params: { frames: '48000' } },
    { method: 'transport.locate', params: { frames: '144000' } },
    { method: 'transport.set_cycle', params: { enabled: true } },
    { method: 'transport.set_click', params: { enabled: true } },
    setLocators('96000', '144000'),
  ]);
  // Ctrl+Num 1 after the right locator, and no selection for P: declined.
  cursor = '200000';
  assert.equal(run('transport.setLeftLocator'), false);
  assert.equal(run('transport.locatorsToSelection'), false);
  cursor = null;
  assert.equal(run('transport.setRightLocator'), false);
  // No locators: Ctrl+Num 1 sends nothing, Ctrl+Num 2 gives 0..cursor.
  t.setSnapshot(sampleSnapshot());
  cursor = '96000';
  assert.equal(run('transport.setLeftLocator'), false);
  assert.equal(run('transport.setRightLocator'), true);
  await settle();
  assert.deepEqual(t.sent().at(-1), setLocators('0', '96000'));
});
