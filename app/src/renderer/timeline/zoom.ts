// Zoom and scroll of the event display (UI redesign spec 3.2, "Zoom and
// scroll"; Cubase's H / G, Ctrl+wheel, Shift+H / Shift+G, Ctrl+Shift+wheel,
// Shift+F, Shift+wheel): pure functions from one Viewport to the next.
// A horizontal zoom keeps the frame under its anchor (the pointer, the project
// cursor or the view's centre) where it was, in whole frames per pixel from 1
// to MAX_FRAMES_PER_PIXEL; the scroll never goes before the session's start.
// Positions stay BigInt, as in geometry.ts. Framework-free.

import { MAX_LANE_HEIGHT, MIN_LANE_HEIGHT, clampLaneHeight, xToFrame, type Viewport } from './geometry';

// H and G halve and double the frames per pixel.
export const ZOOM_STEP = 2;
// About 4.5 hours across 1000 px at 48 kHz.
export const MAX_FRAMES_PER_PIXEL = 1 << 20;
// Lane height presets for Shift+H / Shift+G (spec 1.4: 26 compact, 53 normal, 96 tall).
export const LANE_HEIGHT_STEPS: readonly number[] = [MIN_LANE_HEIGHT, 26, 32, 40, 53, 64, 80, 96, 128, 160, 200, MAX_LANE_HEIGHT];

function clampFpp(value: number): number {
  return Math.min(MAX_FRAMES_PER_PIXEL, Math.max(1, value));
}

function nonNegative(frame: bigint): string {
  return (frame < 0n ? 0n : frame).toString();
}

// The view zoomed by `factor` (below 1: in) about canvas x `anchorX`.
export function zoomAbout(view: Viewport, anchorX: number, factor: number): Viewport {
  if (!(factor > 0) || !Number.isFinite(factor)) return view;
  const current = view.framesPerPixel;
  let next = clampFpp(Math.round(current * factor));
  // A step always changes the zoom while it can.
  if (next === current && factor !== 1) next = clampFpp(current + (factor < 1 ? -1 : 1));
  if (next === current) return view;
  const anchor = xToFrame(anchorX, view);
  const scroll = anchor - BigInt(Math.round(anchorX * next));
  return { ...view, framesPerPixel: next, scrollFrames: nonNegative(scroll) };
}

// Zoom Full (Shift+F): [0, end] fits the width, as close as whole frames allow.
export function zoomFull(view: Viewport, endFrame: bigint): Viewport {
  if (endFrame <= 0n) return { ...view, scrollFrames: '0' };
  const width = BigInt(Math.max(1, Math.floor(view.width)));
  const fpp = clampFpp(Number((endFrame + width - 1n) / width));
  return { ...view, framesPerPixel: fpp, scrollFrames: '0' };
}

// Zoom to Selection and Zoom to Event (Alt+S, Shift+E; m5-ui-edit-basics):
// [start, end] and a margin of `margin` of its length either side fit the width.
export function zoomToRange(view: Viewport, start: bigint, end: bigint, margin = 0.05): Viewport {
  if (end <= start) return view;
  const length = end - start;
  const pad = (length * BigInt(Math.round(margin * 1000))) / 1000n;
  const width = BigInt(Math.max(1, Math.floor(view.width)));
  const fpp = clampFpp(Number((length + 2n * pad + width - 1n) / width));
  const scroll = nonNegative(start - pad);
  if (fpp === view.framesPerPixel && scroll === view.scrollFrames) return view;
  return { ...view, framesPerPixel: fpp, scrollFrames: scroll };
}

// Shift+wheel (and a trackpad's horizontal swipe): scroll by `dx` pixels.
export function scrollFramesBy(view: Viewport, dx: number): Viewport {
  const delta = BigInt(Math.round(dx * view.framesPerPixel));
  const next = nonNegative(BigInt(view.scrollFrames) + delta);
  return next === view.scrollFrames ? view : { ...view, scrollFrames: next };
}

// The largest vertical scroll for lanes `content` px high in this view.
export function maxScrollY(view: Viewport, content: number): number {
  const visible = Math.max(0, (view.height ?? 0) - view.rulerHeight);
  return Math.max(0, Math.ceil(content - visible));
}

// The wheel: scroll the lanes by `dy` pixels within their height.
export function scrollYBy(view: Viewport, dy: number, content: number): Viewport {
  const next = Math.min(maxScrollY(view, content), Math.max(0, Math.round((view.scrollY ?? 0) + dy)));
  return next === (view.scrollY ?? 0) ? view : { ...view, scrollY: next };
}

// Shift+H (+1) and Shift+G (-1): the next preset height in that direction.
export function stepLaneHeight(height: number, direction: 1 | -1): number {
  const current = clampLaneHeight(height);
  if (direction > 0) return LANE_HEIGHT_STEPS.find((h) => h > current) ?? MAX_LANE_HEIGHT;
  return [...LANE_HEIGHT_STEPS].reverse().find((h) => h < current) ?? MIN_LANE_HEIGHT;
}
