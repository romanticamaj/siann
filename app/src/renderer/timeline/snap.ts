// Snap type Grid (UI redesign spec 3.2 "Editing", 4.5 C10 and P1-8): the
// grid types Bar (7680 ticks) and Beat (1920 ticks), 4/4 until E-10, and
// Adapt to Zoom, the finest of a 1/64 note, 1/32, 1/16, 1/8, a beat and a bar
// whose lines are at least SNAP_MIN_PX apart at the current zoom (a bar when
// none is). Grid is absolute: a frame snaps to the nearest grid line through
// root.tempo (musical-time.ts), never before the timeline's start; a moved
// selection takes the delta that puts the dragged clip's start on the grid.
// Snap off, or Ctrl held while resizing (the ignore flag), leaves a frame
// alone. Framework-free.

import type { TempoPoint } from '../model/document';
import { BEATS_PER_BAR, TICKS_PER_BAR, TICKS_PER_QUARTER, framesToTicks, tempoSegments, ticksToFrames } from './musical-time';

export type GridType = 'bar' | 'beat' | 'adapt';
export const GRID_TYPES: readonly GridType[] = ['bar', 'beat', 'adapt'];

export interface SnapSettings {
  readonly on: boolean;
  readonly grid: GridType;
}

// Snap on, grid Adapt to Zoom (4.5 C10).
export const DEFAULT_SNAP: SnapSettings = Object.freeze({ on: true, grid: 'adapt' });

// 1/64, 1/32, 1/16 and 1/8 notes, a beat and a bar, in ticks.
export const ADAPT_STEPS_TICKS: readonly number[] = Object.freeze([
  TICKS_PER_QUARTER / 16,
  TICKS_PER_QUARTER / 8,
  TICKS_PER_QUARTER / 4,
  TICKS_PER_QUARTER / 2,
  TICKS_PER_QUARTER,
  TICKS_PER_QUARTER * BEATS_PER_BAR,
]);

// The closest Adapt to Zoom's grid lines may be, in CSS pixels.
export const SNAP_MIN_PX = 10;

export function isGridType(value: unknown): value is GridType {
  return value === 'bar' || value === 'beat' || value === 'adapt';
}

// The grid step in ticks; Adapt to Zoom needs the pixels a tick is wide.
export function gridStepTicks(grid: GridType, pxPerTick = 0): number {
  if (grid === 'bar') return TICKS_PER_BAR;
  if (grid === 'beat') return TICKS_PER_QUARTER;
  return ADAPT_STEPS_TICKS.find((step) => step * pxPerTick >= SNAP_MIN_PX) ?? TICKS_PER_BAR;
}

// How many pixels a tick is wide at a zoom, at the tempo in force at `atFrame`.
export function pixelsPerTick(framesPerPixel: number, tempo: readonly TempoPoint[], sampleRate: number, atFrame: bigint = 0n): number {
  const segments = tempoSegments(tempo, sampleRate);
  const frame = Number(atFrame);
  let segment = segments[0]!;
  for (const s of segments) if (s.startFrame <= frame) segment = s;
  return segment.framesPerTick / framesPerPixel;
}

// The nearest grid line of `stepTicks` to a frame, never before 0.
export function snapFrame(frame: bigint, stepTicks: number, tempo: readonly TempoPoint[], sampleRate: number): bigint {
  if (frame <= 0n) return 0n;
  const ticks = framesToTicks(Number(frame), tempo, sampleRate);
  const line = Math.round(ticks / stepTicks) * stepTicks;
  return BigInt(Math.max(0, ticksToFrames(line, tempo, sampleRate)));
}

export type Snapper = (frame: bigint) => bigint;

// A frame's snap at a zoom: the identity when snap is off or ignored.
export function snapperFor(
  settings: SnapSettings,
  framesPerPixel: number,
  tempo: readonly TempoPoint[],
  sampleRate: number,
  ignore = false,
  atFrame: bigint = 0n,
): Snapper {
  if (!settings.on || ignore) return (frame) => frame;
  const step = gridStepTicks(settings.grid, pixelsPerTick(framesPerPixel, tempo, sampleRate, atFrame));
  return (frame) => snapFrame(frame, step, tempo, sampleRate);
}

// The delta that puts a clip starting at `start`, moved by `delta`, on the grid.
export function snappedMoveDelta(start: bigint, delta: bigint, snap: Snapper): bigint {
  const moved = start + delta;
  return snap(moved < 0n ? 0n : moved) - start;
}
