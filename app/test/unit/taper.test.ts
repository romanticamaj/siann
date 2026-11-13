// The fader taper (m5-ui-mixer; UI redesign spec 4.5 C7 and 3.4): minus
// infinity at the bottom, 0 dB at 75 % of the travel, +6 dB at the top, and
// piecewise linear in dB between the spec's breakpoints (100 % = +6, 75 % = 0,
// 50 % = -12, 30 % = -24, 15 % = -40, 5 % = -60 dB; linear in amplitude below
// 5 %). A stored gain above +6 dB pins the cap at the top. Expectations are the
// spec's table, not the code's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAboveCap, milliDbToPosition, positionToMilliDb } from '../../src/renderer/mixer/taper';

const INT32_MIN = -2147483648;

test('the ends and 0 dB at three quarters of the travel', () => {
  assert.equal(positionToMilliDb(1), 6000);
  assert.equal(positionToMilliDb(0.75), 0);
  assert.equal(positionToMilliDb(0), INT32_MIN);
  assert.equal(milliDbToPosition(6000), 1);
  assert.equal(milliDbToPosition(0), 0.75);
  assert.equal(milliDbToPosition(INT32_MIN), 0);
  // Outside the travel clamps.
  assert.equal(positionToMilliDb(1.5), 6000);
  assert.equal(positionToMilliDb(-0.2), INT32_MIN);
});

test('the spec\'s breakpoints, both ways', () => {
  const table: Array<[number, number]> = [
    [1, 6000],
    [0.75, 0],
    [0.5, -12000],
    [0.3, -24000],
    [0.15, -40000],
    [0.05, -60000],
  ];
  for (const [position, milliDb] of table) {
    assert.equal(positionToMilliDb(position), milliDb, `position ${position}`);
    assert.ok(Math.abs(milliDbToPosition(milliDb) - position) < 1e-9, `${milliDb} mdB`);
  }
  // Linear in dB between two breakpoints: the middle of 50..75 % is -6 dB.
  assert.equal(positionToMilliDb(0.625), -6000);
  // Linear in amplitude below 5 %: half of 5 % is -60 dB - 6.02 dB.
  assert.equal(positionToMilliDb(0.025), Math.round(-60000 + 20000 * Math.log10(0.5)));
});

test('monotonic over 1001 positions', () => {
  let previous = -Infinity;
  for (let i = 0; i <= 1000; i += 1) {
    const value = positionToMilliDb(i / 1000);
    assert.ok(value > previous, `position ${i / 1000}: ${value} after ${previous}`);
    previous = value;
  }
});

test('a round trip lands within one milli-dB', () => {
  for (let milliDb = -100000; milliDb <= 6000; milliDb += 37) {
    const back = positionToMilliDb(milliDbToPosition(milliDb));
    assert.ok(Math.abs(back - milliDb) <= 1, `${milliDb} came back as ${back}`);
  }
});

test('a stored gain above +6 dB pins the cap at the top and is flagged', () => {
  assert.equal(milliDbToPosition(9000), 1);
  assert.equal(milliDbToPosition(24000), 1);
  assert.equal(isAboveCap(9000), true);
  assert.equal(isAboveCap(6000), false);
  assert.equal(isAboveCap(0), false);
  assert.equal(isAboveCap(INT32_MIN), false);
});

test('finer near 0 dB: fewer dB per unit of travel around 75 % than around 20 %', () => {
  const slope = (at: number) => (positionToMilliDb(at + 0.01) - positionToMilliDb(at - 0.01)) / 0.02;
  assert.ok(slope(0.75) < slope(0.2), `${slope(0.75)} vs ${slope(0.2)}`);
  assert.ok(slope(0.7) < slope(0.4));
});
