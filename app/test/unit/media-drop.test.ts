// Where a drop of N files lands (m5b-ui-media; UI redesign UR-5, 3.2): the
// pure planner of timeline/media-drop.ts. The position is the drop point's
// frame snapped as a drag snaps it (snap.ts, the same snapper the canvas
// uses), the same for every file; on track k the files go to k, k+1, ...;
// past the last track, and for every file dropped below it, a file gets a
// new track. Each file then ends as one command list: track.add (a client
// trk_ id, named after the media) when its lane is new, and clip.place with
// the media's frames as its length.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planDrop, placementCommand } from '../../src/renderer/timeline/media-drop';
import { snapperFor, DEFAULT_SNAP } from '../../src/renderer/timeline/snap';
import { laneTops, xToFrame, type Viewport } from '../../src/renderer/timeline/geometry';
import { NEW_TRACK_CHANNELS } from '../../src/renderer/timeline/track-commands';
import { media, snapshotOf, track } from './support/timeline';

const VIEW: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: 40, lanesTop: 60, laneHeight: 50, width: 1000 };
const SNAPSHOT = snapshotOf(['trk_c', 'trk_a', 'trk_b'], [track('trk_a'), track('trk_b'), track('trk_c')], [media('med_1', '48000')], []);
const tops = laneTops(SNAPSHOT.trackOrder, VIEW);
const inLane = (index: number) => tops[index]! + 10;
const below = tops[2]! + 50 + 30;

test('on track k the files go to k, k+1, ...; past the last track each further file gets a new track', () => {
  const plan = planDrop({ snapshot: SNAPSHOT, view: VIEW, snap: { on: false, grid: 'bar' }, x: 300, y: inLane(1), count: 4 })!;
  assert.deepEqual(plan.lanes, [{ trackId: 'trk_a' }, { trackId: 'trk_b' }, { trackId: null }, { trackId: null }]);
  assert.equal(plan.position, 30000n);
  const one = planDrop({ snapshot: SNAPSHOT, view: VIEW, snap: { on: false, grid: 'bar' }, x: 300, y: inLane(0), count: 2 })!;
  assert.deepEqual(one.lanes, [{ trackId: 'trk_c' }, { trackId: 'trk_a' }]);
});

test('below the last track every file gets a new track', () => {
  const plan = planDrop({ snapshot: SNAPSHOT, view: VIEW, snap: DEFAULT_SNAP, x: 300, y: below, count: 3 })!;
  assert.deepEqual(plan.lanes, [{ trackId: null }, { trackId: null }, { trackId: null }]);
  const empty = snapshotOf([], [], [], []);
  assert.deepEqual(planDrop({ snapshot: empty, view: VIEW, snap: DEFAULT_SNAP, x: 10, y: 70, count: 1 })!.lanes, [{ trackId: null }]);
});

test('a drop on the ruler or the marker row lands nowhere, and so does a drop of no file', () => {
  assert.equal(planDrop({ snapshot: SNAPSHOT, view: VIEW, snap: DEFAULT_SNAP, x: 300, y: 20, count: 1 }), null);
  assert.equal(planDrop({ snapshot: SNAPSHOT, view: VIEW, snap: DEFAULT_SNAP, x: 300, y: 50, count: 1 }), null);
  assert.equal(planDrop({ snapshot: SNAPSHOT, view: VIEW, snap: DEFAULT_SNAP, x: 300, y: inLane(0), count: 0 }), null);
});

test('every file of a drop is at the same position, snapped as a drag snaps it', () => {
  for (const snap of [DEFAULT_SNAP, { on: true, grid: 'beat' as const }, { on: true, grid: 'bar' as const }, { on: false, grid: 'bar' as const }]) {
    for (const x of [0, 37, 301, 777]) {
      const plan = planDrop({ snapshot: SNAPSHOT, view: VIEW, snap, x, y: inLane(2), count: 3 })!;
      const want = snapperFor(snap, VIEW.framesPerPixel, [], 48000, false, 0n)(xToFrame(x, VIEW));
      assert.equal(plan.position, want < 0n ? 0n : want, `${JSON.stringify(snap)} x=${x}`);
    }
  }
  // A drop left of frame 0 (the view scrolled) lands at 0.
  const scrolled = { ...VIEW, scrollFrames: '0' };
  assert.equal(planDrop({ snapshot: SNAPSHOT, view: scrolled, snap: { on: false, grid: 'bar' }, x: -20, y: inLane(0), count: 1 })!.position, 0n);
});

test('a file on an existing lane is one clip.place with the media\'s frames, at the head', () => {
  const command = placementCommand(SNAPSHOT, { trackId: 'trk_b' }, { mediaId: 'med_1', name: 'kick.wav', frames: '48000' }, 96000n, {
    trackId: () => 'trk_new',
    clipId: () => 'clp_new',
  });
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [
      { op: 'clip.place', clipId: 'clp_new', trackId: 'trk_b', mediaId: 'med_1', position: { domain: 'audio', value: '96000' }, sourceStart: '0', length: '48000' },
    ],
  });
});

test('a file on a new lane is track.add named after the media and clip.place in one command list', () => {
  const command = placementCommand(SNAPSHOT, { trackId: null }, { mediaId: 'med_1', name: 'Pad swell.wav', frames: '24000' }, 0n, {
    trackId: () => 'trk_0123456789abcdef',
    clipId: () => 'clp_0123456789abcdef',
  });
  assert.deepEqual(command.commands, [
    { op: 'track.add', trackId: 'trk_0123456789abcdef', name: 'Pad swell.wav', channels: NEW_TRACK_CHANNELS },
    {
      op: 'clip.place',
      clipId: 'clp_0123456789abcdef',
      trackId: 'trk_0123456789abcdef',
      mediaId: 'med_1',
      position: { domain: 'audio', value: '0' },
      sourceStart: '0',
      length: '24000',
    },
  ]);
  // A media without a name names its track by its id.
  const unnamed = placementCommand(SNAPSHOT, { trackId: null }, { mediaId: 'med_9', frames: '1' }, 0n);
  assert.equal(unnamed.commands[0]!.name, 'med_9');
  assert.match(String(unnamed.commands[0]!.trackId), /^trk_[0-9a-f]{16}$/);
  assert.match(String(unnamed.commands[1]!.clipId), /^clp_[0-9a-f]{16}$/);
});

test('a lane whose track went away meanwhile becomes a new track', () => {
  const command = placementCommand(SNAPSHOT, { trackId: 'trk_gone' }, { mediaId: 'med_1', name: 'a.wav', frames: '10' }, 0n, { trackId: () => 'trk_x', clipId: () => 'clp_x' });
  assert.deepEqual(command.commands.map((c) => c.op), ['track.add', 'clip.place']);
});
