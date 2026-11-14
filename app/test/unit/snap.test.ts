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
  SNAP_MIN_PX,
  gridStepTicks,
  pixelsPerTick,
  snapFrame,
  snappedMoveDelta,
  snapperFor,
} from '../../src/renderer/timeline/snap';
import { moveSelectionCommand } from '../../src/renderer/timeline/edit-commands';
import { clip, media, snapshotOf, track } from './support/timeline';

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
