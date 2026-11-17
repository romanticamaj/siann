// Bars and beats on the ruler (m5-ui-arrange; UI redesign spec 3.2): sample
// frames to bars.beats.ticks through root.tempo in 4/4, and the subdivision
// the ruler labels at a zoom. Ticks per quarter is the engine's
// (native/libs/time/include/siann/time/time.hpp, kTicksPerQuarter = 1920); a
// tempo point is {ticks, milliBpm}, 120 BPM being 120000
// (tempo_map.hpp). Expected values are worked out by hand below.
// Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TICKS_PER_QUARTER,
  formatBbt,
  formatBbtLength,
  framesToTicks,
  ticksToFrames,
} from '../../src/renderer/timeline/musical-time';
import { chooseRulerStep, rulerMarks, RULER_BAR_LABEL_PX, RULER_MIN_LABEL_PX } from '../../src/renderer/timeline/ruler';
import type { TempoPoint } from '../../src/renderer/model/document';
import type { Viewport } from '../../src/renderer/timeline/geometry';
import { RULER_HEIGHT, RULER_LOWER, RULER_UPPER } from '../../src/renderer/timeline/TimelineCanvas';
import { TOKENS } from '../../src/renderer/tokens';

const RATE = 48000;
const T120: readonly TempoPoint[] = [{ ticks: '0', milliBpm: 120000 }];
// 120 BPM for the first bar (7680 ticks), then 60 BPM.
const CHANGE: readonly TempoPoint[] = [
  { ticks: '0', milliBpm: 120000 },
  { ticks: '7680', milliBpm: 60000 },
];

test('ticks per quarter is the engine\'s 1920', () => {
  assert.equal(TICKS_PER_QUARTER, 1920);
});

test('at 120 BPM and 48 kHz a quarter is 24000 frames: frame 192000 is bar 3 beat 1', () => {
  // 60 s / 120 = 0.5 s per quarter = 24000 frames = 1920 ticks: 12.5 frames per tick.
  assert.equal(framesToTicks(24000, T120, RATE), 1920);
  assert.equal(framesToTicks(192000, T120, RATE), 15360);
  assert.equal(formatBbt(framesToTicks(192000, T120, RATE)), '3.1.000');
  assert.equal(formatBbt(framesToTicks(0, T120, RATE)), '1.1.000');
  // Half a quarter into beat 2 of bar 1: 24000 + 12000 frames = 1920 + 960 ticks.
  assert.equal(formatBbt(framesToTicks(36000, T120, RATE)), '1.2.960');
  assert.equal(ticksToFrames(15360, T120, RATE), 192000);
});

test('a tempo change mid-session: bar 2 at 60 BPM is twice as long', () => {
  // Bar 1 at 120 BPM: 7680 ticks * 12.5 = 96000 frames. At 60 BPM a tick is 25 frames.
  assert.equal(framesToTicks(96000, CHANGE, RATE), 7680);
  assert.equal(formatBbt(framesToTicks(96000, CHANGE, RATE)), '2.1.000');
  // One quarter later at 60 BPM: 96000 + 1920 * 25 = 144000.
  assert.equal(formatBbt(framesToTicks(144000, CHANGE, RATE)), '2.2.000');
  // Bar 3: 96000 + 7680 * 25 = 288000.
  assert.equal(formatBbt(framesToTicks(288000, CHANGE, RATE)), '3.1.000');
  assert.equal(ticksToFrames(15360, CHANGE, RATE), 288000);
  assert.equal(ticksToFrames(3840, CHANGE, RATE), 48000, 'inside the first segment');
});

test('an empty tempo list reads as 120 BPM', () => {
  assert.equal(framesToTicks(192000, [], RATE), 15360);
  assert.equal(ticksToFrames(1920, [], RATE), 24000);
});

test('a length reads as bars.beats.ticks counted from zero', () => {
  assert.equal(formatBbtLength(0), '0.0.000');
  assert.equal(formatBbtLength(1920 * 2 + 480), '0.2.480');
  assert.equal(formatBbtLength(7680 * 3 + 1920), '3.1.000');
});

test('the subdivision gets finer as the frames per pixel fall, labels at least the minimum apart', () => {
  // px per tick = 12.5 frames per tick / frames per pixel.
  const at = (framesPerPixel: number) => chooseRulerStep(12.5 / framesPerPixel);
  // 1000 frames/px: a bar is 96000 frames = 96 px.
  assert.deepEqual(at(1000), { ticks: 7680, kind: 'bar' });
  // 10000 frames/px: a bar is 9.6 px; four bars 38.4, eight bars 76.8.
  assert.deepEqual(at(10000), { ticks: 7680 * 8, kind: 'bar' });
  // 200 frames/px: a beat is 24000 / 200 = 120 px, an eighth 60 (under 64).
  assert.deepEqual(at(200), { ticks: 1920, kind: 'beat' });
  // 20 frames/px: an eighth (960 ticks) is 600 px, a 32nd (240 ticks) 150 px.
  assert.deepEqual(at(20), { ticks: 240, kind: 'sub' });
  // 100 frames/px: a beat is 240 px; an eighth 120; a sixteenth 60, under the 64 px minimum.
  assert.deepEqual(at(100), { ticks: 960, kind: 'sub' });
  assert.equal(RULER_MIN_LABEL_PX, 64);
  assert.equal(RULER_BAR_LABEL_PX, 40);
  for (const fpp of [1, 20, 100, 200, 1000, 10000, 100000]) {
    const step = at(fpp);
    const px = (step.ticks * 12.5) / fpp;
    const min = step.kind === 'bar' ? RULER_BAR_LABEL_PX : RULER_MIN_LABEL_PX;
    assert.ok(px >= min || step.ticks === 7680 * 64, `${fpp}: ${px} px`);
  }
});

// The mockup's draw() labels every bar at its 40 px per bar (PXB): bar
// numbers stay at least RULER_BAR_LABEL_PX apart, the finer labels
// RULER_MIN_LABEL_PX.
test("bar numbers: every bar at draw()'s 40 px per bar, every other bar just below it", () => {
  const at = (framesPerPixel: number) => chooseRulerStep(12.5 / framesPerPixel);
  // 2400 frames/px: a bar is 96000 / 2400 = 40 px.
  assert.deepEqual(at(2400), { ticks: 7680, kind: 'bar' });
  // 2500 frames/px: a bar is 38.4 px, two bars 76.8.
  assert.deepEqual(at(2500), { ticks: 7680 * 2, kind: 'bar' });
  // 375 frames/px: a beat is 24000 / 375 = 64 px: beats are labelled.
  assert.deepEqual(at(375), { ticks: 1920, kind: 'beat' });
  // 400 frames/px: a beat is 60 px, under 64; the 240 px bar is labelled alone.
  assert.deepEqual(at(400), { ticks: 7680, kind: 'bar' });
  const view: Viewport = { framesPerPixel: 2400, scrollFrames: '0', rulerHeight: RULER_HEIGHT, laneHeight: 53, width: 680, height: 300, scrollY: 0 };
  assert.deepEqual(rulerMarks(view, T120, RATE).map((m) => m.label), Array.from({ length: 17 }, (_, i) => String(i + 1)));
});

test('the marks across a view are bar numbers, then beats and subdivisions zoomed in', () => {
  const view: Viewport = { framesPerPixel: 1000, scrollFrames: '0', rulerHeight: RULER_HEIGHT, laneHeight: 53, width: 400, height: 300, scrollY: 0 };
  const bars = rulerMarks(view, T120, RATE);
  // A bar is 96 px: bars 1-5 at 0, 96, 192, 288, 384.
  assert.deepEqual(bars.map((m) => m.label), ['1', '2', '3', '4', '5']);
  assert.deepEqual(bars.map((m) => m.x), [0, 96, 192, 288, 384]);
  const close = rulerMarks({ ...view, framesPerPixel: 100 }, T120, RATE);
  const labels = close.map((m) => m.label);
  assert.equal(labels[0], '1');
  assert.ok(labels.includes('1.2'), labels.join(' '));
  assert.ok(labels.includes('1.1.960'), labels.join(' '));
  assert.ok(close.filter((m) => m.kind === 'bar').every((m) => /^\d+$/.test(m.label)));
  // Scrolled: the first mark is the first one at or after the left edge.
  const scrolled = rulerMarks({ ...view, scrollFrames: '100000' }, T120, RATE);
  assert.equal(scrolled[0]!.label, '3');
  assert.equal(scrolled[0]!.x, 92);
});

// UI redesign spec 3.2 and 1.4: the ruler is 40 px, an 18 px locator half
// above a 22 px cursor half; the canvas takes all three from the tokens
// (app/renderer/tokens.css --ruler-h, --ruler-upper-h, --ruler-lower-h).
test("the ruler's height and its two halves are the tokens' values", () => {
  assert.equal(RULER_HEIGHT, parseFloat(TOKENS['ruler-h']));
  assert.equal(RULER_UPPER, parseFloat(TOKENS['ruler-upper-h']));
  assert.equal(RULER_LOWER, parseFloat(TOKENS['ruler-lower-h']));
  assert.deepEqual([RULER_HEIGHT, RULER_UPPER, RULER_LOWER], [40, 18, 22]);
  assert.equal(RULER_UPPER + RULER_LOWER, RULER_HEIGHT);
});
