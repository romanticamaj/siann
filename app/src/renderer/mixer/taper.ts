// The gain fader's audio taper (UX pass, A5): fader travel 0..1 (bottom to
// top) to milli-dB and back. Minus infinity sits at the bottom, 0 dB at three
// quarters of the travel and the fader maximum (+12 dB, unchanged) at the top;
// the dB per pixel shrinks toward 0 dB, as on a console. Between the
// breakpoints the mapping is linear in dB. Values the fader yields are whole
// tenths of a dB. Framework-free and DOM-free.

import { MINUS_INFINITY_MILLI_DB } from '../format';

export const FADER_MAX_MILLI_DB = 12_000;
// The lowest finite gain on the fader's travel (just above the bottom).
export const FADER_FLOOR_MILLI_DB = -144_000;
export const UNITY_POSITION = 0.75;

// [position, dB], ascending. Position 0 itself is minus infinity.
const BREAKPOINTS: ReadonlyArray<readonly [number, number]> = [
  [0, -144],
  [0.05, -60],
  [0.15, -40],
  [0.3, -24],
  [0.45, -12],
  [0.6, -6],
  [UNITY_POSITION, 0],
  [1, FADER_MAX_MILLI_DB / 1000],
];

// The labelled ticks beside the fader.
export const FADER_TICKS: ReadonlyArray<{ readonly db: number | null; readonly label: string }> = [
  { db: 12, label: '+12' },
  { db: 6, label: '+6' },
  { db: 0, label: '0' },
  { db: -6, label: '-6' },
  { db: -12, label: '-12' },
  { db: -24, label: '-24' },
  { db: -40, label: '-40' },
  { db: -60, label: '-60' },
  { db: null, label: '-inf' },
];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// The fader position of a gain (minus infinity and anything at or below the
// floor at 0, anything above the maximum at 1).
export function gainToPosition(milliDb: number): number {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return 0;
  const db = milliDb / 1000;
  if (db <= BREAKPOINTS[0]![1]) return 0;
  for (let i = 1; i < BREAKPOINTS.length; i += 1) {
    const [p1, d1] = BREAKPOINTS[i]!;
    if (db <= d1) {
      const [p0, d0] = BREAKPOINTS[i - 1]!;
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 1;
}

// The gain at a fader position, in whole tenths of a dB; minus infinity at
// the bottom.
export function positionToGain(position: number): number {
  const p = clamp01(position);
  if (p <= 0) return MINUS_INFINITY_MILLI_DB;
  for (let i = 1; i < BREAKPOINTS.length; i += 1) {
    const [p1, d1] = BREAKPOINTS[i]!;
    if (p <= p1) {
      const [p0, d0] = BREAKPOINTS[i - 1]!;
      const db = d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
      return Math.round(db * 10) * 100;
    }
  }
  return FADER_MAX_MILLI_DB;
}

// The gain a vertical drag lands on: from the gain at the drag's start, dy
// pixels down (positive) or up (negative) over a track of `travelPx` pixels,
// ten times finer with `fine` (Shift). A position within `detentPx` of 0 dB
// holds at exactly 0 dB (the unity detent).
export function dragGain(startMilliDb: number, dy: number, travelPx: number, fine = false, detentPx = 3): number {
  const travel = Math.max(1, travelPx);
  const scale = fine ? 0.1 : 1;
  const position = clamp01(gainToPosition(startMilliDb) - (dy * scale) / travel);
  if (Math.abs(position - UNITY_POSITION) * travel <= detentPx * scale) return 0;
  return positionToGain(position);
}

// One keyboard step from a gain: up or down 0.5 dB (0.1 dB fine); from minus
// infinity up lands on the lowest labelled tick, down to it from there.
export function stepGain(milliDb: number, direction: 1 | -1, fine = false): number {
  const step = fine ? 100 : 500;
  if (milliDb === MINUS_INFINITY_MILLI_DB) return direction > 0 ? -60_000 : MINUS_INFINITY_MILLI_DB;
  const next = Math.round((milliDb + direction * step) / 100) * 100;
  if (next < FADER_FLOOR_MILLI_DB) return MINUS_INFINITY_MILLI_DB;
  if (next > FADER_MAX_MILLI_DB && milliDb <= FADER_MAX_MILLI_DB) return FADER_MAX_MILLI_DB;
  return next;
}
