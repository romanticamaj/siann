// The track list's mini meters (UI redesign spec 5.1 and 5.3): one narrow
// canvas down the header column, not a canvas per header, drawn on its own
// animation frame from the RealtimeClient's newest readings, with zero React
// commits. Each track's bar sits in its header's meter cell; the rows come
// from the same view the event display draws (lane tops and heights after
// the vertical scroll), so the meters move with the headers. A frame is drawn
// only when a new meter frame arrived or the rows moved. Colours are tokens:
// --ok to -12 dBFS, --warn to -3, --err above.

import type { RealtimeClient } from '../model/realtime-client';

export interface MeterRow {
  // "track:<id>", as the meter legend names it.
  readonly ref: string;
  // The row's top and height in the canvas's CSS px.
  readonly top: number;
  readonly height: number;
}

export interface AnimationFrames {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrames: AnimationFrames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

// -60 dBFS at the bottom, 0 dBFS at the top.
function meterFraction(linear: number): number {
  if (!(linear > 0)) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

const WARN_FRACTION = (60 - 12) / 60;
const CLIP_FRACTION = (60 - 3) / 60;
// The meter's height inside a row, at most.
const BAR_MAX_PX = 36;

export class HeaderMeters {
  readonly #canvas: HTMLCanvasElement;
  readonly #realtime: Pick<RealtimeClient, 'frameCount' | 'meter'>;
  readonly #rows: () => readonly MeterRow[];
  readonly #frames: AnimationFrames;
  #handle: number | null = null;
  #drawnFrame = -1;
  #drawnRows = '';

  constructor(
    canvas: HTMLCanvasElement,
    realtime: Pick<RealtimeClient, 'frameCount' | 'meter'>,
    rows: () => readonly MeterRow[],
    frames: AnimationFrames = browserFrames,
  ) {
    this.#canvas = canvas;
    this.#realtime = realtime;
    this.#rows = rows;
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
    const canvas = this.#canvas;
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    const ratio = globalThis.devicePixelRatio || 1;
    const rows = this.#rows();
    const key = `${width}x${height}@${ratio}|${rows.map((r) => `${r.ref}:${r.top}:${r.height}`).join(',')}`;
    const count = this.#realtime.frameCount();
    if (count === this.#drawnFrame && key === this.#drawnRows) return;
    this.#drawnFrame = count;
    this.#drawnRows = key;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const style = getComputedStyle(canvas);
    const colour = (name: string) => style.getPropertyValue(name).trim();
    const slot = colour('--bg-0');
    const ok = colour('--ok');
    const warn = colour('--warn');
    const err = colour('--err');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let peaks = 0;
    for (const row of rows) {
      if (row.top + row.height < 0 || row.top > height) continue;
      const bar = Math.max(4, Math.min(BAR_MAX_PX, row.height - 8));
      const top = row.top + (row.height - bar) / 2;
      ctx.fillStyle = slot;
      ctx.fillRect(0, top, width, bar);
      const reading = this.#realtime.meter(row.ref);
      const channels = reading ? reading.peak : [];
      const lanes = Math.max(1, channels.length);
      const laneWidth = width / lanes;
      for (let c = 0; c < lanes; c += 1) {
        const fraction = meterFraction(channels[c] ?? 0);
        if (fraction > 0) peaks += 1;
        const filled = Math.round(bar * fraction);
        ctx.fillStyle = fraction > CLIP_FRACTION ? err : fraction > WARN_FRACTION ? warn : ok;
        ctx.fillRect(c * laneWidth, top + bar - filled, Math.max(1, laneWidth - 1), filled);
      }
    }
    // For the e2e: how many meter frames were drawn, and how many bars read above silence.
    canvas.dataset.frames = String(count);
    canvas.dataset.lit = String(peaks);
  }
}
