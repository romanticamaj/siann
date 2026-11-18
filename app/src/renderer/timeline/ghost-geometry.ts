// Where the event display draws the ghosts (m5b-ui-ghosts; UI redesign 4.2,
// 5.2), from the mockup's draw(): a ghost clip is placed as clip() places a
// clip (geometry.ts clipBox: inset 1 px from its bars and 3 px from its lane,
// 7 px shorter than the lane), its body hatched with 4 px lines every 11 px,
// its outline dashed 4/3 at 1.25 px, its step on a disc of radius 5.2 at
// (8.5, 6.5) with the title moved to 18 px; the original of a moved or
// trimmed clip is drawn at 38 %; the arrow runs from 10 px into the original's
// lane rectangle to 10 px into the ghost's, 6 px above the lane's bottom, 1.5
// px wide with a 6 px head 7 px across and a 2.2 px dot at its start; a
// proposed track's lane lies under the last lane, as high as a lane, hatched
// with 5 px lines every 14 px; the locator ghost band is the band
// (locators.ts bandRect) of the new range. Pure.

import { clipBox, frameToX, laneHeightOf, laneTops, type Box, type Viewport } from './geometry';
import { bandRect, type BandRect, type LocatorRange } from './locators';

// draw(): `if(old) g.globalAlpha=.38`.
export const MOVED_ORIGINAL_ALPHA = 0.38;
export const GHOST_HATCH_PITCH = 11;
export const GHOST_HATCH_WIDTH = 4;
export const GHOST_DASH: readonly number[] = Object.freeze([4, 3]);
export const GHOST_OUTLINE_W = 1.25;
// The proposed lane's hatch (draw(): lineWidth 5, x += 14).
export const LANE_HATCH_PITCH = 14;
export const LANE_HATCH_WIDTH = 5;
// The step's disc on a ghost clip, and where its title then starts.
export const STEP_DISC = Object.freeze({ x: 8.5, y: 6.5, r: 5.2, titleX: 18 });
export const ARROW = Object.freeze({ inset: 10, bottom: 6, head: 6, half: 3.5, dot: 2.2, width: 1.5 });
// The hovered step's outline on the overlay, outside the ghost's box.
export const HOT_OUTLINE_W = 2;

export interface GhostLane extends Box {
  readonly key: string;
}

// The proposed tracks' lanes, in step order, under the last lane of `order`.
export function ghostLaneRects(order: readonly string[], keys: readonly string[], view: Viewport): GhostLane[] {
  const tops = laneTops(order, view);
  const start = order.length > 0 ? tops[tops.length - 1]! + laneHeightOf(order[order.length - 1]!, view) : (view.lanesTop ?? view.rulerHeight) - (view.scrollY ?? 0);
  return keys.map((key, index) => ({ key, x: 0, y: start + index * view.laneHeight, width: view.width, height: view.laneHeight }));
}

// The box of a clip at `position` for `length` frames in the lane at laneTop.
export function ghostClipBox(laneTop: number, laneHeight: number, position: string, length: string, view: Viewport): Box & { readonly radius: number } {
  const x = frameToX(position, view);
  return clipBox({ x, y: laneTop, width: Number(BigInt(length)) / view.framesPerPixel, height: laneHeight });
}

// The arrow from an original clip's box to its ghost's (both clipBox boxes).
export function arrowOf(from: Box, to: Box): { x0: number; y0: number; x1: number; y1: number } {
  // A box is inset 1 px from its lane rectangle and 3 px from its lane's top, 7 px shorter than the lane.
  const lane = (box: Box) => ({ x: box.x - 1, bottom: box.y - 3 + box.height + 7 });
  const a = lane(from);
  const b = lane(to);
  return { x0: a.x + ARROW.inset, y0: a.bottom - ARROW.bottom, x1: b.x + ARROW.inset, y1: b.bottom - ARROW.bottom };
}

export function locatorGhostRect(range: LocatorRange, view: Viewport): BandRect | null {
  return bandRect(range, view);
}

// The smallest scroll (frames, pixels) that shows `box` in the view, or null when it shows already.
export function revealScroll(box: Box, view: Viewport, lanesTop: number, maxScrollY: number): { readonly dx: number; readonly dy: number } | null {
  let dx = 0;
  if (box.x < 0) dx = box.x;
  else if (box.x + box.width > view.width) dx = Math.min(box.x, box.x + box.width - view.width);
  const height = view.height ?? 0;
  let dy = 0;
  if (box.y < lanesTop) dy = box.y - lanesTop;
  else if (box.y + box.height > height) dy = Math.min(box.y - lanesTop, box.y + box.height - height);
  const scrollY = view.scrollY ?? 0;
  dy = Math.max(-scrollY, Math.min(maxScrollY - scrollY, dy));
  dx = Math.round(dx);
  dy = Math.round(dy);
  return dx === 0 && dy === 0 ? null : { dx, dy };
}
