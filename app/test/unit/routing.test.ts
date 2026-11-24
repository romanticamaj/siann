// Output routing and the rack switches' gates (m5b-ui-sends-buses; UI
// redesign 3.4, 3.0, 10.11, 25): the output selector of a track lists the
// master, then every bus in busOrder; a bus's lists the master and the other
// buses, every one of them (the engine refuses a loop with routing_cycle,
// the UI does not guess it). A switch is rendered only where its rack can be:
// Routing with features.buses and track.set_output, Sends with features.sends
// and send.add, Inserts as before; a stored rack the engine cannot show reads
// as none lit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { availableRacks, busesListed, outputChoices, outputOf, routingListed, sendsListed, shownRack } from '../../src/renderer/mixer/routing';
import { bus, busSnapshot } from './support/buses';
import { track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `capabilities-${name}.json`), 'utf8')) as Capabilities;
const FULL = load('full');
const REDUCED = load('reduced');
const NO_PLUGINS = load('no-plugins');

const snap = () =>
  busSnapshot(
    [bus('bus_b', 'Verb'), bus('bus_a', 'Delay'), { ...bus('bus_c', 'Room'), output: { busId: 'bus_b' } }],
    [],
    [track('trk_a'), { ...track('trk_b'), output: { busId: 'bus_a' } }],
  );

test('a track\'s output choices: the master, then every bus in busOrder', () => {
  assert.deepEqual(outputChoices(snap(), { kind: 'track', id: 'trk_a' }), [
    { busId: null, name: null },
    { busId: 'bus_b', name: 'Verb' },
    { busId: 'bus_a', name: 'Delay' },
    { busId: 'bus_c', name: 'Room' },
  ]);
  assert.equal(outputOf(snap(), { kind: 'track', id: 'trk_a' }), null, 'the master');
  assert.equal(outputOf(snap(), { kind: 'track', id: 'trk_b' }), 'bus_a');
});

test('a bus\'s output choices: the master and the other buses, a loop among them too', () => {
  // bus_c feeds bus_b, so bus_b to bus_c would close a loop: offered all the same.
  assert.deepEqual(outputChoices(snap(), { kind: 'bus', id: 'bus_b' }), [
    { busId: null, name: null },
    { busId: 'bus_a', name: 'Delay' },
    { busId: 'bus_c', name: 'Room' },
  ]);
  assert.equal(outputOf(snap(), { kind: 'bus', id: 'bus_c' }), 'bus_b');
  assert.equal(outputOf(snap(), { kind: 'bus', id: 'bus_x' }), null);
});

test('the gates: buses, routing and sends listed on the full engine, none on the reduced one', () => {
  const full = capabilitySelector(FULL);
  assert.equal(busesListed(full), true);
  assert.equal(routingListed(full), true);
  assert.equal(sendsListed(full), true);
  const reduced = capabilitySelector(REDUCED);
  assert.equal(busesListed(reduced), false);
  assert.equal(routingListed(reduced), false);
  assert.equal(sendsListed(reduced), false);
  assert.equal(busesListed(capabilitySelector(null)), false);
  // Each needs its command too.
  const noOutput = capabilitySelector({ ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_output') });
  assert.equal(routingListed(noOutput), false);
  assert.equal(busesListed(noOutput), true);
  const noSendAdd = capabilitySelector({ ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'send.add') });
  assert.equal(sendsListed(noSendAdd), false);
  // Sends go to a bus: without features.buses there are none.
  const noBuses = capabilitySelector({ ...FULL, features: { ...FULL.features, buses: false } });
  assert.equal(sendsListed(noBuses), false);
  assert.equal(routingListed(noBuses), false);
});

test('a switch per rack the engine can show; a stored rack it cannot reads as none', () => {
  assert.deepEqual(availableRacks(capabilitySelector(FULL)), { routing: true, inserts: true, sends: true });
  assert.deepEqual(availableRacks(capabilitySelector(NO_PLUGINS)), { routing: true, inserts: false, sends: true });
  assert.deepEqual(availableRacks(capabilitySelector(REDUCED)), { routing: false, inserts: false, sends: false });
  const all = { routing: true, inserts: true, sends: true };
  for (const rack of ['routing', 'inserts', 'sends', null] as const) assert.equal(shownRack(rack, all), rack);
  assert.equal(shownRack('inserts', { routing: true, inserts: false, sends: true }), null);
  assert.equal(shownRack('sends', { routing: false, inserts: false, sends: false }), null);
});
