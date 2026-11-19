// The keys the main process takes before the page (shell hardening; UI
// redesign 3.1): F12 and Ctrl/Cmd+Shift+I open devtools, F5 and plain
// Ctrl/Cmd+R reload. Ctrl/Cmd+Shift+R is not a reload here: it is Record's
// laptop fallback (m5b-ui-recording, the Cubase preset's Mod+Shift+R), so it
// goes on to the renderer's key dispatcher, on Windows and Linux (Ctrl) and
// on macOS (Cmd) alike.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDevtoolsOrReloadKey, type KeyInput } from '../../src/main/blocked-keys';

const key = (k: string, mods: Partial<Omit<KeyInput, 'key'>> = {}): KeyInput => ({ key: k, control: false, meta: false, shift: false, ...mods });

test('F12, F5, Ctrl/Cmd+Shift+I and plain Ctrl/Cmd+R are taken', () => {
  for (const input of [
    key('F12'),
    key('F5'),
    key('I', { control: true, shift: true }),
    key('I', { meta: true, shift: true }),
    key('r', { control: true }),
    key('R', { control: true }),
    key('r', { meta: true }),
  ]) assert.equal(isDevtoolsOrReloadKey(input), true, JSON.stringify(input));
});

test('Ctrl+Shift+R and Cmd+Shift+R go on to the renderer (Record\'s fallback)', () => {
  assert.equal(isDevtoolsOrReloadKey(key('R', { control: true, shift: true })), false);
  assert.equal(isDevtoolsOrReloadKey(key('r', { control: true, shift: true })), false);
  assert.equal(isDevtoolsOrReloadKey(key('R', { meta: true, shift: true })), false);
});

test('other keys go on to the renderer', () => {
  for (const input of [key('r'), key('R', { shift: true }), key('i', { control: true }), key('Space'), key('Multiply')]) {
    assert.equal(isDevtoolsOrReloadKey(input), false, JSON.stringify(input));
  }
});
