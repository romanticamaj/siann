// The ruler's marks (UI redesign spec 3.2, "Ruler"): bars and beats through
// root.tempo, with the subdivision chosen by the zoom so labels stay at least
// RULER_MIN_LABEL_PX apart: several bars per label far out, every bar, every
// beat, then eighths, sixteenths and thirty-seconds. A bar's label is its
// number, a beat's bar.beat, a finer step's bar.beat.tick; the same text in
// every locale. Framework-free.

import type { TempoPoint } from '../model/document';
import type { Viewport } from './geometry';
import { TICKS_PER_BAR, TICKS_PER_QUARTER, framesToTicks, tempoSegments, ticksToFrames } from './musical-time';

export const RULER_MIN_LABEL_PX = 64;

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
// `pxPerTick`; the coarsest when none is.
export function chooseRulerStep(pxPerTick: number): RulerStep {
  return STEPS.find((step) => step.ticks * pxPerTick >= RULER_MIN_LABEL_PX) ?? STEPS[STEPS.length - 1]!;
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

// The marks across the view, left to right, from the first one at or right of x = 0.
export function rulerMarks(view: Viewport, tempo: readonly TempoPoint[], sampleRate: number): RulerMark[] {
  // The fastest tempo in the map spaces ticks the closest: labels never collide.
  const fastest = Math.min(...tempoSegments(tempo, sampleRate).map((s) => s.framesPerTick));
  const step = chooseRulerStep(fastest / view.framesPerPixel);
  const scroll = Number(view.scrollFrames);
  const startTick = Math.max(0, framesToTicks(scroll, tempo, sampleRate));
  const marks: RulerMark[] = [];
  for (let ticks = Math.ceil(startTick / step.ticks) * step.ticks; marks.length < 2000; ticks += step.ticks) {
    const x = (ticksToFrames(ticks, tempo, sampleRate) - scroll) / view.framesPerPixel;
    if (x >= view.width) break;
    if (x < 0) continue;
    marks.push({ x, ticks, ...labelOf(ticks) });
  }
  return marks;
}
