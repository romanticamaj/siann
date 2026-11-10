// The renderer's peak pyramid decoder (docs/schemas/protocol-peaks-v0.md,
// spec Protocol v0 item 23) against fixtures/peaks: the same bytes the C++
// producer is tested to write, from the Node generator (parity as with the
// jcs fixtures). Then the level a zoom draws, and a column's min and max.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PeaksError, chooseLevel, columnRange, decodePeaks } from '../../src/renderer/model/peaks';
import { listFixtures, readFixture, readFixtureBytes } from './support/fixtures';

interface Bin {
  readonly min: number;
  readonly max: number;
}

interface PeaksFixture {
  readonly name: string;
  readonly file: string;
  readonly signal: { readonly kind: string; readonly channels: number; readonly frames: number; readonly sampleRate: number };
  readonly header: { readonly version: number; readonly channels: number; readonly levels: number; readonly frames: string; readonly sampleRate: number };
  readonly levels: ReadonlyArray<{ readonly binFrames: number; readonly binCount: number; readonly first: readonly Bin[]; readonly last: readonly Bin[] }>;
}

const names = listFixtures('peaks')
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length));

test('fixtures/peaks holds the generator cases', () => {
  assert.ok(names.length >= 6, names.join(', '));
});

for (const name of names) {
  test(`decodes ${name} as the fixture describes it`, () => {
    const fixture = readFixture<PeaksFixture>('peaks', `${name}.json`);
    const bytes = readFixtureBytes('peaks', fixture.file);
    const pyramid = decodePeaks(bytes);
    assert.equal(pyramid.channels, fixture.header.channels);
    // A number: the format's longest media (256 * 4^11 frames) is far below 2^53.
    assert.equal(pyramid.frames, Number(fixture.header.frames));
    assert.equal(pyramid.sampleRate, fixture.header.sampleRate);
    assert.equal(pyramid.levels.length, fixture.header.levels);
    pyramid.levels.forEach((level, k) => {
      const expected = fixture.levels[k]!;
      assert.equal(level.binFrames, expected.binFrames);
      assert.equal(level.binCount, expected.binCount);
      assert.equal(level.values.length, level.binCount * pyramid.channels * 2);
      for (let c = 0; c < pyramid.channels; c += 1) {
        assert.deepEqual({ min: level.values[c * 2], max: level.values[c * 2 + 1] }, expected.first[c]);
        const at = ((level.binCount - 1) * pyramid.channels + c) * 2;
        assert.deepEqual({ min: level.values[at], max: level.values[at + 1] }, expected.last[c]);
      }
    });
    // An ArrayBuffer (what fetch hands over) decodes the same, also at an offset.
    const copy = new Uint8Array(bytes.length + 3);
    copy.set(bytes, 3);
    assert.deepEqual(decodePeaks(copy.subarray(3)), pyramid);
    assert.deepEqual(decodePeaks(bytes.slice().buffer), pyramid);
  });
}

test('a bad magic, version, reserved byte, layout or size is refused', () => {
  const good = readFixtureBytes('peaks', 'ramp-stereo.peaks');
  const refuses = (bytes: Uint8Array) =>
    assert.throws(() => decodePeaks(bytes), (e: unknown) => e instanceof PeaksError && e.code === 'decode_failed');
  const edited = (at: number, value: number) => {
    const copy = good.slice();
    copy[at] = value;
    return copy;
  };
  refuses(edited(0, 0x58));
  refuses(edited(4, 2));
  refuses(edited(7, 1));
  refuses(edited(6, 1));
  refuses(edited(20, 1));
  for (const size of [0, 3, 19, 20, 27, good.length - 1]) refuses(good.subarray(0, size));
  const longer = new Uint8Array(good.length + 1);
  longer.set(good);
  refuses(longer);
});

test('the level for a zoom is the coarsest whose bins fit in a pixel', () => {
  const pyramid = decodePeaks(readFixtureBytes('peaks', 'silence-mono.peaks'));
  // Levels of 256, 1024, 4096 and 16384 frames per bin.
  assert.deepEqual(pyramid.levels.map((l) => l.binFrames), [256, 1024, 4096, 16384]);
  assert.equal(chooseLevel(pyramid, 1), 0, 'one pixel per frame: the finest level');
  assert.equal(chooseLevel(pyramid, 1 / 255), 0);
  assert.equal(chooseLevel(pyramid, 1 / 256), 0);
  assert.equal(chooseLevel(pyramid, 1 / 1023), 0);
  assert.equal(chooseLevel(pyramid, 1 / 1024), 1);
  assert.equal(chooseLevel(pyramid, 1 / 5000), 2);
  assert.equal(chooseLevel(pyramid, 1 / 1e9), 3, 'never past the last level');
  assert.throws(() => chooseLevel(pyramid, 0), RangeError);
  assert.throws(() => chooseLevel(pyramid, Number.NaN), RangeError);
});

test("a column's min and max come from the bins it overlaps", () => {
  const pyramid = decodePeaks(readFixtureBytes('peaks', 'ramp-stereo.peaks'));
  const level = pyramid.levels[0]!;
  // Frames 0..255 are bin 0 alone; 200..300 spans bins 0 and 1.
  const bin = (i: number, c: number) => ({ min: level.values[(i * 2 + c) * 2]!, max: level.values[(i * 2 + c) * 2 + 1]! });
  assert.deepEqual(columnRange(pyramid, 0, 0, 0, 256), bin(0, 0));
  assert.deepEqual(columnRange(pyramid, 0, 0, 200, 300), { min: bin(0, 0).min, max: bin(1, 0).max });
  assert.deepEqual(columnRange(pyramid, 0, 1, 200, 300), { min: bin(1, 1).min, max: bin(0, 1).max });
  // Outside the media, or an empty range: nothing to draw.
  assert.equal(columnRange(pyramid, 0, 0, 3000, 4000), null);
  assert.equal(columnRange(pyramid, 0, 0, 10, 10), null);
  assert.equal(columnRange(pyramid, 0, 0, -50, -1), null);
  // A range running past the end is cut at the end.
  assert.deepEqual(columnRange(pyramid, 0, 0, 2900, 9000), bin(level.binCount - 1, 0));
});
