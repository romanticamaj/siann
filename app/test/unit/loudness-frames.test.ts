// The realtime channel's loudness frames (protocol-events-v1.md, "Loudness
// frame"; m5b-ui-meter): every frame of fixtures/protocol/loudness-frames.json,
// written by scripts/generate-protocol-fixtures.js with DataView independently
// of the decoder, decodes byte-exact, minus infinity included; a frame with
// another magic or version, or of any length but 25 bytes, decodes to null;
// the meter decoder still refuses a SLUD frame, and frameKind tells the two
// apart by the magic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeLoudnessFrame, frameKind, LOUDNESS_FRAME_BYTES, type LoudnessFrame } from '../../src/renderer/model/loudness-frames';
import { decodeMeterFrame } from '../../src/renderer/model/meter-frames';
import { hexBytes } from './support/fakes';
import { readFixture } from './support/fixtures';

interface Fixtures {
  frameBytes: number;
  loudnessFrames: Array<{ name: string; frame: { engineTimestampMicros: string; momentary: number | string; shortTerm: number | string; integrated: number | string }; hex: string }>;
}

const fixtures = readFixture<Fixtures>('protocol', 'loudness-frames.json');
const meters = readFixture<{ meterFrames: Array<{ hex: string }> }>('protocol', 'meter-frames.json');

// The fixture writes minus infinity as the string "-Infinity".
const lufs = (value: number | string) => (value === '-Infinity' ? -Infinity : Number(value));

function expected(frame: Fixtures['loudnessFrames'][number]['frame']): LoudnessFrame {
  return {
    engineTimestampMicros: frame.engineTimestampMicros,
    momentary: lufs(frame.momentary),
    shortTerm: lufs(frame.shortTerm),
    integrated: lufs(frame.integrated),
  };
}

test('the fixture file holds 25-byte frames, minus infinity among them', () => {
  assert.equal(fixtures.frameBytes, 25);
  assert.equal(LOUDNESS_FRAME_BYTES, 25);
  assert.ok(fixtures.loudnessFrames.length >= 3);
  assert.ok(fixtures.loudnessFrames.some((f) => f.frame.integrated === '-Infinity'));
});

for (const fixture of fixtures.loudnessFrames) {
  test(`decodes the loudness frame "${fixture.name}" byte-exact`, () => {
    const frame = decodeLoudnessFrame(hexBytes(fixture.hex));
    assert.deepEqual(frame, expected(fixture.frame));
    // An ArrayBuffer and a view at an offset read the same.
    const padded = new Uint8Array(28);
    padded.set(hexBytes(fixture.hex), 3);
    assert.deepEqual(decodeLoudnessFrame(padded.subarray(3)), expected(fixture.frame));
    assert.deepEqual(decodeLoudnessFrame(hexBytes(fixture.hex).slice().buffer), expected(fixture.frame));
  });
}

test('a frame of another magic, version or length decodes to null', () => {
  const good = hexBytes(fixtures.loudnessFrames[0]!.hex);
  const magic = good.slice();
  magic[3] = 0x45; // "SLUE"
  assert.equal(decodeLoudnessFrame(magic), null);
  const version = good.slice();
  version[4] = 2;
  assert.equal(decodeLoudnessFrame(version), null);
  assert.equal(decodeLoudnessFrame(good.slice(0, 24)), null, '24 bytes');
  const long = new Uint8Array(26);
  long.set(good);
  assert.equal(decodeLoudnessFrame(long), null, '26 bytes');
  assert.equal(decodeLoudnessFrame(new Uint8Array(0)), null, 'empty');
  // A meter frame is not a loudness frame.
  assert.equal(decodeLoudnessFrame(hexBytes(meters.meterFrames[0]!.hex)), null);
});

test('the meter decoder still refuses a SLUD frame, and frameKind tells them apart by the magic', () => {
  for (const fixture of fixtures.loudnessFrames) {
    assert.equal(decodeMeterFrame(hexBytes(fixture.hex)), null, fixture.name);
    assert.equal(frameKind(hexBytes(fixture.hex)), 'loudness', fixture.name);
  }
  assert.equal(frameKind(hexBytes(meters.meterFrames[0]!.hex)), 'meter');
  assert.equal(frameKind(new Uint8Array([0x58, 0x58, 0x58, 0x58, 1])), null);
  assert.equal(frameKind(new Uint8Array([0x53, 0x4c])), null, 'shorter than a magic');
});
