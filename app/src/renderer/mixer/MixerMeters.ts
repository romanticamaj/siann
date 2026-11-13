// The MixConsole's meters (UI redesign spec 5.1, 5.3): one Canvas2D over the
// strips (pointer-events off; it paints only inside the meter slots), one
// requestAnimationFrame callback that takes the newest frame into the
// MeterStore, applies the ballistics with the frame's time delta and draws
// every slot, tracks and master, in one pass. The strips' peak values are
// written here with textContent; no meter value passes through React
// (ADR-0019 point 3).
//
// The loop runs while the transport plays or a meter is still decaying, and
// stops otherwise; a realtime frame (onFrame) wakes it only when it has
// something to show. It never runs while the document is hidden. Slots are
// measured when one is added or removed and when the owner reports a resize
// (ResizeObserver in Mixer.tsx), not every frame.
//
// Colours by threshold (spec 1.2): green to -12 dB, yellow to -3 dB, red
// above, a white 1.5 px hold line and a latching clip indicator. The bars use
// the fader's taper, so a meter and its fader read alike.

import { formatPeakDb } from '../format';
import type { MeterStore } from '../model/meter-store';
import { FLOOR_DB } from './peak-hold';
import { milliDbToPosition } from './taper';

export interface AnimationFrames {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface Context2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): Context2DLike | null;
  style?: { width: string; height: string };
}

export interface SlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PeakText {
  textContent: string | null;
  classList?: { toggle(name: string, force?: boolean): boolean };
}

export interface MeterSlot {
  // "master" or "track:<id>".
  readonly ref: string;
  // The slot in canvas CSS pixels, or null when it is not laid out.
  measure(): SlotRect | null;
  readonly peakText?: PeakText | null;
}

export interface MeterPalette {
  readonly well: string;
  readonly green: string;
  readonly yellow: string;
  readonly red: string;
  readonly hold: string;
  readonly clip: string;
}

export interface MixerMetersOptions {
  readonly canvas?: CanvasLike | null;
  readonly store: MeterStore;
  readonly frames?: AnimationFrames;
  // Milliseconds, monotonic.
  readonly clock?: () => number;
  readonly hidden?: () => boolean;
  readonly palette?: MeterPalette;
  readonly pixelRatio?: () => number;
  // The canvas's CSS size.
  readonly size?: () => { width: number; height: number };
}

export interface MeterTestHooks {
  read(ref: string): { peak: number; hold: number; clip: boolean } | null;
  // Draw callbacks run so far.
  frames(): number;
  readonly canvases: number;
}

const browserFrames: AnimationFrames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export const DEFAULT_PALETTE: MeterPalette = {
  well: '#090A0D',
  green: '#3DDC84',
  yellow: '#FFD23F',
  red: '#FF4D57',
  hold: '#FFFFFF',
  clip: '#FF4D57',
};

// The bars' thresholds on the taper (spec 1.2).
const GREEN_TOP = milliDbToPosition(-12_000);
const YELLOW_TOP = milliDbToPosition(-3_000);
const HOLD_PX = 1.5;
const CLIP_PX = 3;
// A frame delta longer than this (a stall) counts as this.
const MAX_DT_SECONDS = 0.25;

function fraction(db: number): number {
  if (!(db > FLOOR_DB)) return 0;
  return milliDbToPosition(Math.round(db * 1000));
}

interface Entry {
  readonly slot: MeterSlot;
  rect: SlotRect | null;
  shown: string;
  clipShown: boolean;
}

export class MixerMeters {
  readonly #store: MeterStore;
  readonly #frames: AnimationFrames;
  readonly #clock: () => number;
  readonly #hidden: () => boolean;
  #palette: MeterPalette;
  readonly #pixelRatio: () => number;
  readonly #size: () => { width: number; height: number };
  #canvas: CanvasLike | null;
  readonly #entries = new Set<Entry>();
  #handle: number | null = null;
  #last: number | null = null;
  #dirty = true;
  #drawn = 0;
  #destroyed = false;

  constructor(options: MixerMetersOptions) {
    this.#store = options.store;
    this.#canvas = options.canvas ?? null;
    this.#frames = options.frames ?? browserFrames;
    this.#clock = options.clock ?? (() => performance.now());
    this.#hidden = options.hidden ?? (() => document.hidden);
    this.#palette = options.palette ?? DEFAULT_PALETTE;
    this.#pixelRatio = options.pixelRatio ?? (() => window.devicePixelRatio || 1);
    this.#size = options.size ?? (() => ({ width: 0, height: 0 }));
  }

  get running(): boolean {
    return this.#handle !== null;
  }

  // Draws on `canvas` from now on; null stops the loop until the next attach.
  attach(canvas: CanvasLike | null): void {
    this.#canvas = canvas;
    this.#dirty = true;
    if (canvas) {
      this.wake();
    } else if (this.#handle !== null) {
      this.#frames.cancel(this.#handle);
      this.#handle = null;
      this.#last = null;
    }
  }

  // The colours, read from the design tokens by the owner.
  setPalette(palette: MeterPalette): void {
    this.#palette = palette;
    this.wake();
  }

  addSlot(slot: MeterSlot): () => void {
    const entry: Entry = { slot, rect: null, shown: '', clipShown: false };
    this.#entries.add(entry);
    this.#writePeak(entry);
    this.#dirty = true;
    this.wake();
    return () => {
      this.#entries.delete(entry);
      this.#dirty = true;
      this.wake();
    };
  }

  // The layout changed (a resize, a strip added or removed): re-measure on the
  // next frame, which this asks for.
  invalidate(): void {
    this.#dirty = true;
    this.wake();
  }

  // Re-measures the canvas and every slot now.
  measure(): void {
    this.#dirty = false;
    const canvas = this.#canvas;
    if (canvas) {
      const { width, height } = this.#size();
      const ratio = this.#pixelRatio();
      const w = Math.max(0, Math.round(width * ratio));
      const h = Math.max(0, Math.round(height * ratio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      if (canvas.style) {
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    }
    for (const entry of this.#entries) entry.rect = entry.slot.measure();
  }

  // A realtime frame arrived: run the loop when there is something to show.
  onFrame(): void {
    if (this.#destroyed || this.#handle !== null || this.#hidden()) return;
    this.#store.sync();
    if (this.#store.playing() || !this.#store.decayed()) this.#request();
  }

  // Draws once more (a slot changed, a reset, the window became visible).
  wake(): void {
    if (this.#destroyed || this.#handle !== null || this.#hidden()) return;
    this.#request();
  }

  // Clears a meter's hold line, peak value and clip (a click on the peak value).
  reset(ref: string): void {
    this.#store.reset(ref);
    for (const entry of this.#entries) if (entry.slot.ref === ref) entry.shown = '';
    this.wake();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#handle !== null) this.#frames.cancel(this.#handle);
    this.#handle = null;
    this.#entries.clear();
  }

  testHooks(): MeterTestHooks {
    return {
      read: (ref) => {
        const reading = this.#store.read(ref);
        return reading ? { peak: reading.peak, hold: reading.hold, clip: reading.clip } : null;
      },
      frames: () => this.#drawn,
      canvases: 1,
    };
  }

  #request(): void {
    this.#handle = this.#frames.request(() => this.#frame());
  }

  #frame(): void {
    this.#handle = null;
    if (this.#destroyed) return;
    const now = this.#clock();
    const dt = this.#last === null ? 0 : Math.min(MAX_DT_SECONDS, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    const store = this.#store;
    store.sync();
    store.advance(dt);
    if (this.#dirty) this.measure();
    this.#draw();
    this.#drawn += 1;
    if (!this.#hidden() && (store.playing() || !store.decayed())) this.#request();
    else this.#last = null;
  }

  #draw(): void {
    const context = this.#canvas?.getContext('2d') ?? null;
    if (context) {
      const ratio = this.#pixelRatio();
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const { width, height } = this.#size();
      context.clearRect(0, 0, width, height);
    }
    for (const entry of this.#entries) {
      if (context && entry.rect) this.#drawSlot(context, entry.slot.ref, entry.rect);
      this.#writePeak(entry);
    }
  }

  #drawSlot(context: Context2DLike, ref: string, rect: SlotRect): void {
    const palette = this.#palette;
    context.fillStyle = palette.well;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    const index = this.#store.indexOf(ref);
    if (index < 0) return;
    const bottom = rect.y + rect.height;
    const level = fraction(this.#store.level[index]!);
    const segment = (from: number, to: number, style: string) => {
      if (to <= from) return;
      context.fillStyle = style;
      context.fillRect(rect.x, bottom - to * rect.height, rect.width, (to - from) * rect.height);
    };
    segment(0, Math.min(level, GREEN_TOP), palette.green);
    segment(GREEN_TOP, Math.min(level, YELLOW_TOP), palette.yellow);
    segment(YELLOW_TOP, level, palette.red);
    const hold = fraction(this.#store.hold[index]!);
    if (hold > 0) {
      context.fillStyle = palette.hold;
      context.fillRect(rect.x, Math.max(rect.y, bottom - hold * rect.height), rect.width, HOLD_PX);
    }
    if (this.#store.clip[index] === 1) {
      context.fillStyle = palette.clip;
      context.fillRect(rect.x, rect.y, rect.width, CLIP_PX);
    }
  }

  #writePeak(entry: Entry): void {
    const target = entry.slot.peakText;
    if (!target) return;
    const index = this.#store.indexOf(entry.slot.ref);
    const text = formatPeakDb(index < 0 ? 0 : this.#store.max[index]!);
    if (text !== entry.shown) {
      entry.shown = text;
      target.textContent = text;
    }
    const clip = index >= 0 && this.#store.clip[index] === 1;
    if (clip !== entry.clipShown) {
      entry.clipShown = clip;
      target.classList?.toggle('clip', clip);
    }
  }
}
