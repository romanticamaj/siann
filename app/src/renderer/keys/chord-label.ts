// A chord as people read it (m5b-ui-keymap). Not implemented yet.

import type { T } from '../i18n/t';
import type { Binding, CommandId } from './commands';
import { CUBASE_PRESET } from './preset-cubase';

export type Platform = 'mac' | 'other';

export function formatChord(chord: string, _platform: Platform): string {
  return chord;
}

export function chordsOf(_commandId: CommandId, _preset: readonly Binding[] = CUBASE_PRESET): string[] {
  return [];
}

export function tipWithKey(_t: T, label: string, _commandId: CommandId, _platform?: Platform): string {
  return label;
}
