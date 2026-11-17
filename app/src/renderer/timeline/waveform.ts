// A clip's waveform as the event display draws it (m5-ui-port-arrange-canvas;
// UI redesign 5.2 and 10.9): real peaks, in the two tones of the mockup's
// draw(). One column per device pixel, from the pyramid level whose bins are
// the widest that still fit a device pixel (model/peaks.ts chooseLevel). A
// column's amplitude is the largest |min| or |max| of every channel over the
// media frames it covers; the outer layer reaches max(.5, a * half) above and
// below the middle, the inner one max(.5, a * half * .52), so silence is half
// a pixel high, never nothing. Framework-free and DOM-free.

import { chooseLevel, columnRange, type PeakPyramid } from '../model/peaks';

// The inner layer's height against the outer's (draw(): a * half * .52).
export const INNER_RATIO = 0.52;
// The least half-height of a column (draw(): Math.max(.5, ...)).
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

export interface WaveColumn {
  // CSS x and width (1 / ratio).
  readonly x: number;
  readonly w: number;
  // The amplitude, 0 to 1, and the half-heights of the two layers.
  readonly amplitude: number;
  readonly outer: number;
  readonly inner: number;
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
    let peak = -1;
    for (let channel = 0; channel < pyramid.channels; channel += 1) {
      const range = columnRange(pyramid, level, channel, start, stop);
      if (range) peak = Math.max(peak, Math.abs(range.min), Math.abs(range.max));
    }
    if (peak < 0) continue;
    const a = Math.min(1, peak / FULL_SCALE);
    columns.push({ x: cx, w, amplitude: a, outer: Math.max(MIN_HALF_HEIGHT, a * half), inner: Math.max(MIN_HALF_HEIGHT, a * half * INNER_RATIO) });
  }
  return { level, columns };
}
