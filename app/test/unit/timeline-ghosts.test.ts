// Where the event display draws the ghosts (m5b-ui-ghosts; UI redesign 4.2,
// 5.2; mockup.html draw()): timeline/ghost-geometry.ts places a ghost clip as
// draw()'s clip() places a clip (its box inset from its bars and lane), the
// original of a moved clip where it is, the arrow from 10 px into the old box
// to 10 px into the new one, 6 px above the lane's bottom, a proposed track's
// lane under the last lane, and the locator ghost band where the band of the
// new range would be. The expectations are draw()'s numbers for the mockup's
// Riser (bar 6 to bar 7 on FX, the seventh lane) at the mockup's zoom (40 px
// per bar) and at twice that, written out by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Viewport } from '../../src/renderer/timeline/geometry';
import {
  ARROW,
  GHOST_DASH,
  GHOST_HATCH_PITCH,
  GHOST_HATCH_WIDTH,
  GHOST_OUTLINE_W,
  LANE_HATCH_PITCH,
  LANE_HATCH_WIDTH,
  MOVED_ORIGINAL_ALPHA,
  STEP_DISC,
  arrowOf,
  ghostClipBox,
  ghostLaneRects,
  locatorGhostRect,
} from '../../src/renderer/timeline/ghost-geometry';

const BAR = 96000;
const ORDER = ['t1', 't2', 't3', 't4', 't5', 't6', 'fx'];

// The mockup's view: 40 px per bar is 2400 frames per pixel at 48 kHz and 120 BPM.
function view(framesPerPixel: number): Viewport {
  return { framesPerPixel, scrollFrames: '0', rulerHeight: 40, lanesTop: 60, laneHeight: 53, width: 1000, height: 484 };
}

test('draw()\'s constants: the original at 38 %, the hatch, the dash, the outline, the step disc and the arrow', () => {
  assert.equal(MOVED_ORIGINAL_ALPHA, 0.38);
  assert.equal(GHOST_HATCH_PITCH, 11);
  assert.equal(GHOST_HATCH_WIDTH, 4);
  assert.deepEqual([...GHOST_DASH], [4, 3]);
  assert.equal(GHOST_OUTLINE_W, 1.25);
  assert.equal(LANE_HATCH_PITCH, 14);
  assert.equal(LANE_HATCH_WIDTH, 5);
  assert.deepEqual({ ...STEP_DISC }, { x: 8.5, y: 6.5, r: 5.2, titleX: 18 });
  assert.deepEqual({ ...ARROW }, { inset: 10, bottom: 6, head: 6, half: 3.5, dot: 2.2, width: 1.5 });
});

test('the moved Riser: the original box, the ghost box and the arrow at the mockup\'s zoom', () => {
  const v = view(2400);
  const lanes = ghostLaneRects(ORDER, [], v);
  assert.deepEqual(lanes, []);
  const fxTop = 60 + 6 * 53;
  const original = ghostClipBox(fxTop, 53, String(5 * BAR), String(2 * BAR), v);
  const ghost = ghostClipBox(fxTop, 53, String(6 * BAR), String(2 * BAR), v);
  // xb(6)+1, laneY+3, 2 bars - 2, LANE - 7.
  assert.deepEqual({ ...original }, { x: 201, y: 381, width: 78, height: 46, radius: 4 });
  assert.deepEqual({ ...ghost }, { x: 241, y: 381, width: 78, height: 46, radius: 4 });
  // y = laneY + LANE - 6, x0 = xb(6) + 10, x1 = xb(7) + 10.
  assert.deepEqual(arrowOf(original, ghost), { x0: 210, y0: 425, x1: 250, y1: 425 });
});

test('at twice the zoom the boxes and the arrow scale with the bars', () => {
  const v = view(1200);
  const fxTop = 60 + 6 * 53;
  const original = ghostClipBox(fxTop, 53, String(5 * BAR), String(2 * BAR), v);
  const ghost = ghostClipBox(fxTop, 53, String(6 * BAR), String(2 * BAR), v);
  assert.deepEqual({ ...original }, { x: 401, y: 381, width: 158, height: 46, radius: 4 });
  assert.deepEqual({ ...ghost }, { x: 481, y: 381, width: 158, height: 46, radius: 4 });
  assert.deepEqual(arrowOf(original, ghost), { x0: 410, y0: 425, x1: 490, y1: 425 });
});

test('a proposed track\'s lane is under the last lane, one lane high, and a second under it', () => {
  assert.deepEqual(ghostLaneRects(ORDER, ['ghost'], view(2400)), [{ key: 'ghost', x: 0, y: 431, width: 1000, height: 53 }]);
  assert.deepEqual(ghostLaneRects(ORDER, ['ghost', 'ghost-2'], { ...view(1200), scrollY: 20 }), [
    { key: 'ghost', x: 0, y: 411, width: 1000, height: 53 },
    { key: 'ghost-2', x: 0, y: 464, width: 1000, height: 53 },
  ]);
  // The mockup's ghost clip, Pad swell on the eighth lane from bar 9 for 8 bars.
  assert.deepEqual({ ...ghostClipBox(431, 53, String(8 * BAR), String(8 * BAR), view(2400)) }, { x: 321, y: 434, width: 318, height: 46, radius: 4 });
});

test('the locator ghost band is where the band of the new range would be', () => {
  // Bars 9 to 13: draw()'s band at L0 = 320, L1 = 480, from y 2 to RU - 1.
  assert.deepEqual(locatorGhostRect({ left: BigInt(8 * BAR), right: BigInt(12 * BAR) }, view(2400)), { x: 320, y: 2, width: 160, height: 15 });
  assert.deepEqual(locatorGhostRect({ left: BigInt(8 * BAR), right: BigInt(12 * BAR) }, view(1200)), { x: 640, y: 2, width: 320, height: 15 });
});
