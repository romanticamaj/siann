#!/usr/bin/env node
// Regenerates fixtures/peaks/<name>.json and fixtures/peaks/<name>.peaks.
//
// Peak pyramids (docs/schemas/protocol-peaks-v0.md, architecture spec Protocol
// v0 item 23) of small synthetic signals, written by a plain Node
// implementation of the file format, independent of the C++ producer
// (native/libs/media, computePeaks / encodePeaks) and the renderer's decoder
// (app/src/renderer/model/peaks.ts), which are both tested against these bytes.
//
// Each signal is described in its JSON file so the C++ tests can build the same
// float samples: every sample is a double expression rounded once to float32.
//
//   silence  0
//   square   +amplitude for the first period/2 frames of each period, then
//            -amplitude; channel c is shifted by c * period / 4 frames
//   ramp     2 * i / (frames - 1) - 1 on even channels, its negation on odd ones
//
//   node scripts/generate-peaks-fixtures.js          writes the files
//   node scripts/generate-peaks-fixtures.js --check  exits 1 when they differ
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'peaks');
const BASE_BIN_FRAMES = 256;
const MAX_LEVEL = 11; // 256 * 4^11 frames is the longest media (spec, item 23)

const CASES = [
  { name: 'silence-mono', signal: { kind: 'silence', channels: 1, frames: 5000, sampleRate: 48000 } },
  { name: 'square-mono', signal: { kind: 'square', channels: 1, frames: 5000, sampleRate: 48000, amplitude: 1, period: 64 } },
  { name: 'ramp-stereo', signal: { kind: 'ramp', channels: 2, frames: 3000, sampleRate: 44100 } },
  { name: 'square-stereo-exact', signal: { kind: 'square', channels: 2, frames: 1024, sampleRate: 48000, amplitude: 0.5, period: 100 } },
  { name: 'overload-mono', signal: { kind: 'square', channels: 1, frames: 300, sampleRate: 48000, amplitude: 1.5, period: 64 } },
  { name: 'short-mono', signal: { kind: 'ramp', channels: 1, frames: 100, sampleRate: 48000 } },
];

// The float32 sample of a signal at frame i, channel c.
function sample(signal, i, c) {
  switch (signal.kind) {
    case 'silence':
      return 0;
    case 'square': {
      const shifted = i + (c * signal.period) / 4;
      const high = Math.floor(shifted / (signal.period / 2)) % 2 === 0;
      return Math.fround(high ? signal.amplitude : -signal.amplitude);
    }
    case 'ramp': {
      const value = (2 * i) / (signal.frames - 1) - 1;
      return Math.fround(c % 2 === 0 ? value : -value);
    }
    default:
      throw new Error(`unknown signal kind ${signal.kind}`);
  }
}

// floor(x * 32767 + 0.5) in double, clamped to int16; NaN is 0.
function quantize(x) {
  if (Number.isNaN(x)) return 0;
  const v = Math.floor(x * 32767 + 0.5);
  return Math.max(-32768, Math.min(32767, v));
}

// Levels as [{binFrames, binCount, pairs: Int16Array(binCount * channels * 2)}].
function pyramid(signal) {
  const { channels, frames } = signal;
  const levels = [];
  for (let k = 0; k <= MAX_LEVEL; k += 1) {
    const binFrames = BASE_BIN_FRAMES * 4 ** k;
    const binCount = Math.ceil(frames / binFrames);
    const pairs = new Int16Array(binCount * channels * 2);
    for (let bin = 0; bin < binCount; bin += 1) {
      const end = Math.min((bin + 1) * binFrames, frames);
      for (let c = 0; c < channels; c += 1) {
        let min = 32767;
        let max = -32768;
        for (let i = bin * binFrames; i < end; i += 1) {
          const q = quantize(sample(signal, i, c));
          if (q < min) min = q;
          if (q > max) max = q;
        }
        pairs[(bin * channels + c) * 2] = min;
        pairs[(bin * channels + c) * 2 + 1] = max;
      }
    }
    levels.push({ binFrames, binCount, pairs });
    if (binCount <= 1) return levels;
  }
  throw new Error(`${frames} frames is longer than the format allows`);
}

function encode(signal, levels) {
  const size = 20 + levels.reduce((n, level) => n + 8 + level.pairs.length * 2, 0);
  const out = Buffer.alloc(size);
  out.write('SPKS', 0, 'latin1');
  out.writeUInt8(1, 4);
  out.writeUInt8(signal.channels, 5);
  out.writeUInt8(levels.length, 6);
  out.writeUInt8(0, 7);
  out.writeBigUInt64LE(BigInt(signal.frames), 8);
  out.writeUInt32LE(signal.sampleRate, 16);
  let at = 20;
  for (const level of levels) {
    out.writeUInt32LE(level.binFrames, at);
    out.writeUInt32LE(level.binCount, at + 4);
    at += 8;
    for (const value of level.pairs) {
      out.writeInt16LE(value, at);
      at += 2;
    }
  }
  return out;
}

function buildCase({ name, signal }) {
  const levels = pyramid(signal);
  const bytes = encode(signal, levels);
  const fixture = {
    schema: 'siann.peaks_fixture.v0',
    name,
    signal,
    file: `${name}.peaks`,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    header: { version: 1, channels: signal.channels, levels: levels.length, frames: String(signal.frames), sampleRate: signal.sampleRate },
    levels: levels.map((level) => ({
      binFrames: level.binFrames,
      binCount: level.binCount,
      // The first and last bin of every channel, as {min, max}.
      first: Array.from({ length: signal.channels }, (_, c) => ({ min: level.pairs[c * 2], max: level.pairs[c * 2 + 1] })),
      last: Array.from({ length: signal.channels }, (_, c) => {
        const at = ((level.binCount - 1) * signal.channels + c) * 2;
        return { min: level.pairs[at], max: level.pairs[at + 1] };
      }),
    })),
  };
  return { fixture, bytes };
}

function buildAll() {
  return CASES.map(buildCase);
}

function main() {
  const check = process.argv.includes('--check');
  let stale = false;
  if (!check) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const { fixture, bytes } of buildAll()) {
    const json = `${JSON.stringify(fixture, null, 2)}\n`;
    const jsonFile = path.join(FIXTURE_DIR, `${fixture.name}.json`);
    const peaksFile = path.join(FIXTURE_DIR, fixture.file);
    if (check) {
      const same =
        fs.existsSync(jsonFile) &&
        fs.existsSync(peaksFile) &&
        JSON.stringify(JSON.parse(fs.readFileSync(jsonFile, 'utf8'))) === JSON.stringify(fixture) &&
        fs.readFileSync(peaksFile).equals(bytes);
      if (!same) {
        console.error(`stale: ${fixture.name}`);
        stale = true;
      }
    } else {
      fs.writeFileSync(jsonFile, json);
      fs.writeFileSync(peaksFile, bytes);
    }
  }
  if (stale) process.exit(1);
}

if (require.main === module) main();

module.exports = { CASES, FIXTURE_DIR, buildAll, buildCase, quantize, sample };
