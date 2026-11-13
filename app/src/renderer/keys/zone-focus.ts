// Keyboard focus between and inside the zones (UI redesign spec 2.1 and 3.6),
// pure: where the focus is and which focus command ran go in, the move comes
// out. Shell.tsx reads the place from the DOM and carries the move out.
//
// - Tab / Shift+Tab (focus.next / focus.prev): from a zone itself or from the
//   page they cycle the zones, as Cubase does; from a control inside a zone
//   (a button, a fader, a field, the zone's divider) they move between that
//   zone's controls and wrap at its ends, so the focus stays in the zone;
//   anywhere else (the top bar, the status bar) they stay native.
// - F6 / Shift+F6 (focus.nextZone / focus.prevZone): cycle the zones from
//   anywhere, the platform's convention.
// - Enter on a zone (focus.enterZone) moves into its first control; Escape
//   from a control (focus.zoneRoot) returns to its zone.
// - Inside a modal dialog nothing here applies: the dialog keeps the focus.

import type { CommandId, ZoneScope } from './commands';

export type FocusPlace =
  | { readonly kind: 'zone'; readonly zone: ZoneScope }
  | { readonly kind: 'control'; readonly zone: ZoneScope }
  | { readonly kind: 'page' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'dialog' };

export type FocusMove =
  | { readonly type: 'zone'; readonly step: 1 | -1 }
  | { readonly type: 'control'; readonly zone: ZoneScope; readonly step: 1 | -1 }
  | { readonly type: 'enter'; readonly zone: ZoneScope }
  | { readonly type: 'root'; readonly zone: ZoneScope };

export const FOCUS_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'focus.next',
  'focus.prev',
  'focus.nextZone',
  'focus.prevZone',
  'focus.enterZone',
  'focus.zoneRoot',
]);

// The focus keys that also leave a text field, as the platform's own Tab and F6 do.
export const FOCUS_COMMANDS_IN_FIELDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'focus.next',
  'focus.prev',
  'focus.nextZone',
  'focus.prevZone',
  'focus.zoneRoot',
]);

export function focusMove(command: CommandId, place: FocusPlace): FocusMove | null {
  if (place.kind === 'dialog') return null;
  switch (command) {
    case 'focus.nextZone':
    case 'focus.prevZone':
      return { type: 'zone', step: command === 'focus.nextZone' ? 1 : -1 };
    case 'focus.next':
    case 'focus.prev': {
      const step = command === 'focus.next' ? 1 : -1;
      if (place.kind === 'zone' || place.kind === 'page') return { type: 'zone', step };
      if (place.kind === 'control') return { type: 'control', zone: place.zone, step };
      return null;
    }
    case 'focus.enterZone':
      return place.kind === 'zone' ? { type: 'enter', zone: place.zone } : null;
    case 'focus.zoneRoot':
      return place.kind === 'control' ? { type: 'root', zone: place.zone } : null;
    default:
      return null;
  }
}

// The next item of a ring, wrapping at both ends; from outside the ring, its first or last.
export function ringStep<T>(ring: readonly T[], current: T | null, step: 1 | -1): T | undefined {
  if (ring.length === 0) return undefined;
  const at = current === null ? -1 : ring.indexOf(current);
  if (at === -1) return step === 1 ? ring[0] : ring[ring.length - 1];
  return ring[(at + step + ring.length) % ring.length];
}
