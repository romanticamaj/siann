// The card's summary line (m5-ui-port-plans): not implemented yet.

import type { T } from '../i18n/t';

export type ChipKind = 'trackAdd' | 'trackRemove' | 'clipAdd' | 'clipRemove' | 'move' | 'mix' | 'edit';

export interface Chip {
  readonly kind: ChipKind;
  readonly count: number;
  readonly figure: string;
  readonly word: string;
}

export function chipsOf(_steps: readonly Record<string, unknown>[], _t?: T): Chip[] {
  return [];
}
