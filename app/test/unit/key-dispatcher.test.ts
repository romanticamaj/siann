// The key dispatcher (m5-ui-shell; UI redesign spec 3.6): pure over the key
// event's code and modifiers, the focused zone, whether the target is a text
// field and the platform. The focused zone's binding wins over the window's
// for the same chord, a key falls through to the window otherwise, nothing
// fires while a text field has focus, and keys match on event.code so Opt+I
// on macOS (event.key 'ˆ') still toggles the left zone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Binding } from '../../src/renderer/keys/commands';
import { chordOf, composingKey, isTextField, resolveKey, type KeyInput } from '../../src/renderer/keys/dispatcher';
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

// m5b-ui-notepad (acceptance 2 as corrected; UI redesign 2.1, 3.4, 10.11
// item 24): from the Notepad's text area M mutes nothing and Mod+Enter runs no
// preset command (the area commits it itself), while Escape, Tab and F6 still
// move the focus.
test('from the Notepad\'s TEXTAREA KeyM and Mod+Enter resolve to nothing; Escape, Tab and F6 to the focus commands', () => {
  const area = { tagName: 'TEXTAREA' } as unknown as EventTarget;
  assert.equal(isTextField(area), true);
  const field = (code: string, key: string, modifiers = NONE, platform: 'mac' | 'other' = 'other') =>
    resolveKey(input({ code, key, modifiers, targetIsTextField: isTextField(area), focusedZone: 'left', platform }), CUBASE_PRESET);
  // M is bound outside a field (mute the selected track).
  assert.notEqual(resolveKey(input({ code: 'KeyM', key: 'm' }), CUBASE_PRESET), null, 'M is bound');
  assert.equal(field('KeyM', 'm'), null);
  assert.equal(resolveKey(input({ code: 'KeyM', key: 'm', targetIsTextField: true }), CUBASE_PRESET), null, 'whatever zone has the frame');
  // Mod+Enter is plans.primary in the right zone (3.6); from the area, nothing, on both platforms.
  assert.notEqual(resolveKey(input({ code: 'Enter', key: 'Enter', modifiers: { ...NONE, ctrl: true }, focusedZone: 'right' }), CUBASE_PRESET), null, 'Mod+Enter is bound');
  for (const focusedZone of ['left', 'right'] as const) {
    assert.equal(resolveKey(input({ code: 'Enter', key: 'Enter', modifiers: { ...NONE, ctrl: true }, targetIsTextField: true, focusedZone }), CUBASE_PRESET), null, focusedZone);
    assert.equal(resolveKey(input({ code: 'Enter', key: 'Enter', modifiers: { ...NONE, meta: true }, targetIsTextField: true, focusedZone, platform: 'mac' }), CUBASE_PRESET), null, `${focusedZone} mac`);
  }
  assert.equal(field('Escape', 'Escape')?.commandId, 'focus.zoneRoot');
  assert.equal(field('Tab', 'Tab')?.commandId, 'focus.next');
  assert.equal(field('F6', 'F6')?.commandId, 'focus.nextZone');
});

// m5b-ui-composer (acceptance 1 as corrected; UI redesign 2.1): from the
// "ask the agent" box no transport, edit or tool command runs, while the focus
// keys still move the focus.
test('from a text field Space, Delete, a digit, Mod+Z and numpad Enter run nothing; the focus keys still resolve', () => {
  const field = (code: string, key: string, modifiers = NONE) => resolveKey(input({ code, key, modifiers, targetIsTextField: true }), CUBASE_PRESET);
  // Each of them is bound outside a field.
  for (const [code, key, modifiers] of [
    ['Space', ' ', NONE],
    ['Delete', 'Delete', NONE],
    ['Digit1', '1', NONE],
    ['KeyZ', 'z', { ...NONE, ctrl: true }],
    ['NumpadEnter', 'Enter', NONE],
  ] as const) {
    assert.notEqual(resolveKey(input({ code, key, modifiers }), CUBASE_PRESET), null, `${code} is bound in the project zone`);
    assert.equal(field(code, key, modifiers), null, `${code} from the box`);
  }
  assert.equal(field('KeyA', 'a'), null, 'a typed character');
  assert.equal(field('Escape', 'Escape')?.commandId, 'focus.zoneRoot');
  assert.equal(field('Tab', 'Tab')?.commandId, 'focus.next');
  assert.equal(field('Tab', 'Tab', { ...NONE, shift: true })?.commandId, 'focus.prev');
  assert.equal(field('F6', 'F6')?.commandId, 'focus.nextZone');
  assert.equal(field('F6', 'F6', { ...NONE, shift: true })?.commandId, 'focus.prevZone');
});

test('a key that belongs to an input-method composition is not the shell\'s (isComposing, or keyCode 229)', () => {
  assert.equal(composingKey({ isComposing: true, keyCode: 27 }), true, 'Escape that cancels a composition');
  assert.equal(composingKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(composingKey({ isComposing: false, keyCode: 27 }), false);
  assert.equal(composingKey({ isComposing: false, keyCode: 9 }), false);
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

// m5b-ui-project: the start view covers the zones (they are inert), so only
// the window's project, Studio Setup and focus keys run; Space plays nothing.
test('under the start view only Ctrl+N, Ctrl+O, Ctrl+S and the focus keys run', () => {
  const covered = (over: Partial<KeyInput>) => input({ ...over, startView: true });
  const ctrl = { ...NONE, ctrl: true };
  assert.equal(resolveKey(covered({ code: 'KeyN', key: 'n', modifiers: ctrl }), CUBASE_PRESET)?.commandId, 'project.new');
  assert.equal(resolveKey(covered({ code: 'KeyO', key: 'o', modifiers: ctrl }), CUBASE_PRESET)?.commandId, 'project.open');
  assert.equal(resolveKey(covered({ code: 'KeyS', key: 's', modifiers: ctrl }), CUBASE_PRESET)?.commandId, 'project.save');
  assert.equal(resolveKey(covered({ code: 'Tab', key: 'Tab' }), CUBASE_PRESET)?.commandId, 'focus.next');
  for (const [code, key] of [['Space', ' '], ['KeyT', 't'], ['Delete', 'Delete'], ['F3', 'F3']] as const) {
    assert.equal(resolveKey(covered({ code, key }), CUBASE_PRESET), null, code);
  }
  assert.equal(resolveKey(input({ code: 'KeyN', key: 'n', modifiers: ctrl }), CUBASE_PRESET)?.commandId, 'project.new');
});

test('the editing keys (m5-ui-edit-basics) never fire while typing; 1 is the number row, not the numpad', () => {
  const keys: Array<[string, Partial<KeyInput['modifiers']>]> = [
    ['Digit1', {}],
    ['Digit3', {}],
    ['KeyX', { alt: true }],
    ['KeyD', { ctrl: true }],
    ['KeyJ', {}],
    ['KeyA', { ctrl: true }],
    ['KeyL', {}],
    ['KeyN', {}],
    ['KeyB', {}],
    ['KeyS', { alt: true }],
    ['KeyE', { shift: true }],
    ['KeyM', {}],
    ['KeyS', {}],
    ['Delete', { shift: true }],
  ];
  for (const [code, mods] of keys) {
    const key = input({ code, key: code, modifiers: { ...NONE, ...mods } });
    assert.ok(resolveKey(key, CUBASE_PRESET), `${code} is bound`);
    assert.equal(resolveKey({ ...key, targetIsTextField: true }, CUBASE_PRESET), null, `${code} while typing`);
  }
  assert.equal(resolveKey(input({ code: 'Digit1', key: '1' }), CUBASE_PRESET)?.commandId, 'tool.select');
  // Num 1 is not the tool: it goes to the left locator (m5-ui-loop-click).
  assert.equal(resolveKey(input({ code: 'Numpad1', key: '1' }), CUBASE_PRESET)?.commandId, 'transport.toLeftLocator');
  assert.equal(resolveKey(input({ code: 'Numpad3', key: '3' }), CUBASE_PRESET)?.commandId, undefined);
  // Cmd+D on macOS, Ctrl+D elsewhere.
  assert.equal(resolveKey(input({ code: 'KeyD', key: 'd', modifiers: { ...NONE, meta: true }, platform: 'mac' }), CUBASE_PRESET)?.commandId, 'edit.duplicate');
  assert.equal(resolveKey(input({ code: 'KeyD', key: 'd', modifiers: { ...NONE, ctrl: true } }), CUBASE_PRESET)?.commandId, 'edit.duplicate');
  // Plain Delete still deletes clips; Shift+Delete removes tracks.
  assert.equal(resolveKey(input({ code: 'Delete', key: 'Delete' }), CUBASE_PRESET)?.commandId, 'edit.delete');
  assert.equal(resolveKey(input({ code: 'Delete', key: 'Delete', modifiers: { ...NONE, shift: true } }), CUBASE_PRESET)?.commandId, 'track.removeSelected');
});

test('Opt+I on macOS toggles the left zone (event.key is a dead character there)', () => {
  const optI = input({ code: 'KeyI', key: 'ˆ', modifiers: { ...NONE, alt: true }, platform: 'mac' });
  assert.equal(resolveKey(optI, CUBASE_PRESET)?.commandId, 'zone.left.toggle');
  const cmdOptL = input({ code: 'KeyL', key: '¬', modifiers: { ...NONE, meta: true, alt: true }, platform: 'mac' });
  assert.equal(resolveKey(cmdOptL, CUBASE_PRESET)?.commandId, 'zone.left.toggle');
  const ctrlAltL = input({ code: 'KeyL', key: 'l', modifiers: { ...NONE, ctrl: true, alt: true } });
  assert.equal(resolveKey(ctrlAltL, CUBASE_PRESET)?.commandId, 'zone.left.toggle');
});

// m5-ui-transport (UI redesign spec 3.1, 3.6): the transport keys, the
// position display's keys and undo and redo are window commands keyed on
// event.code, so the numpad's Enter and decimal point are chords of their own.
const TRANSPORT_KEYS: ReadonlyArray<{ code: string; key: string; modifiers?: Partial<typeof NONE>; commandId: string }> = [
  { code: 'Space', key: ' ', commandId: 'transport.toggle' },
  { code: 'NumpadEnter', key: 'Enter', commandId: 'transport.start' },
  { code: 'Numpad0', key: '0', commandId: 'transport.stop' },
  { code: 'NumpadDecimal', key: '.', commandId: 'transport.toStart' },
  { code: 'Comma', key: ',', commandId: 'transport.toStart' },
  { code: 'Period', key: '.', commandId: 'transport.exchangeFormats' },
  { code: 'KeyP', key: 'P', modifiers: { shift: true }, commandId: 'transport.enterPosition' },
  { code: 'KeyZ', key: 'z', modifiers: { ctrl: true }, commandId: 'edit.undo' },
  { code: 'KeyZ', key: 'Z', modifiers: { ctrl: true, shift: true }, commandId: 'edit.redo' },
];

test('the transport keys resolve in every zone, and none while a text field has focus or the engine is away', () => {
  for (const { code, key, modifiers, commandId } of TRANSPORT_KEYS) {
    const press = input({ code, key, modifiers: { ...NONE, ...modifiers } });
    for (const focusedZone of ['project', 'left', 'lower', 'right'] as const) {
      assert.equal(resolveKey({ ...press, focusedZone }, CUBASE_PRESET)?.commandId, commandId, `${code} in ${focusedZone}`);
    }
    assert.equal(resolveKey({ ...press, targetIsTextField: true }, CUBASE_PRESET), null, `${code} in a text field`);
    assert.equal(resolveKey({ ...press, offline: true }, CUBASE_PRESET), null, `${code} while offline`);
  }
  // Cmd+Z and Cmd+Shift+Z on macOS.
  const cmdZ = input({ code: 'KeyZ', key: 'z', modifiers: { ...NONE, meta: true }, platform: 'mac' });
  assert.equal(resolveKey(cmdZ, CUBASE_PRESET)?.commandId, 'edit.undo');
  assert.equal(resolveKey({ ...cmdZ, modifiers: { ...NONE, meta: true, shift: true } }, CUBASE_PRESET)?.commandId, 'edit.redo');
});

test('F toggles auto-scroll in the project zone only; the numpad keys are not their main-block twins', () => {
  assert.equal(resolveKey(input({ code: 'KeyF', key: 'f' }), CUBASE_PRESET)?.commandId, 'view.autoScroll');
  assert.equal(resolveKey(input({ code: 'KeyF', key: 'f', focusedZone: 'lower' }), CUBASE_PRESET), null);
  assert.equal(resolveKey(input({ code: 'KeyF', key: 'f', targetIsTextField: true }), CUBASE_PRESET), null);
  assert.equal(resolveKey(input({ code: 'KeyF', key: 'f', offline: true }), CUBASE_PRESET), null);
  assert.equal(resolveKey(input({ code: 'KeyF', key: 'F', modifiers: { ...NONE, shift: true } }), CUBASE_PRESET)?.commandId, 'view.zoomFull');
  // Numpad Enter starts playback; the main Enter still enters a zone.
  assert.equal(resolveKey(input({ code: 'NumpadEnter', key: 'Enter' }), CUBASE_PRESET)?.commandId, 'transport.start');
  assert.equal(resolveKey(input({ code: 'Enter', key: 'Enter' }), CUBASE_PRESET)?.commandId, 'focus.enterZone');
  // The numpad's decimal point (key 'Delete' with Num Lock off) is not Delete.
  assert.equal(resolveKey(input({ code: 'NumpadDecimal', key: 'Delete' }), CUBASE_PRESET)?.commandId, 'transport.toStart');
});

// m5-ui-loop-click: the locator, cycle and metronome keys.
const LOOP_KEYS: Array<{ code: string; key: string; modifiers?: Partial<typeof NONE>; commandId: string }> = [
  { code: 'KeyP', key: 'p', commandId: 'transport.locatorsToSelection' },
  { code: 'KeyP', key: 'p', modifiers: { alt: true }, commandId: 'transport.loopSelection' },
  { code: 'KeyC', key: 'c', commandId: 'transport.metronomeToggle' },
  { code: 'NumpadDivide', key: '/', commandId: 'transport.cycleToggle' },
  { code: 'Slash', key: '/', commandId: 'transport.cycleToggle' },
  { code: 'Numpad1', key: '1', commandId: 'transport.toLeftLocator' },
  { code: 'Numpad2', key: '2', commandId: 'transport.toRightLocator' },
  { code: 'Digit1', key: '!', modifiers: { shift: true }, commandId: 'transport.toLeftLocator' },
  { code: 'Digit2', key: '@', modifiers: { shift: true }, commandId: 'transport.toRightLocator' },
  { code: 'Numpad1', key: '1', modifiers: { ctrl: true }, commandId: 'transport.setLeftLocator' },
  { code: 'Numpad2', key: '2', modifiers: { ctrl: true }, commandId: 'transport.setRightLocator' },
];

test('the locator, cycle and metronome keys resolve in every zone and never in a text field', () => {
  for (const { code, key, modifiers, commandId } of LOOP_KEYS) {
    const press = input({ code, key, modifiers: { ...NONE, ...modifiers } });
    for (const focusedZone of ['project', 'left', 'lower', 'right'] as const) {
      assert.equal(resolveKey({ ...press, focusedZone }, CUBASE_PRESET)?.commandId, commandId, `${code} in ${focusedZone}`);
    }
    assert.equal(resolveKey({ ...press, targetIsTextField: true }, CUBASE_PRESET), null, `${code} in a text field`);
    assert.equal(resolveKey({ ...press, offline: true }, CUBASE_PRESET), null, `${code} while offline`);
  }
  // Cmd+Num 1 on macOS sets the left locator; the number row's 1 stays the tool, Num 1 is not Digit1.
  assert.equal(resolveKey(input({ code: 'Numpad1', key: '1', modifiers: { ...NONE, meta: true }, platform: 'mac' }), CUBASE_PRESET)?.commandId, 'transport.setLeftLocator');
  assert.equal(resolveKey(input({ code: 'Digit1', key: '1' }), CUBASE_PRESET)?.commandId, 'tool.select');
  assert.equal(resolveKey(input({ code: 'KeyP', key: 'P', modifiers: { ...NONE, shift: true } }), CUBASE_PRESET)?.commandId, 'transport.enterPosition');
});

test('Ctrl+Alt+G toggles the ghosts from any zone, Cmd+Alt+G on macOS, and not while typing (m5b-ui-ghosts)', () => {
  const win = input({ code: 'KeyG', key: 'g', modifiers: { ...NONE, ctrl: true, alt: true } });
  const mac = input({ code: 'KeyG', key: 'g', modifiers: { ...NONE, meta: true, alt: true }, platform: 'mac' });
  for (const key of [win, mac]) {
    assert.equal(chordOf(key), 'Mod+Alt+G');
    for (const focusedZone of ['project', 'left', 'lower', 'right'] as const) {
      assert.equal(resolveKey({ ...key, focusedZone }, CUBASE_PRESET)?.commandId, 'plans.toggleGhosts', focusedZone);
    }
    assert.equal(resolveKey({ ...key, targetIsTextField: true }, CUBASE_PRESET), null);
  }
});

test('Ctrl+P opens the Media tab on Windows and Linux, Cmd+P on macOS, from any zone and not while typing (m5b-ui-media)', () => {
  const ctrlP = input({ code: 'KeyP', key: 'p', modifiers: { ...NONE, ctrl: true } });
  const cmdP = input({ code: 'KeyP', key: 'p', modifiers: { ...NONE, meta: true }, platform: 'mac' });
  assert.equal(chordOf(ctrlP), 'Mod+P');
  assert.equal(chordOf(cmdP), 'Mod+P');
  for (const key of [ctrlP, cmdP]) {
    for (const focusedZone of ['project', 'left', 'lower', 'right'] as const) {
      assert.equal(resolveKey({ ...key, focusedZone }, CUBASE_PRESET)?.commandId, 'media.open', focusedZone);
    }
    assert.equal(resolveKey({ ...key, targetIsTextField: true }, CUBASE_PRESET), null);
  }
  // Ctrl+P on macOS is the Control key: not the Media tab.
  assert.notEqual(resolveKey(input({ code: 'KeyP', key: 'p', modifiers: { ...NONE, ctrl: true }, platform: 'mac' }), CUBASE_PRESET)?.commandId, 'media.open');
});

// m5b-ui-recording: R in the project zone only (it acts on the selected
// track, as M and S do); Num *, Ctrl+Shift+R (Cmd+Shift+R on macOS), I and O
// from every zone; none while typing.
test('the record keys resolve where they are bound and never in a text field (m5b-ui-recording)', () => {
  const r = input({ code: 'KeyR', key: 'r' });
  assert.equal(resolveKey(r, CUBASE_PRESET)?.commandId, 'track.recordEnable');
  assert.equal(resolveKey({ ...r, focusedZone: 'lower' }, CUBASE_PRESET), null);
  assert.equal(resolveKey({ ...r, targetIsTextField: true }, CUBASE_PRESET), null);
  const windowKeys: Array<{ code: string; key: string; modifiers?: Partial<typeof NONE>; platform?: 'mac' | 'other'; commandId: string }> = [
    { code: 'NumpadMultiply', key: '*', commandId: 'transport.record' },
    { code: 'KeyR', key: 'R', modifiers: { ctrl: true, shift: true }, commandId: 'transport.record' },
    { code: 'KeyR', key: 'R', modifiers: { meta: true, shift: true }, platform: 'mac', commandId: 'transport.record' },
    { code: 'KeyI', key: 'i', commandId: 'transport.punchIn' },
    { code: 'KeyO', key: 'o', commandId: 'transport.punchOut' },
  ];
  for (const { code, key, modifiers, platform, commandId } of windowKeys) {
    const press = input({ code, key, modifiers: { ...NONE, ...modifiers }, ...(platform ? { platform } : {}) });
    for (const focusedZone of ['project', 'left', 'lower', 'right'] as const) {
      assert.equal(resolveKey({ ...press, focusedZone }, CUBASE_PRESET)?.commandId, commandId, `${code} in ${focusedZone}`);
    }
    assert.equal(resolveKey({ ...press, targetIsTextField: true }, CUBASE_PRESET), null, `${code} in a text field`);
  }
  // The number row's 8 with Shift is not Num *.
  assert.equal(resolveKey(input({ code: 'Digit8', key: '*', modifiers: { ...NONE, shift: true } }), CUBASE_PRESET), null);
});

// m5b-ui-editor-channel: the Channel zone is a focus scope whose keys are the
// window's; H and G go to the focused zone's zoom (the event display's in the
// project zone, the sample editor's in the lower zone); the tab keys run in
// every zone, and the Channel zone key also while the engine is away.
test('the Channel zone resolves the window\'s keys; H and G follow the focused zone; Ctrl+Alt+arrows step tabs (m5b-ui-editor-channel)', () => {
  const space = input({ code: 'Space', key: ' ', focusedZone: 'channel' });
  assert.equal(resolveKey(space, CUBASE_PRESET)?.commandId, 'transport.toggle');
  const toggle = input({ code: 'KeyC', key: 'c', modifiers: { ...NONE, ctrl: true, alt: true } });
  for (const focusedZone of ['channel', 'project', 'left', 'lower', 'right'] as const) {
    assert.equal(resolveKey({ ...toggle, focusedZone }, CUBASE_PRESET)?.commandId, 'zone.channel.toggle', focusedZone);
  }
  assert.equal(resolveKey({ ...toggle, platform: 'mac', modifiers: { ...NONE, meta: true, alt: true } }, CUBASE_PRESET)?.commandId, 'zone.channel.toggle');
  assert.equal(resolveKey({ ...toggle, offline: true }, CUBASE_PRESET)?.commandId, 'zone.channel.toggle', 'a layout key, offline too');
  const h = input({ code: 'KeyH', key: 'h' });
  assert.deepEqual([resolveKey({ ...h, focusedZone: 'lower' }, CUBASE_PRESET)?.scope, resolveKey({ ...h, focusedZone: 'lower' }, CUBASE_PRESET)?.commandId], ['lower', 'view.zoomIn']);
  assert.deepEqual([resolveKey(h, CUBASE_PRESET)?.scope, resolveKey(h, CUBASE_PRESET)?.commandId], ['project', 'view.zoomIn']);
  assert.equal(resolveKey({ ...input({ code: 'KeyG', key: 'g' }), focusedZone: 'lower' }, CUBASE_PRESET)?.scope, 'lower');
  assert.equal(resolveKey({ ...h, focusedZone: 'right' }, CUBASE_PRESET), null);
  const next = input({ code: 'ArrowRight', key: 'ArrowRight', modifiers: { ...NONE, ctrl: true, alt: true }, focusedZone: 'lower' });
  assert.equal(resolveKey(next, CUBASE_PRESET)?.commandId, 'zone.tab.next');
  assert.equal(resolveKey({ ...next, code: 'ArrowLeft', key: 'ArrowLeft' }, CUBASE_PRESET)?.commandId, 'zone.tab.prev');
  // Ctrl+Right alone stays the project zone's nudge.
  assert.equal(resolveKey({ ...next, modifiers: { ...NONE, ctrl: true }, focusedZone: 'project' }, CUBASE_PRESET)?.commandId, 'edit.nudgeRight');
  assert.equal(resolveKey({ ...next, targetIsTextField: true }, CUBASE_PRESET), null);
});
