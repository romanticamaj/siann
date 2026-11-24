// Command names and categories (m5b-ui-keymap). Not implemented yet.

import type { T } from '../i18n/t';
import type { CommandId } from './commands';
import type { Platform } from './chord-label';

export const KEY_CATEGORIES = ['transport', 'markers', 'tools', 'edit', 'track', 'zoom', 'navigate', 'zones', 'file', 'plans'] as const;
export type KeyCategory = (typeof KEY_CATEGORIES)[number];

export interface KeyCommandRow {
  readonly commandId: CommandId;
  readonly name: string;
  readonly keys: readonly string[];
}

export interface KeyCommandGroup {
  readonly category: KeyCategory;
  readonly label: string;
  readonly rows: readonly KeyCommandRow[];
}

export function categoryOf(_id: CommandId): KeyCategory {
  return 'plans';
}

export function commandName(_t: T, id: CommandId): string {
  return id;
}

export function keyCommandGroups(_t: T, _platform: Platform, _query = ''): KeyCommandGroup[] {
  return [];
}
