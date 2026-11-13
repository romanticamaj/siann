// The key dispatcher (m5-ui-shell; UI redesign spec 3.6): pure over the key
// event's code and modifiers, the focused zone, whether the target is a text
// field and the platform. The focused zone's binding wins over the window's
// for the same chord, a key falls through to the window otherwise, nothing
// fires while a text field has focus, and keys match on event.code so Opt+I
// on macOS (event.key 'ˆ') still toggles the left zone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Binding } from '../../src/renderer/keys/commands';
import { chordOf, isTextField, resolveKey, type KeyInput } from '../../src/renderer/keys/dispatcher';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';

const NONE = { ctrl: false, alt: false, shift: false, meta: false };

function input(over: Partial<KeyInput>): KeyInput {
  return {
    code: 'KeyA',
    key: 'a',
    modifiers: NONE,
    targetIsTextField: false,
    focusedZone: 'project',
    platform: 'other',
    ...over,
  };
}

const PRESET: readonly Binding[] = [
  { chord: 'Delete', commandId: 'edit.delete', scope: 'project' },
  { chord: 'Mod+Alt+L', commandId: 'zone.left.toggle', scope: 'window' },
  { chord: 'Alt+I', commandId: 'zone.left.toggle', scope: 'window' },
  { chord: 'F3', commandId: 'zone.lower.mixconsole', scope: 'window' },
  // The same chord in a zone and in the window: the zone wins when focused.
  { chord: 'Escape', commandId: 'edit.cancel', scope: 'project' },
  { chord: 'Escape', commandId: 'zone.right.toggle', scope: 'window' },
];

test('chords: Mod is Ctrl on Windows and Linux and Cmd on macOS; the key comes from event.code', () => {
  assert.equal(chordOf(input({ code: 'KeyL', key: 'l', modifiers: { ...NONE, ctrl: true, alt: true } })), 'Mod+Alt+L');
  assert.equal(chordOf(input({ code: 'KeyL', key: '¬', modifiers: { ...NONE, meta: true, alt: true }, platform: 'mac' })), 'Mod+Alt+L');
  assert.equal(chordOf(input({ code: 'KeyL', key: 'l', modifiers: { ...NONE, ctrl: true, alt: true }, platform: 'mac' })), 'Ctrl+Alt+L');
  assert.equal(chordOf(input({ code: 'Tab', key: 'Tab', modifiers: { ...NONE, shift: true } })), 'Shift+Tab');
  assert.equal(chordOf(input({ code: 'Digit1', key: '!', modifiers: { ...NONE, shift: true } })), 'Shift+1');
  assert.equal(chordOf(input({ code: 'F3', key: 'F3' })), 'F3');
});

test('the focused zone wins over the window for the same chord, and a key falls through to the window', () => {
  const escape = input({ code: 'Escape', key: 'Escape' });
  assert.equal(resolveKey(escape, PRESET)?.commandId, 'edit.cancel');
  assert.equal(resolveKey({ ...escape, focusedZone: 'right' }, PRESET)?.commandId, 'zone.right.toggle');
  assert.equal(resolveKey(input({ code: 'F3', key: 'F3', focusedZone: 'lower' }), PRESET)?.commandId, 'zone.lower.mixconsole');
  // A zone binding does not fire in another zone.
  assert.equal(resolveKey(input({ code: 'Delete', key: 'Delete', focusedZone: 'right' }), PRESET), null);
  assert.equal(resolveKey(input({ code: 'Delete', key: 'Delete' }), PRESET)?.commandId, 'edit.delete');
  assert.equal(resolveKey(input({ code: 'KeyQ', key: 'q' }), PRESET), null);
});

test('nothing fires while a text field has focus', () => {
  for (const code of ['Delete', 'Escape', 'F3']) {
    assert.equal(resolveKey(input({ code, key: code, targetIsTextField: true }), PRESET), null, code);
  }
  assert.equal(
    resolveKey(input({ code: 'KeyL', key: 'l', modifiers: { ...NONE, ctrl: true, alt: true }, targetIsTextField: true }), PRESET),
    null,
  );
  // Only the focus keys leave a text field, as the platform's own Tab and F6 do.
  assert.equal(resolveKey(input({ code: 'Tab', key: 'Tab', targetIsTextField: true }), CUBASE_PRESET)?.commandId, 'focus.next');
  assert.equal(resolveKey(input({ code: 'F6', key: 'F6', targetIsTextField: true }), CUBASE_PRESET)?.commandId, 'focus.nextZone');
  assert.equal(
    resolveKey(input({ code: 'Escape', key: 'Escape', targetIsTextField: true }), CUBASE_PRESET)?.commandId,
    'focus.zoneRoot',
  );
  assert.equal(resolveKey(input({ code: 'Enter', key: 'Enter', targetIsTextField: true }), CUBASE_PRESET), null);
  assert.equal(resolveKey(input({ code: 'Delete', key: 'Delete', targetIsTextField: true }), CUBASE_PRESET), null);
});

test('isTextField: input, textarea, select and contenteditable', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
  assert.equal(isTextField(el('INPUT', { type: 'text' })), true);
  assert.equal(isTextField(el('INPUT', { type: 'search' })), true);
  assert.equal(isTextField(el('TEXTAREA')), true);
  assert.equal(isTextField(el('SELECT')), true);
  assert.equal(isTextField(el('DIV', { isContentEditable: true })), true);
  assert.equal(isTextField(el('BUTTON')), false);
  assert.equal(isTextField(el('DIV')), false);
  // A fader or a checkbox takes no typing.
  assert.equal(isTextField(el('INPUT', { type: 'range' })), false);
  assert.equal(isTextField(el('INPUT', { type: 'checkbox' })), false);
  assert.equal(isTextField(null), false);
});

test('while the engine is disconnected no zone command runs; the window layout and focus commands still do', () => {
  const offline = (over: Partial<KeyInput>) => input({ ...over, offline: true });
  // Delete in the project zone would remove the selected clip (a request).
  assert.equal(resolveKey(offline({ code: 'Delete', key: 'Delete' }), CUBASE_PRESET), null);
  assert.equal(resolveKey(offline({ code: 'Backspace', key: 'Backspace' }), CUBASE_PRESET), null);
  assert.equal(resolveKey(input({ code: 'Delete', key: 'Delete' }), CUBASE_PRESET)?.commandId, 'edit.delete');
  // The project zone's Escape gives way to the window's.
  assert.equal(resolveKey(offline({ code: 'Escape', key: 'Escape' }), CUBASE_PRESET)?.commandId, 'focus.zoneRoot');
  // Layout and focus keys send nothing and stay.
  assert.equal(resolveKey(offline({ code: 'F3', key: 'F3' }), CUBASE_PRESET)?.commandId, 'zone.lower.mixconsole');
  assert.equal(
    resolveKey(offline({ code: 'KeyP', key: 'p', modifiers: { ...NONE, ctrl: true, alt: true } }), CUBASE_PRESET)?.commandId,
    'zone.right.plans',
  );
  assert.equal(resolveKey(offline({ code: 'Tab', key: 'Tab' }), CUBASE_PRESET)?.commandId, 'focus.next');
  assert.equal(resolveKey(offline({ code: 'F6', key: 'F6' }), CUBASE_PRESET)?.commandId, 'focus.nextZone');
});

test('Opt+I on macOS toggles the left zone (event.key is a dead character there)', () => {
  const optI = input({ code: 'KeyI', key: 'ˆ', modifiers: { ...NONE, alt: true }, platform: 'mac' });
  assert.equal(resolveKey(optI, CUBASE_PRESET)?.commandId, 'zone.left.toggle');
  const cmdOptL = input({ code: 'KeyL', key: '¬', modifiers: { ...NONE, meta: true, alt: true }, platform: 'mac' });
  assert.equal(resolveKey(cmdOptL, CUBASE_PRESET)?.commandId, 'zone.left.toggle');
  const ctrlAltL = input({ code: 'KeyL', key: 'l', modifiers: { ...NONE, ctrl: true, alt: true } });
  assert.equal(resolveKey(ctrlAltL, CUBASE_PRESET)?.commandId, 'zone.left.toggle');
});
