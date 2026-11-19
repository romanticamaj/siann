// The loudness store (UI redesign spec 5.3; m5b-ui-meter): SLUD frame ->
// RealtimeClient -> LoudnessStore, a plain object holding the master's
// momentary, short-term and integrated loudness in LUFS, minus infinity for
// silence, before the first frame and after a clear (the realtime channel
// closed). Nothing is emitted: the meter surfaces read it from their own
// animation frame, so no loudness value reaches React (ADR-0019 point 3).

import type { LoudnessFrame } from './loudness-frames';

export type LoudnessField = 'momentary' | 'shortTerm' | 'integrated';

// What the meter surfaces read of a LoudnessStore.
export interface LoudnessReadings {
  read(field: LoudnessField): number;
}

export class LoudnessStore implements LoudnessReadings {
  momentary = -Infinity;
  shortTerm = -Infinity;
  integrated = -Infinity;
  // Frames taken since this store was made.
  frames = 0;

  set(frame: LoudnessFrame): void {
    this.momentary = frame.momentary;
    this.shortTerm = frame.shortTerm;
    this.integrated = frame.integrated;
    this.frames += 1;
  }

  clear(): void {
    this.momentary = -Infinity;
    this.shortTerm = -Infinity;
    this.integrated = -Infinity;
  }

  read(field: LoudnessField): number {
    return this[field];
  }
}
