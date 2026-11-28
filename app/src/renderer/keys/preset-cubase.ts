// The "Cubase" key-command preset, the default (UI redesign spec 3.6 and
// research/cubase.md section 7). One table: chord, command id, scope. A chord
// names its modifiers in the order Mod, Ctrl, Alt, Shift, then the key as
// event.code names it without its "Key"/"Digit" prefix. Mod is Ctrl on Windows
// and Linux and Cmd on macOS; Alt is Opt; Ctrl on macOS is the Control key.
// Cubase writes Ctrl/Cmd+Alt/Opt+L; here that is Mod+Alt+L.
//
// Phase 1 binds what m5-ui-shell implements; each later ticket adds its rows.
// app/test/unit/support/cubase-reference.ts transcribes research section 7, and the audit
// (key-audit.test.ts) holds this table to it (m5b-ui-keymap). Nothing else
// writes a key: menus, tooltips and the Key Commands list read this table
// through keys/chord-label.ts.

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
  // m5b-ui-editor-channel (spec 2.1, 3.6): the Channel zone, and the focused
  // zone's tabs, first used by the lower zone's MixConsole and Editor. Return
  // reaches editor.open through focus.enterZone (zone-focus.ts) and has no row
  // of its own; Num Enter stays the transport's start.
  { chord: 'Mod+Alt+C', commandId: 'zone.channel.toggle', scope: 'window' },
  { chord: 'Mod+Alt+ArrowRight', commandId: 'zone.tab.next', scope: 'window' },
  { chord: 'Mod+Alt+ArrowLeft', commandId: 'zone.tab.prev', scope: 'window' },
  // The plan review (m5b-ui-ghosts; spec 4.2, 3.6): the ghosts of the overlaid plan on and off.
  { chord: 'Mod+Alt+G', commandId: 'plans.toggleGhosts', scope: 'window' },
  // The audition (m5b-ui-audition; spec 4.3, 3.6, on keys Cubase leaves free):
  // Shift+A hears the other side while a plan is auditioned; Ctrl+Return
  // (Cmd+Return on macOS) with the right zone focused runs the selected plan's
  // primary action. Enter and NumpadEnter keep theirs.
  { chord: 'Shift+A', commandId: 'audition.flip', scope: 'window' },
  { chord: 'Mod+Enter', commandId: 'plans.primary', scope: 'right' },
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
  // The lower zone: Escape clears the bus selection (m5b-ui-sends-buses; UI redesign 3.4).
  { chord: 'Escape', commandId: 'edit.cancel', scope: 'lower' },
  // The event display's zoom (m5-ui-arrange; research/cubase.md 7.6, 8.1).
  { chord: 'H', commandId: 'view.zoomIn', scope: 'project' },
  { chord: 'G', commandId: 'view.zoomOut', scope: 'project' },
  { chord: 'Shift+H', commandId: 'view.tracksTaller', scope: 'project' },
  { chord: 'Shift+G', commandId: 'view.tracksShorter', scope: 'project' },
  { chord: 'Shift+F', commandId: 'view.zoomFull', scope: 'project' },
  // The sample editor's own horizontal zoom while the lower zone has the focus
  // (m5b-ui-editor-channel; spec 5.2); it declines on the MixConsole tab.
  { chord: 'H', commandId: 'view.zoomIn', scope: 'lower' },
  { chord: 'G', commandId: 'view.zoomOut', scope: 'lower' },
  // Add a track (spec 3.3).
  { chord: 'T', commandId: 'track.add', scope: 'project' },
  // The transport (m5-ui-transport; spec 3.1, research/cubase.md 7.1): Space
  // starts and stops, numpad Enter starts, Num 0 stops, Num . goes to the
  // project start and the comma is its laptop fallback (SIANN addition);
  // the period exchanges the position display's formats, Shift+P types a
  // position. Numpad keys are their own event.code, never the main block's.
  { chord: 'Space', commandId: 'transport.toggle', scope: 'window' },
  { chord: 'NumpadEnter', commandId: 'transport.start', scope: 'window' },
  { chord: 'Numpad0', commandId: 'transport.stop', scope: 'window' },
  { chord: 'NumpadDecimal', commandId: 'transport.toStart', scope: 'window' },
  { chord: 'Comma', commandId: 'transport.toStart', scope: 'window' },
  { chord: 'Period', commandId: 'transport.exchangeFormats', scope: 'window' },
  { chord: 'Shift+P', commandId: 'transport.enterPosition', scope: 'window' },
  // Undo and redo (spec 3.2).
  { chord: 'Mod+Z', commandId: 'edit.undo', scope: 'window' },
  { chord: 'Mod+Shift+Z', commandId: 'edit.redo', scope: 'window' },
  // Auto-scroll (spec 3.1; Cubase's F, page mode).
  { chord: 'F', commandId: 'view.autoScroll', scope: 'project' },
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
  // Locators, cycle and metronome (m5-ui-loop-click; spec 3.1, 3.2, 3.6;
  // research/cubase.md 7.1): Num / toggles cycle and the slash key is its
  // laptop fallback; C the metronome; P the locators to the selection and
  // Alt+P Loop Selection; Num 1 and Num 2 go to the left and right locator,
  // Shift+1 and Shift+2 their laptop fallback (the number row, so 1 stays
  // the Object Selection tool); Ctrl+Num 1 and Ctrl+Num 2 (Mod) set them to
  // the project cursor. Shift+P stays the position field's.
  { chord: 'NumpadDivide', commandId: 'transport.cycleToggle', scope: 'window' },
  { chord: 'Slash', commandId: 'transport.cycleToggle', scope: 'window' },
  { chord: 'C', commandId: 'transport.metronomeToggle', scope: 'window' },
  { chord: 'P', commandId: 'transport.locatorsToSelection', scope: 'window' },
  { chord: 'Alt+P', commandId: 'transport.loopSelection', scope: 'window' },
  { chord: 'Numpad1', commandId: 'transport.toLeftLocator', scope: 'window' },
  { chord: 'Numpad2', commandId: 'transport.toRightLocator', scope: 'window' },
  { chord: 'Shift+1', commandId: 'transport.toLeftLocator', scope: 'window' },
  { chord: 'Shift+2', commandId: 'transport.toRightLocator', scope: 'window' },
  { chord: 'Mod+Numpad1', commandId: 'transport.setLeftLocator', scope: 'window' },
  { chord: 'Mod+Numpad2', commandId: 'transport.setRightLocator', scope: 'window' },
  // The Media tab (m5b-ui-media; UR-5; spec 10.8, 1; research/cubase.md 7):
  // Ctrl+P (Cmd+P), Cubase's Open Pool, opens the right zone on it. P, Alt+P,
  // Shift+P and Mod+Alt+P keep theirs.
  { chord: 'Mod+P', commandId: 'media.open', scope: 'window' },
  // Projects (m5b-ui-project; spec 3.6; research/cubase.md 7): Cubase's New
  // Project, Open and Save. The File menu shows them as its accelerators and
  // registers none. Studio Setup and Open Recent have no key.
  { chord: 'Mod+N', commandId: 'project.new', scope: 'window' },
  { chord: 'Mod+O', commandId: 'project.open', scope: 'window' },
  { chord: 'Mod+S', commandId: 'project.save', scope: 'window' },
  // The rest of the editing (m5b-ui-edit-more; spec 3.2, 3.6; research/cubase.md
  // 7.2-7.4): Glue and Erase on the number row; cut, copy and paste at the
  // cursor, paste at the origin; Repeat; the nudges of the key-command table
  // (not the manual's range page): Mod+Left/Right the position, Alt+Left the
  // start left, Alt+Shift+Right the start right, Alt+Shift+Left the end left,
  // Alt+Right the end right; Select None. edit.glue stays unbound, as in Cubase.
  { chord: '4', commandId: 'tool.glue', scope: 'project' },
  { chord: '5', commandId: 'tool.erase', scope: 'project' },
  { chord: 'Mod+X', commandId: 'edit.cut', scope: 'project' },
  { chord: 'Mod+C', commandId: 'edit.copy', scope: 'project' },
  { chord: 'Mod+V', commandId: 'edit.paste', scope: 'project' },
  { chord: 'Alt+V', commandId: 'edit.pasteAtOrigin', scope: 'project' },
  { chord: 'Mod+K', commandId: 'edit.repeat', scope: 'project' },
  { chord: 'Mod+ArrowLeft', commandId: 'edit.nudgeLeft', scope: 'project' },
  { chord: 'Mod+ArrowRight', commandId: 'edit.nudgeRight', scope: 'project' },
  { chord: 'Alt+ArrowLeft', commandId: 'edit.nudgeStartLeft', scope: 'project' },
  { chord: 'Alt+Shift+ArrowRight', commandId: 'edit.nudgeStartRight', scope: 'project' },
  { chord: 'Alt+Shift+ArrowLeft', commandId: 'edit.nudgeEndLeft', scope: 'project' },
  { chord: 'Alt+ArrowRight', commandId: 'edit.nudgeEndRight', scope: 'project' },
  { chord: 'Mod+Shift+A', commandId: 'edit.selectNone', scope: 'project' },
  // Recording (m5b-ui-recording; UI redesign 3.1, 3.3): R arms the selected
  // track; Num * records, Ctrl+Shift+R is its laptop fallback; I and O punch.
  { chord: 'R', commandId: 'track.recordEnable', scope: 'project' },
  { chord: 'NumpadMultiply', commandId: 'transport.record', scope: 'window' },
  { chord: 'Mod+Shift+R', commandId: 'transport.record', scope: 'window' },
  { chord: 'I', commandId: 'transport.punchIn', scope: 'window' },
  { chord: 'O', commandId: 'transport.punchOut', scope: 'window' },
  // The marker track (m5b-ui-markers; spec 3.1, 3.6, UR-9; research/cubase.md
  // 7.2): Insert adds a position marker at the cursor; Shift+3..9 and Num 3..9
  // go to position markers 3 to 9 (Shift+1, Shift+2, Num 1 and Num 2 stay the
  // locators); Shift+N and Shift+B go to the next and the previous marker (N
  // and B stay the clip locate commands). Window commands, as the locator keys.
  { chord: 'Insert', commandId: 'marker.insert', scope: 'window' },
  { chord: 'Shift+3', commandId: 'marker.goTo3', scope: 'window' },
  { chord: 'Shift+4', commandId: 'marker.goTo4', scope: 'window' },
  { chord: 'Shift+5', commandId: 'marker.goTo5', scope: 'window' },
  { chord: 'Shift+6', commandId: 'marker.goTo6', scope: 'window' },
  { chord: 'Shift+7', commandId: 'marker.goTo7', scope: 'window' },
  { chord: 'Shift+8', commandId: 'marker.goTo8', scope: 'window' },
  { chord: 'Shift+9', commandId: 'marker.goTo9', scope: 'window' },
  { chord: 'Numpad3', commandId: 'marker.goTo3', scope: 'window' },
  { chord: 'Numpad4', commandId: 'marker.goTo4', scope: 'window' },
  { chord: 'Numpad5', commandId: 'marker.goTo5', scope: 'window' },
  { chord: 'Numpad6', commandId: 'marker.goTo6', scope: 'window' },
  { chord: 'Numpad7', commandId: 'marker.goTo7', scope: 'window' },
  { chord: 'Numpad8', commandId: 'marker.goTo8', scope: 'window' },
  { chord: 'Numpad9', commandId: 'marker.goTo9', scope: 'window' },
  { chord: 'Shift+N', commandId: 'marker.next', scope: 'window' },
  { chord: 'Shift+B', commandId: 'marker.previous', scope: 'window' },
  // The rest of Cubase's transport keys (m5b-ui-keymap; spec 3.1, 3.6;
  // research/cubase.md 7.1): Num - and Num + rewind and forward a bar, Ctrl+Num
  // - and Ctrl+Num + nudge the cursor a grid step, Shift+T types the tempo,
  // Num , is Go to Project Start too. The laptop fallbacks (SIANN additions,
  // 3.6): - and = wind, Ctrl+- and Ctrl+= nudge, Shift+Enter starts and Shift+0
  // stops (Shift and the digit mirror Num 0, as Shift+1 and Shift+2 mirror Num
  // 1 and Num 2), Ctrl+1 and Ctrl+2 set the locators (Cubase's Set Marker 1
  // and 2, which are the locators: a difference the audit lists).
  { chord: 'NumpadSubtract', commandId: 'transport.rewind', scope: 'window' },
  { chord: 'NumpadAdd', commandId: 'transport.forward', scope: 'window' },
  { chord: 'Minus', commandId: 'transport.rewind', scope: 'window' },
  { chord: 'Equal', commandId: 'transport.forward', scope: 'window' },
  { chord: 'Mod+NumpadSubtract', commandId: 'transport.nudgeCursorLeft', scope: 'window' },
  { chord: 'Mod+NumpadAdd', commandId: 'transport.nudgeCursorRight', scope: 'window' },
  { chord: 'Mod+Minus', commandId: 'transport.nudgeCursorLeft', scope: 'window' },
  { chord: 'Mod+Equal', commandId: 'transport.nudgeCursorRight', scope: 'window' },
  { chord: 'Shift+T', commandId: 'transport.enterTempo', scope: 'window' },
  { chord: 'NumpadComma', commandId: 'transport.toStart', scope: 'window' },
  { chord: 'Shift+Enter', commandId: 'transport.start', scope: 'window' },
  { chord: 'Shift+0', commandId: 'transport.stop', scope: 'window' },
  { chord: 'Mod+1', commandId: 'transport.setLeftLocator', scope: 'window' },
  { chord: 'Mod+2', commandId: 'transport.setRightLocator', scope: 'window' },
];
