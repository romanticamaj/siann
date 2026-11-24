// The key-command audit's reference (m5b-ui-keymap; UI redesign 3.6; UR-11):
// research/cubase.md (docs/superpowers/research/2026-11-13-cubase-reference.md)
// section 7, Cubase Pro's default key commands, transcribed row by row. Each
// row is one default Windows key of one Cubase command: the subsection, the
// command as the research names it, the key exactly as it writes it between
// backticks (`key`; a range such as "Ctrl+1 ... Ctrl+9" gives one row per
// chord, each with the key the research writes), the Mac column where the
// research writes one, and the chord in the preset's notation
// (preset-cubase.ts: Mod, Ctrl, Alt, Shift, then the key as event.code names
// it). Then either the SIANN command the Cubase preset binds to that chord
// (`commandId`) or the reason it does not:
//
// - no-backend: SIANN has no such command yet; `ref` names the engine ticket
//   (E-n), the feature (m6a-ui-tools, ...) or the milestone or phase (M6a,
//   M6b, M6c, phase 3, phase 5) that brings it;
// - not-planned: a Cubase window or workflow SIANN does not copy (9.3);
// - siann-addition: the key is a SIANN addition's or a SIANN key of 3.6
//   (`note` names it); DIFFERENCES below then lists the preset's binding.
//
// The expectation is the research file, not the preset: key-audit.test.ts
// holds the preset to this table, and parses section 7 of the research file
// so that no key of it is missing here.

import type { CommandId, Scope } from './commands';

export type ReferenceSection = '7.1' | '7.2' | '7.3' | '7.4' | '7.5' | '7.6' | '7.7' | '7.8' | '7.9';

export type ReferenceReason =
  | { readonly kind: 'no-backend'; readonly ref: string }
  | { readonly kind: 'not-planned'; readonly why: string }
  | { readonly kind: 'siann-addition'; readonly note: string };

export interface ReferenceRow {
  readonly section: ReferenceSection;
  // Cubase's command, as the research names it.
  readonly command: string;
  // The Windows key as the research writes it between backticks.
  readonly key: string;
  // The Mac column where the research gives one other than "same", written
  // out where it writes "Cmd+..." or "Opt+...".
  readonly mac?: string;
  // The chord in the preset's notation.
  readonly chord: string;
  readonly commandId?: CommandId;
  readonly reason?: ReferenceReason;
}

const nb = (ref: string): ReferenceReason => ({ kind: 'no-backend', ref });
const np = (why: string): ReferenceReason => ({ kind: 'not-planned', why });
const sa = (note: string): ReferenceReason => ({ kind: 'siann-addition', note });

const digits = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const CUBASE_REFERENCE: readonly ReferenceRow[] = [
  // 7.1 Transport.
  { section: '7.1', command: 'Start/Stop', key: 'Space', chord: 'Space', commandId: 'transport.toggle' },
  { section: '7.1', command: 'Start', key: 'Enter', chord: 'NumpadEnter', commandId: 'transport.start' },
  { section: '7.1', command: 'Stop', key: 'Num 0', chord: 'Numpad0', commandId: 'transport.stop' },
  { section: '7.1', command: 'Record', key: 'Num *', chord: 'NumpadMultiply', commandId: 'transport.record' },
  { section: '7.1', command: 'Cycle on/off', key: 'Num /', chord: 'NumpadDivide', commandId: 'transport.cycleToggle' },
  { section: '7.1', command: 'Rewind', key: 'Num -', chord: 'NumpadSubtract', commandId: 'transport.rewind' },
  { section: '7.1', command: 'Forward', key: 'Num +', chord: 'NumpadAdd', commandId: 'transport.forward' },
  { section: '7.1', command: 'Fast Rewind', key: 'Shift+Num -', chord: 'Shift+NumpadSubtract', reason: nb('phase 3') },
  { section: '7.1', command: 'Fast Forward', key: 'Shift+Num +', chord: 'Shift+NumpadAdd', reason: nb('phase 3') },
  { section: '7.1', command: 'Nudge Cursor Left', key: 'Ctrl+Num -', mac: 'Cmd+Num -', chord: 'Mod+NumpadSubtract', commandId: 'transport.nudgeCursorLeft' },
  { section: '7.1', command: 'Nudge Cursor Right', key: 'Ctrl+Num +', mac: 'Cmd+Num +', chord: 'Mod+NumpadAdd', commandId: 'transport.nudgeCursorRight' },
  { section: '7.1', command: 'Go to Left Locator', key: 'Num 1', chord: 'Numpad1', commandId: 'transport.toLeftLocator' },
  { section: '7.1', command: 'Go to Right Locator', key: 'Num 2', chord: 'Numpad2', commandId: 'transport.toRightLocator' },
  { section: '7.1', command: 'Go to Project Start', key: 'Num .', chord: 'NumpadDecimal', commandId: 'transport.toStart' },
  { section: '7.1', command: 'Go to Project Start', key: 'Num ,', chord: 'NumpadComma', commandId: 'transport.toStart' },
  { section: '7.1', command: 'Go to Project Start', key: 'Num ;', chord: 'Num ;', reason: np('no event.code names a keypad semicolon; Num . and Num , cover the keypads that have one') },
  { section: '7.1', command: 'Set Left Locator to cursor', key: 'Ctrl+Num 1', mac: 'Cmd+Num 1', chord: 'Mod+Numpad1', commandId: 'transport.setLeftLocator' },
  { section: '7.1', command: 'Set Right Locator to cursor', key: 'Ctrl+Num 2', mac: 'Cmd+Num 2', chord: 'Mod+Numpad2', commandId: 'transport.setRightLocator' },
  { section: '7.1', command: 'Locators to Selection', key: 'P', chord: 'P', commandId: 'transport.locatorsToSelection' },
  { section: '7.1', command: 'Loop Selection', key: 'Alt+P', mac: 'Opt+P', chord: 'Alt+P', commandId: 'transport.loopSelection' },
  { section: '7.1', command: 'Loop Selection Solo', key: 'Alt+Shift+P', mac: 'Opt+Shift+P', chord: 'Alt+Shift+P', reason: nb('phase 3') },
  { section: '7.1', command: 'Play Selection Range', key: 'Alt+Space', mac: 'Opt+Space', chord: 'Alt+Space', reason: nb('m6a-ui-tools') },
  { section: '7.1', command: 'Play Selection Solo', key: 'Ctrl+Alt+Space', mac: 'Cmd+Opt+Space', chord: 'Mod+Alt+Space', reason: nb('m6a-ui-tools') },
  { section: '7.1', command: 'Locate Selection Start', key: 'L', chord: 'L', commandId: 'transport.locateSelection' },
  { section: '7.1', command: 'Locate Next Event', key: 'N', chord: 'N', commandId: 'transport.locateNextClip' },
  { section: '7.1', command: 'Locate Previous Event', key: 'B', chord: 'B', commandId: 'transport.locatePreviousClip' },
  { section: '7.1', command: 'Locate Next Marker', key: 'Shift+N', chord: 'Shift+N', commandId: 'marker.next' },
  { section: '7.1', command: 'Locate Previous Marker', key: 'Shift+B', chord: 'Shift+B', commandId: 'marker.previous' },
  { section: '7.1', command: 'Locate Next Hitpoint', key: 'Alt+N', mac: 'Opt+N', chord: 'Alt+N', reason: np('hitpoint detection is not planned') },
  { section: '7.1', command: 'Locate Previous Hitpoint', key: 'Alt+B', mac: 'Opt+B', chord: 'Alt+B', reason: np('hitpoint detection is not planned') },
  { section: '7.1', command: 'Metronome on/off', key: 'C', chord: 'C', commandId: 'transport.metronomeToggle' },
  { section: '7.1', command: 'Punch In', key: 'I', chord: 'I', commandId: 'transport.punchIn' },
  { section: '7.1', command: 'Punch Out', key: 'O', chord: 'O', commandId: 'transport.punchOut' },
  { section: '7.1', command: 'Enter Project Cursor Position', key: 'Shift+P', chord: 'Shift+P', commandId: 'transport.enterPosition' },
  { section: '7.1', command: 'Enter Left Locator', key: 'Shift+L', chord: 'Shift+L', reason: nb('phase 3') },
  { section: '7.1', command: 'Enter Right Locator', key: 'Shift+R', chord: 'Shift+R', reason: nb('phase 3') },
  { section: '7.1', command: 'Enter Locator Range Duration', key: 'Shift+D', chord: 'Shift+D', reason: nb('phase 3') },
  { section: '7.1', command: 'Enter Punch In Position', key: 'Shift+I', chord: 'Shift+I', reason: np('punch is locked to the locators (UI redesign 3.1)') },
  { section: '7.1', command: 'Enter Punch Out Position', key: 'Shift+O', chord: 'Shift+O', reason: np('punch is locked to the locators (UI redesign 3.1)') },
  { section: '7.1', command: 'Enter Tempo', key: 'Shift+T', chord: 'Shift+T', commandId: 'transport.enterTempo' },
  { section: '7.1', command: 'Enter Time Signature', key: 'Shift+C', chord: 'Shift+C', reason: nb('E-10') },
  { section: '7.1', command: 'Tap Tempo', key: 'Shift+Space', chord: 'Shift+Space', reason: nb('phase 3') },
  { section: '7.1', command: 'Exchange Time Formats', key: '.', chord: 'Period', commandId: 'transport.exchangeFormats' },
  { section: '7.1', command: 'Activate External Sync', key: 'Alt+Shift+T', mac: 'Opt+Shift+T', chord: 'Alt+Shift+T', reason: np('external sync is not planned') },
  { section: '7.1', command: 'MIDI Retrospective Record', key: 'Shift+Num *', chord: 'Shift+NumpadMultiply', reason: nb('m6b-midi-record') },
  { section: '7.1', command: 'Auto-Scroll on/off', key: 'F', chord: 'F', commandId: 'view.autoScroll' },
  { section: '7.1', command: 'Stationary Cursor', key: 'Alt+C', mac: 'Opt+C', chord: 'Alt+C', reason: nb('phase 3') },
  { section: '7.1', command: 'Transport panel show/hide', key: 'F2', chord: 'F2', reason: np('the transport is the top bar\'s; there is no transport panel (UI redesign 3.6)') },

  // 7.2 Markers and cycle markers. Markers 1 and 2 are the locators.
  { section: '7.2', command: 'Add Position Marker', key: 'Insert', chord: 'Insert', commandId: 'marker.insert' },
  { section: '7.2', command: 'Set Marker 1', key: 'Ctrl+1', mac: 'Cmd+1', chord: 'Mod+1', reason: sa('Set Left Locator, Ctrl+1 (marker 1 is the left locator)') },
  { section: '7.2', command: 'Set Marker 2', key: 'Ctrl+9', chord: 'Mod+2', reason: sa('Set Right Locator, Ctrl+2 (marker 2 is the right locator)') },
  ...digits(3, 9).map((n): ReferenceRow => ({ section: '7.2', command: `Set Marker ${n}`, key: 'Ctrl+9', chord: `Mod+${n}`, reason: nb('phase 3') })),
  ...digits(3, 9).map((n): ReferenceRow => ({ section: '7.2', command: `Set Marker ${n}`, key: 'Ctrl+Num 3..9', chord: `Mod+Numpad${n}`, reason: nb('phase 3') })),
  { section: '7.2', command: 'To Marker 1', key: 'Shift+1', chord: 'Shift+1', reason: sa('Go to Left Locator, Shift+1 (the laptop fallback for Num 1)') },
  { section: '7.2', command: 'To Marker 2', key: 'Shift+9', chord: 'Shift+2', reason: sa('Go to Right Locator, Shift+2 (the laptop fallback for Num 2)') },
  ...digits(3, 9).map((n): ReferenceRow => ({ section: '7.2', command: `To Marker ${n}`, key: 'Shift+9', chord: `Shift+${n}`, commandId: `marker.goTo${n}` as CommandId })),
  ...digits(3, 9).map((n): ReferenceRow => ({ section: '7.2', command: `To Marker ${n}`, key: 'Num 3..9', chord: `Numpad${n}`, commandId: `marker.goTo${n}` as CommandId })),
  ...digits(1, 9).map((n): ReferenceRow => ({ section: '7.2', command: `Recall Cycle Marker ${n}`, key: 'Shift+Num 1..9', chord: `Shift+Numpad${n}`, reason: nb('phase 3') })),
  { section: '7.2', command: 'Open Markers window', key: 'Ctrl+M', mac: 'Cmd+M', chord: 'Mod+M', reason: nb('phase 5') },

  // 7.3 Tools.
  { section: '7.3', command: 'Object Selection', key: '1', chord: '1', commandId: 'tool.select' },
  { section: '7.3', command: 'Range Selection', key: '2', chord: '2', reason: nb('m6a-ui-tools') },
  { section: '7.3', command: 'Split', key: '3', chord: '3', commandId: 'tool.split' },
  { section: '7.3', command: 'Glue', key: '4', chord: '4', commandId: 'tool.glue' },
  { section: '7.3', command: 'Erase', key: '5', chord: '5', commandId: 'tool.erase' },
  { section: '7.3', command: 'Zoom', key: '6', chord: '6', reason: nb('m6a-ui-tools') },
  { section: '7.3', command: 'Mute', key: '7', chord: '7', reason: nb('m6a-ui-tools') },
  { section: '7.3', command: 'Draw', key: '8', chord: '8', reason: nb('m6a-ui-automation') },
  { section: '7.3', command: 'Play', key: '9', chord: '9', reason: nb('m6a-ui-tools') },
  { section: '7.3', command: 'Drumstick', key: '0', chord: '0', reason: np('MIDI drum editing is not planned') },
  { section: '7.3', command: 'Previous Tool', key: 'F9', chord: 'F9', reason: nb('phase 3') },
  { section: '7.3', command: 'Next Tool', key: 'F10', chord: 'F10', reason: nb('phase 3') },
  { section: '7.3', command: 'Combine Selection Tools on/off', key: 'Alt+Shift+1', chord: 'Alt+Shift+1', reason: nb('phase 3') },

  // 7.4 Editing.
  { section: '7.4', command: 'Undo', key: 'Ctrl+Z', chord: 'Mod+Z', commandId: 'edit.undo' },
  { section: '7.4', command: 'Redo', key: 'Ctrl+Shift+Z', chord: 'Mod+Shift+Z', commandId: 'edit.redo' },
  { section: '7.4', command: 'Cut', key: 'Ctrl+X', chord: 'Mod+X', commandId: 'edit.cut' },
  { section: '7.4', command: 'Copy', key: 'Ctrl+C', chord: 'Mod+C', commandId: 'edit.copy' },
  { section: '7.4', command: 'Paste', key: 'Ctrl+V', chord: 'Mod+V', commandId: 'edit.paste' },
  { section: '7.4', command: 'Paste at Origin', key: 'Alt+V', mac: 'Opt+V', chord: 'Alt+V', commandId: 'edit.pasteAtOrigin' },
  { section: '7.4', command: 'Paste Relative to Cursor', key: 'Shift+V', chord: 'Shift+V', reason: nb('phase 3') },
  { section: '7.4', command: 'Delete', key: 'Delete', chord: 'Delete', commandId: 'edit.delete' },
  { section: '7.4', command: 'Delete', key: 'Backspace', chord: 'Backspace', commandId: 'edit.delete' },
  { section: '7.4', command: 'Select All', key: 'Ctrl+A', chord: 'Mod+A', commandId: 'edit.selectAll' },
  { section: '7.4', command: 'Select None', key: 'Ctrl+Shift+A', chord: 'Mod+Shift+A', commandId: 'edit.selectNone' },
  { section: '7.4', command: 'Invert Selection', key: 'Ctrl+Alt+I', mac: 'Cmd+Opt+I', chord: 'Mod+Alt+I', reason: nb('phase 3') },
  { section: '7.4', command: 'Duplicate', key: 'Ctrl+D', mac: 'Cmd+D', chord: 'Mod+D', commandId: 'edit.duplicate' },
  { section: '7.4', command: 'Repeat', key: 'Ctrl+K', mac: 'Cmd+K', chord: 'Mod+K', commandId: 'edit.repeat' },
  { section: '7.4', command: 'Split at Cursor', key: 'Alt+X', mac: 'Opt+X', chord: 'Alt+X', commandId: 'edit.splitAtCursor' },
  { section: '7.4', command: 'Split Range', key: 'Shift+X', chord: 'Shift+X', reason: nb('m6a-ui-tools') },
  { section: '7.4', command: 'Cut Time', key: 'Ctrl+Shift+X', chord: 'Mod+Shift+X', reason: nb('m6a-ui-tools') },
  { section: '7.4', command: 'Paste Time', key: 'Ctrl+Shift+V', chord: 'Mod+Shift+V', reason: nb('m6a-ui-tools') },
  { section: '7.4', command: 'Delete Time', key: 'Shift+Backspace', chord: 'Shift+Backspace', reason: nb('m6a-ui-tools') },
  { section: '7.4', command: 'Insert Silence', key: 'Ctrl+Shift+E', mac: 'Cmd+Shift+E', chord: 'Mod+Shift+E', reason: nb('m6a-ui-tools') },
  { section: '7.4', command: 'Left Selection Side to Cursor', key: 'E', chord: 'E', reason: nb('phase 3') },
  { section: '7.4', command: 'Right Selection Side to Cursor', key: 'D', chord: 'D', reason: nb('phase 3') },
  { section: '7.4', command: 'Move Event Start / Range Start to Cursor', key: 'Ctrl+L', mac: 'Cmd+L', chord: 'Mod+L', reason: nb('phase 3') },
  { section: '7.4', command: 'Move Events to Front', key: 'U', chord: 'U', reason: nb('phase 3') },
  { section: '7.4', command: 'Mute Events', key: 'Shift+M', chord: 'Shift+M', reason: nb('m6a-engine-clip-mute') },
  { section: '7.4', command: 'Unmute Events', key: 'Shift+U', chord: 'Shift+U', reason: nb('m6a-engine-clip-mute') },
  { section: '7.4', command: 'Mute Events toggle', key: 'Alt+M', mac: 'Opt+M', chord: 'Alt+M', reason: nb('m6a-engine-clip-mute') },
  { section: '7.4', command: 'Lock', key: 'Ctrl+Shift+L', chord: 'Mod+Shift+L', reason: nb('phase 3') },
  { section: '7.4', command: 'Unlock', key: 'Ctrl+Shift+U', chord: 'Mod+Shift+U', reason: nb('phase 3') },
  { section: '7.4', command: 'Group', key: 'Ctrl+G', chord: 'Mod+G', reason: nb('phase 3') },
  { section: '7.4', command: 'Ungroup', key: 'Ctrl+U', chord: 'Mod+U', reason: nb('phase 3') },
  { section: '7.4', command: 'Group Editing on Selected Tracks', key: 'K', chord: 'K', reason: nb('M6c') },
  { section: '7.4', command: 'Snap on/off', key: 'J', chord: 'J', commandId: 'edit.snapToggle' },
  { section: '7.4', command: 'Quantize', key: 'Q', chord: 'Q', reason: nb('phase 5') },
  { section: '7.4', command: 'Auto-Grid', key: 'Shift+Q', chord: 'Shift+Q', reason: nb('phase 3') },
  { section: '7.4', command: 'Crossfade', key: 'X', chord: 'X', reason: nb('E-9') },
  { section: '7.4', command: 'Adjust Fades to Range', key: 'A', chord: 'A', reason: nb('m6a-ui-tools') },
  { section: '7.4', command: 'Nudge Left', key: 'Ctrl+Left', chord: 'Mod+ArrowLeft', commandId: 'edit.nudgeLeft' },
  { section: '7.4', command: 'Nudge Right', key: 'Ctrl+Right', chord: 'Mod+ArrowRight', commandId: 'edit.nudgeRight' },
  { section: '7.4', command: 'Nudge Start Left', key: 'Alt+Left', chord: 'Alt+ArrowLeft', commandId: 'edit.nudgeStartLeft' },
  { section: '7.4', command: 'Nudge Start Right', key: 'Alt+Shift+Right', chord: 'Alt+Shift+ArrowRight', commandId: 'edit.nudgeStartRight' },
  { section: '7.4', command: 'Nudge End Left', key: 'Alt+Shift+Left', chord: 'Alt+Shift+ArrowLeft', commandId: 'edit.nudgeEndLeft' },
  { section: '7.4', command: 'Nudge End Right', key: 'Alt+Right', chord: 'Alt+ArrowRight', commandId: 'edit.nudgeEndRight' },
  { section: '7.4', command: 'Rename Selected Events', key: 'F2', chord: 'F2', reason: nb('E-4') },
  { section: '7.4', command: 'Rename First Selected Track', key: 'Alt+F2', mac: 'Opt+F2', chord: 'Alt+F2', reason: nb('phase 3') },
  { section: '7.4', command: 'Open (editor)', key: 'Ctrl+E', mac: 'Cmd+E', chord: 'Mod+E', reason: np('Return opens the sample editor from the project zone, and editor.open keeps no chord of its own (2.1, 3.6)') },
  { section: '7.4', command: 'Open/Close Editor', key: 'Return', chord: 'Enter', reason: sa('the focus key Enter (focus.enterZone), which opens the editor on the project zone with a clip selected (2.1)') },
  { section: '7.4', command: 'Edit In-Place', key: 'Ctrl+Shift+I', mac: 'Cmd+Shift+I', chord: 'Mod+Shift+I', reason: np('MIDI editing in place is not planned') },
  { section: '7.4', command: 'Activate/Deactivate Focused Object', key: 'Alt+A', mac: 'Opt+A', chord: 'Alt+A', reason: np('focused objects are zones and controls, which take Enter and Space') },
  { section: '7.4', command: 'Expand/Reduce', key: 'Alt+E', mac: 'Opt+E', chord: 'Alt+E', reason: np('there is no expandable tree to expand') },
  { section: '7.4', command: 'Find Track/Channel', key: 'Ctrl+F', mac: 'Cmd+F', chord: 'Mod+F', reason: nb('phase 4') },
  { section: '7.4', command: 'Set Track/Event Color', key: 'Alt+Shift+C', mac: 'Opt+Shift+C', chord: 'Alt+Shift+C', reason: nb('E-2') },

  // 7.5 Track state.
  { section: '7.5', command: 'Add Track', key: 'T', chord: 'T', commandId: 'track.add' },
  { section: '7.5', command: 'Mute', key: 'M', chord: 'M', commandId: 'track.muteSelected' },
  { section: '7.5', command: 'Solo', key: 'S', chord: 'S', commandId: 'track.soloSelected' },
  { section: '7.5', command: 'Record Enable', key: 'R', chord: 'R', commandId: 'track.recordEnable' },
  { section: '7.5', command: 'Write', key: 'W', chord: 'W', reason: nb('m6a-ui-automation') },
  { section: '7.5', command: 'Read automation for all tracks', key: 'Alt+R', mac: 'Opt+R', chord: 'Alt+R', reason: nb('m6a-ui-automation') },
  { section: '7.5', command: 'Write automation for all tracks', key: 'Alt+W', mac: 'Opt+W', chord: 'Alt+W', reason: nb('m6a-ui-automation') },
  { section: '7.5', command: 'Remove Selected Tracks', key: 'Shift+Delete', chord: 'Shift+Delete', commandId: 'track.removeSelected' },
  { section: '7.5', command: 'Track Versions: New', key: 'Ctrl+Shift+N', mac: 'Cmd+Shift+N', chord: 'Mod+Shift+N', reason: nb('M6b') },
  { section: '7.5', command: 'Track Versions: Duplicate', key: 'D', mac: 'Cmd+Shift+D', chord: 'Mod+Shift+D', reason: nb('M6b') },
  { section: '7.5', command: 'Track Versions: Next', key: 'H', mac: 'Cmd+Shift+H', chord: 'Mod+Shift+H', reason: nb('M6b') },
  { section: '7.5', command: 'Track Versions: Previous', key: 'G', mac: 'Cmd+Shift+G', chord: 'Mod+Shift+G', reason: nb('M6b') },

  // 7.6 Zoom.
  { section: '7.6', command: 'Zoom In', key: 'H', chord: 'H', commandId: 'view.zoomIn' },
  { section: '7.6', command: 'Zoom Out', key: 'G', chord: 'G', commandId: 'view.zoomOut' },
  { section: '7.6', command: 'Zoom In Vertically', key: 'Shift+H', chord: 'Shift+H', commandId: 'view.tracksTaller' },
  { section: '7.6', command: 'Zoom Out Vertically', key: 'Shift+G', chord: 'Shift+G', commandId: 'view.tracksShorter' },
  { section: '7.6', command: 'Zoom In on Waveform Vertically', key: 'Alt+H', mac: 'Opt+H', chord: 'Alt+H', reason: nb('phase 3') },
  { section: '7.6', command: 'Zoom Out on Waveform Vertically', key: 'Alt+G', mac: 'Opt+G', chord: 'Alt+G', reason: nb('phase 3') },
  { section: '7.6', command: 'Zoom In Tracks', key: 'Ctrl+Down', mac: 'Cmd+Down', chord: 'Mod+ArrowDown', reason: nb('phase 3') },
  { section: '7.6', command: 'Zoom Out Tracks', key: 'Ctrl+Up', mac: 'Cmd+Up', chord: 'Mod+ArrowUp', reason: nb('phase 3') },
  { section: '7.6', command: 'Zoom Tracks Exclusive', key: 'Z', chord: 'Z', reason: nb('phase 3') },
  { section: '7.6', command: 'Zoom Full', key: 'Shift+F', chord: 'Shift+F', commandId: 'view.zoomFull' },
  { section: '7.6', command: 'Zoom to Selection', key: 'Alt+S', mac: 'Opt+S', chord: 'Alt+S', commandId: 'view.zoomSelection' },
  { section: '7.6', command: 'Zoom to Event', key: 'Shift+E', chord: 'Shift+E', commandId: 'view.zoomEvent' },

  // 7.7 Navigation.
  ...(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).map((arrow): ReferenceRow => ({ section: '7.7', command: 'Extend selection', key: 'Shift+Arrow', chord: `Shift+${arrow}`, reason: nb('phase 3') })),
  { section: '7.7', command: 'Top track in the track list', key: 'Home', chord: 'Home', reason: nb('phase 3') },
  { section: '7.7', command: 'Bottom track in the track list', key: 'End', chord: 'End', reason: nb('phase 3') },
  { section: '7.7', command: 'Toggle Selection', key: 'Ctrl+Space', chord: 'Mod+Space', reason: nb('phase 3') },
  { section: '7.7', command: 'Next zone (focus)', key: 'Tab', chord: 'Tab', commandId: 'focus.next' },
  { section: '7.7', command: 'Previous zone (focus)', key: 'Shift+Tab', chord: 'Shift+Tab', commandId: 'focus.prev' },
  { section: '7.7', command: 'Page Up', key: 'Page Up', chord: 'PageUp', reason: nb('phase 3') },
  { section: '7.7', command: 'Page Down', key: 'Page Down', chord: 'PageDown', reason: nb('phase 3') },

  // 7.8 Windows, zones, mixer.
  { section: '7.8', command: 'MixConsole (window)', key: 'F3', chord: 'F3', reason: sa('MixConsole: F3 shows the lower zone until the window exists') },
  { section: '7.8', command: 'MixConsole in Project window (lower zone)', key: 'Alt+F3', mac: 'Opt+F3', chord: 'Alt+F3', commandId: 'zone.lower.mixconsole' },
  { section: '7.8', command: 'Audio Connections', key: 'F4', chord: 'F4', reason: np('Studio Setup and the Routing rack take its place') },
  { section: '7.8', command: 'MediaBay', key: 'F5', chord: 'F5', reason: np('the Media tab takes its place (UR-5)') },
  { section: '7.8', command: 'Search MediaBay', key: 'Shift+F5', chord: 'Shift+F5', reason: np('the Media tab takes its place (UR-5)') },
  { section: '7.8', command: 'Automation panel', key: 'F6', chord: 'F6', reason: nb('M6a') },
  { section: '7.8', command: 'Direct Offline Processing', key: 'F7', chord: 'F7', reason: np('offline processing is not planned') },
  { section: '7.8', command: 'Video Player', key: 'F8', chord: 'F8', reason: np('video is not planned') },
  { section: '7.8', command: 'VST Instruments', key: 'F11', chord: 'F11', reason: np('an instrument rack window is not planned') },
  { section: '7.8', command: 'Audio Performance Monitor', key: 'F12', chord: 'F12', reason: np('the top bar\'s DSP load and the Meter tab take its place (UR-14)') },
  { section: '7.8', command: 'On-Screen Keyboard', key: 'Alt+K', mac: 'Opt+K', chord: 'Alt+K', reason: np('MIDI input from the computer keyboard is not planned') },
  { section: '7.8', command: 'Show/Hide Left Zone', key: 'Ctrl+Alt+L', mac: 'Cmd+Opt+L', chord: 'Mod+Alt+L', commandId: 'zone.left.toggle' },
  { section: '7.8', command: 'Show/Hide Left Zone', key: 'Alt+I', mac: 'Opt+I', chord: 'Alt+I', commandId: 'zone.left.toggle' },
  { section: '7.8', command: 'Show/Hide Right Zone', key: 'Ctrl+Alt+R', mac: 'Cmd+Opt+R', chord: 'Mod+Alt+R', commandId: 'zone.right.toggle' },
  { section: '7.8', command: 'Show/Hide Lower Zone', key: 'Ctrl+Alt+E', chord: 'Mod+Alt+E', commandId: 'zone.lower.toggle' },
  { section: '7.8', command: 'Show/Hide Lower Zone', key: 'Ctrl+Alt+B', chord: 'Mod+Alt+B', commandId: 'zone.lower.toggle' },
  { section: '7.8', command: 'Show/Hide Channel', key: 'Ctrl+Alt+C', mac: 'Cmd+Opt+C', chord: 'Mod+Alt+C', commandId: 'zone.channel.toggle' },
  { section: '7.8', command: 'Show/Hide Transport Zone', key: 'Ctrl+Alt+T', mac: 'Cmd+Opt+T', chord: 'Mod+Alt+T', reason: np('the transport is the top bar\'s, always shown') },
  { section: '7.8', command: 'Show/Hide Info Line', key: 'Ctrl+I', mac: 'Cmd+I', chord: 'Mod+I', reason: nb('phase 3') },
  { section: '7.8', command: 'Show/Hide Overview', key: 'Alt+O', mac: 'Opt+O', chord: 'Alt+O', reason: nb('phase 3') },
  { section: '7.8', command: 'Previous Tab', key: 'Ctrl+Alt+Left', chord: 'Mod+Alt+ArrowLeft', commandId: 'zone.tab.prev' },
  { section: '7.8', command: 'Next Tab', key: 'Right', chord: 'Mod+Alt+ArrowRight', commandId: 'zone.tab.next' },
  { section: '7.8', command: 'Previous Page', key: 'Ctrl+Alt+Up', chord: 'Mod+Alt+ArrowUp', reason: nb('phase 3') },
  { section: '7.8', command: 'Next Page', key: 'Down', chord: 'Mod+Alt+ArrowDown', reason: nb('phase 3') },
  { section: '7.8', command: 'Show/Hide Chord Pads', key: 'Ctrl+Shift+C', mac: 'Cmd+Shift+C', chord: 'Mod+Shift+C', reason: np('chord pads are not planned') },
  { section: '7.8', command: 'Show/Hide Controller Lanes', key: 'Alt+L', mac: 'Opt+L', chord: 'Alt+L', reason: np('MIDI controller lanes are not planned') },
  { section: '7.8', command: 'Undo MixConsole step', key: 'Alt+Z', mac: 'Opt+Z', chord: 'Alt+Z', reason: np('the MixConsole shares the session\'s one undo (session.undo)') },
  { section: '7.8', command: 'Redo MixConsole step', key: 'Alt+Shift+Z', mac: 'Opt+Shift+Z', chord: 'Alt+Shift+Z', reason: np('the MixConsole shares the session\'s one undo (session.redo)') },
  { section: '7.8', command: 'Open Pool', key: 'Ctrl+P', mac: 'Cmd+P', chord: 'Mod+P', reason: sa('the Media tab, which replaced the Pool (UR-5; 10.8, 1): Ctrl+P opens it') },
  { section: '7.8', command: 'Open Tempo Track Editor', key: 'Ctrl+T', mac: 'Cmd+T', chord: 'Mod+T', reason: nb('phase 3') },
  { section: '7.8', command: 'Open Score Editor', key: 'Ctrl+R', mac: 'Cmd+R', chord: 'Mod+R', reason: np('a score editor is not planned') },
  { section: '7.8', command: 'Project Setup', key: 'Shift+S', chord: 'Shift+S', reason: nb('phase 3') },
  { section: '7.8', command: 'Project Colors', key: 'Alt+Shift+S', mac: 'Opt+Shift+S', chord: 'Alt+Shift+S', reason: nb('E-2') },
  ...digits(1, 9).map((n): ReferenceRow => ({ section: '7.8', command: `Workspace ${n}`, key: 'Alt+Num 1..9', chord: `Alt+Numpad${n}`, reason: nb('phase 5') })),
  { section: '7.8', command: 'Update Workspace', key: 'Alt+U', mac: 'Opt+U', chord: 'Alt+U', reason: nb('phase 5') },
  { section: '7.8', command: 'New Workspace', key: 'Ctrl+Num 0', chord: 'Mod+Numpad0', reason: nb('phase 5') },
  { section: '7.8', command: 'No Workspace', key: 'Alt+Num 0', chord: 'Alt+Numpad0', reason: nb('phase 5') },

  // 7.9 File.
  { section: '7.9', command: 'New', key: 'Ctrl+N', chord: 'Mod+N', commandId: 'project.new' },
  { section: '7.9', command: 'Open', key: 'Ctrl+O', chord: 'Mod+O', commandId: 'project.open' },
  { section: '7.9', command: 'Save', key: 'Ctrl+S', chord: 'Mod+S', commandId: 'project.save' },
  { section: '7.9', command: 'Save As', key: 'Ctrl+Shift+S', chord: 'Mod+Shift+S', reason: nb('phase 3') },
  { section: '7.9', command: 'Save New Version', key: 'Ctrl+Alt+S', chord: 'Mod+Alt+S', reason: nb('phase 3') },
  { section: '7.9', command: 'Close', key: 'Ctrl+W', chord: 'Mod+W', reason: np('one project per window: New and Open replace it; macOS\'s Close is the File menu\'s role item') },
  { section: '7.9', command: 'Quit', key: 'Ctrl+Q', chord: 'Mod+Q', reason: np('the platform\'s own Quit, the File menu\'s role item') },
];

// A preset chord that Cubase gives to another command (the audit's second
// test): the SIANN command bound to it, Cubase's command and why.
export interface Difference {
  readonly chord: string;
  readonly scope: Scope;
  readonly commandId: CommandId;
  readonly cubase: string;
  readonly why: string;
}

export const DIFFERENCES: readonly Difference[] = [
  { chord: 'Shift+1', scope: 'window', commandId: 'transport.toLeftLocator', cubase: 'To Marker 1', why: 'marker 1 is the left locator; the laptop fallback for Num 1 (3.6)' },
  { chord: 'Shift+2', scope: 'window', commandId: 'transport.toRightLocator', cubase: 'To Marker 2', why: 'marker 2 is the right locator; the laptop fallback for Num 2 (3.6)' },
  { chord: 'Mod+1', scope: 'window', commandId: 'transport.setLeftLocator', cubase: 'Set Marker 1', why: 'marker 1 is the left locator; the laptop fallback for Ctrl+Num 1 (3.6)' },
  { chord: 'Mod+2', scope: 'window', commandId: 'transport.setRightLocator', cubase: 'Set Marker 2', why: 'marker 2 is the right locator; the laptop fallback for Ctrl+Num 2 (3.6)' },
  { chord: 'F3', scope: 'window', commandId: 'zone.lower.mixconsole', cubase: 'MixConsole (window)', why: 'the lower zone\'s MixConsole until the window exists (2.5, 3.6)' },
  { chord: 'F6', scope: 'window', commandId: 'focus.nextZone', cubase: 'Automation panel', why: 'zone focus (2.1, 3.6); the Automation panel takes another chord in M6a' },
  { chord: 'Mod+P', scope: 'window', commandId: 'media.open', cubase: 'Open Pool', why: 'the Media tab replaced the Pool (UR-5; 10.8, 1)' },
  { chord: 'Enter', scope: 'window', commandId: 'focus.enterZone', cubase: 'Open/Close Editor', why: 'the focus key, which opens the editor from the project zone with a clip selected (2.1, 3.6)' },
];
