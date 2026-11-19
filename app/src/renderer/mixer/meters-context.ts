// How a strip's meter channels and peak value reach the Mixer's one meter
// canvas (MixerMeters): each registers its element under the meter's ref
// ("master", "track:<id>") while mounted, a channel with its index (0 left,
// 1 right), and a click on the peak value resets that meter. A loudness text
// (the master's LUFS-S, the Meter tab's three values; m5b-ui-meter) registers
// under its field. Null outside a Mixer (server rendering in tests).

import { createContext } from 'react';

import type { LoudnessField } from '../model/loudness-store';

export interface MetersRegistry {
  slot(ref: string, channel: number, element: HTMLElement): () => void;
  peak(ref: string, element: HTMLElement): () => void;
  loudness(field: LoudnessField, element: HTMLElement): () => void;
  reset(ref: string): void;
}

export const MetersContext = createContext<MetersRegistry | null>(null);
