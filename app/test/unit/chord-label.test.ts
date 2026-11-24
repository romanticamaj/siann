// A chord as people read it (m5b-ui-keymap; UI redesign 3.6): formatChord
// writes a preset chord for the platform, the one place a key's written form
// comes from (menus show the accelerator, tooltips, the MixConsole tab's
// kbd, the Inspector's hint and the Key Commands list read it). Windows and
// Linux as Cubase's tables write keys (Ctrl+Alt+L, Num 0, Ctrl+Left); macOS
// in Apple's glyphs, Control, Option, Shift, Command in that order (⌥⌘L).
// tipWithKey adds the key a control's command is bound to after its label.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANCEL_CHORD, COMMIT_CHORD, SET_EACH_CHORD, chordsOf, formatChord, formatModifier, tipWithKey } from '../../src/renderer/keys/chord-label';
import { TOOL_MODIFIERS } from '../../src/renderer/keys/tool-modifiers';
import { COMMAND_IDS } from '../../src/renderer/keys/commands';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';
import { translator } from '../../src/renderer/i18n/t';

test('Windows and Linux: modifiers spelled out, Cubase\'s key names', () => {
  const cases: Array<[string, string]> = [
    ['Mod+Alt+L', 'Ctrl+Alt+L'],
    ['Alt+I', 'Alt+I'],
    ['Mod+Shift+Z', 'Ctrl+Shift+Z'],
    ['Shift+1', 'Shift+1'],
    ['Numpad0', 'Num 0'],
    ['Mod+Numpad1', 'Ctrl+Num 1'],
    ['NumpadEnter', 'Num Enter'],
    ['NumpadDecimal', 'Num .'],
    ['NumpadComma', 'Num ,'],
    ['NumpadDivide', 'Num /'],
    ['NumpadMultiply', 'Num *'],
    ['NumpadSubtract', 'Num -'],
    ['NumpadAdd', 'Num +'],
    ['Mod+NumpadSubtract', 'Ctrl+Num -'],
    ['Comma', ','],
    ['Period', '.'],
    ['Slash', '/'],
    ['Minus', '-'],
    ['Equal', '='],
    ['Mod+Minus', 'Ctrl+-'],
    ['Mod+Equal', 'Ctrl+='],
    ['Mod+ArrowLeft', 'Ctrl+Left'],
    ['Alt+Shift+ArrowRight', 'Alt+Shift+Right'],
    ['Mod+Alt+ArrowUp', 'Ctrl+Alt+Up'],
    ['Space', 'Space'],
    ['Enter', 'Enter'],
    ['Mod+Enter', 'Ctrl+Enter'],
    ['Shift+Enter', 'Shift+Enter'],
    ['Escape', 'Esc'],
    ['Delete', 'Delete'],
    ['Shift+Delete', 'Shift+Delete'],
    ['Backspace', 'Backspace'],
    ['Insert', 'Insert'],
    ['Tab', 'Tab'],
    ['F3', 'F3'],
    ['Shift+F6', 'Shift+F6'],
  ];
  for (const [chord, written] of cases) assert.equal(formatChord(chord, 'other'), written, chord);
});

test('macOS: Apple\'s glyphs, Control Option Shift Command in that order, the key last', () => {
  const cases: Array<[string, string]> = [
    ['Mod+Alt+L', '⌥⌘L'],
    ['Alt+I', '⌥I'],
    ['Mod+Shift+Z', '⇧⌘Z'],
    ['Mod+Alt+P', '⌥⌘P'],
    ['Mod+Shift+R', '⇧⌘R'],
    ['Shift+1', '⇧1'],
    ['Mod+Numpad1', '⌘Num 1'],
    ['Numpad0', 'Num 0'],
    ['Mod+ArrowLeft', '⌘←'],
    ['Alt+Shift+ArrowRight', '⌥⇧→'],
    ['Mod+Enter', '⌘↩'],
    ['Mod+Minus', '⌘-'],
    ['Ctrl+Alt+K', '⌃⌥K'],
    ['Space', 'Space'],
    ['F3', 'F3'],
  ];
  for (const [chord, written] of cases) assert.equal(formatChord(chord, 'mac'), written, chord);
});

test('every chord of the preset has a written form on both platforms', () => {
  for (const binding of CUBASE_PRESET) {
    for (const platform of ['other', 'mac'] as const) {
      const written = formatChord(binding.chord, platform);
      assert.ok(written.length > 0 && !/Numpad|Arrow|Digit|Key[A-Z]/.test(written), `${binding.chord} on ${platform}: ${written}`);
    }
  }
});

test('chordsOf: a command\'s chords, the window\'s first, each once; none for an unbound command', () => {
  assert.deepEqual(chordsOf('zone.left.toggle'), ['Mod+Alt+L', 'Alt+I']);
  assert.deepEqual(chordsOf('transport.stop'), ['Numpad0', 'Shift+0']);
  assert.deepEqual(chordsOf('view.zoomIn'), ['H']);
  assert.deepEqual(chordsOf('edit.glue'), []);
  assert.deepEqual(chordsOf('help.keyCommands'), []);
  for (const id of COMMAND_IDS) assert.equal(new Set(chordsOf(id)).size, chordsOf(id).length, id);
});

test('tipWithKey: the label, then the first key in the locale\'s brackets; the label alone without a key', () => {
  const en = translator('en');
  const zh = translator('zh-Hant');
  assert.equal(tipWithKey(en, 'Stop', 'transport.stop', 'other'), 'Stop (Num 0)');
  assert.equal(tipWithKey(zh, '停止', 'transport.stop', 'other'), '停止（Num 0）');
  assert.equal(tipWithKey(en, 'Left zone', 'zone.left.toggle', 'mac'), 'Left zone (⌥⌘L)');
  assert.equal(tipWithKey(en, 'Glue', 'edit.glue', 'other'), 'Glue');
});

test('the keys catalog sentences name come from here: Enter, Escape, the set-each chord, a tool modifier', () => {
  assert.equal(formatChord(COMMIT_CHORD, 'other'), 'Enter');
  assert.equal(formatChord(COMMIT_CHORD, 'mac'), '↩');
  assert.equal(formatChord(CANCEL_CHORD, 'other'), 'Esc');
  assert.equal(formatChord(CANCEL_CHORD, 'mac'), 'Esc');
  assert.equal(formatChord(SET_EACH_CHORD, 'other'), 'Ctrl+Enter');
  assert.equal(formatChord(SET_EACH_CHORD, 'mac'), '⌘↩');
  assert.equal(formatModifier(TOOL_MODIFIERS.fine, 'other'), 'Shift');
  assert.equal(formatModifier(TOOL_MODIFIERS.fine, 'mac'), '⇧');
  assert.equal(formatModifier('Mod', 'other'), 'Ctrl');
  assert.equal(formatModifier('Mod', 'mac'), '⌘');
  assert.equal(formatModifier('Alt', 'mac'), '⌥');
  // The info line's tooltip names Enter one way on each platform.
  const en = translator('en');
  for (const platform of ['other', 'mac'] as const) {
    const hint = en('info.editHint', { commit: formatChord(COMMIT_CHORD, platform), key: formatChord(SET_EACH_CHORD, platform), cancel: formatChord(CANCEL_CHORD, platform) });
    assert.ok(!hint.includes('{'), hint);
    if (platform === 'mac') assert.ok(!hint.includes('Enter') && !hint.includes('Return'), hint);
  }
  assert.equal(en('clip.gainControl', { key: formatModifier(TOOL_MODIFIERS.fine, 'mac') }), 'Clip volume: drag up or down, ⇧ for fine steps');
});
