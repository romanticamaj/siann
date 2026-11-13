// The meter store (UI redesign spec 5.3): SMTR frame -> RealtimeClient ->
// MeterStore, a plain object holding Float32Arrays for peak, RMS, hold and
// clip per legend index. The meter canvases call sync() and advance() from
// their own animation frame and read the arrays; nothing is emitted, so no
// meter value reaches React (ADR-0019 point 3). Each entry keeps the louder
// channel. A new legend epoch resizes the arrays and starts from silence; an
// entity missing from the newest frame, and every entity of a frame whose
// transport is stopped (the engine then repeats its last readings), reads as
// silence.

import { PeakHold } from '../mixer/peak-hold';
import type { MeterFrame, MeterLegend } from './meter-frames';

// What the store reads of a RealtimeClient.
export interface MeterSource {
  legend(): MeterLegend | null;
  latest(): MeterFrame | null;
  frameCount(): number;
}

export interface MeterReading {
  // The newest frame's linear peak and RMS (the louder channel).
  readonly peak: number;
  readonly rms: number;
  // The bar and the hold line in dB (the ballistics).
  readonly level: number;
  readonly hold: number;
  // The loudest peak since the last reset (linear), and the latched clip.
  readonly max: number;
  readonly clip: boolean;
}

export class MeterStore {
  readonly #source: MeterSource;
  readonly #ballistics = new PeakHold(0);
  #epoch: string | null = null;
  #entities: readonly string[] = [];
  #frames = 0;
  #playing = false;
  peak = new Float32Array(0);
  rms = new Float32Array(0);

  constructor(source: MeterSource) {
    this.#source = source;
  }

  get hold(): Float32Array {
    return this.#ballistics.hold;
  }

  get level(): Float32Array {
    return this.#ballistics.level;
  }

  get max(): Float32Array {
    return this.#ballistics.max;
  }

  get clip(): Uint8Array {
    return this.#ballistics.clip;
  }

  // Follows the legend and takes the newest frame; true when it was new.
  sync(): boolean {
    const legend = this.#source.legend();
    const epoch = legend?.epoch ?? null;
    if (epoch !== this.#epoch) {
      this.#epoch = epoch;
      this.#entities = legend?.entities ?? [];
      const size = this.#entities.length;
      this.peak = new Float32Array(size);
      this.rms = new Float32Array(size);
      this.#ballistics.resize(size);
      this.#playing = false;
    }
    const count = this.#source.frameCount();
    if (count === this.#frames) return false;
    this.#frames = count;
    const frame = this.#source.latest();
    this.peak.fill(0);
    this.rms.fill(0);
    this.#playing = frame?.playing === true;
    // Stopped, the engine repeats its last readings; nothing is metered then.
    if (!frame || frame.epoch !== this.#epoch || !frame.playing) return true;
    for (const entry of frame.entries) {
      const index = entry.entityIndex;
      if (index >= this.peak.length) continue;
      let peak = 0;
      let rms = 0;
      for (const value of entry.peak) if (value > peak) peak = value;
      for (const value of entry.rms) if (value > rms) rms = value;
      this.peak[index] = peak;
      this.rms[index] = rms;
    }
    return true;
  }

  // Applies the ballistics to every meter with the frame's time delta.
  advance(dtSeconds: number): void {
    for (let i = 0; i < this.peak.length; i += 1) this.#ballistics.step(i, this.peak[i]!, dtSeconds);
  }

  indexOf(ref: string): number {
    return this.#entities.indexOf(ref);
  }

  read(ref: string): MeterReading | null {
    const i = this.indexOf(ref);
    if (i < 0) return null;
    return {
      peak: this.peak[i]!,
      rms: this.rms[i]!,
      level: this.#ballistics.level[i]!,
      hold: this.#ballistics.hold[i]!,
      max: this.#ballistics.max[i]!,
      clip: this.#ballistics.clip[i] === 1,
    };
  }

  // Clears the hold line, the peak value and the clip of one meter.
  reset(ref: string): void {
    this.#ballistics.reset(this.indexOf(ref));
  }

  // The newest frame says the transport plays.
  playing(): boolean {
    return this.#playing;
  }

  // Every bar and hold line is at the floor and no input is above it.
  decayed(): boolean {
    for (let i = 0; i < this.peak.length; i += 1) {
      if (this.peak[i]! > 0 || !this.#ballistics.decayed(i)) return false;
    }
    return true;
  }
}
