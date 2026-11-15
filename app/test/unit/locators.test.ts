// The locators of the ruler's upper half (m5-ui-loop-click; UI redesign spec
// 3.2, "Ruler" and "Setting one locator"): the band's geometry, what a point
// of the upper half is over, and the range each gesture or key ends in, never
// one the engine refuses (invalid_locators: 0 <= left < right <= 2^42,
// docs/schemas/protocol-engine-v0.md). The band's height comes from the one
// exported ruler constant; nothing here hard-codes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RULER_HEIGHT, RULER_UPPER, type Viewport } from '../../src/renderer/timeline/geometry';
import {
  BAND_BOTTOM_GAP,
  BAND_LINE,
  BAND_TOP,
  END_HIT_PX,
  FLAG_W,
  LABEL_INSET,
  MAX_LOCATOR,
  bandRect,
  barBeat,
  dragEnd,
  drawRange,
  formatLocators,
  fromSelection,
  locatorHit,
  moveRange,
  rangeOf,
  setLeft,
  setRight,
  type LocatorGrid,
} from '../../src/renderer/timeline/locators';
import { snapperFor } from '../../src/renderer/timeline/snap';
import { TOKENS } from '../../src/renderer/tokens';

const view = (over: Partial<Viewport> = {}): Viewport => ({
  framesPerPixel: 100,
  scrollFrames: '0',
  rulerHeight: RULER_HEIGHT,
  laneHeight: 53,
  width: 1000,
  height: 400,
  ...over,
});

// Snap off: frames stay, an end keeps one pixel's frames from the other.
const OFF: LocatorGrid = { snap: (f) => f, minGap: () => 100n };
// A 1000-frame grid: frames go to the nearest multiple, the gap is a step.
const GRID: LocatorGrid = { snap: (f) => ((f + 500n) / 1000n) * 1000n, minGap: () => 1000n };

test('the upper half is the exported constant, the ruler-upper-h token', () => {
  assert.equal(RULER_UPPER, Number.parseFloat(TOKENS['ruler-upper-h']));
  assert.ok(RULER_UPPER > 0 && RULER_UPPER < RULER_HEIGHT);
});

// The band's drawing parameters are tokens with the mockup's draw() values
// (RU=18: the band at y 2, height RU-3, a 2 px line, 8 px flags, labels 10 px
// in), so the band is the mockup's 15 px tall at y 2.
test('the band\'s drawing parameters are the --locator-* tokens, the mockup\'s values', () => {
  const token = (name: keyof typeof TOKENS): number => Number.parseFloat(TOKENS[name]);
  assert.deepEqual(
    { BAND_TOP, BAND_BOTTOM_GAP, BAND_LINE, FLAG_W, LABEL_INSET, END_HIT_PX },
    {
      BAND_TOP: token('locator-band-top'),
      BAND_BOTTOM_GAP: token('locator-band-gap'),
      BAND_LINE: token('locator-band-line'),
      FLAG_W: token('locator-flag-w'),
      LABEL_INSET: token('locator-label-inset'),
      END_HIT_PX: token('locator-end-hit'),
    },
  );
  assert.deepEqual([BAND_TOP, BAND_BOTTOM_GAP, BAND_LINE, FLAG_W, LABEL_INSET], [2, 1, 2, 8, 10]);
  const rect = bandRect({ left: 0n, right: 48000n }, view())!;
  assert.deepEqual({ y: rect.y, height: rect.height }, { y: 2, height: 15 });
});

test('the band spans the locators in the upper half, at the view\'s zoom and scroll', () => {
  const range = { left: 4800n, right: 24000n };
  assert.deepEqual(bandRect(range, view()), { x: 48, y: BAND_TOP, width: 192, height: RULER_UPPER - BAND_TOP - 1 });
  // Scrolled by 1000 frames and zoomed to 50 frames per pixel.
  assert.deepEqual(bandRect(range, view({ scrollFrames: '1000', framesPerPixel: 50 })), {
    x: 76,
    y: BAND_TOP,
    width: 384,
    height: RULER_UPPER - BAND_TOP - 1,
  });
  assert.equal(bandRect(null, view()), null);
  // It never reaches into the lower half.
  const rect = bandRect(range, view())!;
  assert.ok(rect.y + rect.height < RULER_UPPER);
});

test('hit zones: the left end, the right end, the body, outside', () => {
  const range = { left: 10000n, right: 30000n }; // x 100 .. 300
  const y = RULER_UPPER / 2;
  assert.equal(locatorHit(range, view(), 100, y), 'left');
  assert.equal(locatorHit(range, view(), 100 + END_HIT_PX, y), 'left');
  assert.equal(locatorHit(range, view(), 100 - END_HIT_PX, y), 'left');
  assert.equal(locatorHit(range, view(), 300, y), 'right');
  assert.equal(locatorHit(range, view(), 300 - END_HIT_PX, y), 'right');
  assert.equal(locatorHit(range, view(), 200, y), 'body');
  assert.equal(locatorHit(range, view(), 50, y), 'outside');
  assert.equal(locatorHit(range, view(), 400, y), 'outside');
  // Below the upper half, and without locators, nothing is hit.
  assert.equal(locatorHit(range, view(), 200, RULER_UPPER), 'outside');
  assert.equal(locatorHit(null, view(), 200, y), 'outside');
  // A band narrower than both zones: the nearer end.
  const narrow = { left: 10000n, right: 10600n }; // x 100 .. 106
  assert.equal(locatorHit(narrow, view(), 101, y), 'left');
  assert.equal(locatorHit(narrow, view(), 105, y), 'right');
});

test('drawing a range: both ends snap with snap on, stay with it off, in either direction', () => {
  assert.deepEqual(drawRange(1200n, 4400n, GRID), { left: 1000n, right: 4000n });
  assert.deepEqual(drawRange(4400n, 1200n, GRID), { left: 1000n, right: 4000n });
  assert.deepEqual(drawRange(1200n, 4400n, OFF), { left: 1200n, right: 4400n });
  // Through the clips' snap (snap.ts), Bar grid at 120 BPM: a bar is 96000 frames.
  const bar = snapperFor({ on: true, grid: 'bar' }, 100, [], 48000);
  assert.deepEqual(drawRange(90000n, 200000n, { snap: bar, minGap: () => 96000n }), { left: 96000n, right: 192000n });
});

test('a range of zero length sets nothing', () => {
  assert.equal(drawRange(3000n, 3000n, OFF), null);
  // Snapped to the same line.
  assert.equal(drawRange(1100n, 1300n, GRID), null);
});

test('moving keeps the length and stops at 0 and at 2^42', () => {
  const range = { left: 10000n, right: 30000n };
  assert.deepEqual(moveRange(range, 5000n, OFF), { left: 15000n, right: 35000n });
  assert.deepEqual(moveRange(range, -50000n, OFF), { left: 0n, right: 20000n });
  assert.deepEqual(moveRange(range, 5300n, GRID), { left: 15000n, right: 35000n });
  assert.deepEqual(moveRange(range, MAX_LOCATOR, OFF), { left: MAX_LOCATOR - 20000n, right: MAX_LOCATOR });
});

test('an end dragged past the other stops one grid step (one pixel with snap off) before it', () => {
  const range = { left: 10000n, right: 30000n };
  assert.deepEqual(dragEnd(range, 'left', 12000n, OFF), { left: 12000n, right: 30000n });
  assert.deepEqual(dragEnd(range, 'left', 50000n, OFF), { left: 29900n, right: 30000n });
  assert.deepEqual(dragEnd(range, 'right', 0n, OFF), { left: 10000n, right: 10100n });
  assert.deepEqual(dragEnd(range, 'left', 50000n, GRID), { left: 29000n, right: 30000n });
  assert.deepEqual(dragEnd(range, 'right', 2000n, GRID), { left: 10000n, right: 11000n });
  assert.deepEqual(dragEnd(range, 'right', 41400n, GRID), { left: 10000n, right: 41000n });
});

test('setting one locator follows spec 3.2', () => {
  // No locators: the right one gives 0..position, the left one nothing.
  assert.deepEqual(setRight(null, 48000n), { left: 0n, right: 48000n });
  assert.equal(setLeft(null, 48000n), null);
  // The right one at 0 with none set would not leave left < right.
  assert.equal(setRight(null, 0n), null);
  const range = { left: 10000n, right: 30000n };
  assert.deepEqual(setLeft(range, 20000n), { left: 20000n, right: 30000n });
  assert.deepEqual(setRight(range, 20000n), { left: 10000n, right: 20000n });
  // Anything that does not leave left < right gives nothing.
  assert.equal(setLeft(range, 30000n), null);
  assert.equal(setLeft(range, 40000n), null);
  assert.equal(setRight(range, 10000n), null);
  assert.equal(setRight(range, 5000n), null);
  // 2^42 is the upper bound.
  assert.deepEqual(setRight(range, MAX_LOCATOR), { left: 10000n, right: MAX_LOCATOR });
  assert.equal(setRight(range, MAX_LOCATOR + 1n), null);
});

test('P takes the selection\'s span, and nothing without a selection', () => {
  assert.deepEqual(fromSelection({ start: 4800n, end: 72000n }), { left: 4800n, right: 72000n });
  assert.equal(fromSelection(null), null);
  assert.equal(fromSelection({ start: 0n, end: 0n }), null);
  assert.equal(fromSelection({ start: 0n, end: MAX_LOCATOR + 1n }), null);
});

test('the document entity reads as a range, and the display reads it in bars and beats', () => {
  assert.deepEqual(rangeOf({ left: '384000', right: '576000' }), { left: 384000n, right: 576000n });
  assert.equal(rangeOf(null), null);
  assert.equal(rangeOf({ left: '-1', right: '2' }), null);
  // 120 BPM at 48 kHz: a bar is 2 s. Bars 9.1 and 13.1.
  assert.equal(formatLocators({ left: 8n * 96000n, right: 12n * 96000n }, [], 48000), '9.1 – 13.1');
  assert.equal(barBeat(96000n + 24000n, [], 48000), '2.2');
  // Across a tempo change: 60 BPM from bar 3 (frame 192000), a beat is 1 s.
  const tempo = [
    { ticks: '0', milliBpm: 120000 },
    { ticks: String(2 * 7680), milliBpm: 60000 },
  ];
  assert.equal(formatLocators({ left: 192000n, right: 192000n + 48000n * 5n }, tempo, 48000), '3.1 – 4.2');
});
