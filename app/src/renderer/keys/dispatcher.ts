// The key dispatcher (UI redesign spec 3.6), pure: a key event's code and
// modifiers, the focused zone, whether the target takes typing and the
// platform go in; the binding to run, or null, comes out. The focused zone's
// binding wins over the window's for the same chord; nothing fires while a
// text field has focus but the focus keys (Tab, Shift+Tab, F6, Shift+F6,
// Escape), which leave a field as the platform's own keys do; and while the
// engine is disconnected only the window's layout and focus commands run.
// Keys match on event.code, not event.key, so Opt+I on
// macOS (event.key is a dead accent there) and other layouts' characters
// still reach their commands.

import type { Binding, ZoneScope } from './commands';
import { FOCUS_COMMANDS_IN_FIELDS } from './zone-focus';

export interface KeyModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface KeyInput {
  readonly code: string;
  readonly key: string;
  readonly modifiers: KeyModifiers;
  readonly targetIsTextField: boolean;
  readonly focusedZone: ZoneScope;
  readonly platform: 'mac' | 'other';
  // The engine is disconnected (m5-ui-connection): only the window's layout
  // and focus commands run, which send nothing; every zone command, which may,
  // is refused, and its chord falls through to the window's binding.
  readonly offline?: boolean;
}

// What still runs while the engine is disconnected: the window's zone layout
// and focus commands (UI redesign spec 3.0, "engine disconnected").
export function runsOffline(binding: Binding): boolean {
  return binding.scope === 'window' && (binding.commandId.startsWith('zone.') || binding.commandId.startsWith('focus.'));
}

// "KeyL" -> "L", "Digit1" -> "1", anything else as event.code names it.
function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code;
}

export function chordOf(input: KeyInput): string {
  const { ctrl, alt, shift, meta } = input.modifiers;
  const mac = input.platform === 'mac';
  const parts: string[] = [];
  if (mac ? meta : ctrl) parts.push('Mod');
  if (mac && ctrl) parts.push('Ctrl');
  if (alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(keyName(input.code));
  return parts.join('+');
}

export function resolveKey(input: KeyInput, preset: readonly Binding[]): Binding | null {
  if (!input.code) return null;
  // The Windows key (Meta off macOS) belongs to the OS.
  if (input.platform !== 'mac' && input.modifiers.meta) return null;
  const chord = chordOf(input);
  let table = input.targetIsTextField ? preset.filter((b) => FOCUS_COMMANDS_IN_FIELDS.has(b.commandId)) : preset;
  if (input.offline) table = table.filter(runsOffline);
  return (
    table.find((b) => b.chord === chord && b.scope === input.focusedZone) ??
    table.find((b) => b.chord === chord && b.scope === 'window') ??
    null
  );
}

const NOT_TYPED = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image']);

// Input (except the kinds that take no typing: buttons, faders, boxes),
// textarea, select and contenteditable.
export function isTextField(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  switch (typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '') {
    case 'INPUT':
      return !NOT_TYPED.has(typeof el.type === 'string' ? el.type.toLowerCase() : 'text');
    case 'TEXTAREA':
    case 'SELECT':
      return true;
    default:
      return false;
  }
}

export function platformOf(navigatorPlatform: string): 'mac' | 'other' {
  return /^Mac|iPhone|iPad/i.test(navigatorPlatform) ? 'mac' : 'other';
}
