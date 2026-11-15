// The meter-frame fixture must match the documented layout
// (docs/schemas/protocol-events-v1.md) and its Node generator. The native
// encoder is tested against the same file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generator = require('../scripts/generate-protocol-fixtures');

const fixture = JSON.parse(fs.readFileSync(generator.FIXTURE_FILE, 'utf8'));

test('the meter-frame fixture matches its Node generator', () => {
  assert.deepEqual(fixture, generator.buildFixture());
});

test('every fixture frame decodes per the documented layout', () => {
  assert.equal(fixture.headerBytes, 32);
  assert.ok(fixture.meterFrames.length >= 3);
  for (const { name, frame, hex } of fixture.meterFrames) {
    const bytes = Buffer.from(hex, 'hex');
    assert.equal(bytes.toString('ascii', 0, 4), 'SMTR', name);
    assert.equal(bytes[4], 1, `${name}: version`);
    const expectedLength = 32 + frame.entries.reduce((sum, e) => sum + 3 + 8 * e.channels, 0);
    assert.equal(bytes.length, expectedLength, `${name}: length`);
    assert.equal(bytes.readUInt16LE(30), frame.entries.length, `${name}: entryCount`);
    assert.equal(bytes.readBigUInt64LE(5).toString(), frame.epoch, `${name}: epoch`);
    assert.equal(bytes.readBigInt64LE(21).toString(), frame.playheadSamples, `${name}: playhead`);
    assert.deepEqual(generator.decodeFrame(bytes), frame, name);
  }
});

test('the schema doc states the layout the fixture uses', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'schemas', 'protocol-events-v1.md'), 'utf8');
  for (const row of ['| 0 | 4 | magic `"SMTR"` |', '| 4 | 1 | u8 version, `1` |', '| 30 | 2 | u16 entryCount |',
    '| 32 | ... | entries |']) {
    assert.ok(doc.includes(row), `doc row ${row}`);
  }
});

// m5b-engine-load-loudness (Protocol v0 item 30): the loudness frame "SLUD".
const loudness = JSON.parse(fs.readFileSync(generator.LOUDNESS_FIXTURE_FILE, 'utf8'));

test('the loudness-frame fixture matches its Node generator', () => {
  assert.deepEqual(loudness, generator.buildLoudnessFixture());
});

test('every loudness frame is 25 bytes per the documented layout, one of them minus infinity', () => {
  assert.equal(loudness.frameBytes, 25);
  assert.ok(loudness.loudnessFrames.length >= 3);
  const value = (v) => (v === '-Infinity' ? -Infinity : v);
  let infinity = false;
  for (const { name, frame, hex } of loudness.loudnessFrames) {
    const bytes = Buffer.from(hex, 'hex');
    assert.equal(bytes.length, 25, `${name}: length`);
    assert.equal(bytes.toString('ascii', 0, 4), 'SLUD', name);
    assert.equal(bytes[4], 1, `${name}: version`);
    assert.equal(bytes.readBigInt64LE(5).toString(), frame.engineTimestampMicros, `${name}: timestamp`);
    assert.equal(bytes.readFloatLE(13), value(frame.momentary), `${name}: momentary`);
    assert.equal(bytes.readFloatLE(17), value(frame.shortTerm), `${name}: shortTerm`);
    assert.equal(bytes.readFloatLE(21), value(frame.integrated), `${name}: integrated`);
    for (const v of [frame.momentary, frame.shortTerm, frame.integrated]) {
      if (v === '-Infinity') {
        infinity = true;
      }
    }
    assert.deepEqual(generator.decodeLoudnessFrame(bytes), frame, name);
  }
  assert.ok(infinity, 'a frame carries minus infinity');
  const silent = loudness.loudnessFrames.find((f) => f.frame.integrated === '-Infinity');
  assert.equal(silent.hex.slice(42), '000080ff', 'minus infinity is the f32 bytes 00 00 80 ff');
});

test('the loudness frame is not a meter frame, and malformed loudness frames are rejected', () => {
  const good = Buffer.from(loudness.loudnessFrames[0].hex, 'hex');
  assert.throws(() => generator.decodeFrame(good));
  assert.throws(() => generator.decodeLoudnessFrame(good.subarray(0, 24)));
  assert.throws(() => generator.decodeLoudnessFrame(Buffer.concat([good, Buffer.from([0])])));
  const badMagic = Buffer.from(good);
  badMagic[0] = 0x58;
  assert.throws(() => generator.decodeLoudnessFrame(badMagic));
  const badVersion = Buffer.from(good);
  badVersion[4] = 2;
  assert.throws(() => generator.decodeLoudnessFrame(badVersion));
});

test('the schema doc states the loudness layout the fixture uses', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'schemas', 'protocol-events-v1.md'), 'utf8');
  for (const row of ['| 0 | 4 | magic `"SLUD"` |', '| 5 | 8 | i64 engineTimestampMicros (the meter frame\'s) |',
    '| 13 | 4 | f32 momentary (LUFS, 400 ms) |', '| 17 | 4 | f32 shortTerm (LUFS, 3 s) |']) {
    assert.ok(doc.includes(row), `doc row ${row}`);
  }
});

test('malformed frames are rejected by the reference decoder', () => {
  const good = Buffer.from(fixture.meterFrames[0].hex, 'hex');
  assert.throws(() => generator.decodeFrame(good.subarray(0, good.length - 1)));
  const badMagic = Buffer.from(good);
  badMagic[0] = 0x58;
  assert.throws(() => generator.decodeFrame(badMagic));
  assert.throws(() => generator.decodeFrame(Buffer.concat([good, Buffer.from([0])])));
});
