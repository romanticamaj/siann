// The position display's text (m5-ui-transport; UI redesign spec 3.1): the
// project cursor's frame in Bars+Beats (bar.beat.tick, 1-based, 4/4 until
// E-10) through root.tempo, or in Seconds as a fixed m:ss.mmm; a typed
// position read back in the primary format; and the period key's exchange of
// primary and secondary. Every expected string here is worked out by hand
// from the tempo map, never by musical-time.ts. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TempoPoint } from '../../src/renderer/model/document';
import { exchange, formatPosition, formatSeconds, parsePosition } from '../../src/renderer/timeline/transport-time';

const RATE = 48000;
const AT_120: readonly TempoPoint[] = [{ ticks: '0', milliBpm: 120_000 }];
// 120 BPM for the first bar (7680 ticks = 4 quarters of 1920), then 60 BPM.
const CHANGE: readonly TempoPoint[] = [
  { ticks: '0', milliBpm: 120_000 },
  { ticks: '7680', milliBpm: 60_000 },
];

test('at 120 BPM and 48 kHz the display reads 3.1.000 at 4 s', () => {
  // A quarter at 120 BPM is 0.5 s, a 4/4 bar 2 s: 4 s is the start of bar 3.
  assert.equal(formatPosition(4 * RATE, AT_120, RATE, 'bars'), '3.1.000');
  assert.equal(formatPosition('192000', AT_120, RATE, 'bars'), '3.1.000');
  assert.equal(formatPosition(0, AT_120, RATE, 'bars'), '1.1.000');
  // 0.25 s is half a quarter: 960 ticks into beat 1.
  assert.equal(formatPosition(12_000, AT_120, RATE, 'bars'), '1.1.960');
  // No tempo map reads as a new session's 120 BPM.
  assert.equal(formatPosition(4 * RATE, [], RATE, 'bars'), '3.1.000');
});

test('across a tempo change: 120 BPM for bar 1, then 60 BPM', () => {
  // Bar 1 lasts 2 s (96000 frames). At 60 BPM a quarter is 1 s (48000
  // frames), so bar 2 lasts 4 s: 2 s to 6 s.
  assert.equal(formatPosition(96_000, CHANGE, RATE, 'bars'), '2.1.000');
  // 3 s: one quarter into bar 2.
  assert.equal(formatPosition(144_000, CHANGE, RATE, 'bars'), '2.2.000');
  // 4 s: two quarters into bar 2 (at 120 BPM throughout it would be 3.1.000).
  assert.equal(formatPosition(192_000, CHANGE, RATE, 'bars'), '2.3.000');
  // 4.5 s: two and a half quarters into bar 2, 960 ticks into beat 3.
  assert.equal(formatPosition(216_000, CHANGE, RATE, 'bars'), '2.3.960');
  // 6 s: the start of bar 3.
  assert.equal(formatPosition(288_000, CHANGE, RATE, 'bars'), '3.1.000');
  // And back: typed bar positions land on the same frames.
  assert.equal(parsePosition('2.3.000', CHANGE, RATE, 'bars'), '192000');
  assert.equal(parsePosition('3.1.000', CHANGE, RATE, 'bars'), '288000');
  assert.equal(parsePosition('2.3.960', CHANGE, RATE, 'bars'), '216000');
});

test('seconds are m:ss.mmm, the same bytes in every locale, never rounded up', () => {
  assert.equal(formatSeconds(4 * RATE, RATE), '0:04.000');
  assert.equal(formatSeconds(0, RATE), '0:00.000');
  assert.equal(formatSeconds(12_000, RATE), '0:00.250');
  assert.equal(formatSeconds(61.5 * RATE, RATE), '1:01.500');
  // One frame short of a second is still 0.999 s.
  assert.equal(formatSeconds(RATE - 1, RATE), '0:00.999');
  assert.equal(formatSeconds('2880000', RATE), '1:00.000');
  assert.equal(formatPosition(4 * RATE, AT_120, RATE, 'seconds'), '0:04.000');
});

test('a typed position is read in the primary format; garbage, negatives and bar 0 are refused', () => {
  // Bars: bar.beat.tick, bar.beat and bar.
  assert.equal(parsePosition('3.1.000', AT_120, RATE, 'bars'), '192000');
  assert.equal(parsePosition('3.1', AT_120, RATE, 'bars'), '192000');
  assert.equal(parsePosition('3', AT_120, RATE, 'bars'), '192000');
  assert.equal(parsePosition(' 1.1.960 ', AT_120, RATE, 'bars'), '12000');
  assert.equal(parsePosition('1', AT_120, RATE, 'bars'), '0');
  for (const bad of ['', 'abc', '0', '0.1.000', '1.0.000', '1.5.000', '1.1.1920', '-1', '1..2', '3.1.000.0', '1e3']) {
    assert.equal(parsePosition(bad, AT_120, RATE, 'bars'), null, JSON.stringify(bad));
  }
  // Seconds: plain seconds or m:ss.mmm.
  assert.equal(parsePosition('4', AT_120, RATE, 'seconds'), '192000');
  assert.equal(parsePosition('4.5', AT_120, RATE, 'seconds'), '216000');
  assert.equal(parsePosition('0:04.000', AT_120, RATE, 'seconds'), '192000');
  assert.equal(parsePosition('1:01.5', AT_120, RATE, 'seconds'), String(61.5 * RATE));
  for (const bad of ['', 'x', '-4', '-0:01', '1:60', '4s', '1:2:3']) {
    assert.equal(parsePosition(bad, AT_120, RATE, 'seconds'), null, JSON.stringify(bad));
  }
});

test('the period key exchanges the primary and the secondary format', () => {
  assert.deepEqual(exchange({ primary: 'bars', secondary: 'seconds' }), { primary: 'seconds', secondary: 'bars' });
  assert.deepEqual(exchange(exchange({ primary: 'bars', secondary: 'seconds' })), { primary: 'bars', secondary: 'seconds' });
});
