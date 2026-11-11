// The realtime channel's binary meter frames (protocol-events-v1.md, "Frame
// layout"): every frame of fixtures/protocol/meter-frames.json, written by
// scripts/generate-protocol-fixtures.js independently of the decoder, decodes
// byte-exact; malformed frames decode to null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeMeterFrame, type MeterFrame } from '../../src/renderer/model/meter-frames';
import { readFixture } from './support/fixtures';

interface Fixtures {
  headerBytes: number;
  meterFrames: Array<{ name: string; frame: MeterFrame; hex: string }>;
}

const fixtures = readFixture<Fixtures>('protocol', 'meter-frames.json');

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

test('the fixture file holds the frames the decoder must read', () => {
  assert.equal(fixtures.headerBytes, 32);
  assert.ok(fixtures.meterFrames.some((f) => f.name === 'stopped before the first meter block, no entries'));
  assert.ok(fixtures.meterFrames.length >= 3);
});

for (const fixture of fixtures.meterFrames) {
  test(`decodes: ${fixture.name}`, () => {
    assert.deepEqual(decodeMeterFrame(bytes(fixture.hex)), fixture.frame);
  });

  test(`decodes from an ArrayBuffer and from an offset view: ${fixture.name}`, () => {
    const frame = bytes(fixture.hex);
    assert.deepEqual(decodeMeterFrame(frame.slice().buffer), fixture.frame);
    const padded = new Uint8Array(frame.length + 3);
    padded.set(frame, 3);
    assert.deepEqual(decodeMeterFrame(padded.subarray(3)), fixture.frame);
  });
}

test('malformed frames decode to null', () => {
  const good = bytes(fixtures.meterFrames[0]!.hex);
  const badMagic = good.slice();
  badMagic[0] = 0x58;
  const badVersion = good.slice();
  badVersion[4] = 2;
  const badPlaying = good.slice();
  badPlaying[29] = 2;
  const moreEntries = good.slice();
  moreEntries[30] = 3; // entryCount 3, two in the bytes
  const badChannels = good.slice();
  badChannels[32 + 2] = 0; // an entry of zero channels makes the length disagree
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['shorter than the header', good.slice(0, 31)],
    ['bad magic', badMagic],
    ['version 2', badVersion],
    ['playing is neither 0 nor 1', badPlaying],
    ['truncated entries', good.slice(0, good.length - 1)],
    ['a trailing byte', Uint8Array.from([...good, 0])],
    ['more entries than bytes', moreEntries],
    ['an entry length that disagrees', badChannels],
  ];
  for (const [name, frame] of cases) assert.equal(decodeMeterFrame(frame), null, name);
});
