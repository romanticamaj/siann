// The info line (m5-ui-arrange; UI redesign spec 3.2, "Info line", read-only
// in phase 1): the selected clip's start, end, length, offset and gain in the
// user's units: positions as bars.beats.ticks through root.tempo (1-based),
// length and offset as bars.beats.ticks counted from zero, gain in dB with
// one decimal. Nothing for no selection. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDb } from '../../src/renderer/format';
import type { ClipEntity, RootEntity } from '../../src/renderer/model/document';
import { infoLine } from '../../src/renderer/timeline/info-line';
import { clip, sampleSnapshot, snapshotOf, track, media } from './support/timeline';

test('a clip at bar 2 one bar long with a two-beat offset, at 120 BPM and 48 kHz', () => {
  // 120 BPM: a quarter is 24000 frames, a bar 96000.
  const at: ClipEntity = { ...clip('clp_x', 'trk_a', 'med_sq', '96000', '48000', '96000'), gainMilliDb: -3500 };
  const snapshot = snapshotOf(['trk_a'], [track('trk_a')], [media('med_sq', '480000')], [at]);
  assert.deepEqual(infoLine(snapshot, 'clp_x'), {
    start: '2.1.000',
    end: '3.1.000',
    length: '1.0.000',
    offset: '0.2.000',
    gain: '-3.5 dB',
  });
});

test('the info line follows root.tempo', () => {
  const base = snapshotOf(['trk_a'], [track('trk_a')], [media('med_sq', '480000')], [clip('clp_x', 'trk_a', 'med_sq', '96000', '0', '48000')]);
  // 60 BPM: a quarter is 48000 frames; frame 96000 is beat 3 of bar 1.
  const root: RootEntity = { ...base.root!, tempo: [{ ticks: '0', milliBpm: 60000 }] };
  const slow = { ...base, root, entities: { ...base.entities, 'root:root': root } };
  const line = infoLine(slow, 'clp_x')!;
  assert.equal(line.start, '1.3.000');
  assert.equal(line.end, '1.4.000');
  assert.equal(line.length, '0.1.000');
  assert.equal(line.offset, '0.0.000');
  assert.equal(line.gain, '0.0 dB');
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
