// How a strip's meter slot and peak value reach the Mixer's one meter canvas
// (MixerMeters): each registers its element under the meter's ref ("master",
// "track:<id>") while mounted, and a click on the peak value resets that
// meter. Null outside a Mixer (the Inspector, server rendering in tests).

import { createContext } from 'react';

export interface MetersRegistry {
  slot(ref: string, element: HTMLElement): () => void;
  peak(ref: string, element: HTMLElement): () => void;
  reset(ref: string): void;
}

export const MetersContext = createContext<MetersRegistry | null>(null);
