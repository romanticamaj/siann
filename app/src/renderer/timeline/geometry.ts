// The timeline's geometry (spec, "Frontend"): audio-domain sample frames to
// canvas pixels and back at a zoom (whole frames per pixel) and a scroll,
// clip rectangles in root.trackOrder lanes, hit testing of a clip's body, its
// lower resize corners, its edges and its volume control (m5-ui-edit-basics),
// and the clamping a move or trim ends in (the grid is snap.ts's). Lanes have their own
// heights (UI redesign spec 2.3: 53 px by default, 24-240 px, a view setting
// kept per session id) and scroll vertically under the fixed ruler
// (m5-ui-arrange). Coordinates are the event display canvas's, which begins
// right of the track list, so nothing here knows the list's width. Positions are
// decimal strings, as the document carries them; arithmetic on them is
// BigInt, so a position beyond 2^53 keeps every frame. Framework-free.

import type { ClipEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';

export interface Viewport {
  // Whole sample frames per CSS pixel (the zoom), at least 1.
  readonly framesPerPixel: number;
  // The frame at x = 0, a decimal string.
  readonly scrollFrames: string;
  // Pixels above the first lane.
  readonly rulerHeight: number;
  // The height of a lane the map does not name.
  readonly laneHeight: number;
  // Track id -> lane height in px (clamped to MIN..MAX_LANE_HEIGHT).
  readonly laneHeights?: Readonly<Record<string, number>>;
  // Pixels the lanes are scrolled up under the ruler, at least 0.
  readonly scrollY?: number;
  readonly width: number;
  readonly height?: number;
}

export const DEFAULT_LANE_HEIGHT = 53;
export const MIN_LANE_HEIGHT = 24;
export const MAX_LANE_HEIGHT = 240;

export function clampLaneHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_LANE_HEIGHT;
  return Math.min(MAX_LANE_HEIGHT, Math.max(MIN_LANE_HEIGHT, Math.round(height)));
}

export function laneHeightOf(trackId: string, view: Viewport): number {
  const height = view.laneHeights?.[trackId];
  return clampLaneHeight(height ?? view.laneHeight);
}

// The top of each lane in trackOrder, in canvas pixels (the ruler above, the scroll applied).
export function laneTops(trackOrder: readonly string[], view: Viewport): number[] {
  const tops: number[] = [];
  let top = view.rulerHeight - (view.scrollY ?? 0);
  for (const trackId of trackOrder) {
    tops.push(top);
    top += laneHeightOf(trackId, view);
  }
  return tops;
}

// All lanes stacked, in pixels.
export function lanesHeight(trackOrder: readonly string[], view: Viewport): number {
  return trackOrder.reduce((sum, trackId) => sum + laneHeightOf(trackId, view), 0);
}

export interface ClipRect {
  readonly clipId: string;
  readonly trackId: string;
  readonly mediaId: string;
  readonly position: string;
  readonly sourceStart: string;
  readonly length: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// A clip's parts (UI redesign spec 3.2, "Clip handles"): the lower corners
// resize, the rest of each edge is a narrower resize target as well, the
// volume control sits just inside the lower-left corner, and the body moves.
export type HitPart = 'body' | 'left' | 'right' | 'cornerLeft' | 'cornerRight' | 'gain';
export type TrimEdge = 'left' | 'right';

// The width of the resize target along each edge, in pixels.
export const HANDLE_PX = 4;
// The resize squares in the lower corners, in pixels.
export const CORNER_PX = 8;
// The volume control: its box right of the lower-left corner, and the
// smallest clip that has one.
export const GAIN_W = 14;
export const GAIN_H = 12;
export const GAIN_MIN_WIDTH = 48;
export const GAIN_MIN_HEIGHT = 30;

// The edge a resize part changes, or null for the body and the volume control.
export function trimEdgeOf(part: HitPart): TrimEdge | null {
  if (part === 'left' || part === 'cornerLeft') return 'left';
  if (part === 'right' || part === 'cornerRight') return 'right';
  return null;
}

// The size of a clip's corner squares: CORNER_PX, less on a narrow or short clip.
export function cornerSize(rect: Pick<ClipRect, 'width' | 'height'>): number {
  return Math.min(CORNER_PX, rect.width / 3, rect.height / 2);
}

// The volume control's box, or null on a clip too small for one.
export function gainBox(rect: ClipRect): { x: number; y: number; width: number; height: number } | null {
  if (rect.width < GAIN_MIN_WIDTH || rect.height < GAIN_MIN_HEIGHT) return null;
  return { x: rect.x + cornerSize(rect), y: rect.y + rect.height - GAIN_H, width: GAIN_W, height: GAIN_H };
}

function big(value: string | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

// Pixels of a frame difference, exact for any difference a screen shows.
function pixelsOf(frames: bigint, view: Viewport): number {
  const fpp = BigInt(view.framesPerPixel);
  return Number(frames / fpp) + Number(frames % fpp) / view.framesPerPixel;
}

export function frameToX(frame: string | bigint, view: Viewport): number {
  return pixelsOf(big(frame) - big(view.scrollFrames), view);
}

// The frame under x, rounded to the nearest frame (it may be negative).
export function xToFrame(x: number, view: Viewport): bigint {
  return big(view.scrollFrames) + deltaFrames(x, view);
}

// The frames a horizontal pointer movement of dx pixels covers.
export function deltaFrames(dx: number, view: Viewport): bigint {
  return BigInt(Math.round(dx * view.framesPerPixel));
}

// The track whose lane holds y, or null on the ruler or below the lanes.
export function trackAt(snapshot: Snapshot, y: number, view: Viewport): string | null {
  if (y < view.rulerHeight) return null;
  const tops = laneTops(snapshot.trackOrder, view);
  for (let i = 0; i < tops.length; i += 1) {
    const trackId = snapshot.trackOrder[i]!;
    if (y >= tops[i]! && y < tops[i]! + laneHeightOf(trackId, view)) return trackId;
  }
  return null;
}

// Every audio-domain clip of a track in trackOrder, in that order. A clip in
// the music domain needs the tempo map and is not drawn by this timeline yet.
export function clipRects(snapshot: Snapshot, view: Viewport): ClipRect[] {
  const lanes = new Map(snapshot.trackOrder.map((id, index) => [id, index]));
  const tops = laneTops(snapshot.trackOrder, view);
  const rects: ClipRect[] = [];
  for (const clip of snapshot.clips) {
    const lane = lanes.get(clip.trackId);
    if (lane === undefined || clip.position.domain !== 'audio') continue;
    rects.push({
      clipId: clip.id,
      trackId: clip.trackId,
      mediaId: clip.mediaId,
      position: clip.position.value,
      sourceStart: clip.sourceStart,
      length: clip.length,
      x: frameToX(clip.position.value, view),
      y: tops[lane]!,
      width: pixelsOf(big(clip.length), view),
      height: laneHeightOf(clip.trackId, view),
    });
  }
  rects.sort((a, b) => (lanes.get(a.trackId)! - lanes.get(b.trackId)!) || (a.x - b.x));
  return rects;
}

// The clip under a point, topmost (last drawn) first, and which part of it:
// the lower corners (cornerSize), then the edges (HANDLE_PX, or a third of a
// clip narrower than three handles), then the volume control, then the body.
export function hitTest(rects: readonly ClipRect[], x: number, y: number): { rect: ClipRect; part: HitPart } | null {
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i]!;
    if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) continue;
    const corner = cornerSize(rect);
    if (y >= rect.y + rect.height - corner) {
      if (x < rect.x + corner) return { rect, part: 'cornerLeft' };
      if (x >= rect.x + rect.width - corner) return { rect, part: 'cornerRight' };
    }
    const handle = Math.min(HANDLE_PX, rect.width / 3);
    if (x < rect.x + handle) return { rect, part: 'left' };
    if (x >= rect.x + rect.width - handle) return { rect, part: 'right' };
    const gain = gainBox(rect);
    if (gain && x >= gain.x && x < gain.x + gain.width && y >= gain.y) return { rect, part: 'gain' };
    return { rect, part: 'body' };
  }
  return null;
}

// A move: the position plus the delta, never before the timeline's start.
export function snapMove(position: string, delta: bigint): string {
  const moved = big(position) + delta;
  return (moved < 0n ? 0n : moved).toString();
}

function clamp(value: bigint, low: bigint, high: bigint): bigint {
  return value < low ? low : value > high ? high : value;
}

// A trim: the right edge changes the length within the media; the left edge
// moves the start in the media and on the timeline together (the audio stays
// where it was), within the media, after the timeline's start, and leaving
// at least one frame.
export function snapTrim(
  clip: ClipEntity,
  mediaFrames: string,
  edge: TrimEdge,
  delta: bigint,
): { position: string; sourceStart: string; length: string } {
  const position = big(clip.position.value);
  const sourceStart = big(clip.sourceStart);
  const length = big(clip.length);
  if (edge === 'right') {
    const next = clamp(length + delta, 1n, big(mediaFrames) - sourceStart);
    return { position: position.toString(), sourceStart: sourceStart.toString(), length: next.toString() };
  }
  const lowest = -(sourceStart < position ? sourceStart : position);
  const d = clamp(delta, lowest, length - 1n);
  return { position: (position + d).toString(), sourceStart: (sourceStart + d).toString(), length: (length - d).toString() };
}
