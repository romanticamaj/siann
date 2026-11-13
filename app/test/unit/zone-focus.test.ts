// Keyboard focus between and inside the zones (m5-ui-shell; UI redesign spec
// 2.1, 2.3 and 3.6). Tab and Shift+Tab cycle the zones when the focus is on a
// zone itself or on the page, and move between the controls of a zone (its
// divider included) when the focus is on one of them, wrapping at the zone's
// ends; F6 and Shift+F6 cycle the zones from anywhere; Enter on a zone moves
// into its first control and Escape from a control returns to the zone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { focusMove, ringStep, type FocusPlace } from '../../src/renderer/keys/zone-focus';

const ROOT: FocusPlace = { kind: 'zone', zone: 'lower' };
const CONTROL: FocusPlace = { kind: 'control', zone: 'lower' };
const BODY: FocusPlace = { kind: 'page' };
const OUTSIDE: FocusPlace = { kind: 'outside' };

test('Tab and Shift+Tab cycle the zones from a zone or the page', () => {
  for (const place of [ROOT, BODY]) {
    assert.deepEqual(focusMove('focus.next', place), { type: 'zone', step: 1 });
    assert.deepEqual(focusMove('focus.prev', place), { type: 'zone', step: -1 });
  }
});

test('Tab and Shift+Tab move between the controls of the zone from inside it', () => {
  assert.deepEqual(focusMove('focus.next', CONTROL), { type: 'control', zone: 'lower', step: 1 });
  assert.deepEqual(focusMove('focus.prev', CONTROL), { type: 'control', zone: 'lower', step: -1 });
});

test('outside the zones (top bar, status bar, a dialog) Tab stays native', () => {
  assert.equal(focusMove('focus.next', OUTSIDE), null);
  assert.equal(focusMove('focus.prev', OUTSIDE), null);
});

test('F6 and Shift+F6 cycle the zones from anywhere but a dialog', () => {
  for (const place of [ROOT, CONTROL, BODY, OUTSIDE]) {
    assert.deepEqual(focusMove('focus.nextZone', place), { type: 'zone', step: 1 });
    assert.deepEqual(focusMove('focus.prevZone', place), { type: 'zone', step: -1 });
  }
  assert.equal(focusMove('focus.nextZone', { kind: 'dialog' }), null);
  assert.equal(focusMove('focus.next', { kind: 'dialog' }), null);
});

test('Enter on a zone enters it; Escape from a control returns to its zone', () => {
  assert.deepEqual(focusMove('focus.enterZone', ROOT), { type: 'enter', zone: 'lower' });
  for (const place of [CONTROL, BODY, OUTSIDE]) assert.equal(focusMove('focus.enterZone', place), null);
  assert.deepEqual(focusMove('focus.zoneRoot', CONTROL), { type: 'root', zone: 'lower' });
  for (const place of [ROOT, BODY, OUTSIDE]) assert.equal(focusMove('focus.zoneRoot', place), null);
});

test('the ring wraps at both ends and starts at an end when nothing in it has the focus', () => {
  const ring = ['divider', 'tab', 'mute', 'fader'];
  assert.equal(ringStep(ring, 'tab', 1), 'mute');
  assert.equal(ringStep(ring, 'fader', 1), 'divider');
  assert.equal(ringStep(ring, 'divider', -1), 'fader');
  assert.equal(ringStep(ring, null, 1), 'divider');
  assert.equal(ringStep(ring, null, -1), 'fader');
  assert.equal(ringStep([], null, 1), undefined);
});
