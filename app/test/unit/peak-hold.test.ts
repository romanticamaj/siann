// Meter ballistics (m5-ui-mixer; UI redesign spec 1.6 and 1.2): instant
// attack, a release of 20 dB in 1.7 s (IEC 60268-18's digital PPM return
// rate), a peak-hold line that stays 1.5 s and then falls, and a clip
// indication that latches until reset. Time is the sum of the frame deltas
// the draw loop passes in; no clock is read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FLOOR_DB, HOLD_SECONDS, PeakHold, RELEASE_DB_PER_SECOND } from '../../src/renderer/mixer/peak-hold';

const db = (linear: number) => 20 * Math.log10(linear);
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${what}: ${actual} vs ${expected}`);

// Steps index 0 with `linear` for `seconds`, in frames of 1/60 s.
function run(meter: PeakHold, linear: number, seconds: number): void {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i += 1) meter.step(0, linear, 1 / 60);
}

test('the constants are the spec\'s', () => {
  near(RELEASE_DB_PER_SECOND * 1.7, 20, 'release');
  assert.equal(HOLD_SECONDS, 1.5);
});

test('a step up shows at once', () => {
  const meter = new PeakHold(1);
  assert.equal(meter.level[0], FLOOR_DB);
  meter.step(0, 0.5, 1 / 60);
  near(meter.level[0]!, db(0.5), 'level');
  near(meter.hold[0]!, db(0.5), 'hold');
  near(meter.max[0]!, 0.5, 'max');
});

test('after the input drops the bar falls 20 dB in 1.7 s', () => {
  const meter = new PeakHold(1);
  meter.step(0, 0.5, 1 / 60);
  run(meter, 0, 0.85);
  near(meter.level[0]!, db(0.5) - 10, 'half way');
  run(meter, 0, 0.85);
  near(meter.level[0]!, db(0.5) - 20, 'after 1.7 s');
  // A louder input than the falling bar takes over at once.
  meter.step(0, 0.25, 1 / 60);
  near(meter.level[0]!, db(0.25), 'attack again');
  // It never falls under the floor.
  run(meter, 0, 30);
  assert.equal(meter.level[0], FLOOR_DB);
  assert.equal(meter.decayed(0), true);
});

test('the hold line stays 1.5 s, then falls at the release rate', () => {
  const meter = new PeakHold(1);
  meter.step(0, 1 / Math.SQRT2, 1 / 60); // -3 dB
  run(meter, 0, 1.45);
  near(meter.hold[0]!, -3.01, 'held');
  run(meter, 0, 0.05);
  near(meter.hold[0]!, -3.01, 'held at 1.5 s');
  run(meter, 0, 0.85);
  near(meter.hold[0]!, -3.01 - 10, 'falling after the hold');
  assert.equal(meter.decayed(0), false);
  // A new peak above the line re-arms the hold.
  meter.step(0, 0.5, 1 / 60);
  near(meter.hold[0]!, db(0.5), 're-armed');
  run(meter, 0, 1.4);
  near(meter.hold[0]!, db(0.5), 'held again');
});

test('a peak at or above 1.0 latches clip until reset; reset clears hold, max and clip', () => {
  const meter = new PeakHold(2);
  meter.step(0, 0.99, 1 / 60);
  assert.equal(meter.clip[0], 0);
  meter.step(0, 1.0, 1 / 60);
  assert.equal(meter.clip[0], 1);
  run(meter, 0, 10);
  assert.equal(meter.clip[0], 1, 'latched while silent');
  near(meter.max[0]!, 1, 'max peak kept');
  assert.equal(meter.clip[1], 0, 'other meters untouched');
  meter.reset(0);
  assert.equal(meter.clip[0], 0);
  assert.equal(meter.max[0], 0);
  assert.equal(meter.hold[0], FLOOR_DB);
});

test('resize starts every meter from silence', () => {
  const meter = new PeakHold(1);
  meter.step(0, 2, 1 / 60);
  meter.resize(3);
  assert.equal(meter.level.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(meter.level[i], FLOOR_DB);
    assert.equal(meter.clip[i], 0);
    assert.equal(meter.max[i], 0);
  }
});
