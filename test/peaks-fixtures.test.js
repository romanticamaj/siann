// The peak pyramid fixtures (fixtures/peaks, docs/schemas/protocol-peaks-v0.md)
// that the C++ producer and the renderer's decoder are tested against must stay
// honest: each .peaks file matches its JSON expectations and its generator, and
// every bin holds what the format says for the signal the JSON describes,
// checked here with a decoder and per-bin reasoning of its own.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generator = require('../scripts/generate-peaks-fixtures');

const DIR = generator.FIXTURE_DIR;
const names = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))
  .sort();

function decode(bytes) {
  assert.equal(bytes.toString('latin1', 0, 4), 'SPKS');
  const header = {
    version: bytes.readUInt8(4),
    channels: bytes.readUInt8(5),
    levels: bytes.readUInt8(6),
    reserved: bytes.readUInt8(7),
    frames: bytes.readBigUInt64LE(8),
    sampleRate: bytes.readUInt32LE(16),
  };
  const levels = [];
  let at = 20;
  for (let k = 0; k < header.levels; k += 1) {
    const binFrames = bytes.readUInt32LE(at);
    const binCount = bytes.readUInt32LE(at + 4);
    at += 8;
    const pairs = [];
    for (let i = 0; i < binCount * header.channels; i += 1) {
      pairs.push({ min: bytes.readInt16LE(at), max: bytes.readInt16LE(at + 2) });
      at += 4;
    }
    levels.push({ binFrames, binCount, pairs });
  }
  assert.equal(at, bytes.length, 'no bytes after the last level');
  return { header, levels };
}

// The int16 a float32 sample becomes, written out from the schema text.
function q(x) {
  return Math.min(32767, Math.max(-32768, Math.floor(Math.fround(x) * 32767 + 0.5)));
}

test('every case of the generator has its files, and nothing else is in fixtures/peaks', () => {
  assert.deepEqual(names, generator.CASES.map((c) => c.name).sort());
  const files = fs.readdirSync(DIR).sort();
  assert.deepEqual(files, names.flatMap((n) => [`${n}.json`, `${n}.peaks`]).sort());
});

for (const name of names) {
  test(`${name}: the file matches its JSON expectations and its generator`, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
    const bytes = fs.readFileSync(path.join(DIR, fixture.file));
    const built = generator.buildCase(generator.CASES.find((c) => c.name === name));
    assert.deepEqual(fixture, built.fixture);
    assert.ok(bytes.equals(built.bytes), 'the .peaks bytes are the generator output');
    assert.equal(bytes.length, fixture.size);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.sha256);

    const { header, levels } = decode(bytes);
    const { signal } = fixture;
    assert.equal(header.version, 1);
    assert.equal(header.reserved, 0);
    assert.equal(header.channels, signal.channels);
    assert.equal(header.frames, BigInt(signal.frames));
    assert.equal(header.sampleRate, signal.sampleRate);
    assert.equal(header.levels, fixture.levels.length);
    levels.forEach((level, k) => {
      assert.equal(level.binFrames, 256 * 4 ** k);
      assert.equal(level.binCount, Math.ceil(signal.frames / level.binFrames));
      assert.equal(level.binCount <= 1, k === levels.length - 1, 'only the last level has at most one bin');
      assert.equal(level.binFrames, fixture.levels[k].binFrames);
      assert.equal(level.binCount, fixture.levels[k].binCount);
      for (let c = 0; c < signal.channels; c += 1) {
        assert.deepEqual(level.pairs[c], fixture.levels[k].first[c]);
        assert.deepEqual(level.pairs[(level.binCount - 1) * signal.channels + c], fixture.levels[k].last[c]);
      }
    });
  });

  test(`${name}: every bin holds the min and max of its own frames`, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
    const { levels } = decode(fs.readFileSync(path.join(DIR, fixture.file)));
    const { signal } = fixture;
    for (const level of levels) {
      for (let bin = 0; bin < level.binCount; bin += 1) {
        const first = bin * level.binFrames;
        const last = Math.min(first + level.binFrames, signal.frames) - 1;
        for (let c = 0; c < signal.channels; c += 1) {
          const got = level.pairs[bin * signal.channels + c];
          if (signal.kind === 'silence') {
            assert.deepEqual(got, { min: 0, max: 0 });
          } else if (signal.kind === 'square') {
            // A bin wider than half a period holds both halves, saturating.
            const span = last - first + 1;
            const a = q(signal.amplitude);
            const b = q(-signal.amplitude);
            if (span > signal.period / 2) assert.deepEqual(got, { min: b, max: a }, `bin ${bin}`);
          } else {
            // A monotonic ramp: the bin's first and last frames are its extremes.
            const at = (i) => (2 * i) / (signal.frames - 1) - 1;
            const ends = [q(c % 2 === 0 ? at(first) : -at(first)), q(c % 2 === 0 ? at(last) : -at(last))];
            assert.deepEqual(got, { min: Math.min(...ends), max: Math.max(...ends) }, `level ${level.binFrames} bin ${bin}`);
          }
        }
      }
    }
  });
}

test('a partial last bin holds only the media frames, and loud samples saturate', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(DIR, 'overload-mono.json'), 'utf8'));
  // 300 frames: bin 1 of level 0 covers 256..299, the high half of period 8 and
  // 12 frames of the low half; amplitude 1.5 saturates at both ends.
  assert.deepEqual(fixture.levels[0].last[0], { min: -32768, max: 32767 });
  const ramp = JSON.parse(fs.readFileSync(path.join(DIR, 'ramp-stereo.json'), 'utf8'));
  // The ramp ends at +1 on channel 0: a zero-padded last bin would report max 32767 too,
  // but its min would be 0 instead of the ramp value at frame 2816.
  assert.equal(ramp.levels[0].last[0].max, 32767);
  assert.equal(ramp.levels[0].last[0].min, q((2 * 2816) / 2999 - 1));
  assert.ok(ramp.levels[0].last[0].min > 0);
});
