// The card's summary line (m5-ui-port-plans; UI redesign 10.7, 3): count
// chips from the plan's steps, as the mockup's .sum draws them ("+1 track",
// "+1 clip", "1 move", "3 mix"). In this order, a kind with no step left out:
// "+N track" (track.add), "−N track" (track.remove), "+N clip" (clip.place),
// "−N clip" (clip.remove), "N move" (clip.move), "N mix" (gain, pan, mute,
// solo, clip gain, plug-in bypass), "N edit" (every other op). The figure is
// the same bytes in every locale; the word is the catalog's.

import type { MessageKey } from '../i18n/en';
import { translator, type T } from '../i18n/t';

export type ChipKind = 'trackAdd' | 'trackRemove' | 'clipAdd' | 'clipRemove' | 'move' | 'mix' | 'edit';

export interface Chip {
  readonly kind: ChipKind;
  readonly count: number;
  // "+1", "−2", "3": the <b> of the chip.
  readonly figure: string;
  readonly word: string;
}

const MINUS = '−';

const KINDS: ReadonlyArray<{ kind: ChipKind; sign: string; word: MessageKey }> = [
  { kind: 'trackAdd', sign: '+', word: 'chip.track' },
  { kind: 'trackRemove', sign: MINUS, word: 'chip.track' },
  { kind: 'clipAdd', sign: '+', word: 'chip.clip' },
  { kind: 'clipRemove', sign: MINUS, word: 'chip.clip' },
  { kind: 'move', sign: '', word: 'chip.move' },
  { kind: 'mix', sign: '', word: 'chip.mix' },
  { kind: 'edit', sign: '', word: 'chip.edit' },
];

const MIX = new Set(['track.set_gain', 'track.set_pan', 'track.set_mute', 'track.set_solo', 'clip.set_gain', 'plugin.set_bypass']);

export function kindOf(op: unknown): ChipKind {
  switch (op) {
    case 'track.add':
      return 'trackAdd';
    case 'track.remove':
      return 'trackRemove';
    case 'clip.place':
      return 'clipAdd';
    case 'clip.remove':
      return 'clipRemove';
    case 'clip.move':
      return 'move';
    default:
      return typeof op === 'string' && MIX.has(op) ? 'mix' : 'edit';
  }
}

export function chipsOf(steps: readonly Record<string, unknown>[], t: T = translator('en')): Chip[] {
  const counts = new Map<ChipKind, number>();
  for (const step of steps) {
    const kind = kindOf(step.op);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return KINDS.filter(({ kind }) => counts.has(kind)).map(({ kind, sign, word }) => {
    const count = counts.get(kind)!;
    return { kind, count, figure: `${sign}${count}`, word: t(word) };
  });
}
