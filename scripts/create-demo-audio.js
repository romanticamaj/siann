#!/usr/bin/env node
// Demo WAV files (mono, 16-bit PCM): a sine with short fades. `writeWav`
// takes the sample rate (48000 by default), and the CLI takes
// `--sample-rate <n>` for both demo files, so a test can import a file whose
// rate differs from the session's (m5b-ui-media).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SAMPLE_RATE = 48000;

function writeWav(file, frequency, seconds = 0.5, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error(`not a sample rate: ${sampleRate}`);
  const frames = Math.floor(sampleRate * seconds);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const fadeFrames = Math.max(1, Math.round((1200 * sampleRate) / DEFAULT_SAMPLE_RATE));
  for (let i = 0; i < frames; i += 1) {
    const fade = Math.min(1, i / fadeFrames, (frames - i) / fadeFrames);
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000 * fade);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  fs.writeFileSync(file, buffer);
}

function writeDemoAudio(outDir, options = {}) {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const absoluteOutDir = path.resolve(outDir);
  fs.mkdirSync(absoluteOutDir, { recursive: true });
  writeWav(path.join(absoluteOutDir, 'riser.wav'), 660, 0.5, sampleRate);
  writeWav(path.join(absoluteOutDir, 'impact.wav'), 110, 0.5, sampleRate);
  return absoluteOutDir;
}

// `[outDir] [--sample-rate <n>]`; a rate that is not a positive integer is refused.
function parseArgs(argv) {
  let outDir;
  let sampleRate = DEFAULT_SAMPLE_RATE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sample-rate') {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`--sample-rate needs a positive integer sample rate, not ${JSON.stringify(value ?? '')}`);
      sampleRate = Number(value);
    } else if (outDir === undefined) {
      outDir = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return { outDir: outDir ?? path.join(os.tmpdir(), 'siann-import-pack-demo', 'audio'), sampleRate };
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  console.log(`Wrote demo audio to ${writeDemoAudio(args.outDir, { sampleRate: args.sampleRate })}`);
}

module.exports = {
  writeDemoAudio,
  writeWav,
};
