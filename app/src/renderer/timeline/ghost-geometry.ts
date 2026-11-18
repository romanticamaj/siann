// Where the event display draws the ghosts (m5b-ui-ghosts). Stub.

import type { Box, Viewport } from './geometry';
import type { BandRect, LocatorRange } from './locators';

export const MOVED_ORIGINAL_ALPHA = 0;
export const GHOST_HATCH_PITCH = 0;
export const GHOST_HATCH_WIDTH = 0;
export const GHOST_DASH: readonly number[] = [];
export const GHOST_OUTLINE_W = 0;
export const LANE_HATCH_PITCH = 0;
export const LANE_HATCH_WIDTH = 0;
export const STEP_DISC = { x: 0, y: 0, r: 0, titleX: 0 } as const;
export const ARROW = { inset: 0, bottom: 0, head: 0, half: 0, dot: 0, width: 0 } as const;

export interface GhostLane extends Box {
  readonly key: string;
}

export function ghostLaneRects(_order: readonly string[], _keys: readonly string[], _view: Viewport): GhostLane[] {
  return [];
}

export function ghostClipBox(_laneTop: number, _laneHeight: number, _position: string, _length: string, _view: Viewport): Box & { readonly radius: number } {
  return { x: 0, y: 0, width: 0, height: 0, radius: 0 };
}

export function arrowOf(_from: Box, _to: Box): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: 0, y0: 0, x1: 0, y1: 0 };
}

export function locatorGhostRect(_range: LocatorRange, _view: Viewport): BandRect | null {
  return null;
}
