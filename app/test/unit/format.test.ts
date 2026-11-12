// The renderer's shared formatters (UX pass): gain in dB with one decimal and
// an explicit sign, -inf at the minimum, typed gains parsed back, pan as
// L/C/R, clock and bars.beats.ticks positions, relative times.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MINUS_INFINITY_MILLI_DB,
  formatBarsBeats,
  formatClock,
  formatDeltaSeconds,
  formatGainDb,
  formatPan,
  formatRelativeTime,
  mediaDisplayName,
  parseGainDb,
} from '../../src/renderer/format';

test('gain prints one decimal with an explicit sign, 0.0 dB unsigned, -inf at the minimum', () => {
  assert.equal(formatGainDb(1500), '+1.5 dB');
  assert.equal(formatGainDb(-12000), '-12.0 dB');
  assert.equal(formatGainDb(0), '0.0 dB');
  assert.equal(formatGainDb(-600), '-0.6 dB');
  assert.equal(formatGainDb(-40), '0.0 dB', 'rounds to a tenth');
  assert.equal(formatGainDb(-2560), '-2.6 dB');
  assert.equal(formatGainDb(MINUS_INFINITY_MILLI_DB), '-inf dB');
});

test('a typed gain parses to milli-dB rounded to 0.1 dB and clamped to the engine range', () => {
  assert.equal(parseGainDb('-6'), -6000);
  assert.equal(parseGainDb('+1.5 dB'), 1500);
  assert.equal(parseGainDb('  1.54dB '), 1500);
  assert.equal(parseGainDb('−3,5'), -3500);
  assert.equal(parseGainDb('.5'), 500);
  assert.equal(parseGainDb('-inf'), MINUS_INFINITY_MILLI_DB);
  assert.equal(parseGainDb('inf'), MINUS_INFINITY_MILLI_DB);
  assert.equal(parseGainDb('100'), 24000);
  assert.equal(parseGainDb('-500'), -144000);
  assert.equal(parseGainDb(''), null);
  assert.equal(parseGainDb('loud'), null);
  assert.equal(parseGainDb('1e3'), null);
});

test('pan prints L/C/R percentages', () => {
  assert.equal(formatPan(0), 'C');
  assert.equal(formatPan(-3500), 'L35');
  assert.equal(formatPan(4000), 'R40');
  assert.equal(formatPan(10000), 'R100');
  assert.equal(formatPan(-10000), 'L100');
  assert.equal(formatPan(40), 'C', 'under half a percent is centre');
  assert.equal(formatPan(-20000), 'L100', 'clamped');
});

test('clock and bars.beats.ticks positions', () => {
  assert.equal(formatClock(0), '00:00.000');
  assert.equal(formatClock(1.2), '00:01.200');
  assert.equal(formatClock(75.0456), '01:15.046');
  assert.equal(formatBarsBeats(0, 120000), '1.1.000');
  // 120 bpm: a beat is 0.5 s, a bar 2 s.
  assert.equal(formatBarsBeats(0.5, 120000), '1.2.000');
  assert.equal(formatBarsBeats(2.25, 120000), '2.1.480');
  assert.equal(formatBarsBeats(1.2, 120000), '1.3.384');
  assert.equal(formatBarsBeats(1, 60000), '1.2.000');
  assert.equal(formatBarsBeats(1, 0), '1.3.000', 'no tempo: 120 bpm');
});

test('deltas, relative times and media names', () => {
  assert.equal(formatDeltaSeconds(0.25), '+0.250 s');
  assert.equal(formatDeltaSeconds(-1), '-1.000 s');
  assert.equal(formatDeltaSeconds(0), '+0.000 s');
  const now = 1_000_000_000;
  assert.equal(formatRelativeTime(now - 2000, now), 'just now');
  assert.equal(formatRelativeTime(now - 30_000, now), '30 s ago');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(formatRelativeTime(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(formatRelativeTime(now - 50 * 3600_000, now), '2 d ago');
  assert.equal(mediaDisplayName('med_voxlead'), 'voxlead');
  assert.equal(mediaDisplayName('kick'), 'kick');
});
