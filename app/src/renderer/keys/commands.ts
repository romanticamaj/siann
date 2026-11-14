// Key commands (UI redesign spec 3.6): every command has an id; a preset is a
// table from chords to command ids per scope (preset-cubase.ts), and the
// dispatcher sends a key to the focused zone first, then to the window. The
// registry holds who handles each command id; menus, tooltips and the future
// key-command editor read the same ids.
//
// Scopes: 'window' (everywhere), or one zone ('project', 'left', 'lower',
// 'right'), which fires only while that zone has the focus frame.

export const SCOPES = ['window', 'project', 'left', 'lower', 'right'] as const;
export type Scope = (typeof SCOPES)[number];
export type ZoneScope = Exclude<Scope, 'window'>;

export const COMMAND_IDS = [
  // Zones (spec 2.1). The project zone has none: it is never hidden.
  'zone.left.toggle',
  'zone.lower.toggle',
  'zone.lower.mixconsole',
  'zone.right.toggle',
  'zone.right.plans',
  // The focus frame (spec 2.1, "Keyboard focus is per zone"; zone-focus.ts):
  // Tab and Shift+Tab, F6 and Shift+F6, Enter into a zone, Escape out of a control.
  'focus.next',
  'focus.prev',
  'focus.nextZone',
  'focus.prevZone',
  'focus.enterZone',
  'focus.zoneRoot',
  // The project zone's edits (moved from the timeline's own key listener).
  'edit.delete',
  'edit.cancel',
  // The event display's zoom (m5-ui-arrange; spec 3.2): horizontal zoom in
  // and out, track heights taller and shorter, Zoom Full.
  'view.zoomIn',
  'view.zoomOut',
  'view.tracksTaller',
  'view.tracksShorter',
  'view.zoomFull',
  // The track list (spec 3.3).
  'track.add',
  // Editing by Cubase's gestures (m5-ui-edit-basics; spec 3.1, 3.2, 3.3):
  // the tools, split at the cursor, duplicate, snap, select all, locating
  // the selection and the clips, zoom to the selection and to the clip, and
  // M, S and removal of the selected tracks.
  'tool.select',
  'tool.split',
  'edit.splitAtCursor',
  'edit.duplicate',
  'edit.snapToggle',
  'edit.selectAll',
  'transport.locateSelection',
  'transport.locateNextClip',
  'transport.locatePreviousClip',
  'view.zoomSelection',
  'view.zoomEvent',
  'track.muteSelected',
  'track.soloSelected',
  'track.removeSelected',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export interface Binding {
  readonly chord: string;
  readonly commandId: CommandId;
  readonly scope: Scope;
}

// Runs a command; returns false when it did nothing (the key then keeps its default).
export type CommandHandler = () => boolean | void;

export class CommandRegistry {
  readonly #handlers = new Map<string, CommandHandler>();

  register(scope: Scope, commandId: CommandId, handler: CommandHandler): () => void {
    const key = `${scope} ${commandId}`;
    this.#handlers.set(key, handler);
    return () => {
      if (this.#handlers.get(key) === handler) this.#handlers.delete(key);
    };
  }

  // True when a handler ran and did not decline.
  run(scope: Scope, commandId: CommandId): boolean {
    const handler = this.#handlers.get(`${scope} ${commandId}`);
    if (!handler) return false;
    return handler() !== false;
  }
}
