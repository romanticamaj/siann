// Timeline zoom and scroll math (UX pass, A15): zoom around the pointer keeps
// the frame under it, zoom-to-fit shows every clip, scrolling stays within the
// content plus room, and a vertical scroll moves the lanes under the ruler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FRAMES_PER_PIXEL,
  MIN_FRAMES_PER_PIXEL,
  clampScroll,
  contentEndFrames,
  laneTop,
  scrollableFrames,
  trackAt,
  xToFrame,
  zoomAround,
  zoomToFit,
  type Viewport,
} from '../../src/renderer/timeline/geometry';
import { sampleSnapshot } from './support/timeline';

const VIEW: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: 20, laneHeight: 60, width: 1000 };

test('the content ends at the last clip end', () => {
  // clp_3 on trk_a: 48000 + 24000.
  assert.equal(contentEndFrames(sampleSnapshot()), 72000n);
  assert.equal(contentEndFrames(null), 0n);
});

test('zooming around the pointer keeps the frame under it', () => {
  const snapshot = sampleSnapshot();
  const start = { ...VIEW, scrollFrames: '10000' };
  const before = xToFrame(400, start);
  const zoomed = zoomAround(snapshot, start, 2, 400);
  assert.equal(zoomed.framesPerPixel, 50);
  assert.equal(xToFrame(400, zoomed), before);
  const out = zoomAround(snapshot, zoomed, 0.5, 400);
  assert.equal(out.framesPerPixel, 100);
  assert.equal(xToFrame(400, out), before);
});

test('the zoom is clamped and the scroll never goes before the start', () => {
  const snapshot = sampleSnapshot();
  assert.equal(zoomAround(snapshot, VIEW, 1000, 0).framesPerPixel, MIN_FRAMES_PER_PIXEL);
  assert.equal(zoomAround(snapshot, VIEW, 1e-9, 0).framesPerPixel, MAX_FRAMES_PER_PIXEL);
  // Zooming out around the right edge at scroll 0 would scroll negative.
  assert.equal(zoomAround(snapshot, VIEW, 0.5, 1000).scrollFrames, '0');
});

test('scrolling is limited to the content plus half a view', () => {
  const snapshot = sampleSnapshot();
  // A view of 1000 px at 100 frames/px is 100000 frames; content ends at 72000.
  assert.equal(scrollableFrames(snapshot, VIEW), 122000n);
  assert.equal(clampScroll(snapshot, VIEW, 50000n), '22000');
  assert.equal(clampScroll(snapshot, VIEW, -5n), '0');
  assert.equal(clampScroll(snapshot, { ...VIEW, framesPerPixel: 10 }, 50000n), '50000');
  assert.equal(scrollableFrames(null, VIEW), 100000n, 'never less than one view');
});

test('zoom to fit shows every clip from the start', () => {
  const fitted = zoomToFit(sampleSnapshot(), { ...VIEW, scrollFrames: '5000', framesPerPixel: 7 });
  assert.equal(fitted.scrollFrames, '0');
  assert.equal(fitted.framesPerPixel, Math.ceil(72000 / 950));
  assert.ok(72000 / fitted.framesPerPixel <= 1000);
  assert.equal(zoomToFit(null, VIEW).framesPerPixel, VIEW.framesPerPixel);
});

test('a vertical scroll moves the lanes under the ruler', () => {
  const snapshot = sampleSnapshot();
  const view = { ...VIEW, scrollY: 30 };
  assert.equal(laneTop(1, view), 20 + 60 - 30);
  assert.equal(trackAt(snapshot, 25, view), 'trk_b');
  assert.equal(trackAt(snapshot, 55, view), 'trk_a', 'the second lane starts at 50 when scrolled 30');
  assert.equal(trackAt(snapshot, 10, view), null, 'the ruler');
});
