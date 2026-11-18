// Where each row of a plan's diff is shown (m5-ui-port-plans; UI redesign
// 10.10, P1-13 notes, c): under the step that names its ref, else under the
// step whose ids its change carries (a cascade), else in the card's "Other
// changes" row. Every row of the diff has a home: under each step that names
// it, else under one step or in the other row. The cascades are
// the engine's (docs/schemas/protocol-engine-v0.md, command.list:
// "track.remove": ["clip", "plugin_slot", "root", "send"]).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffRows, type PlanPreview } from '../../src/renderer/plans/diff';
import { entityHomes, idsOf, refsOf } from '../../src/renderer/plans/entity-homes';

const preview = (entities: PlanPreview['entities'], stale: PlanPreview['stale'] = []): PlanPreview => ({
  revision: 'r1',
  documentHash: 'sha256:' + '0'.repeat(64),
  stale,
  entities,
});

test('refsOf names the target of each kind of step', () => {
  assert.deepEqual(refsOf({ op: 'track.remove', trackId: 't1' }), ['track:t1', 'root:root']);
  assert.deepEqual(refsOf({ op: 'master.set_gain', gainMilliDb: -1000 }), ['master:master']);
  assert.deepEqual(refsOf({ op: 'bus.remove', busId: 'b1' }), ['bus:b1']);
  assert.deepEqual(refsOf({ op: 'send.set_level', sendId: 's1' }), ['send:s1']);
  assert.deepEqual(idsOf({ op: 'clip.place', clipId: 'c1', trackId: 't1', mediaId: 'm1', name: 'x' }), ['c1', 't1', 'm1']);
});

test("track.remove's cascade lands under the step: clips, plugin slots and sends that carry the track's id", () => {
  const rows = diffRows(
    preview([
      { ref: 'track:t1', before: { id: 't1' }, after: null },
      { ref: 'clip:c1', before: { id: 'c1', trackId: 't1' }, after: null },
      { ref: 'plugin_slot:p1', before: { id: 'p1', trackId: 't1' }, after: null },
      { ref: 'send:s1', before: { id: 's1', fromTrackId: 't1', toBusId: 'b1' }, after: null },
      { ref: 'track:t2', before: { id: 't2', gainMilliDb: 0 }, after: { id: 't2', gainMilliDb: -1000 } },
    ]),
  );
  const homes = entityHomes([{ op: 'track.set_gain', trackId: 't2', gainMilliDb: -1000 }, { op: 'track.remove', trackId: 't1' }], rows);
  assert.deepEqual(homes.steps, [[4], [0, 1, 2, 3]]);
  assert.deepEqual(homes.rest, []);
});

test("plugin.remove's track (its inserts change) lands under the step; an unchanged mention does not count", () => {
  const rows = diffRows(
    preview([
      { ref: 'plugin_slot:p1', before: { id: 'p1' }, after: null },
      { ref: 'track:t1', before: { id: 't1', name: 'p1 bus', inserts: ['p1', 'p2'] }, after: { id: 't1', name: 'p1 bus', inserts: ['p2'] } },
      // Mentions p1 only in a field the plan does not change.
      { ref: 'track:t9', before: { id: 't9', name: 'p1', gainMilliDb: 0 }, after: { id: 't9', name: 'p1', gainMilliDb: -10 } },
    ]),
  );
  const homes = entityHomes([{ op: 'plugin.remove', slotId: 'p1' }], rows);
  assert.deepEqual(homes.steps, [[0, 1]]);
  assert.deepEqual(homes.rest, [2]);
});

test('a row no step names or causes, and a stale ref the preview does not list, go to the other row; every row has one home', () => {
  const rows = diffRows(
    preview([
      { ref: 'track:t1', before: { id: 't1', mute: false }, after: { id: 't1', mute: true } },
      { ref: 'tempo:tempo', before: { id: 'tempo', bpm: 120 }, after: { id: 'tempo', bpm: 128 } },
    ]),
    [{ ref: 'clip:c7', change: 'removed' }],
  );
  const steps = [{ op: 'track.set_mute', trackId: 't1', mute: true }];
  const homes = entityHomes(steps, rows);
  assert.deepEqual(homes.steps, [[0]]);
  assert.deepEqual(homes.rest, [1, 2]);
  const all = new Set([...homes.steps.flat(), ...homes.rest]);
  assert.deepEqual([...all].sort(), rows.map((_, i) => i));
});

test('a named ref is under every step that names it, and never also a cascade', () => {
  const rows = diffRows(
    preview([
      { ref: 'clip:c1', before: { id: 'c1', trackId: 't1', start: '0' }, after: { id: 'c1', trackId: 't1', start: '10' } },
      { ref: 'track:t1', before: { id: 't1', gainMilliDb: 0, pan: 0 }, after: { id: 't1', gainMilliDb: -10, pan: 5 } },
    ]),
  );
  const steps = [{ op: 'track.set_gain', trackId: 't1', gainMilliDb: -10 }, { op: 'clip.move', clipId: 'c1' }, { op: 'track.set_pan', trackId: 't1', pan: 5 }];
  const homes = entityHomes(steps, rows);
  assert.deepEqual(homes.steps, [[1], [0], [1]]);
  assert.deepEqual(homes.rest, []);
});
