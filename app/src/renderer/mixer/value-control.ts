// The value controls' maths (UI redesign spec 3.4, for every value control in
// the app): a drag turns pixels along the control into a position of its
// travel, Shift moves a tenth as far (switching it mid-drag re-anchors, so the
// value never jumps), Ctrl-click gives the default, the pan knob maps the
// model's -10000..10000 onto the travel with a detent at the centre, and a
// typed value is parsed as the user writes it. Pure and DOM-free.

import { FADER_TOP_MILLI_DB, MINUS_INFINITY_MILLI_DB } from './taper';

export type ValueKind = 'gain' | 'pan';

export const FINE_FACTOR = 0.1;
const PAN_RANGE = 10_000;
// |pan| below this (1.5 %) snaps to the centre.
const PAN_DETENT = 150;
// The model's lowest gain above minus infinity (Gain::kMinMilliDb).
const MIN_MILLI_DB = -144_000;

export interface Drag {
  // The pointer (px along the control, increasing toward a higher value) and
  // the position it was at when the drag (or the last Shift change) began.
  readonly anchorPx: number;
  readonly anchorPosition: number;
  readonly travelPx: number;
  readonly fine: boolean;
}

export function startDrag(position: number, px: number, travelPx: number, fine: boolean): Drag {
  return { anchorPx: px, anchorPosition: position, travelPx: Math.max(1, travelPx), fine };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function positionAt(drag: Drag, px: number): number {
  return clamp01(drag.anchorPosition + ((px - drag.anchorPx) / drag.travelPx) * (drag.fine ? FINE_FACTOR : 1));
}

// The position for the pointer at `px`; a change of `fine` re-anchors there.
export function dragTo(drag: Drag, px: number, fine: boolean): { drag: Drag; position: number } {
  let current = drag;
  if (fine !== drag.fine) current = { ...drag, anchorPx: px, anchorPosition: positionAt(drag, px), fine };
  return { drag: current, position: positionAt(current, px) };
}

// What Ctrl-click sets: 0.0 dB, or the centre.
const DEFAULTS: Readonly<Record<ValueKind, number>> = { gain: 0, pan: 0 };

export function defaultValue(kind: ValueKind): number {
  return DEFAULTS[kind];
}

export function panToPosition(pan: number): number {
  return clamp01((pan + PAN_RANGE) / (2 * PAN_RANGE));
}

// Whole percent steps, the centre within the detent.
export function positionToPan(position: number): number {
  const raw = clamp01(position) * 2 * PAN_RANGE - PAN_RANGE;
  if (Math.abs(raw) < PAN_DETENT) return 0;
  return Math.round(raw / 100) * 100;
}

const GAIN_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:db)?$/i;
const MINUS_INF_RE = /^-\s*inf(?:inity)?\s*(?:db)?$/i;
const PAN_RE = /^([lrc])(\d{1,3})?$/i;

// A typed value, or null when it does not parse. Gain is dB with an optional
// unit ("-6.5", "-6.5 dB", "-inf"), clamped to -inf..+6 dB; pan is L35, C or
// R40, clamped to 100. A comma is not a decimal point here.
export function parseTyped(kind: ValueKind, text: string): number | null {
  const trimmed = text.trim();
  if (kind === 'gain') {
    if (MINUS_INF_RE.test(trimmed)) return MINUS_INFINITY_MILLI_DB;
    const match = GAIN_RE.exec(trimmed);
    if (!match) return null;
    const milliDb = Math.round(Number(match[1]) * 1000);
    if (!Number.isFinite(milliDb)) return null;
    if (milliDb > FADER_TOP_MILLI_DB) return FADER_TOP_MILLI_DB;
    if (milliDb < MIN_MILLI_DB) return MINUS_INFINITY_MILLI_DB;
    return milliDb === 0 ? 0 : milliDb;
  }
  const match = PAN_RE.exec(trimmed);
  if (!match) return null;
  const side = match[1]!.toUpperCase();
  if (side === 'C') return match[2] === undefined || Number(match[2]) === 0 ? 0 : null;
  if (match[2] === undefined) return null;
  const percent = Math.min(100, Number(match[2]));
  if (percent === 0) return 0;
  return (side === 'L' ? -1 : 1) * percent * 100;
}
