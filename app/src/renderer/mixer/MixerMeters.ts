// The MixConsole's meters (UI redesign spec 5.1, 5.3): one Canvas2D over the
// strips (pointer-events off; it paints only inside the meter channels), one
// requestAnimationFrame callback that takes the newest frame into the
// MeterStore, applies the ballistics with the frame's time delta and draws
// every channel, tracks and master, in one pass. The strips' peak values are
// written here with textContent; no meter value passes through React
// (ADR-0019 point 3).
//
// The loop runs while the transport plays or a meter is still decaying, and
// stops otherwise; a realtime frame (onFrame) wakes it only when it has
// something to show. It never runs while the document is hidden. Slots are
// measured when one is added or removed and when the owner reports a resize
// (ResizeObserver in Mixer.tsx), not every frame.
//
// What it draws is the mockup's strip() meter (m5-ui-port-mixer-strip; spec
// 1.2: the mockup's parameters win): each strip has two channel wells (.ch,
// drawn by ui/lower-zone.css), and in each the bar is one gradient over
// --meter-scale-h from the channel's bottom (--meter-low, --play at 55 %,
// --meter-mid at 78 %, --err at 96 %) as tall as the level on the fader's
// taper, with a --hairline-1h --tx-0 hold line whose bottom edge is the hold
// level. The latched clip is a --space-3q band in --err at the top of both
// channels. Every colour and size is a token of tokens.ts.
//
// The master's loudness (m5b-ui-meter; spec 5.3): the surface writes the
// loudness texts registered with it (the master strip's LUFS-S, the Meter
// tab's momentary, short-term and integrated) from the LoudnessStore in the
// same frame callback, with formatLufs. A loudness frame wakes a stopped loop
// only when a text would change. The Meter tab runs a second MixerMeters over
// the same MeterStore: the store advances its ballistics once per animation
// frame (the frame's timestamp), whichever surface draws first.

import { formatLufs, formatPeakDb } from '../format';
import type { LoudnessField, LoudnessReadings } from '../model/loudness-store';
import type { MeterStore } from '../model/meter-store';
import { armedMeterRef } from '../model/record';
import { TOKENS } from '../tokens';
import { FLOOR_DB } from './peak-hold';
import { milliDbToPosition } from './taper';
import { frameMarks } from '../perf/frame-marks';

export interface AnimationFrames {
  // The callback gets the frame's timestamp (the same for every callback of a frame).
  request(callback: (time?: number) => void): number;
  cancel(handle: number): void;
}

export interface GradientLike {
  addColorStop(offset: number, colour: string): void;
}

export interface Context2DLike {
  // A colour or a gradient this context made.
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
  // 0 left, 1 right.
  readonly channel: number;
  // The channel's inside (within its well's border) in canvas CSS pixels, or
  // null when it is not laid out.
  measure(): SlotRect | null;
}

export interface MixerMetersOptions {
  readonly canvas?: CanvasLike | null;
  readonly store: MeterStore;
  // The master's loudness (m5b-ui-meter), for the loudness texts.
  readonly loudness?: LoudnessReadings | null;
  readonly frames?: AnimationFrames;
  // Milliseconds, monotonic.
  readonly clock?: () => number;
  readonly hidden?: () => boolean;
  readonly pixelRatio?: () => number;
  // The canvas's CSS size.
  readonly size?: () => { width: number; height: number };
  // The armed tracks' ids (m5b-ui-recording): their strips read their input
  // meter, input:<trackId>, while the legend has it.
  readonly armed?: () => readonly string[];
}

export interface MeterTestHooks {
  read(ref: string): { peak: number; hold: number; clip: boolean } | null;
  // Draw callbacks run so far.
  frames(): number;
  // The meters.legend epoch the store follows.
  epoch(): string | null;
  readonly canvases: number;
}

const browserFrames: AnimationFrames = {
  request: (callback) => requestAnimationFrame((time) => callback(time)),
  cancel: (handle) => cancelAnimationFrame(handle),
};

const size = (name: keyof typeof TOKENS) => parseFloat(TOKENS[name]);
// The mockup's .meter .ch i: linear-gradient(0deg, ...) over --meter-scale-h from the bottom.
const STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, TOKENS['meter-low']],
  [0.55, TOKENS.play],
  [0.78, TOKENS['meter-mid']],
  [0.96, TOKENS.err],
];
const SCALE_PX = size('meter-scale-h');
const HOLD_PX = size('hairline-1h');
const CLIP_PX = size('space-3q');
// A frame delta longer than this (a stall) counts as this.
const MAX_DT_SECONDS = 0.25;

function fraction(db: number): number {
  if (!(db > FLOOR_DB)) return 0;
  return milliDbToPosition(Math.round(db * 1000));
}

interface Entry {
  readonly slot: MeterSlot;
  rect: SlotRect | null;
  // The bar's gradient for this rect, made when it is measured.
  gradient: GradientLike | null;
}

interface Peak {
  readonly ref: string;
  readonly target: PeakText;
  shown: string;
  clipShown: boolean;
}

interface Loudness {
  readonly field: LoudnessField;
  readonly target: PeakText;
  shown: string | null;
}

export class MixerMeters {
  readonly #store: MeterStore;
  readonly #loudness: LoudnessReadings | null;
  readonly #frames: AnimationFrames;
  readonly #clock: () => number;
  readonly #hidden: () => boolean;
  readonly #pixelRatio: () => number;
  readonly #size: () => { width: number; height: number };
  readonly #armed: () => readonly string[];
  #canvas: CanvasLike | null;
  readonly #entries = new Set<Entry>();
  readonly #peaks = new Set<Peak>();
  readonly #loudnessTexts = new Set<Loudness>();
  #handle: number | null = null;
  #last: number | null = null;
  #dirty = true;
  #drawn = 0;
  #destroyed = false;

  constructor(options: MixerMetersOptions) {
    this.#store = options.store;
    this.#loudness = options.loudness ?? null;
    this.#canvas = options.canvas ?? null;
    this.#frames = options.frames ?? browserFrames;
    this.#clock = options.clock ?? (() => performance.now());
    this.#hidden = options.hidden ?? (() => document.hidden);
    this.#pixelRatio = options.pixelRatio ?? (() => window.devicePixelRatio || 1);
    this.#size = options.size ?? (() => ({ width: 0, height: 0 }));
    this.#armed = options.armed ?? (() => []);
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

  // A meter channel to paint while mounted.
  addSlot(slot: MeterSlot): () => void {
    const entry: Entry = { slot, rect: null, gradient: null };
    this.#entries.add(entry);
    this.#dirty = true;
    this.wake();
    return () => {
      this.#entries.delete(entry);
      this.#dirty = true;
      this.wake();
    };
  }

  // A peak value to write while mounted (its text and its clip class).
  addPeak(ref: string, target: PeakText): () => void {
    const peak: Peak = { ref, target, shown: '', clipShown: false };
    this.#peaks.add(peak);
    this.#writePeak(peak);
    this.wake();
    return () => {
      this.#peaks.delete(peak);
    };
  }

  // A loudness text to write while mounted (m5b-ui-meter).
  addLoudness(field: LoudnessField, target: PeakText): () => void {
    const entry: Loudness = { field, target, shown: null };
    this.#loudnessTexts.add(entry);
    this.#writeLoudness(entry);
    return () => {
      this.#loudnessTexts.delete(entry);
    };
  }

  // A loudness frame arrived (or the loudness was cleared): draw when a text would change.
  onLoudness(): void {
    if (this.#destroyed || this.#handle !== null || this.#hidden()) return;
    for (const entry of this.#loudnessTexts) {
      if (this.#loudnessText(entry.field) !== entry.shown) {
        this.#request();
        return;
      }
    }
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
    const context = canvas?.getContext('2d') ?? null;
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
    for (const entry of this.#entries) {
      entry.rect = entry.slot.measure();
      entry.gradient = null;
      if (context && entry.rect) {
        const { x, y, height } = entry.rect;
        const bottom = y + height;
        const gradient = context.createLinearGradient(x, bottom, x, bottom - SCALE_PX);
        for (const [offset, colour] of STOPS) gradient.addColorStop(offset, colour);
        entry.gradient = gradient;
      }
    }
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

  // Clears a meter's hold lines, peak value and clip (a click on the peak value).
  reset(ref: string): void {
    this.#store.reset(ref);
    for (const peak of this.#peaks) if (peak.ref === ref) peak.shown = '';
    this.wake();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#handle !== null) this.#frames.cancel(this.#handle);
    this.#handle = null;
    this.#entries.clear();
    this.#peaks.clear();
    this.#loudnessTexts.clear();
  }

  testHooks(): MeterTestHooks {
    return {
      read: (ref) => {
        const reading = this.#store.read(ref);
        return reading ? { peak: reading.peak, hold: reading.hold, clip: reading.clip } : null;
      },
      frames: () => this.#drawn,
      epoch: () => this.#store.epoch,
      canvases: 1,
    };
  }

  #request(): void {
    this.#handle = this.#frames.request((time) => this.#frame(time));
  }

  #frame(time?: number): void {
    this.#handle = null;
    if (this.#destroyed) return;
    const now = this.#clock();
    const dt = this.#last === null ? 0 : Math.min(MAX_DT_SECONDS, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    const store = this.#store;
    store.sync();
    store.advance(dt, time);
    // The perf scenario's frame marks (perf/frame-marks.ts; a no-op outside the test hook).
    frameMarks().begin();
    if (this.#dirty) this.measure();
    this.#draw();
    frameMarks().end();
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
      for (const entry of this.#entries) if (entry.rect) this.#drawChannel(context, entry, entry.rect);
    }
    for (const peak of this.#peaks) this.#writePeak(peak);
    for (const entry of this.#loudnessTexts) this.#writeLoudness(entry);
  }

  #loudnessText(field: LoudnessField): string {
    return formatLufs(this.#loudness ? this.#loudness.read(field) : -Infinity);
  }

  #writeLoudness(entry: Loudness): void {
    const text = this.#loudnessText(entry.field);
    if (text === entry.shown) return;
    entry.shown = text;
    entry.target.textContent = text;
  }

  #ref(ref: string): string {
    return armedMeterRef(ref, this.#armed(), (r) => this.#store.indexOf(r) >= 0);
  }

  #drawChannel(context: Context2DLike, entry: Entry, rect: SlotRect): void {
    const store = this.#store;
    const index = store.indexOf(this.#ref(entry.slot.ref));
    if (index < 0) return;
    const at = 2 * index + (entry.slot.channel === 1 ? 1 : 0);
    const bottom = rect.y + rect.height;
    const level = fraction(store.channelLevel[at]!) * rect.height;
    if (level > 0 && entry.gradient) {
      context.fillStyle = entry.gradient;
      context.fillRect(rect.x, bottom - level, rect.width, level);
    }
    const hold = fraction(store.channelHold[at]!);
    if (hold > 0) {
      context.fillStyle = TOKENS['tx-0'];
      context.fillRect(rect.x, Math.max(rect.y, bottom - hold * rect.height - HOLD_PX), rect.width, HOLD_PX);
    }
    if (store.clip[index] === 1) {
      context.fillStyle = TOKENS.err;
      context.fillRect(rect.x, rect.y, rect.width, CLIP_PX);
    }
  }

  #writePeak(peak: Peak): void {
    const index = this.#store.indexOf(this.#ref(peak.ref));
    const text = formatPeakDb(index < 0 ? 0 : this.#store.max[index]!);
    if (text !== peak.shown) {
      peak.shown = text;
      peak.target.textContent = text;
    }
    const clip = index >= 0 && this.#store.clip[index] === 1;
    if (clip !== peak.clipShown) {
      peak.clipShown = clip;
      peak.target.classList?.toggle('clip', clip);
    }
  }
}
