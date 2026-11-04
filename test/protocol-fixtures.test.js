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

test('malformed frames are rejected by the reference decoder', () => {
  const good = Buffer.from(fixture.meterFrames[0].hex, 'hex');
  assert.throws(() => generator.decodeFrame(good.subarray(0, good.length - 1)));
  const badMagic = Buffer.from(good);
  badMagic[0] = 0x58;
  assert.throws(() => generator.decodeFrame(badMagic));
  assert.throws(() => generator.decodeFrame(Buffer.concat([good, Buffer.from([0])])));
});
