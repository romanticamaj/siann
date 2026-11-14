// The locators in the ruler's upper half (m5-ui-loop-click; UI redesign spec
// 3.2, "Ruler" and "Setting one locator"): the band's geometry at a view, what
// a pointer in the upper half is over, and the range each gesture or key
// ends in. Every function returns the range to send as session.set_locators,
// or null when nothing is to be sent: the renderer never sends a pair the
// engine refuses (`invalid_locators`: 0 <= left < right <= 2^42,
// docs/schemas/protocol-engine-v0.md), and never one it already has.
//
// - With no locators, setting the right locator gives the range from 0 to that
//   position; setting the left one gives nothing (there is no right end).
// - Drawing a range of zero length gives nothing; moving keeps the length and
//   stops at 0 (and at 2^42); dragging an end stops one grid step (one pixel
//   with snap off: the grid's `minGap`) before the other end.
// - P takes the selection's span; no selection gives nothing.
//
// The band's height comes from RULER_UPPER_HEIGHT, the one ruler constant
// (geometry.ts), never from a literal. Positions are BigInt frames.
// Framework-free.

import type { TempoPoint } from '../model/document';
import { RULER_UPPER_HEIGHT, frameToX, xToFrame, type Viewport } from './geometry';
import { TICKS_PER_BAR, TICKS_PER_QUARTER, framesToTicks } from './musical-time';
import type { Snapper } from './snap';

export interface LocatorRange {
  readonly left: bigint;
  readonly right: bigint;
}

// The engine's upper bound for a locator (protocol-engine-v0.md).
export const MAX_LOCATOR = 2n ** 42n;

// The band in the upper half, as the mockup draws it: from the left to the
// right locator, BAND_TOP below the ruler's top, ending one pixel above the
// half's bottom edge, with a top line and the L and R flags.
export const BAND_TOP = 2;
export const BAND_BOTTOM_GAP = 1;
export const BAND_LINE = 2;
export const FLAG_W = 8;
// The L and R labels: this far inside the band's ends.
export const LABEL_INSET = 10;
// A press this close to an end (inside the band or out) takes that end.
export const END_HIT_PX = 5;

export interface BandRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// What the snap of a locator gesture does: where a frame lands, and the least
// gap an end keeps from the other (one grid step there; one pixel's frames
// with snap off).
export interface LocatorGrid {
  readonly snap: Snapper;
  minGap(at: bigint): bigint;
}

// The band's rectangle at this view, or null without locators.
export function bandRect(range: LocatorRange | null, view: Viewport): BandRect | null {
  if (!range) return null;
  const x = frameToX(range.left, view);
  return { x, y: BAND_TOP, width: frameToX(range.right, view) - x, height: RULER_UPPER_HEIGHT - BAND_TOP - BAND_BOTTOM_GAP };
}

export type LocatorHit = 'left' | 'right' | 'body' | 'outside';

// What a point of the upper half is over: an end (within END_HIT_PX; the
// nearer one when the band is narrower than both zones), the band's body, or
// nothing. Below the upper half, and without locators, it is outside.
export function locatorHit(range: LocatorRange | null, view: Viewport, x: number, y: number): LocatorHit {
  if (!range || y < 0 || y >= RULER_UPPER_HEIGHT) return 'outside';
  const x0 = frameToX(range.left, view);
  const x1 = frameToX(range.right, view);
  const toLeft = Math.abs(x - x0);
  const toRight = Math.abs(x - x1);
  if (toLeft <= END_HIT_PX || toRight <= END_HIT_PX) return toLeft <= toRight ? 'left' : 'right';
  if (x > x0 && x < x1) return 'body';
  return 'outside';
}

// The frame under x, never before the timeline's start.
export function frameAt(x: number, view: Viewport): bigint {
  const frame = xToFrame(x, view);
  return frame < 0n ? 0n : frame;
}

function valid(range: LocatorRange): boolean {
  return range.left >= 0n && range.left < range.right && range.right <= MAX_LOCATOR;
}

function checked(range: LocatorRange): LocatorRange | null {
  return valid(range) ? range : null;
}

const clampFrame = (frame: bigint): bigint => (frame < 0n ? 0n : frame > MAX_LOCATOR ? MAX_LOCATOR : frame);

// A drag in the empty upper half from one frame to another: the range between
// them, both snapped; zero length gives nothing.
export function drawRange(from: bigint, to: bigint, grid: LocatorGrid): LocatorRange | null {
  const a = grid.snap(clampFrame(from));
  const b = grid.snap(clampFrame(to));
  return checked(a <= b ? { left: a, right: b } : { left: b, right: a });
}

// The band dragged by `delta` frames: the length kept, the left end snapped,
// stopped at 0 and at 2^42.
export function moveRange(range: LocatorRange, delta: bigint, grid: LocatorGrid): LocatorRange | null {
  const length = range.right - range.left;
  let left = grid.snap(clampFrame(range.left + delta));
  if (left < 0n) left = 0n;
  if (left + length > MAX_LOCATOR) left = MAX_LOCATOR - length;
  return checked({ left, right: left + length });
}

// One end dragged to a frame: snapped, and stopped one grid step (minGap)
// before the other end.
export function dragEnd(range: LocatorRange, end: 'left' | 'right', frame: bigint, grid: LocatorGrid): LocatorRange | null {
  const target = grid.snap(clampFrame(frame));
  if (end === 'left') {
    const limit = range.right - grid.minGap(range.right);
    return checked({ left: target > limit ? limit : target, right: range.right });
  }
  const limit = range.left + grid.minGap(range.left);
  return checked({ left: range.left, right: target < limit ? limit : target });
}

// Ctrl-click, Ctrl+Num 1: the left locator at a position. Without locators
// there is no right end to pair it with.
export function setLeft(range: LocatorRange | null, at: bigint): LocatorRange | null {
  if (!range) return null;
  return checked({ left: at, right: range.right });
}

// Alt-click, Ctrl+Num 2: the right locator at a position; without locators
// the range from 0 to it.
export function setRight(range: LocatorRange | null, at: bigint): LocatorRange | null {
  return checked({ left: range ? range.left : 0n, right: at });
}

// P: the selection's span (selection.ts's selectionSpan), or nothing.
export function fromSelection(span: { readonly start: bigint; readonly end: bigint } | null): LocatorRange | null {
  return span ? checked({ left: span.start, right: span.end }) : null;
}

export function sameRange(a: LocatorRange | null, b: LocatorRange | null): boolean {
  return a === b || (a !== null && b !== null && a.left === b.left && a.right === b.right);
}

// A position as the locator display reads it: bar.beat, 1-based, 4/4 (spec 3.0, E-10).
export function barBeat(frame: bigint, tempo: readonly TempoPoint[], sampleRate: number): string {
  const ticks = Math.max(0, Math.round(framesToTicks(Number(frame), tempo, sampleRate)));
  const bar = Math.floor(ticks / TICKS_PER_BAR) + 1;
  const beat = Math.floor((ticks % TICKS_PER_BAR) / TICKS_PER_QUARTER) + 1;
  return `${bar}.${beat}`;
}

// The locator display: "9.1 – 13.1" (left – right, in bars and beats).
export const RANGE_DASH = ' \u2013 ';

export function formatLocators(range: LocatorRange, tempo: readonly TempoPoint[], sampleRate: number): string {
  return `${barBeat(range.left, tempo, sampleRate)}${RANGE_DASH}${barBeat(range.right, tempo, sampleRate)}`;
}

// The document's locators entity as a range (decimal strings to BigInt), or null.
export function rangeOf(entity: { readonly left: string; readonly right: string } | null | undefined): LocatorRange | null {
  if (!entity || !/^\d+$/.test(entity.left) || !/^\d+$/.test(entity.right)) return null;
  return { left: BigInt(entity.left), right: BigInt(entity.right) };
}
