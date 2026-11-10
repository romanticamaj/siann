// The timeline's geometry (spec, "Frontend"): audio-domain sample frames to
// canvas pixels and back at a zoom (whole frames per pixel) and a scroll,
// clip rectangles in root.trackOrder lanes, hit testing of a clip's body and
// trim handles, and the snapping a move or trim ends in. Positions are
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
  // Pixels per track lane.
  readonly laneHeight: number;
  readonly width: number;
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

export type HitPart = 'body' | 'left' | 'right';
export type TrimEdge = 'left' | 'right';

// The width of a trim handle at each end of a clip, in pixels.
export const HANDLE_PX = 6;

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

export function laneTop(index: number, view: Viewport): number {
  return view.rulerHeight + index * view.laneHeight;
}

// The track whose lane holds y, or null above or below the lanes.
export function trackAt(snapshot: Snapshot, y: number, view: Viewport): string | null {
  if (y < view.rulerHeight) return null;
  const index = Math.floor((y - view.rulerHeight) / view.laneHeight);
  return snapshot.trackOrder[index] ?? null;
}

// Every audio-domain clip of a track in trackOrder, in that order. A clip in
// the music domain needs the tempo map and is not drawn by this timeline yet.
export function clipRects(snapshot: Snapshot, view: Viewport): ClipRect[] {
  const lanes = new Map(snapshot.trackOrder.map((id, index) => [id, index]));
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
      y: laneTop(lane, view),
      width: pixelsOf(big(clip.length), view),
      height: view.laneHeight,
    });
  }
  rects.sort((a, b) => (lanes.get(a.trackId)! - lanes.get(b.trackId)!) || (a.x - b.x));
  return rects;
}

// The clip under a point, topmost (last drawn) first, and which part of it:
// a handle is HANDLE_PX wide, or a third of a clip narrower than three handles.
export function hitTest(rects: readonly ClipRect[], x: number, y: number): { rect: ClipRect; part: HitPart } | null {
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i]!;
    if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) continue;
    const handle = Math.min(HANDLE_PX, rect.width / 3);
    if (x < rect.x + handle) return { rect, part: 'left' };
    if (x >= rect.x + rect.width - handle) return { rect, part: 'right' };
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
