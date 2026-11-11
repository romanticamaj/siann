// A strip's meter (ADR-0019 point 3): an imperative class that owns its
// <canvas> and redraws it on every animation frame from the RealtimeClient's
// newest reading. No meter value passes through React state; React only
// mounts the canvas and starts and stops the class.
//
// For the e2e tests it writes, on the canvas itself (DOM, not React), the
// frames received so far (data-frames), the newest frame's entry count
// (data-entries), the legend's length (data-legend) and the newest peak of the
// entity (data-peak, linear, the louder channel).

import type { RealtimeClient } from '../model/realtime-client';

export interface AnimationFrames {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrames: AnimationFrames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

// The bar's height for a linear peak: -60 dBFS at the bottom, 0 dBFS at the top.
function meterFraction(linear: number): number {
  if (!(linear > 0)) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

export class MeterCanvas {
  readonly #canvas: HTMLCanvasElement;
  readonly #realtime: RealtimeClient;
  readonly #ref: string;
  readonly #frames: AnimationFrames;
  #handle: number | null = null;
  #drawn = -1;

  constructor(canvas: HTMLCanvasElement, realtime: RealtimeClient, ref: string, frames: AnimationFrames = browserFrames) {
    this.#canvas = canvas;
    this.#realtime = realtime;
    this.#ref = ref;
    this.#frames = frames;
  }

  start(): void {
    if (this.#handle !== null) return;
    const tick = () => {
      this.#draw();
      this.#handle = this.#frames.request(tick);
    };
    this.#handle = this.#frames.request(tick);
  }

  stop(): void {
    if (this.#handle !== null) this.#frames.cancel(this.#handle);
    this.#handle = null;
  }

  #draw(): void {
    const count = this.#realtime.frameCount();
    if (count === this.#drawn) return;
    this.#drawn = count;
    const canvas = this.#canvas;
    const latest = this.#realtime.latest();
    const reading = this.#realtime.meter(this.#ref);
    const peaks = reading ? reading.peak : [];
    const peak = peaks.length > 0 ? Math.max(...peaks) : 0;
    canvas.dataset.frames = String(count);
    canvas.dataset.entries = String(latest ? latest.entries.length : 0);
    canvas.dataset.legend = String(this.#realtime.legend()?.entities.length ?? 0);
    canvas.dataset.peak = String(peak);

    const context = canvas.getContext('2d');
    if (!context) return;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    const channels = Math.max(peaks.length, 1);
    const barWidth = width / channels;
    for (let c = 0; c < channels; c += 1) {
      const fraction = meterFraction(peaks[c] ?? 0);
      const barHeight = Math.round(height * fraction);
      context.fillStyle = fraction > 0.95 ? '#d33' : '#3a3';
      context.fillRect(c * barWidth + 1, height - barHeight, barWidth - 2, barHeight);
    }
  }
}
