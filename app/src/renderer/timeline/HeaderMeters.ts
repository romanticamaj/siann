// The track list's mini meters (UI redesign spec 5.1 and 5.3;
// m5-ui-port-track-list): one canvas over the header column (pointer events
// off), not a canvas per header, drawn on its own animation frame from the
// RealtimeClient's newest readings, with zero React commits. Each header has a
// .hmeter well (DOM, drawn by ui/project-zone.css, with no <i>); the surface
// paints inside each well a horizontal bar as wide as the louder channel's
// reading on -60..0 dBFS, filled with the mockup's .hmeter i gradient
// (--meter-0 at 0, --play at 62 %, --meter-mid at 82 %, --err at 100 %) over
// --header-meter-scale-w from the well's left edge, repeated as the mockup's
// background-size repeats it. Every colour and size is a token of tokens.ts.
//
// Slots are registered per header and measured when one is added or removed
// and when the owner reports a resize or a scroll (remeasure), not every
// frame; a frame is drawn only when a new meter frame arrived or a slot moved.

import type { RealtimeClient } from '../model/realtime-client';
import { frameMarks } from '../perf/frame-marks';
import { TOKENS } from '../tokens';

export interface AnimationFrames {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface GradientLike {
  addColorStop(offset: number, colour: string): void;
}

export interface Context2DLike {
  fillStyle: unknown;
  fillRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): Context2DLike | null;
  dataset?: Record<string, string | undefined>;
}

export interface SlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HeaderMeterSlot {
  // "track:<id>", as the meter legend names it.
  readonly ref: string;
  // The well's inside (within its border) in the canvas's CSS px, or null when it is not laid out.
  measure(): SlotRect | null;
}

export interface HeaderMetersOptions {
  readonly canvas: CanvasLike;
  readonly realtime: Pick<RealtimeClient, 'frameCount' | 'meter'>;
  readonly frames?: AnimationFrames;
  readonly pixelRatio?: () => number;
  // The canvas's CSS size.
  readonly size: () => { width: number; height: number };
}

const browserFrames: AnimationFrames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

// The mockup's .hmeter i: linear-gradient(90deg, ...) with background-size --header-meter-scale-w.
const STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, TOKENS['meter-0']],
  [0.62, TOKENS.play],
  [0.82, TOKENS['meter-mid']],
  [1, TOKENS.err],
];
const SCALE_PX = parseFloat(TOKENS['header-meter-scale-w']);

// -60 dBFS at the left, 0 dBFS at the right.
function meterFraction(linear: number): number {
  if (!(linear > 0)) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

interface Entry {
  readonly slot: HeaderMeterSlot;
  rect: SlotRect | null;
}

const rectKey = (rect: SlotRect | null) => (rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '-');

export class HeaderMeters {
  readonly #canvas: CanvasLike;
  readonly #realtime: Pick<RealtimeClient, 'frameCount' | 'meter'>;
  readonly #frames: AnimationFrames;
  readonly #pixelRatio: () => number;
  readonly #size: () => { width: number; height: number };
  readonly #entries = new Set<Entry>();
  #handle: number | null = null;
  #drawnFrame = -1;
  #drawnSize = '';
  #dirty = true;

  constructor(options: HeaderMetersOptions) {
    this.#canvas = options.canvas;
    this.#realtime = options.realtime;
    this.#frames = options.frames ?? browserFrames;
    this.#pixelRatio = options.pixelRatio ?? (() => globalThis.devicePixelRatio || 1);
    this.#size = options.size;
  }

  // A header's well, painted while mounted; measured now.
  addSlot(slot: HeaderMeterSlot): () => void {
    const entry: Entry = { slot, rect: slot.measure() };
    this.#entries.add(entry);
    this.#dirty = true;
    return () => {
      this.#entries.delete(entry);
      this.#dirty = true;
    };
  }

  // The owner saw a resize or a scroll: measure every well again; a moved one redraws.
  remeasure(): void {
    for (const entry of this.#entries) {
      const rect = entry.slot.measure();
      if (rectKey(rect) !== rectKey(entry.rect)) this.#dirty = true;
      entry.rect = rect;
    }
  }

  start(): void {
    if (this.#handle !== null) return;
    const tick = () => {
      // The perf scenario's frame marks (perf/frame-marks.ts; a no-op outside the test hook).
      frameMarks().begin();
      this.#draw();
      frameMarks().end();
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
    const { width: cssWidth, height: cssHeight } = this.#size();
    const width = Math.max(1, Math.round(cssWidth));
    const height = Math.max(1, Math.round(cssHeight));
    const ratio = this.#pixelRatio();
    const size = `${width}x${height}@${ratio}`;
    const count = this.#realtime.frameCount();
    if (count === this.#drawnFrame && size === this.#drawnSize && !this.#dirty) return;
    this.#drawnFrame = count;
    this.#drawnSize = size;
    this.#dirty = false;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let lit = 0;
    for (const { slot, rect } of this.#entries) {
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.y + rect.height < 0 || rect.y > height) continue;
      const reading = this.#realtime.meter(slot.ref);
      const level = reading ? Math.max(0, ...reading.peak) : 0;
      const bar = Math.round(rect.width * meterFraction(level));
      if (bar <= 0) continue;
      lit += 1;
      // One gradient per --header-meter-scale-w, from the well's left edge.
      for (let x = rect.x; x < rect.x + bar; x += SCALE_PX) {
        const gradient = ctx.createLinearGradient(x, 0, x + SCALE_PX, 0);
        for (const [offset, colour] of STOPS) gradient.addColorStop(offset, colour);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, rect.y, Math.min(SCALE_PX, rect.x + bar - x), rect.height);
      }
    }
    // For the e2e: how many meter frames were drawn, and how many bars read above silence.
    if (canvas.dataset) {
      canvas.dataset.frames = String(count);
      canvas.dataset.lit = String(lit);
    }
  }
}
