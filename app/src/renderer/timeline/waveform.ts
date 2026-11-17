// A clip's waveform as the event display draws it (m5-ui-port-arrange-canvas;
// UI redesign 5.2 and 10.9): real peaks, in the two tones of the mockup's
// draw(). One min/max column per device pixel, from the pyramid level whose
// bins are the widest that still fit a device pixel (model/peaks.ts
// chooseLevel). A column's range is the lowest min and the highest max of
// every channel over the media frames it covers; the outer layer fills
// between them (max above the middle, min below, scaled by half), the inner
// one fills the same range at .52 of it (draw()'s a * half * .52). An
// asymmetric signal (one-sided transients, a DC offset) is drawn asymmetric:
// its polarity stays. A layer is never less than one pixel high (draw():
// Math.max(.5, ...) above and below), so silence is a 1 px line, never
// nothing. Framework-free and DOM-free.

import { chooseLevel, columnRange, type PeakPyramid } from '../model/peaks';

// The inner layer's height against the outer's (draw(): a * half * .52).
export const INNER_RATIO = 0.52;
// The least half-height of a layer (draw(): Math.max(.5, ...)).
export const MIN_HALF_HEIGHT = 0.5;
const FULL_SCALE = 32767;

export interface WaveformRequest {
  // The media frame at the clip's position, and the frames the clip shows.
  readonly sourceStart: number;
  readonly length: number;
  readonly framesPerPixel: number;
  // The device pixel ratio.
  readonly ratio: number;
  // The CSS x of the clip's position (where sourceStart is drawn).
  readonly x: number;
  // What may be drawn: the clip's box within the view.
  readonly clipLeft: number;
  readonly clipRight: number;
  // The waveform's middle and its half-height (draw(): mid, half).
  readonly mid: number;
  readonly half: number;
}

// One layer of a column: it fills from mid - up to mid + down (CSS px; up is
// the max's reach above the middle, down the min's below it, either negative
// when the whole range lies on the other side).
export interface WaveSpan {
  readonly up: number;
  readonly down: number;
}

export interface WaveColumn {
  // CSS x and width (1 / ratio).
  readonly x: number;
  readonly w: number;
  // The largest |min| or |max|, 0 to 1 (0: silence).
  readonly amplitude: number;
  // The layers, and their half-heights ((up + down) / 2).
  readonly outerSpan: WaveSpan;
  readonly innerSpan: WaveSpan;
  readonly outer: number;
  readonly inner: number;
}

// The range [lo, hi] (fractions of full scale) at `scale` px, at least 1 px high.
function span(lo: number, hi: number, scale: number): WaveSpan {
  let up = hi * scale;
  let down = -lo * scale;
  if (up + down < 2 * MIN_HALF_HEIGHT) {
    const centre = (up - down) / 2;
    up = centre + MIN_HALF_HEIGHT;
    down = MIN_HALF_HEIGHT - centre;
  }
  return { up, down };
}

export function waveformColumns(pyramid: PeakPyramid, request: WaveformRequest): { level: number; columns: WaveColumn[] } {
  const { sourceStart, length, framesPerPixel: fpp, ratio, x, half } = request;
  const level = chooseLevel(pyramid, ratio / fpp);
  const columns: WaveColumn[] = [];
  const w = 1 / ratio;
  const end = sourceStart + length;
  const first = Math.floor(Math.max(x, request.clipLeft) * ratio);
  const last = Math.ceil(Math.min(x + length / fpp, request.clipRight) * ratio);
  for (let device = first; device < last; device += 1) {
    const cx = device / ratio;
    const start = Math.max(sourceStart, sourceStart + (cx - x) * fpp);
    const stop = Math.min(end, sourceStart + (cx + w - x) * fpp);
    if (stop <= start) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let channel = 0; channel < pyramid.channels; channel += 1) {
      const range = columnRange(pyramid, level, channel, start, stop);
      if (!range) continue;
      lo = Math.min(lo, range.min);
      hi = Math.max(hi, range.max);
    }
    if (lo > hi) continue;
    const clamp = (v: number) => Math.min(1, Math.max(-1, v / FULL_SCALE));
    const min = clamp(lo);
    const max = clamp(hi);
    const outerSpan = span(min, max, half);
    const innerSpan = span(min, max, half * INNER_RATIO);
    columns.push({
      x: cx,
      w,
      amplitude: Math.max(Math.abs(min), Math.abs(max)),
      outerSpan,
      innerSpan,
      outer: (outerSpan.up + outerSpan.down) / 2,
      inner: (innerSpan.up + innerSpan.down) / 2,
    });
  }
  return { level, columns };
}
