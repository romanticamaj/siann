// The ruler's marks (UI redesign spec 3.2, "Ruler"): bars and beats through
// root.tempo, with the subdivision chosen by the zoom so labels stay at least
// RULER_MIN_LABEL_PX apart (bar numbers RULER_BAR_LABEL_PX): several bars per
// label far out, every bar, every beat, then eighths, sixteenths and
// thirty-seconds. A bar's label is its
// number, a beat's bar.beat, a finer step's bar.beat.tick; the same text in
// every locale. Framework-free.

import type { TempoPoint } from '../model/document';
import type { Viewport } from './geometry';
import { TICKS_PER_BAR, TICKS_PER_QUARTER, framesToTicks, tempoSegments, ticksToFrames } from './musical-time';

export const RULER_MIN_LABEL_PX = 64;
// Bar numbers are short: the mockup's draw() labels every bar at its 40 px
// per bar (PXB), so a bar number needs only that much room.
export const RULER_BAR_LABEL_PX = 40;

export type MarkKind = 'bar' | 'beat' | 'sub';

export interface RulerStep {
  readonly ticks: number;
  readonly kind: MarkKind;
}

export interface RulerMark {
  readonly x: number;
  readonly ticks: number;
  readonly kind: MarkKind;
  readonly label: string;
}

const STEPS: readonly RulerStep[] = [
  { ticks: TICKS_PER_QUARTER / 8, kind: 'sub' },
  { ticks: TICKS_PER_QUARTER / 4, kind: 'sub' },
  { ticks: TICKS_PER_QUARTER / 2, kind: 'sub' },
  { ticks: TICKS_PER_QUARTER, kind: 'beat' },
  ...[1, 2, 4, 8, 16, 32, 64].map((bars) => ({ ticks: TICKS_PER_BAR * bars, kind: 'bar' as const })),
];

// The finest step whose labels are at least RULER_MIN_LABEL_PX apart at
// `pxPerTick` (RULER_BAR_LABEL_PX for bar numbers); the coarsest when none is.
export function chooseRulerStep(pxPerTick: number): RulerStep {
  return STEPS.find((step) => step.ticks * pxPerTick >= (step.kind === 'bar' ? RULER_BAR_LABEL_PX : RULER_MIN_LABEL_PX)) ?? STEPS[STEPS.length - 1]!;
}

function labelOf(ticks: number): { kind: MarkKind; label: string } {
  const bar = Math.floor(ticks / TICKS_PER_BAR) + 1;
  const inBar = ticks % TICKS_PER_BAR;
  if (inBar === 0) return { kind: 'bar', label: String(bar) };
  const beat = Math.floor(inBar / TICKS_PER_QUARTER) + 1;
  const tick = inBar % TICKS_PER_QUARTER;
  if (tick === 0) return { kind: 'beat', label: `${bar}.${beat}` };
  return { kind: 'sub', label: `${bar}.${beat}.${String(tick).padStart(3, '0')}` };
}

// The fastest tempo in the map spaces ticks the closest: px per tick there.
function closestPxPerTick(view: Viewport, tempo: readonly TempoPoint[], sampleRate: number): number {
  return Math.min(...tempoSegments(tempo, sampleRate).map((s) => s.framesPerTick)) / view.framesPerPixel;
}

// Every `step` ticks across the view, from the first one at or right of x = 0.
function marksEvery(view: Viewport, tempo: readonly TempoPoint[], sampleRate: number, step: number): RulerMark[] {
  const scroll = Number(view.scrollFrames);
  const startTick = Math.max(0, framesToTicks(scroll, tempo, sampleRate));
  const marks: RulerMark[] = [];
  for (let ticks = Math.ceil(startTick / step) * step; marks.length < 2000; ticks += step) {
    const x = (ticksToFrames(ticks, tempo, sampleRate) - scroll) / view.framesPerPixel;
    if (x >= view.width) break;
    if (x < 0) continue;
    marks.push({ x, ticks, ...labelOf(ticks) });
  }
  return marks;
}

// The marks across the view, left to right, from the first one at or right of x = 0.
export function rulerMarks(view: Viewport, tempo: readonly TempoPoint[], sampleRate: number): RulerMark[] {
  // Labels never collide, at the fastest tempo of the map.
  return marksEvery(view, tempo, sampleRate, chooseRulerStep(closestPxPerTick(view, tempo, sampleRate)).ticks);
}

// The grid of the event display (m5-ui-port-arrange-canvas, the mockup's
// draw()): its bar lines and beat lines under the lanes, and the ticks of the
// ruler's lower half. Every beat while beats are at least GRID_MIN_PX apart,
// else every bar while bars are, else the labels' step.
export const GRID_MIN_PX = 4;

export function gridMarks(view: Viewport, tempo: readonly TempoPoint[], sampleRate: number): RulerMark[] {
  const pxPerTick = closestPxPerTick(view, tempo, sampleRate);
  const step =
    TICKS_PER_QUARTER * pxPerTick >= GRID_MIN_PX ? TICKS_PER_QUARTER : TICKS_PER_BAR * pxPerTick >= GRID_MIN_PX ? TICKS_PER_BAR : chooseRulerStep(pxPerTick).ticks;
  return marksEvery(view, tempo, sampleRate, step);
}

// The bar a mark is in, 1-based.
export function barOf(mark: Pick<RulerMark, 'ticks'>): number {
  return Math.floor(mark.ticks / TICKS_PER_BAR) + 1;
}
