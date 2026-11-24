// Snap type Grid (UI redesign spec 3.2 "Editing", 4.5 C10 and P1-8): the
// grid types Bar (7680 ticks) and Beat (1920 ticks), 4/4 until E-10, and
// Adapt to Zoom, the finest of a 1/64 note, 1/32, 1/16, 1/8, a beat and a bar
// whose lines are at least SNAP_MIN_PX apart at the current zoom (a bar when
// none is). Grid is absolute: a frame snaps to the nearest grid line through
// root.tempo (musical-time.ts), never before the timeline's start; a moved
// selection takes the delta that puts the dragged clip's start on the grid.
// Snap off, or Ctrl held while resizing (the ignore flag), leaves a frame
// alone.
//
// The snap types of m5b-ui-edit-more (spec 3.2, "Snap types"): Grid above;
// Grid Relative, where a move keeps the dragged clip's offset from its grid
// line (the delta is a whole number of grid steps) and a single frame snaps as
// Grid does; Events, magnetic to the starts and ends of the other clips; and
// Magnetic Cursor, magnetic to the project cursor. A magnetic type moves a
// frame to the nearest target within SNAP_MAGNET_PX at the zoom and leaves it
// where it is otherwise; the targets come in a SnapContext (snapContext),
// which never holds a clip being dragged. Framework-free.

import type { TempoPoint } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { BEATS_PER_BAR, TICKS_PER_BAR, TICKS_PER_QUARTER, framesToTicks, tempoSegments, ticksToFrames } from './musical-time';

export type GridType = 'bar' | 'beat' | 'adapt';
export const GRID_TYPES: readonly GridType[] = ['bar', 'beat', 'adapt'];

export type SnapType = 'grid' | 'gridRelative' | 'events' | 'cursor';
export const SNAP_TYPES: readonly SnapType[] = ['grid', 'gridRelative', 'events', 'cursor'];

export interface SnapSettings {
  readonly on: boolean;
  readonly grid: GridType;
  // Grid when absent.
  readonly type?: SnapType;
}

// Snap on, grid Adapt to Zoom (4.5 C10), type Grid.
export const DEFAULT_SNAP: SnapSettings = Object.freeze({ on: true, grid: 'adapt', type: 'grid' });

// The reach of Events and Magnetic Cursor, in CSS pixels at the current zoom.
export const SNAP_MAGNET_PX = 8;

// What the magnetic types snap to: the other clips' starts and ends, and the
// project cursor (null when unknown).
export interface SnapContext {
  readonly edges: readonly bigint[];
  readonly cursor: bigint | null;
}

export const NO_SNAP_CONTEXT: SnapContext = Object.freeze({ edges: Object.freeze([]) as readonly bigint[], cursor: null });

export function isSnapType(value: unknown): value is SnapType {
  return value === 'grid' || value === 'gridRelative' || value === 'events' || value === 'cursor';
}

// The starts and ends of every audio clip on a lane, every position marker
// and the start and end of every cycle marker (m5b-ui-markers), but the
// `exclude`d ones (the clips or the marker being dragged, by id), and the
// cursor.
export function snapContext(snapshot: Snapshot, exclude: readonly string[], cursor: bigint | null): SnapContext {
  const lanes = new Set(snapshot.trackOrder);
  const skip = new Set(exclude);
  const edges: bigint[] = [];
  for (const clip of snapshot.clips) {
    if (clip.position.domain !== 'audio' || !lanes.has(clip.trackId) || skip.has(clip.id)) continue;
    const start = BigInt(clip.position.value);
    edges.push(start, start + BigInt(clip.length));
  }
  for (const marker of snapshot.markers ?? []) {
    if (skip.has(marker.id)) continue;
    const start = BigInt(marker.position);
    edges.push(start);
    if (typeof marker.length === 'string') edges.push(start + BigInt(marker.length));
  }
  return { edges, cursor };
}

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

// The nearest target within `reach` frames of a frame, or null.
function magnet(frame: bigint, targets: readonly bigint[], reach: bigint): bigint | null {
  let found: bigint | null = null;
  let best = reach;
  for (const target of targets) {
    const distance = target > frame ? target - frame : frame - target;
    if (distance <= best && (found === null || distance < best)) {
      found = target;
      best = distance;
    }
  }
  return found;
}

function targetsOf(type: SnapType, context: SnapContext): readonly bigint[] {
  if (type === 'events') return context.edges;
  return context.cursor === null ? [] : [context.cursor];
}

function reachOf(framesPerPixel: number): bigint {
  return BigInt(Math.round(SNAP_MAGNET_PX * framesPerPixel));
}

// A frame's snap at a zoom: the identity when snap is off or ignored. Grid
// and Grid Relative snap a single frame to the grid; Events and Magnetic
// Cursor to the nearest target in reach, else not at all.
export function snapperFor(
  settings: SnapSettings,
  framesPerPixel: number,
  tempo: readonly TempoPoint[],
  sampleRate: number,
  ignore = false,
  atFrame: bigint = 0n,
  context: SnapContext = NO_SNAP_CONTEXT,
): Snapper {
  if (!settings.on || ignore) return (frame) => frame;
  const type = settings.type ?? 'grid';
  if (type === 'events' || type === 'cursor') {
    const targets = targetsOf(type, context);
    const reach = reachOf(framesPerPixel);
    return (frame) => magnet(frame, targets, reach) ?? frame;
  }
  const step = gridStepTicks(settings.grid, pixelsPerTick(framesPerPixel, tempo, sampleRate, atFrame));
  return (frame) => snapFrame(frame, step, tempo, sampleRate);
}

// Where a move's snap is worked out: the zoom, the tempo map, the frame the
// grid's zoom is read at and the magnetic targets.
export interface SnapEnv {
  readonly framesPerPixel: number;
  readonly tempo: readonly TempoPoint[];
  readonly sampleRate: number;
  readonly atFrame?: bigint;
  readonly context?: SnapContext;
}

// The delta a dragged clip (start, length) moved by `delta` ends in, never
// before the timeline's start.
export type MoveSnapper = (start: bigint, length: bigint, delta: bigint) => bigint;

// A move's snap per type: Grid puts the start on a line; Grid Relative moves
// by whole grid steps (in ticks, through the tempo map), keeping the start's
// offset from its line; Events and Magnetic Cursor take the start to a target
// in reach, else the end, else leave the drag as it is.
export function moveSnapperFor(settings: SnapSettings, env: SnapEnv, ignore = false): MoveSnapper {
  const { framesPerPixel, tempo, sampleRate } = env;
  const atFrame = env.atFrame ?? 0n;
  const free: MoveSnapper = (start, _length, delta) => (start + delta < 0n ? -start : delta);
  if (!settings.on || ignore) return free;
  const type = settings.type ?? 'grid';
  if (type === 'events' || type === 'cursor') {
    const targets = targetsOf(type, env.context ?? NO_SNAP_CONTEXT);
    const reach = reachOf(framesPerPixel);
    return (start, length, delta) => {
      const moved = start + delta < 0n ? 0n : start + delta;
      const toStart = magnet(moved, targets, reach);
      if (toStart !== null) return toStart - start;
      const toEnd = magnet(moved + length, targets, reach);
      if (toEnd !== null && toEnd - length >= 0n) return toEnd - length - start;
      return moved - start;
    };
  }
  const grid = snapperFor(settings, framesPerPixel, tempo, sampleRate, false, atFrame);
  if (type === 'grid') return (start, _length, delta) => snappedMoveDelta(start, delta, grid);
  const step = gridStepTicks(settings.grid, pixelsPerTick(framesPerPixel, tempo, sampleRate, atFrame));
  return (start, _length, delta) => {
    const from = framesToTicks(Number(start), tempo, sampleRate);
    const to = framesToTicks(Number(start + delta), tempo, sampleRate);
    // The whole steps nearest the drag, no more to the left than fit before 0.
    const steps = Math.max(Math.round((to - from) / step), -Math.floor(from / step));
    if (steps === 0) return 0n;
    // The steps' length in frames from the start's tick, so a start between
    // ticks keeps its exact offset.
    const by = BigInt(ticksToFrames(from + steps * step, tempo, sampleRate) - ticksToFrames(from, tempo, sampleRate));
    return start + by < 0n ? -start : by;
  };
}

// One grid step at a zoom in frames, from `atFrame` (at least 1): the least
// gap a dragged locator end keeps from the other (m5-ui-loop-click; spec 3.2).
export function gridStepFrames(settings: SnapSettings, framesPerPixel: number, tempo: readonly TempoPoint[], sampleRate: number, atFrame: bigint): bigint {
  const step = gridStepTicks(settings.grid, pixelsPerTick(framesPerPixel, tempo, sampleRate, atFrame));
  const at = Number(atFrame);
  const next = ticksToFrames(framesToTicks(at, tempo, sampleRate) + step, tempo, sampleRate);
  return BigInt(Math.max(1, Math.round(next - at)));
}

// The delta that puts a clip starting at `start`, moved by `delta`, on the grid.
export function snappedMoveDelta(start: bigint, delta: bigint, snap: Snapper): bigint {
  const moved = start + delta;
  return snap(moved < 0n ? 0n : moved) - start;
}
