// Command names and categories (m5b-ui-keymap; UI redesign 3.6): what the
// Key Commands list shows for each command of COMMAND_IDS, and the menus
// label their items with. A command's name is the catalog's
// `command.<id>`; the ten Open Recent entries and the seven marker keys share
// one name each with their number. Each command is in one of ten categories,
// in Cubase's order of its Key Commands tree where it has one.

import type { MessageKey } from '../i18n/en';
import type { T } from '../i18n/t';
import { chordsOf, formatChord, type Platform } from './chord-label';
import { COMMAND_IDS, type Binding, type CommandId } from './commands';
import { CUBASE_PRESET } from './preset-cubase';

export const KEY_CATEGORIES = ['transport', 'markers', 'tools', 'edit', 'track', 'zoom', 'navigate', 'zones', 'file', 'plans'] as const;
export type KeyCategory = (typeof KEY_CATEGORIES)[number];

export interface KeyCommandRow {
  readonly commandId: CommandId;
  readonly name: string;
  // The command's keys, written for the platform.
  readonly keys: readonly string[];
}

export interface KeyCommandGroup {
  readonly category: KeyCategory;
  readonly label: string;
  readonly rows: readonly KeyCommandRow[];
}

// The commands that sit in another category than their prefix says.
const CATEGORY_OF: Readonly<Partial<Record<CommandId, KeyCategory>>> = {
  'view.autoScroll': 'transport',
  'track.recordEnable': 'track',
  'editor.open': 'zones',
  'media.open': 'zones',
  'studio.setup': 'zones',
  'help.keyCommands': 'zones',
  'audition.flip': 'plans',
};

const PREFIX: ReadonlyArray<readonly [string, KeyCategory]> = [
  ['transport.', 'transport'],
  ['marker.', 'markers'],
  ['tool.', 'tools'],
  ['edit.', 'edit'],
  ['track.', 'track'],
  ['mixer.', 'track'],
  ['view.', 'zoom'],
  ['focus.', 'navigate'],
  ['zone.', 'zones'],
  ['project.', 'file'],
  ['plans.', 'plans'],
];

// The commands named by their own catalog entry (the recent and marker keys share one each).
type NamedCommand = Exclude<CommandId, `project.openRecent.${string}` | `marker.goTo${string}`>;

const CATEGORY_LABELS: Readonly<Record<KeyCategory, MessageKey>> = {
  transport: 'keys.category.transport',
  markers: 'keys.category.markers',
  tools: 'keys.category.tools',
  edit: 'keys.category.edit',
  track: 'keys.category.track',
  zoom: 'keys.category.zoom',
  navigate: 'keys.category.navigate',
  zones: 'keys.category.zones',
  file: 'keys.category.file',
  plans: 'keys.category.plans',
};

export function categoryOf(id: CommandId): KeyCategory {
  const own = CATEGORY_OF[id];
  if (own) return own;
  const found = PREFIX.find(([prefix]) => id.startsWith(prefix));
  return found ? found[1] : 'zones';
}

export function commandName(t: T, id: CommandId): string {
  const recent = /^project\.openRecent\.(\d+)$/.exec(id);
  if (recent) return t('command.project.openRecent', { n: Number(recent[1]) });
  const marker = /^marker\.goTo(\d)$/.exec(id);
  if (marker) return t('command.marker.goTo', { n: Number(marker[1]) });
  // Every other command has its own catalog entry: the type checks it.
  return t(`command.${id as NamedCommand}`);
}

// Folds case and width for the search (a full-width letter finds its half-width one).
function fold(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase();
}

// The list by category, in COMMAND_IDS order within one; with a query, only
// the commands whose name or one of whose keys holds it, and no empty group.
export function keyCommandGroups(t: T, platform: Platform, query = '', preset: readonly Binding[] = CUBASE_PRESET): KeyCommandGroup[] {
  const needle = fold(query.trim());
  const rows: Array<KeyCommandRow & { readonly category: KeyCategory }> = COMMAND_IDS.map((commandId) => ({
    commandId,
    category: categoryOf(commandId),
    name: commandName(t, commandId),
    keys: chordsOf(commandId, preset).map((chord) => formatChord(chord, platform)),
  }));
  const shown = needle === '' ? rows : rows.filter((row) => fold(row.name).includes(needle) || row.keys.some((key) => fold(key).includes(needle)));
  return KEY_CATEGORIES.map((category) => ({
    category,
    label: t(CATEGORY_LABELS[category]),
    rows: shown.filter((row) => row.category === category).map(({ commandId, name, keys }) => ({ commandId, name, keys })),
  })).filter((group) => group.rows.length > 0 || needle === '');
}
