// Locale-free formatters (m5-ui-i18n; UI redesign spec 6.2): dB values, pan
// as L35 / C / R40 and timeline positions are the same bytes in every locale,
// as on hardware and in Cubase. They take no locale, and the words around
// them (the ruler's unit) come from the catalogs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMilliDb, formatPan, formatSeconds } from '../../src/renderer/format';
import { LOCALES } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';

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

test('the ruler label keeps the number byte-identical; only the unit is the catalog\'s', () => {
  const labels = LOCALES.map((locale) => translator(locale)('timeline.seconds', { value: formatSeconds(1.5) }));
  assert.equal(labels[0], '1.5s');
  for (const label of labels) assert.ok(label.startsWith('1.5'), label);
  assert.ok(labels.slice(1).every((label) => label !== labels[0]), labels.join(' | '));
});
