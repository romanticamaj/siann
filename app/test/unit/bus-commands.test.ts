// The bus, send and routing commands (m5b-ui-sends-buses; UI redesign 3.4,
// 10.11, 24; docs/schemas/protocol-engine-v0.md, "Buses and sends"): pure
// builders from a snapshot to the one command.execute each control sends,
// with the snapshot's revision as expectedRevision. mixer.bus.add names the
// bus "Bus N" with the lowest free N and a fresh bus_ id; a rename that is
// empty or unchanged sends nothing; a send is added post-fader at 0 dB; the
// master is output null. The removal summary names what a bus.remove takes
// with it (the tracks whose sends go, the tracks and buses rerouted to the
// master), and an empty one asks no confirmation. Every expected command is
// written out from the protocol table, not from the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addBusCommand,
  addSendCommand,
  busOutputCommand,
  busPanCommand,
  busToggleCommand,
  needsConfirmation,
  newBusId,
  newSendId,
  nextBusName,
  removalSummary,
  removeBusCommand,
  removeSendCommand,
  renameBusCommand,
  sendEnabledCommand,
  sendPreCommand,
  trackOutputCommand,
} from '../../src/renderer/mixer/bus-commands';
import type { BusEntity, SendEntity, TrackEntity } from '../../src/renderer/model/document';
import { translator } from '../../src/renderer/i18n/t';
import { busSnapshot, bus, send } from './support/buses';
import { track } from './support/timeline';

const t = translator('en');
const name = (n: number) => t('bus.default', { n });

test('a new bus id is bus_ and 16 lowercase hex digits, a send id send_ and 16, each fresh', () => {
  const ids = new Set(Array.from({ length: 20 }, newBusId));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^bus_[0-9a-f]{16}$/);
  for (const id of Array.from({ length: 5 }, newSendId)) assert.match(id, /^snd_[0-9a-f]{16}$/);
});

test('mixer.bus.add: one bus.add named "Bus N" with the lowest free N', () => {
  assert.equal(name(1), 'Bus 1');
  const empty = busSnapshot([], []);
  assert.equal(nextBusName(empty, name), 'Bus 1');
  const some = busSnapshot([bus('bus_a', 'Bus 1'), bus('bus_b', 'Bus 3')], []);
  assert.equal(nextBusName(some, name), 'Bus 2');
  assert.deepEqual(addBusCommand(some, 'Bus 2', () => 'bus_new'), {
    expectedRevision: 'r7',
    commands: [{ op: 'bus.add', busId: 'bus_new', name: 'Bus 2' }],
  });
  // A track's name does not take a bus number.
  const named = busSnapshot([], [], [{ ...track('trk_a'), name: 'Bus 1' }]);
  assert.equal(nextBusName(named, name), 'Bus 1');
});

test('bus.remove, bus.rename (empty or unchanged sends nothing), pan, mute and solo', () => {
  const snap = busSnapshot([bus('bus_a', 'Verb')], []);
  assert.deepEqual(removeBusCommand(snap, 'bus_a'), { expectedRevision: 'r7', commands: [{ op: 'bus.remove', busId: 'bus_a' }] });
  assert.equal(removeBusCommand(snap, 'bus_x'), null, 'an unknown bus');
  assert.deepEqual(renameBusCommand(snap, 'bus_a', '  Hall '), { expectedRevision: 'r7', commands: [{ op: 'bus.rename', busId: 'bus_a', name: 'Hall' }] });
  assert.equal(renameBusCommand(snap, 'bus_a', '   '), null, 'empty');
  assert.equal(renameBusCommand(snap, 'bus_a', 'Verb'), null, 'unchanged');
  assert.deepEqual(busPanCommand(snap, 'bus_a', -2500), { expectedRevision: 'r7', commands: [{ op: 'bus.set_pan', busId: 'bus_a', pan: -2500 }] });
  assert.equal(busPanCommand(snap, 'bus_a', 0), null, 'unchanged pan');
  assert.deepEqual(busToggleCommand(snap, 'bus_a', 'mute'), { expectedRevision: 'r7', commands: [{ op: 'bus.set_mute', busId: 'bus_a', mute: true }] });
  assert.deepEqual(busToggleCommand(busSnapshot([{ ...bus('bus_a', 'Verb'), solo: true }], []), 'bus_a', 'solo'), {
    expectedRevision: 'r7',
    commands: [{ op: 'bus.set_solo', busId: 'bus_a', solo: false }],
  });
});

test('track.set_output and bus.set_output: a bus id, or null for the master; unchanged sends nothing', () => {
  const tracks: TrackEntity[] = [track('trk_a'), { ...track('trk_b'), output: { busId: 'bus_a' } }];
  const snap = busSnapshot([bus('bus_a', 'Verb'), { ...bus('bus_b', 'Delay'), output: { busId: 'bus_a' } }], [], tracks);
  assert.deepEqual(trackOutputCommand(snap, 'trk_a', 'bus_a'), { expectedRevision: 'r7', commands: [{ op: 'track.set_output', trackId: 'trk_a', output: { busId: 'bus_a' } }] });
  assert.deepEqual(trackOutputCommand(snap, 'trk_b', null), { expectedRevision: 'r7', commands: [{ op: 'track.set_output', trackId: 'trk_b', output: null }] });
  assert.equal(trackOutputCommand(snap, 'trk_a', null), null, 'already the master');
  assert.equal(trackOutputCommand(snap, 'trk_b', 'bus_a'), null, 'already that bus');
  assert.deepEqual(busOutputCommand(snap, 'bus_a', 'bus_b'), { expectedRevision: 'r7', commands: [{ op: 'bus.set_output', busId: 'bus_a', output: { busId: 'bus_b' } }] });
  assert.deepEqual(busOutputCommand(snap, 'bus_b', null), { expectedRevision: 'r7', commands: [{ op: 'bus.set_output', busId: 'bus_b', output: null }] });
  assert.equal(busOutputCommand(snap, 'bus_a', null), null);
});

test('send.add defaults to post-fader at 0 dB; pre, on and Remove', () => {
  const snap = busSnapshot([bus('bus_a', 'Verb')], [send('snd_1', 'trk_a', 'bus_a')], [{ ...track('trk_a'), sends: ['snd_1'] }]);
  assert.deepEqual(addSendCommand(snap, 'trk_a', 'bus_a', () => 'snd_new'), {
    expectedRevision: 'r7',
    commands: [{ op: 'send.add', sendId: 'snd_new', trackId: 'trk_a', busId: 'bus_a', levelMilliDb: 0, pre: false }],
  });
  assert.deepEqual(sendPreCommand(snap, 'snd_1', true), { expectedRevision: 'r7', commands: [{ op: 'send.set_pre', sendId: 'snd_1', pre: true }] });
  assert.equal(sendPreCommand(snap, 'snd_1', false), null, 'already post');
  assert.deepEqual(sendEnabledCommand(snap, 'snd_1', false), { expectedRevision: 'r7', commands: [{ op: 'send.set_enabled', sendId: 'snd_1', enabled: false }] });
  assert.deepEqual(removeSendCommand(snap, 'snd_1'), { expectedRevision: 'r7', commands: [{ op: 'send.remove', sendId: 'snd_1' }] });
  assert.equal(removeSendCommand(snap, 'snd_x'), null);
});

test('the removal summary names the sends\' tracks and the tracks and buses routed to the bus; empty asks nothing', () => {
  const buses: BusEntity[] = [bus('bus_a', 'Verb'), { ...bus('bus_b', 'Delay'), output: { busId: 'bus_a' } }, bus('bus_c', 'Spare')];
  const sends: SendEntity[] = [send('snd_1', 'trk_a', 'bus_a'), send('snd_2', 'trk_b', 'bus_a'), send('snd_3', 'trk_a', 'bus_a'), send('snd_4', 'trk_b', 'bus_b')];
  const tracks: TrackEntity[] = [
    { ...track('trk_a'), name: 'Keys', sends: ['snd_1', 'snd_3'] },
    { ...track('trk_b'), name: 'Vox', sends: ['snd_2', 'snd_4'] },
    { ...track('trk_c'), name: 'Pad', output: { busId: 'bus_a' } },
  ];
  const snap = busSnapshot(buses, sends, tracks);
  const summary = removalSummary('bus_a', snap);
  // In track order (trk_a, trk_b, trk_c), each once.
  assert.deepEqual(summary, { sends: ['Keys', 'Vox'], tracks: ['Pad'], buses: ['Delay'] });
  assert.equal(needsConfirmation(summary), true);
  const spare = removalSummary('bus_c', snap);
  assert.deepEqual(spare, { sends: [], tracks: [], buses: [] });
  assert.equal(needsConfirmation(spare), false);
});
