// The "Cubase" key-command preset, the default (UI redesign spec 3.6 and
// research/cubase.md section 7). One table: chord, command id, scope. A chord
// names its modifiers in the order Mod, Ctrl, Alt, Shift, then the key as
// event.code names it without its "Key"/"Digit" prefix. Mod is Ctrl on Windows
// and Linux and Cmd on macOS; Alt is Opt; Ctrl on macOS is the Control key.
// Cubase writes Ctrl/Cmd+Alt/Opt+L; here that is Mod+Alt+L.
//
// Phase 1 binds what m5-ui-shell implements; each later ticket adds its rows.

import type { Binding } from './commands';

export const CUBASE_PRESET: readonly Binding[] = [
  // Zones (spec 2.1).
  { chord: 'Mod+Alt+L', commandId: 'zone.left.toggle', scope: 'window' },
  { chord: 'Alt+I', commandId: 'zone.left.toggle', scope: 'window' },
  { chord: 'Mod+Alt+E', commandId: 'zone.lower.toggle', scope: 'window' },
  { chord: 'Mod+Alt+B', commandId: 'zone.lower.toggle', scope: 'window' },
  { chord: 'Alt+F3', commandId: 'zone.lower.mixconsole', scope: 'window' },
  // F3 opens the MixConsole window in Cubase; until SIANN has one (phase 5) it
  // shows the lower zone's MixConsole tab (spec 2.5).
  { chord: 'F3', commandId: 'zone.lower.mixconsole', scope: 'window' },
  { chord: 'Mod+Alt+R', commandId: 'zone.right.toggle', scope: 'window' },
  // SIANN addition: show the right zone on the Plans tab.
  { chord: 'Mod+Alt+P', commandId: 'zone.right.plans', scope: 'window' },
  // The focus frame (zone-focus.ts). Tab and Shift+Tab cycle the zones from a
  // zone or the page and walk a zone's controls from inside it; F6 and
  // Shift+F6 cycle the zones from anywhere; Enter on a zone enters it and
  // Escape from a control returns to its zone (the project zone's Escape,
  // edit.cancel, still runs after it).
  { chord: 'Tab', commandId: 'focus.next', scope: 'window' },
  { chord: 'Shift+Tab', commandId: 'focus.prev', scope: 'window' },
  { chord: 'F6', commandId: 'focus.nextZone', scope: 'window' },
  { chord: 'Shift+F6', commandId: 'focus.prevZone', scope: 'window' },
  { chord: 'Enter', commandId: 'focus.enterZone', scope: 'window' },
  { chord: 'Escape', commandId: 'focus.zoneRoot', scope: 'window' },
  // The project zone: delete the selected clip; Escape leaves placing mode.
  { chord: 'Delete', commandId: 'edit.delete', scope: 'project' },
  { chord: 'Backspace', commandId: 'edit.delete', scope: 'project' },
  { chord: 'Escape', commandId: 'edit.cancel', scope: 'project' },
  // The event display's zoom (m5-ui-arrange; research/cubase.md 7.6, 8.1).
  { chord: 'H', commandId: 'view.zoomIn', scope: 'project' },
  { chord: 'G', commandId: 'view.zoomOut', scope: 'project' },
  { chord: 'Shift+H', commandId: 'view.tracksTaller', scope: 'project' },
  { chord: 'Shift+G', commandId: 'view.tracksShorter', scope: 'project' },
  { chord: 'Shift+F', commandId: 'view.zoomFull', scope: 'project' },
  // Add a track (spec 3.3).
  { chord: 'T', commandId: 'track.add', scope: 'project' },
  // Editing (m5-ui-edit-basics; research/cubase.md 7.2-7.6): tools on the
  // number row (Digit1, not the numpad), Split at Cursor, Duplicate, Snap,
  // Select All, Locate Selection / Next Event / Previous Event, Zoom to
  // Selection / Event, and M, S and Remove Selected Tracks.
  { chord: '1', commandId: 'tool.select', scope: 'project' },
  { chord: '3', commandId: 'tool.split', scope: 'project' },
  { chord: 'Alt+X', commandId: 'edit.splitAtCursor', scope: 'project' },
  { chord: 'Mod+D', commandId: 'edit.duplicate', scope: 'project' },
  { chord: 'J', commandId: 'edit.snapToggle', scope: 'project' },
  { chord: 'Mod+A', commandId: 'edit.selectAll', scope: 'project' },
  { chord: 'L', commandId: 'transport.locateSelection', scope: 'project' },
  { chord: 'N', commandId: 'transport.locateNextClip', scope: 'project' },
  { chord: 'B', commandId: 'transport.locatePreviousClip', scope: 'project' },
  { chord: 'Alt+S', commandId: 'view.zoomSelection', scope: 'project' },
  { chord: 'Shift+E', commandId: 'view.zoomEvent', scope: 'project' },
  { chord: 'M', commandId: 'track.muteSelected', scope: 'project' },
  { chord: 'S', commandId: 'track.soloSelected', scope: 'project' },
  { chord: 'Shift+Delete', commandId: 'track.removeSelected', scope: 'project' },
];
