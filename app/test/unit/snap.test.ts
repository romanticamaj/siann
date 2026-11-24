// Snap type Grid (m5-ui-edit-basics; UI redesign spec 3.2, 4.5 C10 and P1-8):
// grid types Bar (7680 ticks), Beat (1920) and Adapt to Zoom (the finest of a
// 1/64 note up to a bar whose lines are at least SNAP_MIN_PX apart at the
// zoom), through root.tempo with the conversions of musical-time.ts. A frame
// snaps to the nearest grid line, never before 0; snap off, or Ctrl held
// while resizing, leaves it alone. A moved selection takes the delta that
// puts the dragged clip's start on the grid.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TempoPoint } from '../../src/renderer/model/document';
import { framesToTicks, ticksToFrames } from '../../src/renderer/timeline/musical-time';
import {
  ADAPT_STEPS_TICKS,
  DEFAULT_SNAP,
  SNAP_MAGNET_PX,
  SNAP_MIN_PX,
  SNAP_TYPES,
  isSnapType,
  moveSnapperFor,
  snapContext,
  gridStepTicks,
  pixelsPerTick,
  snapFrame,
  snappedMoveDelta,
  snapperFor,
} from '../../src/renderer/timeline/snap';
import { moveSelectionCommand } from '../../src/renderer/timeline/edit-commands';
import { clip, marker, media, snapshotOf, track, withMarkers } from './support/timeline';

const RATE = 48000;
const NO_TEMPO: readonly TempoPoint[] = [];

test('Bar is 7680 ticks and Beat 1920; Adapt to Zoom steps run from a 1/64 note to a bar', () => {
  assert.equal(gridStepTicks('bar'), 7680);
  assert.equal(gridStepTicks('beat'), 1920);
  assert.deepEqual([...ADAPT_STEPS_TICKS], [120, 240, 480, 960, 1920, 7680]);
  assert.equal(SNAP_MIN_PX, 10);
});

test('Adapt to Zoom takes the finest step at least SNAP_MIN_PX apart, Bar when none is', () => {
  // 120 BPM at 48 kHz: 12.5 frames per tick.
  const table: Array<[number, number]> = [
    [1, 120],
    [100, 120],
    [200, 240],
    [400, 480],
    [800, 960],
    [1600, 1920],
    [3200, 7680],
    [10000, 7680],
    [1 << 20, 7680],
  ];
  let previous = 0;
  for (const [fpp, step] of table) {
    const px = pixelsPerTick(fpp, NO_TEMPO, RATE);
    assert.equal(px, 12.5 / fpp, `px per tick at ${fpp}`);
    const got = gridStepTicks('adapt', px);
    assert.equal(got, step, `${fpp} frames per pixel`);
    assert.ok(got >= previous, 'zooming out never makes the step finer');
    assert.ok(got >= 120 && got <= 7680, 'never below 1/64 or above a bar');
    previous = got;
  }
});

test('a frame snaps to the nearest grid line', () => {
  assert.equal(snapFrame(190000n, 7680, NO_TEMPO, RATE), 192000n, 'bar 3');
  assert.equal(snapFrame(30000n, 1920, NO_TEMPO, RATE), 24000n, 'beat 2');
  assert.equal(snapFrame(40000n, 1920, NO_TEMPO, RATE), 48000n);
  assert.equal(snapFrame(1600n, 120, NO_TEMPO, RATE), 1500n, 'a 1/64 note is 1500 frames');
  assert.equal(snapFrame(-5000n, 7680, NO_TEMPO, RATE), 0n, 'never negative');
  assert.equal(snapFrame(0n, 7680, NO_TEMPO, RATE), 0n);
});

test('across a tempo change the line is ticksToFrames of a multiple of the step', () => {
  // 120 BPM for two bars, then 60 BPM: bar 3 is at 96000 + 7680 * 25 frames.
  const tempo: TempoPoint[] = [
    { ticks: '0', milliBpm: 120000 },
    { ticks: '7680', milliBpm: 60000 },
  ];
  const bar3 = BigInt(ticksToFrames(2 * 7680, tempo, RATE));
  assert.equal(bar3, 288000n);
  assert.equal(snapFrame(280000n, 7680, tempo, RATE), bar3);
  const beat = snapFrame(130000n, 1920, tempo, RATE);
  assert.equal(framesToTicks(Number(beat), tempo, RATE) % 1920, 0);
  // Slower after the change: fewer pixels per tick there.
  assert.equal(pixelsPerTick(100, tempo, RATE, 200000n), 25 / 100);
});

test('snap off, or the ignore flag, leaves the frame alone', () => {
  const on = snapperFor({ on: true, grid: 'bar' }, 100, NO_TEMPO, RATE);
  assert.equal(on(190000n), 192000n);
  const off = snapperFor({ on: false, grid: 'bar' }, 100, NO_TEMPO, RATE);
  assert.equal(off(190000n), 190000n);
  const ignored = snapperFor({ on: true, grid: 'bar' }, 100, NO_TEMPO, RATE, true);
  assert.equal(ignored(190000n), 190000n);
  // Adapt at 100 frames per pixel: 1/64 notes (1500 frames).
  const adapt = snapperFor({ on: true, grid: 'adapt' }, 100, NO_TEMPO, RATE);
  assert.equal(adapt(8000n), 7500n);
  const zoomedOut = snapperFor({ on: true, grid: 'adapt' }, 200, NO_TEMPO, RATE);
  assert.equal(zoomedOut(8000n), 9000n, 'the same drag lands on a 1/32 note zoomed out');
});

test('a snapped move puts the dragged clip\'s start on the grid and moves the rest by the same delta', () => {
  const bar = snapperFor({ on: true, grid: 'bar' }, 100, NO_TEMPO, RATE);
  // The dragged clip starts at 4800 and is dropped 90000 frames later: bar 2 (96000).
  const delta = snappedMoveDelta(4800n, 90000n, bar);
  assert.equal(delta, 91200n);
  const snapshot = snapshotOf(
    ['trk_a', 'trk_b'],
    [track('trk_a'), track('trk_b')],
    [media('med_sq', '48000')],
    [clip('clp_1', 'trk_a', 'med_sq', '4800', '0', '24000'), clip('clp_2', 'trk_b', 'med_sq', '30000', '0', '24000')],
  );
  const command = moveSelectionCommand(snapshot, ['clp_1', 'clp_2'], delta, 0);
  assert.deepEqual(command!.commands.map((c) => (c.position as { value: string }).value), ['96000', '121200']);
  // Never before 0: a drag far left snaps the start to 0.
  assert.equal(snappedMoveDelta(4800n, -90000n, bar), -4800n);
  const off = snapperFor({ on: false, grid: 'bar' }, 100, NO_TEMPO, RATE);
  assert.equal(snappedMoveDelta(4800n, 90000n, off), 90000n);
});

// ---- m5b-ui-edit-more (UI redesign spec 3.2, "Snap types"): Grid Relative,
// Events and Magnetic Cursor. The tolerance is SNAP_MAGNET_PX at the zoom.

test('the snap types are Grid, Grid Relative, Events and Magnetic Cursor; Grid by default', () => {
  assert.deepEqual([...SNAP_TYPES], ['grid', 'gridRelative', 'events', 'cursor']);
  for (const type of SNAP_TYPES) assert.ok(isSnapType(type), type);
  for (const bad of ['shuffle', 'Grid', '', null, 3]) assert.ok(!isSnapType(bad), String(bad));
  assert.equal(DEFAULT_SNAP.type, 'grid');
  assert.equal(SNAP_MAGNET_PX, 8);
});

test('Grid is unchanged by the type field: absent or grid, the same lines', () => {
  const plain = snapperFor({ on: true, grid: 'bar' }, 100, NO_TEMPO, RATE);
  const typed = snapperFor({ on: true, grid: 'bar', type: 'grid' }, 100, NO_TEMPO, RATE);
  for (const frame of [0n, 47999n, 48000n, 190000n, 1000000n]) assert.equal(typed(frame), plain(frame), String(frame));
  const move = moveSnapperFor({ on: true, grid: 'bar', type: 'grid' }, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE });
  assert.equal(move(4800n, 24000n, 90000n), snappedMoveDelta(4800n, 90000n, plain));
});

test('Grid Relative keeps the start\'s offset from its grid line: the delta is a whole number of steps', () => {
  const settings = { on: true, grid: 'bar', type: 'gridRelative' } as const;
  const move = moveSnapperFor(settings, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE });
  // A bar is 96000 frames: 150000 is nearer two bars than one.
  assert.equal(move(100000n, 24000n, 150000n), 192000n);
  assert.equal(move(100000n, 24000n, 140000n), 96000n);
  assert.equal(move(100000n, 24000n, 40000n), 0n, 'less than half a step: no move');
  assert.equal(move(100000n, 24000n, -60000n), -96000n);
  for (const delta of [-60000n, 10000n, 150000n, 400000n]) assert.equal(move(100000n, 24000n, delta) % 96000n, 0n, String(delta));
  // The offset from the grid line (4000 past bar 2) survives the move.
  assert.equal((100000n + move(100000n, 24000n, 150000n)) % 96000n, 100000n % 96000n);
  // Never before the timeline's start: the whole steps that fit.
  assert.equal(move(100000n, 24000n, -300000n), -96000n);
  // Beat steps (24000 frames).
  const beat = moveSnapperFor({ ...settings, grid: 'beat' }, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE });
  assert.equal(beat(1000n, 24000n, 37000n), 48000n);
  // A single frame (a resize, a split) snaps as Grid does.
  assert.equal(snapperFor(settings, 100, NO_TEMPO, RATE)(190000n), 192000n);
});

test('Events: the nearest start or end of another clip within SNAP_MAGNET_PX at the zoom, else the frame itself', () => {
  const settings = { on: true, grid: 'bar', type: 'events' } as const;
  const context = { edges: [10000n, 34000n, 90000n], cursor: null };
  // 100 frames per pixel: 800 frames of tolerance.
  const near = snapperFor(settings, 100, NO_TEMPO, RATE, false, 0n, context);
  assert.equal(near(10500n), 10000n);
  assert.equal(near(33300n), 34000n);
  assert.equal(near(10800n), 10000n, 'the tolerance\'s edge is in');
  assert.equal(near(10801n), 10801n, 'outside it the frame stays, no grid');
  assert.equal(near(60000n), 60000n);
  // Zoomed out (1000 frames per pixel): 8000 frames.
  const far = snapperFor(settings, 1000, NO_TEMPO, RATE, false, 0n, context);
  assert.equal(far(17000n), 10000n);
  assert.equal(far(19000n), 19000n);
  assert.equal(far(26500n), 34000n, 'the nearer edge wins');
  // A move tries the start, then the end.
  const move = moveSnapperFor(settings, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE, context });
  assert.equal(move(0n, 5000n, 9600n), 10000n, 'the start meets an edge');
  assert.equal(move(50000n, 5000n, 35500n), 35000n, 'the end meets 90000');
  assert.equal(move(50000n, 5000n, 20000n), 20000n, 'nothing in reach: the drag as it is');
});

test('Events never snaps to a clip being dragged; the context lists the other clips\' edges', () => {
  const snapshot = snapshotOf(
    ['trk_a', 'trk_b'],
    [track('trk_a'), track('trk_b')],
    [media('med_sq', '48000')],
    [clip('clp_1', 'trk_a', 'med_sq', '4800', '0', '24000'), clip('clp_2', 'trk_b', 'med_sq', '30000', '0', '24000'), clip('clp_3', 'trk_a', 'med_sq', '90000', '0', '1000')],
  );
  const context = snapContext(snapshot, ['clp_1'], 12345n);
  assert.deepEqual([...context.edges].sort((a, b) => (a < b ? -1 : 1)), [30000n, 54000n, 90000n, 91000n]);
  assert.equal(context.cursor, 12345n);
  const events = snapperFor({ on: true, grid: 'bar', type: 'events' }, 100, NO_TEMPO, RATE, false, 0n, context);
  assert.equal(events(4900n), 4900n, 'clp_1\'s own start is not a target');
  assert.equal(events(29500n), 30000n);
});

// m5b-ui-markers (UI redesign 3.2, "Snap types"): Events is magnetic to the
// position markers and to the start and end of each cycle marker too; a
// dragged marker is not a target of its own drag; Grid does not change.
test('Events reaches position markers and both ends of cycle markers; the dragged marker is excluded; Grid is unchanged', () => {
  const base = snapshotOf(['trk_a'], [track('trk_a')], [media('med_sq', '48000')], [clip('clp_1', 'trk_a', 'med_sq', '4800', '0', '24000')]);
  const snapshot = withMarkers(base, [marker('mk_1', 1, '60000', 'Verse'), marker('mk_2', 2, '150000', 'Chorus'), marker('mk_c', 1, '200000', 'Loop', '40000')]);
  const sorted = (edges: readonly bigint[]) => [...edges].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(sorted(snapContext(snapshot, [], null).edges), [4800n, 28800n, 60000n, 150000n, 200000n, 240000n]);
  // The dragged marker (by id) is not a target; a dragged clip still is not either.
  assert.deepEqual(sorted(snapContext(snapshot, ['mk_2'], null).edges), [4800n, 28800n, 60000n, 200000n, 240000n]);
  assert.deepEqual(sorted(snapContext(snapshot, ['mk_c', 'clp_1'], null).edges), [60000n, 150000n]);
  const events = snapperFor({ on: true, grid: 'bar', type: 'events' }, 100, NO_TEMPO, RATE, false, 0n, snapContext(snapshot, [], null));
  assert.equal(events(60500n), 60000n, 'onto a position marker');
  assert.equal(events(199300n), 200000n, 'onto a cycle marker\'s start');
  assert.equal(events(240600n), 240000n, 'onto its end');
  const move = moveSnapperFor({ on: true, grid: 'bar', type: 'events' }, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE, context: snapContext(snapshot, ['clp_1'], null) });
  assert.equal(move(4800n, 24000n, 55500n), 55200n, 'a clip\'s start lands on a marker');
  // Grid ignores the markers.
  const gridSnap = snapperFor({ on: true, grid: 'bar', type: 'grid' }, 100, NO_TEMPO, RATE, false, 0n, snapContext(snapshot, [], null));
  assert.equal(gridSnap(60500n), 96000n);
  assert.equal(gridSnap(150000n), 192000n);
});

test('Magnetic Cursor: the project cursor within the tolerance, else the frame itself', () => {
  const settings = { on: true, grid: 'bar', type: 'cursor' } as const;
  const context = { edges: [10000n], cursor: 50000n };
  const snap = snapperFor(settings, 100, NO_TEMPO, RATE, false, 0n, context);
  assert.equal(snap(50700n), 50000n);
  assert.equal(snap(49300n), 50000n);
  assert.equal(snap(10100n), 10100n, 'clip edges are not targets of this type');
  assert.equal(snap(52000n), 52000n);
  const move = moveSnapperFor(settings, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE, context });
  assert.equal(move(0n, 24000n, 49500n), 50000n, 'the start onto the cursor');
  assert.equal(move(0n, 24000n, 26300n), 26000n, 'the end onto the cursor');
  // No cursor: nothing is magnetic.
  assert.equal(snapperFor(settings, 100, NO_TEMPO, RATE, false, 0n, { edges: [], cursor: null })(50100n), 50100n);
});

test('snap off or the ignore flag is the identity for every type', () => {
  const context = { edges: [10000n], cursor: 50000n };
  for (const type of SNAP_TYPES) {
    for (const [on, ignore] of [[false, false], [true, true]] as const) {
      const snap = snapperFor({ on, grid: 'bar', type }, 100, NO_TEMPO, RATE, ignore, 0n, context);
      for (const frame of [10100n, 50100n, 190000n]) assert.equal(snap(frame), frame, `${type} ${on} ${ignore}`);
      const move = moveSnapperFor({ on, grid: 'bar', type }, { framesPerPixel: 100, tempo: NO_TEMPO, sampleRate: RATE, context }, ignore);
      assert.equal(move(100000n, 1000n, 49900n), 49900n, `${type} move`);
      assert.equal(move(100000n, 1000n, -200000n), -100000n, `${type}: never before 0`);
    }
  }
});
