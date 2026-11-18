// Locale-free formatters (m5-ui-i18n; UI redesign spec 6.2): dB values, pan
// as L35 / C / R40 and timeline positions are the same bytes in every locale,
// as on hardware and in Cubase. They take no locale; the ruler (bars and
// beats since m5-ui-arrange) and the info line carry no catalog word.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDb, formatLoadPercent, formatLufs, formatMilliDb, formatPan, formatPeakDb, formatSeconds, loadBarWidth } from '../../src/renderer/format';
import { LOCALES } from '../../src/renderer/i18n/locale';
import { catalogFor } from '../../src/renderer/i18n/t';
import { formatBbt } from '../../src/renderer/timeline/musical-time';

test('the formatters take no locale', () => {
  assert.equal(formatMilliDb.length, 1);
  assert.equal(formatPan.length, 1);
  assert.equal(formatSeconds.length, 1);
});

test('formatMilliDb prints decibels with two decimals (the gain is in milli-dB)', () => {
  assert.equal(formatMilliDb(-600), '-0.60 dB');
  assert.equal(formatMilliDb(-6000), '-6.00 dB');
  assert.equal(formatMilliDb(0), '0.00 dB');
  assert.equal(formatMilliDb(1250), '+1.25 dB');
  assert.equal(formatMilliDb(-2147483648), '-inf dB');
});

test('formatPan prints L / C / R with the percentage (pan is -10000..10000)', () => {
  assert.equal(formatPan(0), 'C');
  assert.equal(formatPan(-3500), 'L35');
  assert.equal(formatPan(4000), 'R40');
  assert.equal(formatPan(-10000), 'L100');
  assert.equal(formatPan(10000), 'R100');
  assert.equal(formatPan(49), 'C');
  assert.equal(formatPan(-50), 'L1');
  assert.equal(formatPan(251), 'R3');
});

test('formatSeconds prints a ruler position with at most two decimals', () => {
  assert.equal(formatSeconds(0), '0');
  assert.equal(formatSeconds(0.25), '0.25');
  assert.equal(formatSeconds(0.1 + 0.2), '0.3');
  assert.equal(formatSeconds(12), '12');
});

test('ruler and info line positions are the same bytes in every locale (no catalog word around them)', () => {
  const ticks = 7680 * 2 + 1920 + 960;
  assert.equal(formatBbt(ticks), '3.2.960');
  assert.equal(formatDb(-3500), '-3.5 dB');
  // The catalogs carry no ruler unit any more: the ruler is bars and beats.
  for (const locale of LOCALES) assert.ok(!('timeline.seconds' in catalogFor(locale)), locale);
});

// m5-ui-mixer (UI redesign spec 3.4, 4.5 C7): the mixer's values are dB with
// one decimal and an explicit sign, rounded half away from zero; the peak
// value is the meter's linear peak in dBFS, same style without the unit.
test('formatDb prints one decimal with an explicit sign', () => {
  assert.equal(formatDb.length, 1);
  assert.equal(formatDb(1500), '+1.5 dB');
  assert.equal(formatDb(-6000), '-6.0 dB');
  assert.equal(formatDb(0), '0.0 dB');
  assert.equal(formatDb(-50), '-0.1 dB');
  assert.equal(formatDb(50), '+0.1 dB');
  assert.equal(formatDb(-49), '0.0 dB');
  assert.equal(formatDb(9000), '+9.0 dB');
  assert.equal(formatDb(-6500), '-6.5 dB');
  assert.equal(formatDb(-2147483648), '-inf dB');
});

// One rounding for every dB the user reads (track header, info line,
// MixConsole, Inspector): half away from zero, so a gain and its negation read
// as mirror images (+0.65 dB and -0.65 dB as +0.7 and -0.7), never
// Math.round's half-up (-0.65 dB as -0.6).
test('formatDb rounds a half away from zero, symmetric about 0 dB', () => {
  for (const milliDb of [50, 150, 650, 1250, 6050]) {
    const positive = formatDb(milliDb);
    assert.equal(formatDb(-milliDb), positive.replace('+', '-'), String(milliDb));
  }
  assert.equal(formatDb(650), '+0.7 dB');
  assert.equal(formatDb(-650), '-0.7 dB');
  assert.equal(formatDb(-1250), '-1.3 dB');
});

test('formatPeakDb prints a linear peak in dBFS with one decimal', () => {
  assert.equal(formatPeakDb.length, 1);
  assert.equal(formatPeakDb(1), '0.0');
  assert.equal(formatPeakDb(0.5), '-6.0');
  assert.equal(formatPeakDb(2), '+6.0');
  assert.equal(formatPeakDb(0.1), '-20.0');
  assert.equal(formatPeakDb(0), '-inf');
  assert.equal(formatPeakDb(-1), '-inf');
  assert.equal(formatPeakDb(Number.NaN), '-inf');
});

// m5b-ui-meter (UR-14, acceptance 2): a loudness value is written as the peak
// value beside it is: ASCII minus, one decimal, half away from zero, and
// silence (minus infinity, or anything not finite) reads -inf.
test('formatLufs prints LUFS with one decimal as formatPeakDb does, silence as -inf', () => {
  assert.equal(formatLufs.length, 1);
  assert.equal(formatLufs(-13.84), '-13.8');
  assert.equal(formatLufs(-23), '-23.0');
  assert.equal(formatLufs(-23.25), '-23.3', 'half away from zero');
  assert.equal(formatLufs(-0.04), '0.0');
  assert.equal(formatLufs(3.5), '+3.5');
  assert.equal(formatLufs(-Infinity), '-inf');
  assert.equal(formatLufs(Number.NaN), '-inf');
  assert.equal(formatLufs(Infinity), '-inf');
  // The same rounding as the peak value: -6.0206 dBFS reads -6.0 in both.
  assert.equal(formatLufs(20 * Math.log10(0.5)), formatPeakDb(0.5));
  for (const value of [-13.84, -23.25, 3.5]) assert.ok(!formatLufs(value).includes('−'), 'ASCII minus');
});

test('formatLoadPercent prints the DSP load as a whole percentage, the bar width is clamped to 100 %', () => {
  assert.equal(formatLoadPercent(0.123), '12%');
  assert.equal(formatLoadPercent(0), '0%');
  assert.equal(formatLoadPercent(0.005), '1%');
  assert.equal(formatLoadPercent(1.37), '137%', 'a load past the deadline is not clamped in the text');
  assert.equal(formatLoadPercent(Number.NaN), '0%');
  assert.equal(formatLoadPercent(-0.2), '0%');
  assert.equal(loadBarWidth(0.123), '12.3%');
  assert.equal(loadBarWidth(0), '0%');
  assert.equal(loadBarWidth(1.37), '100%');
  assert.equal(loadBarWidth(-1), '0%');
  assert.equal(loadBarWidth(Number.NaN), '0%');
});
