// The meter store (UI redesign spec 5.3): SMTR frame -> RealtimeClient ->
// MeterStore, a plain object holding Float32Arrays for peak, RMS, hold and
// clip per legend index. The meter canvases call sync() and advance() from
// their own animation frame and read the arrays; nothing is emitted, so no
// meter value reaches React (ADR-0019 point 3). Each entry keeps the louder
// channel; a strip meter draws two channels as the mockup does
// (m5-ui-port-mixer-strip), so the store also keeps the level and hold of each
// channel, at 2 * index + channel (a mono entity shows the same value in
// both; the peak value and the clip stay the entity's). A new legend epoch (every graph publication) resizes the arrays;
// an entity still in the legend keeps its bar, hold line, peak value and
// latched clip (spec 1.6: cleared only by clicking the peak value), a new
// one starts from silence; an
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
  // The same per channel, left and right.
  readonly channels: readonly [MeterChannelReading, MeterChannelReading];
  // The loudest peak since the last reset (linear), and the latched clip.
  readonly max: number;
  readonly clip: boolean;
}

export interface MeterChannelReading {
  readonly level: number;
  readonly hold: number;
}

// The two channels a meter draws of an entry: its first two, a mono entry in both.
function channelPeak(peaks: readonly number[], channel: 0 | 1): number {
  if (peaks.length === 0) return 0;
  if (channel === 0 || peaks.length === 1) return peaks[0]!;
  let peak = 0;
  for (let i = 1; i < peaks.length; i += 1) if (peaks[i]! > peak) peak = peaks[i]!;
  return peak;
}

export class MeterStore {
  readonly #source: MeterSource;
  readonly #ballistics = new PeakHold(0);
  // Per channel: index 2 * entity + channel.
  readonly #channels = new PeakHold(0);
  #channelPeak = new Float32Array(0);
  #epoch: string | null = null;
  #entities: readonly string[] = [];
  #frames = 0;
  #playing = false;
  // The animation frame the ballistics last advanced in (two surfaces share a store).
  #advancedIn: number | null = null;
  peak = new Float32Array(0);
  rms = new Float32Array(0);

  constructor(source: MeterSource) {
    this.#source = source;
  }

  // The meters.legend epoch the arrays follow.
  get epoch(): string | null {
    return this.#epoch;
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

  // The bar and the hold line of each channel, in dB: 2 * index + channel.
  get channelLevel(): Float32Array {
    return this.#channels.level;
  }

  get channelHold(): Float32Array {
    return this.#channels.hold;
  }

  // Follows the legend and takes the newest frame; true when it was new.
  sync(): boolean {
    const legend = this.#source.legend();
    const epoch = legend?.epoch ?? null;
    if (epoch !== this.#epoch) {
      this.#epoch = epoch;
      const before = this.#entities;
      this.#entities = legend?.entities ?? [];
      const size = this.#entities.length;
      this.peak = new Float32Array(size);
      this.rms = new Float32Array(size);
      // Every graph publication brings an epoch; the ballistics follow the ref.
      const from = this.#entities.map((ref) => before.indexOf(ref));
      this.#ballistics.remap(from);
      this.#channels.remap(from.flatMap((j) => (j < 0 ? [-1, -1] : [2 * j, 2 * j + 1])));
      this.#channelPeak = new Float32Array(2 * size);
      this.#playing = false;
    }
    const count = this.#source.frameCount();
    if (count === this.#frames) return false;
    this.#frames = count;
    const frame = this.#source.latest();
    this.peak.fill(0);
    this.rms.fill(0);
    this.#channelPeak.fill(0);
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
      this.#channelPeak[2 * index] = channelPeak(entry.peak, 0);
      this.#channelPeak[2 * index + 1] = channelPeak(entry.peak, 1);
    }
    return true;
  }

  // Applies the ballistics to every meter with the frame's time delta. With
  // `frame` (the animation frame's timestamp) a second call in the same frame
  // does nothing: the MixConsole and the Meter tab draw from one store.
  advance(dtSeconds: number, frame?: number): void {
    if (frame !== undefined) {
      if (frame === this.#advancedIn) return;
      this.#advancedIn = frame;
    }
    for (let i = 0; i < this.peak.length; i += 1) this.#ballistics.step(i, this.peak[i]!, dtSeconds);
    for (let i = 0; i < this.#channelPeak.length; i += 1) this.#channels.step(i, this.#channelPeak[i]!, dtSeconds);
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
      channels: [
        { level: this.#channels.level[2 * i]!, hold: this.#channels.hold[2 * i]! },
        { level: this.#channels.level[2 * i + 1]!, hold: this.#channels.hold[2 * i + 1]! },
      ],
      max: this.#ballistics.max[i]!,
      clip: this.#ballistics.clip[i] === 1,
    };
  }

  // Clears the hold line, the peak value and the clip of one meter.
  reset(ref: string): void {
    const i = this.indexOf(ref);
    this.#ballistics.reset(i);
    if (i >= 0) {
      this.#channels.reset(2 * i);
      this.#channels.reset(2 * i + 1);
    }
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
    for (let i = 0; i < this.#channelPeak.length; i += 1) if (!this.#channels.decayed(i)) return false;
    return true;
  }
}
