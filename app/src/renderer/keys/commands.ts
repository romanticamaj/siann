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
