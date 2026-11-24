// The marker track's commands (m5b-ui-markers; UI redesign 3.2, "Marker
// track"; docs/schemas/protocol-engine-v0.md, "Markers"): each gesture is one
// command list for one command.execute at the snapshot's revision. Insert
// adds a position marker at the cursor and Alt-click one at the pointer
// (snapped), both without a number so the engine takes the lowest free one; a
// Ctrl-drag draws a cycle marker of at least one frame; a drag moves a marker
// (snapped unless the caller passes the identity, as Ctrl does); an edge drag
// resizes a cycle marker with marker.move's length, the left edge keeping the
// end; rename and remove name the marker; a cycle marker's range is the
// locators' pair. Positions stay in 0..2^42 (the engine's bound).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MarkerEntity } from '../../src/renderer/model/document';
import type { Snapshot } from '../../src/renderer/model/read-model';
import {
  MAX_MARKER,
  addCycleCommand,
  addMarkerCommand,
  locatorsOf,
  moveMarkerCommand,
  newMarkerId,
  removeMarkerCommand,
  renameMarkerCommand,
  resizeCycleCommand,
} from '../../src/renderer/timeline/markers';
import { snapshotOf, withMarkers } from './support/timeline';

const identity = (frame: bigint) => frame;
// A stand-in grid: the nearest thousand frames.
const grid = (frame: bigint) => ((frame + 500n) / 1000n) * 1000n;

const marker = (id: string, number: number, position: string, name: string, length?: string): MarkerEntity => ({
  schema: 'siann.entity.marker.v1',
  id,
  number,
  name,
  position,
  ...(length !== undefined ? { length } : {}),
});

function session(): Snapshot {
  return withMarkers(snapshotOf([], [], [], []), [
    marker('mk_1', 1, '0', 'Intro'),
    marker('mk_2', 2, '384000', 'Verse 1'),
    marker('mk_c', 1, '960000', 'Loop', '384000'),
  ]);
}

test('Insert at the cursor and Alt-click are one marker.add {markerId, position} without a number or a name', () => {
  const s = session();
  assert.deepEqual(addMarkerCommand(s, 12345n, identity, 'mk_new'), {
    expectedRevision: 'r7',
    commands: [{ op: 'marker.add', markerId: 'mk_new', position: '12345' }],
  });
  // Alt-click: snapped.
  assert.deepEqual(addMarkerCommand(s, 12345n, grid, 'mk_new')!.commands, [{ op: 'marker.add', markerId: 'mk_new', position: '12000' }]);
  // Clamped to the engine's range.
  assert.equal(addMarkerCommand(s, -5n, identity, 'mk_new')!.commands[0]!.position, '0');
  assert.equal(addMarkerCommand(s, MAX_MARKER + 10n, identity, 'mk_new')!.commands[0]!.position, MAX_MARKER.toString());
  assert.equal(MAX_MARKER, 2n ** 42n);
});

test('a Ctrl-drag is one marker.add with a length of at least one frame; a zero-length drag sends nothing', () => {
  const s = session();
  assert.deepEqual(addCycleCommand(s, 20000n, 50000n, identity, 'mk_cyc'), {
    expectedRevision: 'r7',
    commands: [{ op: 'marker.add', markerId: 'mk_cyc', position: '20000', length: '30000' }],
  });
  // Dragged leftwards: the same range.
  assert.deepEqual(addCycleCommand(s, 50000n, 20000n, identity, 'mk_cyc')!.commands, [{ op: 'marker.add', markerId: 'mk_cyc', position: '20000', length: '30000' }]);
  // Snapped ends.
  assert.deepEqual(addCycleCommand(s, 20400n, 49600n, grid, 'mk_cyc')!.commands, [{ op: 'marker.add', markerId: 'mk_cyc', position: '20000', length: '30000' }]);
  assert.equal(addCycleCommand(s, 7000n, 7000n, identity, 'mk_cyc'), null);
  assert.equal(addCycleCommand(s, 7100n, 7300n, grid, 'mk_cyc'), null, 'both ends snap to one frame');
  assert.deepEqual(addCycleCommand(s, 7000n, 7001n, identity, 'mk_cyc')!.commands[0], { op: 'marker.add', markerId: 'mk_cyc', position: '7000', length: '1' });
  // Never past 2^42.
  const end = addCycleCommand(s, MAX_MARKER - 10n, MAX_MARKER + 50n, identity, 'mk_cyc')!.commands[0]!;
  assert.equal(BigInt(end.position as string) + BigInt(end.length as string), MAX_MARKER);
});

test('a drag moves a marker: one marker.move {markerId, position}, snapped, or not with the identity (Ctrl)', () => {
  const s = session();
  assert.deepEqual(moveMarkerCommand(s, 'mk_2', 1234n, identity), {
    expectedRevision: 'r7',
    commands: [{ op: 'marker.move', markerId: 'mk_2', position: '385234' }],
  });
  assert.deepEqual(moveMarkerCommand(s, 'mk_2', 1234n, grid)!.commands, [{ op: 'marker.move', markerId: 'mk_2', position: '385000' }]);
  // A cycle marker keeps its length: marker.move without one.
  assert.deepEqual(moveMarkerCommand(s, 'mk_c', -60000n, identity)!.commands, [{ op: 'marker.move', markerId: 'mk_c', position: '900000' }]);
  // Stopped at 0, and a cycle marker's end at 2^42.
  assert.equal(moveMarkerCommand(s, 'mk_2', -10_000_000n, identity)!.commands[0]!.position, '0');
  assert.equal(moveMarkerCommand(s, 'mk_c', MAX_MARKER, identity)!.commands[0]!.position, (MAX_MARKER - 384000n).toString());
  // Nothing for no movement, a snap back to where it was, or an unknown marker.
  assert.equal(moveMarkerCommand(s, 'mk_2', 0n, identity), null);
  assert.equal(moveMarkerCommand(s, 'mk_2', 300n, grid), null);
  assert.equal(moveMarkerCommand(s, 'mk_gone', 1000n, identity), null);
});

test('an edge drag resizes a cycle marker: marker.move with position and length; the left edge keeps the end; never below one frame', () => {
  const s = session();
  // mk_c: 960000 + 384000 = 1344000.
  assert.deepEqual(resizeCycleCommand(s, 'mk_c', 'right', 1440000n, identity), {
    expectedRevision: 'r7',
    commands: [{ op: 'marker.move', markerId: 'mk_c', position: '960000', length: '480000' }],
  });
  assert.deepEqual(resizeCycleCommand(s, 'mk_c', 'left', 864000n, identity)!.commands, [{ op: 'marker.move', markerId: 'mk_c', position: '864000', length: '480000' }]);
  assert.deepEqual(resizeCycleCommand(s, 'mk_c', 'left', 1000400n, grid)!.commands, [{ op: 'marker.move', markerId: 'mk_c', position: '1000000', length: '344000' }]);
  // Past the other end: one frame long.
  assert.deepEqual(resizeCycleCommand(s, 'mk_c', 'left', 2000000n, identity)!.commands, [{ op: 'marker.move', markerId: 'mk_c', position: '1343999', length: '1' }]);
  assert.deepEqual(resizeCycleCommand(s, 'mk_c', 'right', 10n, identity)!.commands, [{ op: 'marker.move', markerId: 'mk_c', position: '960000', length: '1' }]);
  // The right end stops at 2^42.
  assert.deepEqual(resizeCycleCommand(s, 'mk_c', 'right', MAX_MARKER + 9n, identity)!.commands, [{ op: 'marker.move', markerId: 'mk_c', position: '960000', length: (MAX_MARKER - 960000n).toString() }]);
  // Nothing at the same size, on a position marker or an unknown one.
  assert.equal(resizeCycleCommand(s, 'mk_c', 'right', 1344000n, identity), null);
  assert.equal(resizeCycleCommand(s, 'mk_2', 'right', 500000n, identity), null);
  assert.equal(resizeCycleCommand(s, 'mk_gone', 'right', 500000n, identity), null);
});

test('rename is one marker.rename and remove one marker.remove; nothing for the same name or an unknown marker', () => {
  const s = session();
  assert.deepEqual(renameMarkerCommand(s, 'mk_2', 'Verse 2'), { expectedRevision: 'r7', commands: [{ op: 'marker.rename', markerId: 'mk_2', name: 'Verse 2' }] });
  assert.deepEqual(renameMarkerCommand(s, 'mk_2', '')!.commands, [{ op: 'marker.rename', markerId: 'mk_2', name: '' }]);
  assert.equal(renameMarkerCommand(s, 'mk_2', 'Verse 1'), null);
  assert.equal(renameMarkerCommand(s, 'mk_gone', 'X'), null);
  assert.deepEqual(removeMarkerCommand(s, 'mk_c'), { expectedRevision: 'r7', commands: [{ op: 'marker.remove', markerId: 'mk_c' }] });
  assert.equal(removeMarkerCommand(s, 'mk_gone'), null);
});

test("a cycle marker's locators are its range (one session.set_locators); a position marker has none", () => {
  const s = session();
  const cycle = s.entities['marker:mk_c'] as MarkerEntity;
  assert.deepEqual(locatorsOf(cycle), { left: 960000n, right: 1344000n });
  assert.equal(locatorsOf(s.entities['marker:mk_2'] as MarkerEntity), null);
});

test('new marker ids are mk_ and 16 hex digits, different each time', () => {
  const a = newMarkerId();
  assert.match(a, /^mk_[0-9a-f]{16}$/);
  assert.notEqual(a, newMarkerId());
});
