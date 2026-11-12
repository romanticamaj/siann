// The gain fader's audio taper and the meter's peak hold (UX pass, A5/A17).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MINUS_INFINITY_MILLI_DB } from '../../src/renderer/format';
import { PeakHold, meterFraction, peakText } from '../../src/renderer/mixer/peak-hold';
import { FADER_MAX_MILLI_DB, UNITY_POSITION, dragGain, gainToPosition, positionToGain, stepGain } from '../../src/renderer/mixer/taper';

test('-inf at the bottom, 0 dB at three quarters, the maximum at the top', () => {
  assert.equal(gainToPosition(MINUS_INFINITY_MILLI_DB), 0);
  assert.equal(positionToGain(0), MINUS_INFINITY_MILLI_DB);
  assert.equal(gainToPosition(0), UNITY_POSITION);
  assert.equal(positionToGain(UNITY_POSITION), 0);
  assert.equal(gainToPosition(FADER_MAX_MILLI_DB), 1);
  assert.equal(positionToGain(1), FADER_MAX_MILLI_DB);
  assert.equal(gainToPosition(20_000), 1, 'above the fader maximum pins at the top');
  assert.equal(gainToPosition(-200_000), 0);
  assert.equal(positionToGain(-1), MINUS_INFINITY_MILLI_DB);
  assert.equal(positionToGain(2), FADER_MAX_MILLI_DB);
});

test('the taper is monotonic and round-trips every tenth of a dB on the travel', () => {
  let last = -1;
  for (let milli = -60_000; milli <= FADER_MAX_MILLI_DB; milli += 100) {
    const position = gainToPosition(milli);
    assert.ok(position > last, `${milli} is above the gain below it`);
    last = position;
    assert.equal(positionToGain(position), milli, `${milli} round-trips`);
  }
});

test('the dB per unit of travel shrinks toward 0 dB', () => {
  const slope = (a: number, b: number) => (b - a) / (gainToPosition(b) - gainToPosition(a));
  assert.ok(slope(-60_000, -40_000) > slope(-24_000, -12_000));
  assert.ok(slope(-24_000, -12_000) > slope(-6_000, 0));
});

test('a drag moves along the taper, Shift is ten times finer, 0 dB is a detent', () => {
  // 200 px of travel: 0 dB is at 150 px from the bottom.
  assert.equal(dragGain(0, 0, 200), 0);
  assert.ok(dragGain(0, 20, 200) < 0, 'down lowers the gain');
  assert.ok(dragGain(0, -20, 200) > 0, 'up raises it');
  assert.equal(dragGain(0, 2, 200), 0, 'held by the detent');
  assert.equal(dragGain(-6000, -30, 200), 0, 'lands on the detent from below');
  const coarse = dragGain(-12_000, -20, 200);
  const fine = dragGain(-12_000, -20, 200, true);
  assert.ok(fine > -12_000 && fine < coarse, 'fine moves less');
  assert.equal(dragGain(-12_000, 10_000, 200), MINUS_INFINITY_MILLI_DB, 'past the bottom is -inf');
  assert.equal(dragGain(-12_000, -10_000, 200), FADER_MAX_MILLI_DB, 'past the top is the maximum');
});

test('keyboard steps are 0.5 dB (0.1 dB fine) and leave and reach -inf', () => {
  assert.equal(stepGain(0, 1), 500);
  assert.equal(stepGain(0, -1, true), -100);
  assert.equal(stepGain(-1250, 1), -700, 'snapped to a tenth');
  assert.equal(stepGain(MINUS_INFINITY_MILLI_DB, 1), -60_000);
  assert.equal(stepGain(MINUS_INFINITY_MILLI_DB, -1), MINUS_INFINITY_MILLI_DB);
  assert.equal(stepGain(-143_800, -1), MINUS_INFINITY_MILLI_DB);
  assert.equal(stepGain(11_800, 1), FADER_MAX_MILLI_DB);
});

test('peak hold keeps the highest peak for its hold time; a clip latches until cleared', () => {
  const hold = new PeakHold(1500);
  assert.equal(hold.update(0.5, 0), 0.5);
  assert.equal(hold.update(0.2, 1000), 0.5, 'held');
  assert.equal(hold.update(0.2, 1600), 0.2, 'released after the hold time');
  assert.equal(hold.update(0.3, 1700), 0.3, 'a higher peak takes over at once');
  assert.equal(hold.clipped(), false);
  hold.update(1.2, 1800);
  hold.update(0.1, 5000);
  assert.equal(hold.clipped(), true, 'latched');
  hold.clearClip();
  assert.equal(hold.clipped(), false);
  assert.equal(hold.update(Number.NaN, 6000), 0);
});

test('meter scale and readout', () => {
  assert.equal(meterFraction(0), 0);
  assert.equal(meterFraction(1), 1);
  assert.equal(meterFraction(2), 1);
  assert.ok(Math.abs(meterFraction(0.5) - (60 - 6.0206) / 60) < 1e-6);
  assert.equal(peakText(0), '-inf');
  assert.equal(peakText(1), '0.0');
  assert.equal(peakText(0.5), '-6.0');
  assert.equal(peakText(1.05), '+0.4');
  assert.equal(peakText(1e-9), '-inf');
});
