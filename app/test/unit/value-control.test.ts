// The value controls' maths (m5-ui-mixer; UI redesign spec 3.4: Ctrl-click
// resets, Shift-drag is fine adjustment, double-click types a value, for
// every value control in the app). Pure functions: a drag turns pixels along
// the control into a position of its travel; Shift moves a tenth as far and
// switching it mid-drag does not jump; Ctrl-click gives the default (gain
// 0 dB, pan C); the pan knob maps -10000..10000 with a detent at the centre;
// a typed gain or pan is parsed as the user writes it (dB, L/C/R).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FINE_FACTOR,
  defaultValue,
  dragTo,
  panToPosition,
  parseTyped,
  positionToPan,
  startDrag,
} from '../../src/renderer/mixer/value-control';

const INT32_MIN = -2147483648;

test('a drag moves the position by the pixels over the travel', () => {
  const drag = startDrag(0.5, 100, 200, false);
  assert.equal(dragTo(drag, 150, false).position, 0.75);
  assert.equal(dragTo(drag, 60, false).position, 0.3);
  // Clamped to the travel.
  assert.equal(dragTo(drag, 1000, false).position, 1);
  assert.equal(dragTo(drag, -1000, false).position, 0);
});

test('Shift moves a tenth as far', () => {
  assert.equal(FINE_FACTOR, 0.1);
  const plain = dragTo(startDrag(0.5, 0, 200, false), 40, false).position - 0.5;
  const fine = dragTo(startDrag(0.5, 0, 200, true), 40, true).position - 0.5;
  assert.ok(Math.abs(fine - plain / 10) < 1e-12, `${fine} vs ${plain}`);
});

test('pressing or releasing Shift mid-drag does not jump', () => {
  let drag = startDrag(0.5, 0, 200, false);
  let step = dragTo(drag, 40, false); // 0.7
  drag = step.drag;
  // Shift goes down at the same pixel: the position stays.
  step = dragTo(drag, 40, true);
  assert.ok(Math.abs(step.position - 0.7) < 1e-12);
  drag = step.drag;
  // Fine from there: 20 px more is 0.01.
  step = dragTo(drag, 60, true);
  assert.ok(Math.abs(step.position - 0.71) < 1e-12, String(step.position));
  drag = step.drag;
  // Shift released at the same pixel: no jump; 20 px more is 0.1.
  step = dragTo(drag, 60, false);
  assert.ok(Math.abs(step.position - 0.71) < 1e-12);
  step = dragTo(step.drag, 80, false);
  assert.ok(Math.abs(step.position - 0.81) < 1e-12, String(step.position));
});

test('Ctrl-click gives the default: gain 0 dB, pan centre', () => {
  assert.equal(defaultValue('gain'), 0);
  assert.equal(defaultValue('pan'), 0);
});

test('the pan knob maps -10000..10000 onto the travel with a centre detent', () => {
  assert.equal(panToPosition(-10000), 0);
  assert.equal(panToPosition(0), 0.5);
  assert.equal(panToPosition(10000), 1);
  assert.equal(positionToPan(0), -10000);
  assert.equal(positionToPan(1), 10000);
  assert.equal(positionToPan(0.5), 0);
  assert.equal(positionToPan(0.325), -3500);
  assert.equal(positionToPan(0.7), 4000);
  // Within the detent, the centre.
  assert.equal(positionToPan(0.505), 0);
  assert.equal(positionToPan(0.496), 0);
  // Whole percent steps outside it.
  assert.equal(positionToPan(0.6123), 2200);
});

test('a typed gain: dB with or without the unit, a sign, -inf; a comma is refused; clamped to -inf..+6 dB', () => {
  assert.equal(parseTyped('gain', '-6'), -6000);
  assert.equal(parseTyped('gain', '-6.5 dB'), -6500);
  assert.equal(parseTyped('gain', '-6.5dB'), -6500);
  assert.equal(parseTyped('gain', ' +3 '), 3000);
  assert.equal(parseTyped('gain', '0'), 0);
  assert.equal(parseTyped('gain', '-inf'), INT32_MIN);
  assert.equal(parseTyped('gain', '-INF dB'), INT32_MIN);
  assert.equal(parseTyped('gain', '-6,5'), null);
  assert.equal(parseTyped('gain', 'loud'), null);
  assert.equal(parseTyped('gain', ''), null);
  assert.equal(parseTyped('gain', '+12'), 6000, 'above the top clamps to +6 dB');
  assert.equal(parseTyped('gain', '-200'), INT32_MIN, 'below the model\'s -144 dB is minus infinity');
});

test('a typed pan: L35, R40, C, any case; invalid is null', () => {
  assert.equal(parseTyped('pan', 'L35'), -3500);
  assert.equal(parseTyped('pan', 'R40'), 4000);
  assert.equal(parseTyped('pan', 'C'), 0);
  assert.equal(parseTyped('pan', 'c'), 0);
  assert.equal(parseTyped('pan', 'l100'), -10000);
  assert.equal(parseTyped('pan', ' r7 '), 700);
  assert.equal(parseTyped('pan', 'R150'), 10000, 'clamped to hard right');
  assert.equal(parseTyped('pan', 'X10'), null);
  assert.equal(parseTyped('pan', 'L'), null);
  assert.equal(parseTyped('pan', 'L3.5'), null);
  assert.equal(parseTyped('pan', ''), null);
});
