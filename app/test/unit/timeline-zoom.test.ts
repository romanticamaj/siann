// Zoom and scroll of the event display (m5-ui-arrange; UI redesign spec 3.2,
// "Zoom and scroll"): a horizontal zoom keeps the frame under its anchor (the
// pointer, or the project cursor) where it was, never goes below one frame per
// pixel and never scrolls before the session's start; Zoom Full fits the
// session into the width; Shift+wheel scrolls horizontally, the wheel
// vertically within the lanes; Shift+H and Shift+G step the track heights
// within 24-240 px. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { xToFrame, type Viewport } from '../../src/renderer/timeline/geometry';
import {
  MAX_FRAMES_PER_PIXEL,
  ZOOM_STEP,
  scrollFramesBy,
  scrollYBy,
  stepLaneHeight,
  zoomAbout,
  zoomFull,
} from '../../src/renderer/timeline/zoom';

const VIEW: Viewport = { framesPerPixel: 100, scrollFrames: '4800000', rulerHeight: 32, laneHeight: 53, width: 800, height: 400, scrollY: 0 };

function frameAt(x: number, view: Viewport): bigint {
  return xToFrame(x, view);
}

function within(a: bigint, b: bigint, frames: bigint): boolean {
  const d = a - b;
  return (d < 0n ? -d : d) <= frames;
}

test('zooming in and out keeps the frame under the anchor within one frame', () => {
  assert.equal(ZOOM_STEP, 2);
  for (const anchor of [0, 1, 137.5, 400, 799]) {
    for (const factor of [1 / ZOOM_STEP, ZOOM_STEP, 0.8, 1.25, 7]) {
      const before = frameAt(anchor, VIEW);
      const next = zoomAbout(VIEW, anchor, factor);
      assert.notEqual(next.framesPerPixel, VIEW.framesPerPixel, `${anchor} ${factor}`);
      assert.ok(within(frameAt(anchor, next), before, 1n), `anchor ${anchor}, factor ${factor}: ${frameAt(anchor, next)} vs ${before}`);
    }
  }
  // H halves the frames per pixel, G doubles them.
  assert.equal(zoomAbout(VIEW, 400, 1 / ZOOM_STEP).framesPerPixel, 50);
  assert.equal(zoomAbout(VIEW, 400, ZOOM_STEP).framesPerPixel, 200);
});

test('the zoom clamps at one frame per pixel and at the maximum, and scroll never goes below 0', () => {
  const close = { ...VIEW, framesPerPixel: 1 };
  assert.equal(zoomAbout(close, 400, 0.5).framesPerPixel, 1);
  assert.equal(zoomAbout({ ...VIEW, framesPerPixel: 3 }, 400, 0.5).framesPerPixel, 2, 'a step always changes the zoom while it can');
  const far = { ...VIEW, framesPerPixel: MAX_FRAMES_PER_PIXEL };
  assert.equal(zoomAbout(far, 400, 2).framesPerPixel, MAX_FRAMES_PER_PIXEL);
  // Zooming out about the right edge near the start would scroll before 0.
  const start = { ...VIEW, scrollFrames: '0' };
  const out = zoomAbout(start, 200, 4);
  assert.equal(out.scrollFrames, '0');
  assert.equal(out.framesPerPixel, 400);
});

test('the zoom keeps positions beyond 2^53 exact', () => {
  const far = { ...VIEW, framesPerPixel: 4, scrollFrames: '9007199254740000' };
  const before = frameAt(300, far);
  const next = zoomAbout(far, 300, 0.5);
  assert.equal(frameAt(300, next), before);
});

test('Zoom Full fits [0, the last clip end] into the width', () => {
  const full = zoomFull(VIEW, 1_000_000n);
  assert.equal(full.scrollFrames, '0');
  assert.ok(Number(1_000_000n) / full.framesPerPixel <= VIEW.width, 'the end is inside the width');
  assert.ok(Number(1_000_000n) / (full.framesPerPixel - 1) > VIEW.width, 'and no closer zoom would fit it');
  assert.equal(full.framesPerPixel, 1250);
  // An empty session: one frame per pixel is not useful; the zoom stays.
  assert.equal(zoomFull(VIEW, 0n).framesPerPixel, VIEW.framesPerPixel);
  assert.equal(zoomFull(VIEW, 0n).scrollFrames, '0');
  // A short session never zooms closer than one frame per pixel.
  assert.equal(zoomFull(VIEW, 10n).framesPerPixel, 1);
});

test('Shift+wheel scrolls horizontally by the wheel delta in pixels, not before 0', () => {
  assert.equal(scrollFramesBy(VIEW, 30).scrollFrames, String(4800000 + 30 * 100));
  assert.equal(scrollFramesBy(VIEW, -100).scrollFrames, String(4800000 - 100 * 100));
  assert.equal(scrollFramesBy(VIEW, -100_000).scrollFrames, '0');
  assert.equal(scrollFramesBy(VIEW, 30).framesPerPixel, VIEW.framesPerPixel, 'the zoom stays');
});

test('the wheel scrolls the lanes vertically within their height', () => {
  // 400 high with a 32 px ruler: 368 px of lanes visible; 10 lanes of 53 px are 530.
  assert.equal(scrollYBy(VIEW, 40, 530).scrollY, 40);
  assert.equal(scrollYBy(VIEW, 1000, 530).scrollY, 530 - 368);
  assert.equal(scrollYBy({ ...VIEW, scrollY: 20 }, -100, 530).scrollY, 0);
  // Lanes that fit do not scroll.
  assert.equal(scrollYBy(VIEW, 40, 200).scrollY, 0);
  assert.equal(scrollYBy(VIEW, 40, 530).scrollFrames, VIEW.scrollFrames);
});

test('Shift+H and Shift+G step a lane height through the presets within 24-240 px', () => {
  assert.equal(stepLaneHeight(53, 1), 64);
  assert.equal(stepLaneHeight(53, -1), 40);
  assert.equal(stepLaneHeight(96, -1), 80);
  assert.equal(stepLaneHeight(26, -1), 24);
  assert.equal(stepLaneHeight(24, -1), 24);
  assert.equal(stepLaneHeight(240, 1), 240);
  // A dragged height between presets goes to the next preset in that direction.
  assert.equal(stepLaneHeight(57, 1), 64);
  assert.equal(stepLaneHeight(57, -1), 53);
  // Out-of-range values are clamped first.
  assert.equal(stepLaneHeight(10, 1), 26);
  assert.equal(stepLaneHeight(999, -1), 200);
});
