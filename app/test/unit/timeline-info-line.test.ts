// The info line (m5-ui-arrange; m5-ui-port-toolbar; UI redesign spec 3.2,
// "Info line", 6.2 and 10.8, 2): the selected clip's name and track colour,
// its start and end as bar.beat.sixteenth.tick positions through root.tempo
// (1-based bar, beat and sixteenth; the tick within the sixteenth, 0 to 479
// at 1920 ticks per quarter), its length and offset as
// bars.beats.sixteenths.ticks counted from zero, and its volume in dB with
// two decimals. The mockup's row reads 9.1.1.0, 12.4.1.0, 3.3.0.0, 1.0.2.0
// and 0.00 dB. Nothing for no selection. The top bar's position display and
// the drag tooltip keep bar.beat.tick. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDb, formatDb2 } from '../../src/renderer/format';
import type { ClipEntity, RootEntity } from '../../src/renderer/model/document';
import { infoLine } from '../../src/renderer/timeline/info-line';
import { formatBbt, formatBbtDelta, formatBbtLength, formatLength, formatPosition, TICKS_PER_QUARTER, TICKS_PER_SIXTEENTH } from '../../src/renderer/timeline/musical-time';
import { trackColourVar } from '../../src/renderer/timeline/track-colour';
import { clip, sampleSnapshot, snapshotOf, track, media } from './support/timeline';

test('a position is bar.beat.sixteenth.tick, 1-based but for the tick, with no padding', () => {
  assert.equal(TICKS_PER_SIXTEENTH, TICKS_PER_QUARTER / 4);
  assert.equal(TICKS_PER_SIXTEENTH, 480);
  assert.equal(formatPosition(0), '1.1.1.0');
  assert.equal(formatPosition(1), '1.1.1.1');
  assert.equal(formatPosition(479), '1.1.1.479');
  assert.equal(formatPosition(480), '1.1.2.0');
  assert.equal(formatPosition(1919), '1.1.4.479');
  assert.equal(formatPosition(1920), '1.2.1.0');
  assert.equal(formatPosition(7679), '1.4.4.479');
  assert.equal(formatPosition(7680), '2.1.1.0');
  // The mockup's start and end.
  assert.equal(formatPosition(8 * 7680), '9.1.1.0');
  assert.equal(formatPosition(11 * 7680 + 3 * 1920), '12.4.1.0');
  // Negative ticks clamp to the project start.
  assert.equal(formatPosition(-5), '1.1.1.0');
});

test('a length is bars.beats.sixteenths.ticks counted from zero', () => {
  assert.equal(formatLength(0), '0.0.0.0');
  assert.equal(formatLength(479), '0.0.0.479');
  assert.equal(formatLength(480), '0.0.1.0');
  assert.equal(formatLength(1920), '0.1.0.0');
  assert.equal(formatLength(7680), '1.0.0.0');
  // The mockup's length and offset.
  assert.equal(formatLength(3 * 7680 + 3 * 1920), '3.3.0.0');
  assert.equal(formatLength(7680 + 2 * 480), '1.0.2.0');
});

test('the top bar and the drag tooltip keep bar.beat.tick', () => {
  assert.equal(formatBbt(0), '1.1.000');
  assert.equal(formatBbt(8 * 7680), '9.1.000');
  assert.equal(formatBbt(1920 + 5), '1.2.005');
  assert.equal(formatBbtLength(7680 + 960), '1.0.960');
  assert.equal(formatBbtDelta(-1920), '-0.1.000');
  assert.equal(formatBbtDelta(480), '+0.0.480');
});

test('the mockup\'s selected clip: 9.1.1.0, 12.4.1.0, 3.3.0.0, 1.0.2.0, 0.00 dB', () => {
  // 120 BPM, 48 kHz: a bar is 96000 frames, a sixteenth 6000.
  const at: ClipEntity = clip('clp_x', 'trk_a', 'med_sq', '768000', '108000', '360000');
  const snapshot = snapshotOf(['trk_a'], [track('trk_a')], [{ ...media('med_sq', '4800000'), name: 'Chorus A · take 3' }], [at]);
  assert.deepEqual(infoLine(snapshot, 'clp_x'), {
    name: 'Chorus A · take 3',
    colour: trackColourVar('trk_a'),
    start: '9.1.1.0',
    end: '12.4.1.0',
    length: '3.3.0.0',
    offset: '1.0.2.0',
    volume: '0.00 dB',
    // m5b-ui-fades: no fade reads 0 ms.
    fadeIn: '0 ms',
    fadeOut: '0 ms',
  });
});

test('a clip at bar 2 one bar long with a two-beat offset, its media id for a name, at -3.5 dB', () => {
  const at: ClipEntity = { ...clip('clp_x', 'trk_a', 'med_sq', '96000', '48000', '96000'), gainMilliDb: -3500 };
  const snapshot = snapshotOf(['trk_a'], [track('trk_a')], [media('med_sq', '480000')], [at]);
  assert.deepEqual(infoLine(snapshot, 'clp_x'), {
    name: 'med_sq',
    colour: trackColourVar('trk_a'),
    start: '2.1.1.0',
    end: '3.1.1.0',
    length: '1.0.0.0',
    offset: '0.2.0.0',
    volume: '-3.50 dB',
    fadeIn: '0 ms',
    fadeOut: '0 ms',
  });
});

test('the info line follows root.tempo', () => {
  const base = snapshotOf(['trk_a'], [track('trk_a')], [media('med_sq', '480000')], [clip('clp_x', 'trk_a', 'med_sq', '96000', '0', '48000')]);
  // 60 BPM: a quarter is 48000 frames; frame 96000 is beat 3 of bar 1.
  const root: RootEntity = { ...base.root!, tempo: [{ ticks: '0', milliBpm: 60000 }] };
  const slow = { ...base, root, entities: { ...base.entities, 'root:root': root } };
  const line = infoLine(slow, 'clp_x')!;
  assert.equal(line.start, '1.3.1.0');
  assert.equal(line.end, '1.4.1.0');
  assert.equal(line.length, '0.1.0.0');
  assert.equal(line.offset, '0.0.0.0');
  assert.equal(line.volume, '0.00 dB');
});

test('no selection, or a clip the snapshot does not hold, is no info line', () => {
  assert.equal(infoLine(sampleSnapshot(), null), null);
  assert.equal(infoLine(sampleSnapshot(), 'clp_gone'), null);
  assert.equal(infoLine(null, 'clp_1'), null);
});

test('dB with one decimal and an explicit sign; minus infinity', () => {
  assert.equal(formatDb.length, 1);
  assert.equal(formatDb(0), '0.0 dB');
  assert.equal(formatDb(-3500), '-3.5 dB');
  assert.equal(formatDb(6000), '+6.0 dB');
  assert.equal(formatDb(1240), '+1.2 dB');
  assert.equal(formatDb(-40), '0.0 dB', 'rounds to zero without a sign');
  assert.equal(formatDb(-2147483648), '-inf dB');
});

test('the info line\'s volume: dB with two decimals, formatDb\'s sign, rounding and minus infinity', () => {
  assert.equal(formatDb2.length, 1);
  assert.equal(formatDb2(0), '0.00 dB');
  assert.equal(formatDb2(-3500), '-3.50 dB');
  assert.equal(formatDb2(6000), '+6.00 dB');
  assert.equal(formatDb2(1240), '+1.24 dB');
  assert.equal(formatDb2(1245), '+1.25 dB', 'half away from zero');
  assert.equal(formatDb2(-1245), '-1.25 dB', 'half away from zero');
  assert.equal(formatDb2(-4), '0.00 dB', 'rounds to zero without a sign');
  assert.equal(formatDb2(5), '+0.01 dB');
  assert.equal(formatDb2(-2147483648), '-inf dB');
});
