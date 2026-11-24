// A chord as people read it (m5b-ui-keymap; UI redesign 3.6): the one place
// a key's written form comes from. Menus, tooltips, the MixConsole tab's kbd,
// the Inspector's hint, catalog strings that name a key (as a {key}
// placeholder) and the Key Commands list read a preset chord
// (preset-cubase.ts: Mod, Ctrl, Alt, Shift, then the key as event.code names
// it) and write it here for the platform:
//
// - Windows and Linux as Cubase's key-command tables write keys: Ctrl+Alt+L,
//   Num 0, Ctrl+Num 1, Ctrl+Left, Shift+Enter, the punctuation keys as their
//   character (, . / - =);
// - macOS in Apple's glyphs, Control, Option, Shift, Command in that order,
//   then the key (⌥⌘L, ⇧⌘Z, ⌘←, ⌘↩).
//
// The name table below is the only place outside the preset and the tool
// modifiers that spells a key; key-literals.test.ts fails on any other.

import type { T } from '../i18n/t';
import type { Binding, CommandId } from './commands';
import { platformOf } from './dispatcher';
import { CUBASE_PRESET } from './preset-cubase';

export type Platform = 'mac' | 'other';

// Key names on Windows and Linux; macOS overrides a few with Apple's glyphs.
const NAMES: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  NumpadEnter: 'Num Enter',
  NumpadDecimal: 'Num .',
  NumpadComma: 'Num ,',
  NumpadDivide: 'Num /',
  NumpadMultiply: 'Num *',
  NumpadSubtract: 'Num -',
  NumpadAdd: 'Num +',
};

const MAC_NAMES: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '↩',
};

// Apple's order: Control, Option, Shift, Command.
const MAC_MODIFIERS: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['Mod', '⌘'],
];

function keyName(key: string, platform: Platform): string {
  if (platform === 'mac' && MAC_NAMES[key]) return MAC_NAMES[key]!;
  if (NAMES[key]) return NAMES[key]!;
  const numpad = /^Numpad([0-9])$/.exec(key);
  if (numpad) return `Num ${numpad[1]}`;
  return key;
}

export function formatChord(chord: string, platform: Platform): string {
  const parts = chord.split('+');
  const key = keyName(parts.pop() ?? '', platform);
  if (platform === 'mac') {
    return `${MAC_MODIFIERS.filter(([modifier]) => parts.includes(modifier)).map(([, glyph]) => glyph).join('')}${key}`;
  }
  return [...parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)), key].join('+');
}

// A command's chords: the window's first, then the zones' in the preset's
// order, each chord once.
export function chordsOf(commandId: CommandId, preset: readonly Binding[] = CUBASE_PRESET): string[] {
  const bound = preset.filter((b) => b.commandId === commandId);
  const ordered = [...bound.filter((b) => b.scope === 'window'), ...bound.filter((b) => b.scope !== 'window')];
  return [...new Set(ordered.map((b) => b.chord))];
}

// The platform this window runs on (Windows and Linux are "other").
export function currentPlatform(): Platform {
  return typeof navigator === 'undefined' ? 'other' : platformOf(navigator.platform);
}

// A control's tooltip: its label, then the first key of its command in the
// locale's brackets; the label alone for a command without a key.
export function tipWithKey(t: T, label: string, commandId: CommandId, platform: Platform = currentPlatform()): string {
  const chord = chordsOf(commandId)[0];
  return chord === undefined ? label : t('keys.tip', { label, key: formatChord(chord, platform) });
}

// A chord that is no command of the preset: the info line's Ctrl+Enter
// (Cmd+Return on macOS), which sets each selected clip to the typed value
// (timeline/InfoLine.tsx reads it from the event's modifiers; m5b-ui-edit-more).
export const SET_EACH_CHORD = 'Mod+Enter';

// The first key of a command, written for the platform, or '' without one.
export function keyOf(commandId: CommandId, platform: Platform = currentPlatform()): string {
  const chord = chordsOf(commandId)[0];
  return chord === undefined ? '' : formatChord(chord, platform);
}
