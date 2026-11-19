// scripts/create-demo-audio.js (m5b-ui-media): the demo WAV writer takes the
// sample rate (48000 by default), and its CLI takes --sample-rate, so the
// media e2e can import a 44.1 kHz file into a 48 kHz session.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { writeWav } = require('../scripts/create-demo-audio');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'create-demo-audio.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siann-demo-audio-'));
}

// The header fields of a mono 16-bit PCM WAV: the rate (byte 24), the byte
// rate (byte 28) and the data chunk's size (byte 40), as frames.
function header(file) {
  const bytes = fs.readFileSync(file);
  return {
    riff: bytes.toString('latin1', 0, 4),
    rate: bytes.readUInt32LE(24),
    byteRate: bytes.readUInt32LE(28),
    frames: bytes.readUInt32LE(40) / 2,
    length: bytes.length,
  };
}

test('writeWav writes the sample rate it is given in the header, and rate x seconds frames', () => {
  const dir = scratch();
  const file = path.join(dir, 'a.wav');
  writeWav(file, 440, 0.5, 44100);
  const h = header(file);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.rate, 44100);
  assert.equal(h.byteRate, 44100 * 2);
  assert.equal(h.frames, 22050);
  assert.equal(h.length, 44 + 22050 * 2);
});

test('writeWav writes 48000 when no rate is given', () => {
  const dir = scratch();
  const file = path.join(dir, 'b.wav');
  writeWav(file, 440, 0.25);
  const h = header(file);
  assert.equal(h.rate, 48000);
  assert.equal(h.byteRate, 96000);
  assert.equal(h.frames, 12000);
});

test('the CLI writes both demo files at the rate --sample-rate names', () => {
  const dir = scratch();
  const result = spawnSync(process.execPath, [SCRIPT, dir, '--sample-rate', '44100'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['riser.wav', 'impact.wav']) {
    const h = header(path.join(dir, name));
    assert.equal(h.rate, 44100, name);
    assert.equal(h.frames, 22050, name);
  }
});

test('the CLI writes 48 kHz without --sample-rate', () => {
  const dir = scratch();
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(header(path.join(dir, 'riser.wav')).rate, 48000);
});

test('the CLI refuses a sample rate that is not a positive integer, and writes nothing', () => {
  for (const bad of ['0', '-44100', 'fast', '44100.5', '']) {
    const dir = path.join(scratch(), 'out');
    const result = spawnSync(process.execPath, [SCRIPT, dir, '--sample-rate', bad], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `--sample-rate ${JSON.stringify(bad)}`);
    assert.match(result.stderr, /sample rate/i);
    assert.equal(fs.existsSync(path.join(dir, 'riser.wav')), false);
  }
  const missing = spawnSync(process.execPath, [SCRIPT, scratch(), '--sample-rate'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
});
