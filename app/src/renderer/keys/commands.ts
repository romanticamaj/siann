// Key commands (UI redesign spec 3.6): every command has an id; a preset maps
// chords to ids per scope. Placeholder: the registry arrives with the feature.

export const SCOPES = ['window', 'project', 'left', 'lower', 'right'] as const;
export type Scope = (typeof SCOPES)[number];

export const COMMAND_IDS = [
  'zone.left.toggle',
  'zone.lower.toggle',
  'zone.lower.mixconsole',
  'zone.right.toggle',
  'zone.right.plans',
  'focus.nextZone',
  'focus.prevZone',
  'edit.delete',
  'edit.cancel',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export interface Binding {
  readonly chord: string;
  readonly commandId: CommandId;
  readonly scope: Scope;
}
