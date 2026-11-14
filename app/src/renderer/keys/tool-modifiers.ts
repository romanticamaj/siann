// The tool modifiers (UI redesign spec 3.6: "a second small table, as in
// Cubase's Tool Modifiers page"; m5-ui-edit-basics). The key table
// (preset-cubase.ts) says which key runs a command; this one says which
// modifier, held during a pointer gesture of the Object Selection tool,
// changes what the gesture does. Mod is Ctrl on Windows and Linux and Cmd on
// macOS, as in the key table. Pure.

export type ToolModifier = 'copy' | 'splitClick' | 'constrain' | 'noSnap' | 'fine';
export type ModifierKey = 'Alt' | 'Mod' | 'Shift';

export const TOOL_MODIFIERS: Readonly<Record<ToolModifier, ModifierKey>> = Object.freeze({
  // Alt-drag copies the selection.
  copy: 'Alt',
  // Alt-click splits the clip under the pointer.
  splitClick: 'Alt',
  // Ctrl-drag keeps a move on one axis.
  constrain: 'Mod',
  // Ctrl while resizing ignores snap.
  noSnap: 'Mod',
  // Shift is the fine step (the clip volume control).
  fine: 'Shift',
});

export interface ModifierFlags {
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

function held(key: ModifierKey, flags: ModifierFlags, platform: 'mac' | 'other'): boolean {
  switch (key) {
    case 'Alt':
      return flags.altKey;
    case 'Shift':
      return flags.shiftKey;
    case 'Mod':
      return platform === 'mac' ? flags.metaKey : flags.ctrlKey;
  }
}

// Which tool modifiers an event's flags hold on this platform.
export function toolModifiers(flags: ModifierFlags, platform: 'mac' | 'other'): Record<ToolModifier, boolean> {
  return {
    copy: held(TOOL_MODIFIERS.copy, flags, platform),
    splitClick: held(TOOL_MODIFIERS.splitClick, flags, platform),
    constrain: held(TOOL_MODIFIERS.constrain, flags, platform),
    noSnap: held(TOOL_MODIFIERS.noSnap, flags, platform),
    fine: held(TOOL_MODIFIERS.fine, flags, platform),
  };
}
