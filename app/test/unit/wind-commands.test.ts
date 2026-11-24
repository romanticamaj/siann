// Rewind, forward and nudge cursor (m5b-ui-keymap; UI redesign 3.1, 3.6;
// research/cubase.md 7.1): Num - and Num + (and - and = off the keypad) move
// the project cursor one bar back or on per key event, so the key's repeat
// winds; Ctrl+Num - and Ctrl+Num + (Ctrl+- and Ctrl+=) move it one step of
// the snap grid (the toolbar's grid type, Adapt to Zoom at the event
// display's zoom, snap on or not). The target is a frame for
// transport.locate: never before 0, through the tempo map. No document
// revision.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TempoPoint } from '../../src/renderer/model/document';
import { gridStepTicks, pixelsPerTick, type SnapSettings } from '../../src/renderer/timeline/snap';
import { framesToTicks, ticksToFrames } from '../../src/renderer/timeline/musical-time';
import { nudgeCursorTarget, windTarget } from '../../src/renderer/timeline/wind';

const RATE = 48000;
const STEADY: TempoPoint[] = [{ ticks: '0', milliBpm: 120_000 }];
// 120 BPM for bar 1, then 60 BPM: bar 2 starts at 96,000 frames and lasts 192,000.
const SLOWING: TempoPoint[] = [
  { ticks: '0', milliBpm: 120_000 },
  { ticks: '7680', milliBpm: 60_000 },
];

test('rewind and forward move one bar, in the tempo in force', () => {
  assert.equal(windTarget(0n, 1, STEADY, RATE), 96_000n);
  assert.equal(windTarget(100_000n, -1, STEADY, RATE), 4_000n);
  assert.equal(windTarget(100_000n, 1, STEADY, RATE), 196_000n);
  // Across a tempo change: a bar after bar 2's start is 4 s at 60 BPM.
  assert.equal(windTarget(96_000n, 1, SLOWING, RATE), 288_000n);
  assert.equal(windTarget(288_000n, -1, SLOWING, RATE), 96_000n);
  // Half a bar in (tick 3840), a bar on is tick 11520: two beats into bar 2.
  assert.equal(windTarget(48_000n, 1, SLOWING, RATE), 192_000n);
  // An empty map is 120 BPM, as a new session's.
  assert.equal(windTarget(0n, 1, [], RATE), 96_000n);
});

test('rewind stops at the project start', () => {
  assert.equal(windTarget(50_000n, -1, STEADY, RATE), 0n);
  assert.equal(windTarget(0n, -1, STEADY, RATE), 0n);
});

test('nudge cursor moves one step of the snap grid, snap on or off', () => {
  const beat: SnapSettings = { on: true, grid: 'beat', type: 'grid' };
  const bar: SnapSettings = { on: false, grid: 'bar', type: 'grid' };
  assert.equal(nudgeCursorTarget(30_000n, 1, beat, 100, STEADY, RATE), 54_000n);
  assert.equal(nudgeCursorTarget(30_000n, -1, beat, 100, STEADY, RATE), 6_000n);
  assert.equal(nudgeCursorTarget(30_000n, 1, bar, 100, STEADY, RATE), 126_000n);
  assert.equal(nudgeCursorTarget(30_000n, -1, bar, 100, STEADY, RATE), 0n);
  // Across the tempo change, a beat at 60 BPM is 48,000 frames.
  assert.equal(nudgeCursorTarget(96_000n, 1, beat, 100, SLOWING, RATE), 144_000n);
});

test('nudge cursor with Adapt to Zoom takes the grid step the event display shows at its zoom', () => {
  const adapt: SnapSettings = { on: true, grid: 'adapt', type: 'grid' };
  for (const framesPerPixel of [10, 100, 1000, 20000]) {
    const step = gridStepTicks('adapt', pixelsPerTick(framesPerPixel, STEADY, RATE, 200_000n));
    const expected = BigInt(Math.round(ticksToFrames(framesToTicks(200_000, STEADY, RATE) + step, STEADY, RATE)));
    assert.equal(nudgeCursorTarget(200_000n, 1, adapt, framesPerPixel, STEADY, RATE), expected, `${framesPerPixel} frames per pixel`);
  }
  // A closer zoom takes a smaller step.
  assert.ok(nudgeCursorTarget(200_000n, 1, adapt, 10, STEADY, RATE) < nudgeCursorTarget(200_000n, 1, adapt, 20000, STEADY, RATE));
});
