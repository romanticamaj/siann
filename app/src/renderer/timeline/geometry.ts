// The timeline's geometry (spec, "Frontend"): audio-domain sample frames to
// canvas pixels and back at a zoom (whole frames per pixel) and a scroll,
// clip rectangles in root.trackOrder lanes, hit testing of a clip's body, its
// lower resize corners, its edges and its volume control (m5-ui-edit-basics),
// and the clamping a move or trim ends in (the grid is snap.ts's). Lanes have their own
// heights (UI redesign spec 2.3: 53 px by default, 24-240 px, a view setting
// kept per session id) and scroll vertically under the fixed ruler and the
// marker track row (m5-ui-arrange); a clip is drawn, and hit, as the mockup's
// draw() draws it (m5-ui-port-arrange-canvas: clipBox). Coordinates are the event display canvas's, which begins
// right of the track list, so nothing here knows the list's width. Positions are
// decimal strings, as the document carries them; arithmetic on them is
// BigInt, so a position beyond 2^53 keeps every frame. Framework-free.

import type { ClipEntity, ClipFade } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { TOKENS } from '../tokens';
import { fadeAreaAt, fadeHandleAt } from './fades';

export interface Viewport {
  // Whole sample frames per CSS pixel (the zoom), at least 1.
  readonly framesPerPixel: number;
  // The frame at x = 0, a decimal string.
  readonly scrollFrames: string;
  // The ruler's height: its two halves' hit zones end here.
  readonly rulerHeight: number;
  // Pixels above the first lane: the ruler and the marker track row under it
  // (LANES_TOP; m5-ui-port-arrange-canvas). The ruler's height when absent.
  readonly lanesTop?: number;
  // The height of a lane the map does not name.
  readonly laneHeight: number;
  // Track id -> lane height in px (clamped to MIN..MAX_LANE_HEIGHT).
  readonly laneHeights?: Readonly<Record<string, number>>;
  // Pixels the lanes are scrolled up under the ruler, at least 0.
  readonly scrollY?: number;
  readonly width: number;
  readonly height?: number;
}

// The ruler above the lanes, in two halves (UI redesign spec 3.2): the upper
// one is the locators' (m5-ui-loop-click), the lower one the cursor's and the
// zoom's. RULER_UPPER is the one constant the upper half's geometry (the
// locator band, the hit test, the half boundary of the ruler's gestures) and
// its tests take its height from. The heights are the tokens.css --ruler-h,
// --ruler-upper-h and --ruler-lower-h (tokens.ts), as the track list's head.
export const RULER_HEIGHT = Number.parseFloat(TOKENS['ruler-h']);
export const RULER_UPPER = Number.parseFloat(TOKENS['ruler-upper-h']);
export const RULER_LOWER = Number.parseFloat(TOKENS['ruler-lower-h']);
// The marker track row under the ruler (--marker-h, UI redesign 3.2), empty
// until m5b-ui-markers (spec 3.0: an absent part keeps its space), and the
// lanes below it, as the mockup's draw() lays them out (TOP = RULER + MK).
export const MARKER_HEIGHT = Number.parseFloat(TOKENS['marker-h']);
export const LANES_TOP = RULER_HEIGHT + MARKER_HEIGHT;

// --track-h, the mockup's lane.
export const DEFAULT_LANE_HEIGHT = Number.parseFloat(TOKENS['track-h']);
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

// Where the lanes begin: below the ruler and the marker track row.
export function lanesTopOf(view: Viewport): number {
  return view.lanesTop ?? view.rulerHeight;
}

// The top of each lane in trackOrder, in canvas pixels (the ruler and the
// marker row above, the scroll applied).
export function laneTops(trackOrder: readonly string[], view: Viewport): number[] {
  const tops: number[] = [];
  let top = lanesTopOf(view) - (view.scrollY ?? 0);
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
  // The clip's fades (m5b-ui-fades), present only while the clip has them.
  readonly fadeIn?: ClipFade;
  readonly fadeOut?: ClipFade;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The mockup's draw(), clip(): a clip's box is inset 1 px from its bars and
// 3 px from its lane's top, 7 px shorter than the lane (46 px of a 53 px
// lane), with a 4 px radius; its title strip is --clip-title-h high; its
// lower corners carry 6 px resize squares, reaching 1 px past the box's
// left and right sides.
export const CLIP_INSET_X = 1;
export const CLIP_INSET_TOP = 3;
export const CLIP_INSET_H = 7;
export const CLIP_RADIUS = 4;
export const CLIP_TITLE_HEIGHT = Number.parseFloat(TOKENS['clip-title-h']);
export const CORNER_HANDLE = 6;

export function clipBox(rect: Box): Box & { readonly radius: number } {
  return {
    x: rect.x + CLIP_INSET_X,
    y: rect.y + CLIP_INSET_TOP,
    width: Math.max(0, rect.width - 2 * CLIP_INSET_X),
    height: Math.max(0, rect.height - CLIP_INSET_H),
    radius: CLIP_RADIUS,
  };
}

export function titleStrip(box: Box): Box {
  return { x: box.x, y: box.y, width: box.width, height: Math.min(CLIP_TITLE_HEIGHT, box.height) };
}

// fillRect(x-1, y+h-6, 6, 6) and fillRect(x+w-5, y+h-6, 6, 6).
export function cornerHandles(box: Box): [Box, Box] {
  const y = box.y + box.height - CORNER_HANDLE;
  return [
    { x: box.x - 1, y, width: CORNER_HANDLE, height: CORNER_HANDLE },
    { x: box.x + box.width - CORNER_HANDLE + 1, y, width: CORNER_HANDLE, height: CORNER_HANDLE },
  ];
}

// A clip's parts (UI redesign spec 3.2, "Clip handles"), over its box: the
// lower corners resize, the rest of each edge is a narrower resize target as
// well, the volume control is draw()'s box right of the lower-left corner,
// and the body moves. With fades enabled (m5b-ui-fades; 10.11, 23): the fade
// handles ('fadeIn', 'fadeOut': draw()'s triangles at the fades' ends, with
// the 4 px margin) and the shaded areas ('fadeInArea', 'fadeOutArea': a
// double-click there switches the curve; a drag moves as the body does).
export type HitPart = 'body' | 'left' | 'right' | 'cornerLeft' | 'cornerRight' | 'gain' | 'repeat' | 'fadeIn' | 'fadeOut' | 'fadeInArea' | 'fadeOutArea';
export type TrimEdge = 'left' | 'right';

// The width of the resize target along each edge, in pixels.
export const HANDLE_PX = 4;
// The resize targets in the lower corners, in pixels.
export const CORNER_PX = 8;
// The volume control: draw()'s rr(x+9, y+h-12, 38, 10, 3) in the box, and
// the smallest box that has one (the control and a corner target beside it).
export const GAIN_X = 9;
export const GAIN_BOTTOM = 12;
export const GAIN_W = 38;
export const GAIN_H = 10;
export const GAIN_RADIUS = 3;
export const GAIN_MIN_WIDTH = GAIN_X + GAIN_W + CORNER_PX + 1;
export const GAIN_MIN_HEIGHT = 30;

// The repeat handle (m5b-ui-edit-more; spec 3.2, "Clip handles"): draw()'s
// disc arc(x+w, y+HDR+(h-HDR)/2, 3.2) on the right border, half way down
// below the title strip, and its hit target, REPEAT_HIT_PX around its centre
// inside the box. The canvas draws it on the selected clips; on another
// clip its target is the right edge's.
export const REPEAT_RADIUS = 3.2;
export const REPEAT_HIT_PX = 4;

export function repeatHandle(box: Box): { readonly x: number; readonly y: number; readonly radius: number } {
  const title = Math.min(CLIP_TITLE_HEIGHT, box.height);
  return { x: box.x + box.width, y: box.y + title + (box.height - title) / 2, radius: REPEAT_RADIUS };
}

// The edge a resize part changes, or null for the body and the volume control.
export function trimEdgeOf(part: HitPart): TrimEdge | null {
  if (part === 'left' || part === 'cornerLeft') return 'left';
  if (part === 'right' || part === 'cornerRight') return 'right';
  return null;
}

// The size of a box's corner targets: CORNER_PX, less on a narrow or short clip.
export function cornerSize(box: Pick<Box, 'width' | 'height'>): number {
  return Math.min(CORNER_PX, box.width / 3, box.height / 2);
}

// The volume control's box (draw()'s, in the clip's box), or null on a clip
// too small for one.
export function gainBox(rect: Box): Box | null {
  const box = clipBox(rect);
  if (box.width < GAIN_MIN_WIDTH || box.height < GAIN_MIN_HEIGHT) return null;
  return { x: box.x + GAIN_X, y: box.y + box.height - GAIN_BOTTOM, width: GAIN_W, height: GAIN_H };
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

// The track whose lane holds y, or null on the ruler, in the marker track
// row or below the lanes.
export function trackAt(snapshot: Snapshot, y: number, view: Viewport): string | null {
  if (y < lanesTopOf(view)) return null;
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
      ...(clip.fadeIn ? { fadeIn: clip.fadeIn } : {}),
      ...(clip.fadeOut ? { fadeOut: clip.fadeOut } : {}),
    });
  }
  rects.sort((a, b) => (lanes.get(a.trackId)! - lanes.get(b.trackId)!) || (a.x - b.x));
  return rects;
}

// Frames per pixel of a clip's rectangle (its length over its width).
export function rectFramesPerPixel(rect: Pick<ClipRect, 'length' | 'width'>): number {
  const length = Number(rect.length);
  return rect.width > 0 && length > 0 ? length / rect.width : 1;
}

export interface HitOptions {
  // The fade handles and shaded areas are hit (m5b-ui-fades: the engine lists
  // features.clipFades and clip.set_fade). Off when absent.
  readonly fades?: boolean;
}

// The clip under a point, topmost (last drawn) first, and which part of it,
// over the box draw() draws (clipBox): with fades enabled the fade handles
// first (fades.ts: the nearer one where both take the point), then the lower
// corners (cornerSize), then the repeat handle, then the edges (HANDLE_PX, or
// a third of a clip narrower than three handles), then the volume control,
// then, with fades enabled, a fade's shaded area, then the body.
export function hitTest(rects: readonly ClipRect[], x: number, y: number, options: HitOptions = {}): { rect: ClipRect; part: HitPart } | null {
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i]!;
    const box = clipBox(rect);
    if (x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height) continue;
    if (options.fades) {
      const side = fadeHandleAt(box, rect, rectFramesPerPixel(rect), x, y);
      if (side) return { rect, part: side };
    }
    const corner = cornerSize(box);
    if (y >= box.y + box.height - corner) {
      if (x < box.x + corner) return { rect, part: 'cornerLeft' };
      if (x >= box.x + box.width - corner) return { rect, part: 'cornerRight' };
    }
    const repeat = repeatHandle(box);
    if (x >= repeat.x - REPEAT_HIT_PX && Math.abs(y - repeat.y) <= REPEAT_HIT_PX) return { rect, part: 'repeat' };
    const handle = Math.min(HANDLE_PX, box.width / 3);
    if (x < box.x + handle) return { rect, part: 'left' };
    if (x >= box.x + box.width - handle) return { rect, part: 'right' };
    const gain = gainBox(rect);
    if (gain && x >= gain.x && x < gain.x + gain.width && y >= gain.y && y < gain.y + gain.height) return { rect, part: 'gain' };
    if (options.fades) {
      const area = fadeAreaAt(box, rect, rectFramesPerPixel(rect), x, y);
      if (area) return { rect, part: area === 'fadeIn' ? 'fadeInArea' : 'fadeOutArea' };
    }
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
