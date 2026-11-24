// The marker track (m5b-ui-markers; UI redesign 3.0, 3.1, 3.2 "Marker track"
// and "How markers are drawn", UR-9; docs/schemas/protocol-engine-v0.md,
// "Markers"): the geometry of position and cycle markers in the --marker-h row
// under the ruler, the hit test, the command builders of the gestures and the
// navigation of the marker keys. Framework-free.
//
// Drawing follows the mockup's draw():
//
//   g.fillStyle=rgba(c,.14);g.fillRect(x+1,RULER+2,x2-x-2,MK-5);
//   g.fillStyle=c;g.fillRect(x,RULER+2,2,MK-5);
//   g.fillText((k+1)+'  '+name,x+7,RULER+MK/2)
//
// A position marker's tint runs to the next position marker in position
// order, or to the end of the last clip; one at or past that end has none. A
// cycle marker (which the mockup does not draw) is its range tinted the same
// way with a bar inside each end and its label. The sizes are tokens.ts's
// (--ruler-h, --marker-h and the spacing steps of 2, 5 and 7 px); a marker's
// colour is a track-palette token by the FNV-1a hash of its id, the rule track
// colours follow (track-colour.ts).
//
// Every builder returns the command list of one command.execute at the
// snapshot's revision, or null when there is nothing to send. Positions stay
// in 0..2^42 (the engine's bound); a cycle marker is at least one frame long;
// marker.add carries no number, so the engine takes the lowest free one.

import type { CapabilitySelector } from '../model/capabilities';
import type { MarkerEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { TOKENS } from '../tokens';
import type { TimelineCommand } from './commands';
import { frameToX, type Box, type Viewport } from './geometry';
import { END_HIT_PX, type LocatorRange } from './locators';
import type { Snapper } from './snap';
import { trackColourVar } from './track-colour';

const px = (name: keyof typeof TOKENS): number => Number.parseFloat(TOKENS[name]);

// The ruler and the row (tokens.css --ruler-h, --marker-h).
const RULER = px('ruler-h');
const MK = px('marker-h');
// draw()'s numbers: the bar and the tint from RULER + 2, MK - 5 high; the bar
// 2 px wide; the tint 1 px inside each end; the label at x + 7.
const TOP = px('space-half');
const SHORT = px('space-5q');
const BAR_W = px('space-half');
const INSET = px('hairline');
const LABEL_X = px('space-7q');

// draw()'s rgba(c, .14), drawn as the colour at this alpha.
export const MARKER_TINT_ALPHA = 0.14;
// draw()'s mix(c, select, .25) for the label.
export const MARKER_LABEL_MIX = 0.25;

// The engine's upper bound for a marker's position and end.
export const MAX_MARKER = 2n ** 42n;

// The marker commands; the track needs every one and features.markers.
export const MARKER_OPS = ['marker.add', 'marker.move', 'marker.rename', 'marker.remove'] as const;

// Whether the marker track is shown and its gestures and keys exist (UI
// redesign 3.0): features.markers and the four commands.
export function markersEnabled(can: CapabilitySelector): boolean {
  return can.feature('markers') && MARKER_OPS.every((op) => can.command(op));
}

// The custom property holding a marker's colour: the track palette by the hash of its id.
export function markerColourVar(markerId: string): string {
  return trackColourVar(markerId);
}

// "N  name" (two spaces, as draw()), the number alone without a name.
export function markerLabel(number: number, name: string): string {
  return name === '' ? String(number) : `${number}  ${name}`;
}

// A position marker's bar at x and its tint up to tintEnd (null: no tint).
export function flagBox(x: number, tintEnd: number | null): { readonly bar: Box; readonly tint: Box | null } {
  const y = RULER + TOP;
  const height = MK - SHORT;
  const bar = { x, y, width: BAR_W, height };
  const width = tintEnd === null ? 0 : tintEnd - x - 2 * INSET;
  return { bar, tint: width > 0 ? { x: x + INSET, y, width, height } : null };
}

// A cycle marker from x0 to x1: its range tinted and a bar inside each end.
export function cycleBox(x0: number, x1: number): { readonly tint: Box; readonly left: Box; readonly right: Box } {
  const y = RULER + TOP;
  const height = MK - SHORT;
  return {
    tint: { x: x0, y, width: x1 - x0, height },
    left: { x: x0, y, width: BAR_W, height },
    right: { x: x1 - BAR_W, y, width: BAR_W, height },
  };
}

export interface MarkerLabelBox {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

interface ShapeBase {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly position: string;
  readonly colourVar: string;
  readonly label: MarkerLabelBox;
}

export interface FlagShape extends ShapeBase {
  readonly kind: 'position';
  readonly bar: Box;
  readonly tint: Box | null;
}

export interface CycleShape extends ShapeBase {
  readonly kind: 'cycle';
  readonly length: string;
  readonly x0: number;
  readonly x1: number;
  readonly tint: Box;
  readonly left: Box;
  readonly right: Box;
}

export type MarkerShape = FlagShape | CycleShape;

// The label's width when nothing measures it: an estimate at --fs-micro.
const estimate = (text: string): number => text.length * px('fs-micro') * 0.6;

export function labelBox(x: number, text: string, measure: (text: string) => number = estimate): MarkerLabelBox {
  return { text, x: x + LABEL_X, y: RULER + MK / 2, width: measure(text) };
}

const isCycle = (marker: MarkerEntity): marker is MarkerEntity & { readonly length: string } => typeof marker.length === 'string';

// The end of the last audio clip, or null without clips (the last position marker's tint ends there).
export function clipsEnd(snapshot: Snapshot | null): bigint | null {
  let end: bigint | null = null;
  for (const clip of snapshot?.clips ?? []) {
    if (clip.position.domain !== 'audio') continue;
    const at = BigInt(clip.position.value) + BigInt(clip.length);
    if (end === null || at > end) end = at;
  }
  return end;
}

const byPosition = (a: MarkerEntity, b: MarkerEntity): number => {
  const pa = BigInt(a.position);
  const pb = BigInt(b.position);
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.number !== b.number) return a.number - b.number;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// The shapes to draw, in drawing order: the position markers in position
// order, then the cycle markers (drawn above the position tints).
export function markerShapes(markers: readonly MarkerEntity[], end: bigint | null, view: Viewport, measure?: (text: string) => number): MarkerShape[] {
  const positions = markers.filter((m) => !isCycle(m)).sort(byPosition);
  const cycles = markers.filter(isCycle).sort(byPosition);
  const out: MarkerShape[] = [];
  positions.forEach((marker, index) => {
    const at = BigInt(marker.position);
    const following = positions[index + 1];
    const to = following ? BigInt(following.position) : end !== null && end > at ? end : null;
    const x = frameToX(at, view);
    const { bar, tint } = flagBox(x, to === null ? null : frameToX(to, view));
    out.push({
      kind: 'position',
      id: marker.id,
      number: marker.number,
      name: marker.name,
      position: marker.position,
      colourVar: markerColourVar(marker.id),
      bar,
      tint,
      label: labelBox(x, markerLabel(marker.number, marker.name), measure),
    });
  });
  for (const marker of cycles) {
    const at = BigInt(marker.position);
    const x0 = frameToX(at, view);
    const x1 = frameToX(at + BigInt(marker.length), view);
    out.push({
      kind: 'cycle',
      id: marker.id,
      number: marker.number,
      name: marker.name,
      position: marker.position,
      length: marker.length,
      colourVar: markerColourVar(marker.id),
      x0,
      x1,
      ...cycleBox(x0, x1),
      label: labelBox(x0, markerLabel(marker.number, marker.name), measure),
    });
  }
  return out;
}

export type MarkerHitPart = 'flag' | 'name' | 'cycle-body' | 'cycle-left' | 'cycle-right';
export type MarkerHit = { readonly part: MarkerHitPart; readonly markerId: string } | { readonly part: 'empty' };

// What a point of the marker row is over, or null outside the row. In this
// order: a cycle marker's end (within END_HIT_PX, the nearer one), a
// position marker's flag (within END_HIT_PX of its bar), a label, a cycle
// marker's body; else empty space (a tint is empty space).
export function markerHit(shapes: readonly MarkerShape[], x: number, y: number): MarkerHit | null {
  if (y < RULER || y >= RULER + MK) return null;
  const nearest = (candidates: ReadonlyArray<{ part: MarkerHitPart; markerId: string; distance: number }>): MarkerHit | null => {
    let found: { part: MarkerHitPart; markerId: string; distance: number } | null = null;
    for (const c of candidates) if (c.distance <= END_HIT_PX && (found === null || c.distance < found.distance)) found = c;
    return found ? { part: found.part, markerId: found.markerId } : null;
  };
  const edge = nearest(
    shapes.flatMap((s) =>
      s.kind === 'cycle'
        ? [
            { part: 'cycle-left' as const, markerId: s.id, distance: Math.abs(x - s.x0) },
            { part: 'cycle-right' as const, markerId: s.id, distance: Math.abs(x - s.x1) },
          ]
        : [],
    ),
  );
  if (edge) return edge;
  const flag = nearest(shapes.flatMap((s) => (s.kind === 'position' ? [{ part: 'flag' as const, markerId: s.id, distance: Math.abs(x - (s.bar.x + s.bar.width / 2)) }] : [])));
  if (flag) return flag;
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const { label, id } = shapes[i]!;
    if (x >= label.x && x <= label.x + label.width) return { part: 'name', markerId: id };
  }
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const s = shapes[i]!;
    if (s.kind === 'cycle' && x > s.x0 && x < s.x1) return { part: 'cycle-body', markerId: s.id };
  }
  return { part: 'empty' };
}

// ---------------------------------------------------------------- commands

const clamp = (frame: bigint, max: bigint = MAX_MARKER): bigint => (frame < 0n ? 0n : frame > max ? max : frame);

function markerOf(snapshot: Snapshot, markerId: string): MarkerEntity | null {
  const entity = snapshot.entities[`marker:${markerId}`] as MarkerEntity | undefined;
  return entity && entity.schema === 'siann.entity.marker.v1' ? entity : null;
}

function one(snapshot: Snapshot, command: Record<string, unknown>): TimelineCommand {
  return { expectedRevision: snapshot.revision, commands: [command] };
}

// mk_ and 16 random lowercase hex digits (ids are client-chosen, as clips' are).
export function newMarkerId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `mk_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Insert (the cursor, the identity snap) and Alt-click (snapped): a position marker.
export function addMarkerCommand(snapshot: Snapshot, at: bigint, snap: Snapper, markerId: string): TimelineCommand {
  return one(snapshot, { op: 'marker.add', markerId, position: clamp(snap(clamp(at))).toString() });
}

// A Ctrl-drag between two frames: a cycle marker of their snapped range, at
// least a frame long and ending by 2^42; nothing for zero length.
export function addCycleCommand(snapshot: Snapshot, from: bigint, to: bigint, snap: Snapper, markerId: string): TimelineCommand | null {
  const a = clamp(snap(clamp(from)));
  const b = clamp(snap(clamp(to)));
  const start = a < b ? a : b;
  const end = a < b ? b : a;
  if (end - start < 1n) return null;
  return one(snapshot, { op: 'marker.add', markerId, position: start.toString(), length: (end - start).toString() });
}

// A drag of a marker by `delta` frames: its position snapped, stopped at 0
// and (with a cycle marker's length) at 2^42; nothing when it stays.
export function moveMarkerCommand(snapshot: Snapshot, markerId: string, delta: bigint, snap: Snapper): TimelineCommand | null {
  const marker = markerOf(snapshot, markerId);
  if (!marker) return null;
  const from = BigInt(marker.position);
  const max = isCycle(marker) ? MAX_MARKER - BigInt(marker.length) : MAX_MARKER;
  const to = clamp(snap(clamp(from + delta, max)), max);
  if (to === from) return null;
  return one(snapshot, { op: 'marker.move', markerId, position: to.toString() });
}

// A drag of a cycle marker's edge to a frame: marker.move with its position
// and length; the left edge keeps the end, the right edge the start, never
// shorter than a frame nor past 2^42; nothing when the size stays.
export function resizeCycleCommand(snapshot: Snapshot, markerId: string, edge: 'left' | 'right', frame: bigint, snap: Snapper): TimelineCommand | null {
  const marker = markerOf(snapshot, markerId);
  if (!marker || !isCycle(marker)) return null;
  const start = BigInt(marker.position);
  const end = start + BigInt(marker.length);
  const target = clamp(snap(clamp(frame)));
  let position = start;
  let last = end;
  if (edge === 'left') position = target < end - 1n ? target : end - 1n;
  else last = target > start + 1n ? target : start + 1n;
  if (position === start && last === end) return null;
  return one(snapshot, { op: 'marker.move', markerId, position: position.toString(), length: (last - position).toString() });
}

export function renameMarkerCommand(snapshot: Snapshot, markerId: string, name: string): TimelineCommand | null {
  const marker = markerOf(snapshot, markerId);
  if (!marker || marker.name === name) return null;
  return one(snapshot, { op: 'marker.rename', markerId, name });
}

export function removeMarkerCommand(snapshot: Snapshot, markerId: string): TimelineCommand | null {
  return markerOf(snapshot, markerId) ? one(snapshot, { op: 'marker.remove', markerId }) : null;
}

// A cycle marker's range as the locators' pair (one session.set_locators); none for a position marker.
export function locatorsOf(marker: MarkerEntity): LocatorRange | null {
  if (!isCycle(marker)) return null;
  const left = BigInt(marker.position);
  return { left, right: left + BigInt(marker.length) };
}

// ---------------------------------------------------------------- navigation

// Shift+3..9, Num 3..9: the position marker with that number; a cycle marker never.
export function positionMarkerByNumber(snapshot: Snapshot, number: number): MarkerEntity | null {
  return snapshot.markers.find((m) => !isCycle(m) && m.number === number) ?? null;
}

// The markers' starts: every position marker and every cycle marker's start.
function starts(snapshot: Snapshot): bigint[] {
  return snapshot.markers.map((m) => BigInt(m.position));
}

// Shift+N: the nearest start after the cursor, or null.
export function nextMarker(snapshot: Snapshot, cursor: bigint): bigint | null {
  let found: bigint | null = null;
  for (const at of starts(snapshot)) if (at > cursor && (found === null || at < found)) found = at;
  return found;
}

// Shift+B: the nearest start before the cursor, or null.
export function previousMarker(snapshot: Snapshot, cursor: bigint): bigint | null {
  let found: bigint | null = null;
  for (const at of starts(snapshot)) if (at < cursor && (found === null || at > found)) found = at;
  return found;
}
