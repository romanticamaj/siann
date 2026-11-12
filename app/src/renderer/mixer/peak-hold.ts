// A meter's peak hold and clip latch (UX pass, A17): the highest peak of the
// last `holdMs` stays shown (then falls to the current reading), and a peak
// at or above full scale latches the clip indicator until cleared.
// Framework-free; time is passed in.

export const PEAK_HOLD_MS = 1500;
// 0 dBFS: a reading at or above it clips.
export const CLIP_LINEAR = 1;

export class PeakHold {
  readonly #holdMs: number;
  #held = 0;
  #heldAt = -Infinity;
  #clipped = false;

  constructor(holdMs = PEAK_HOLD_MS) {
    this.#holdMs = holdMs;
  }

  // Takes the newest linear peak at time `now` (ms) and returns the held one.
  update(peak: number, now: number): number {
    const value = Number.isFinite(peak) && peak > 0 ? peak : 0;
    if (value >= this.#held || now - this.#heldAt > this.#holdMs) {
      this.#held = value;
      this.#heldAt = now;
    }
    if (value >= CLIP_LINEAR) this.#clipped = true;
    return this.#held;
  }

  held(): number {
    return this.#held;
  }

  clipped(): boolean {
    return this.#clipped;
  }

  clearClip(): void {
    this.#clipped = false;
  }
}

// The fraction of a meter's height for a linear value on its dB scale:
// `floorDb` at the bottom, 0 dBFS at the top.
export function meterFraction(linear: number, floorDb = -60): number {
  if (!(linear > 0)) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}

// A linear peak as the readout prints it: "-6.0", "-inf", "+0.4".
export function peakText(linear: number): string {
  if (!(linear > 0)) return '-inf';
  const db = 20 * Math.log10(linear);
  if (db < -99.9) return '-inf';
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) return '0.0';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}
