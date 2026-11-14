// The timeline's geometry (spec, "Frontend"): sample frames to pixels and back
// at a zoom and scroll, with positions as decimal strings that may exceed 2^53;
// clip rectangles from a snapshot in root.trackOrder; hit testing of a clip's
// body and trim handles; and the snapping a gesture ends in. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORNER_PX,
  DEFAULT_LANE_HEIGHT,
  GAIN_MIN_HEIGHT,
  GAIN_MIN_WIDTH,
  HANDLE_PX,
  MAX_LANE_HEIGHT,
  MIN_LANE_HEIGHT,
  clampLaneHeight,
  clipRects,
  laneHeightOf,
  laneTops,
  lanesHeight,
  deltaFrames,
  frameToX,
  hitTest,
  snapMove,
  snapTrim,
  trackAt,
  xToFrame,
  type Viewport,
} from '../../src/renderer/timeline/geometry';
import { clip, sampleSnapshot } from './support/timeline';

const VIEW: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: 20, laneHeight: 60, width: 1000 };

test('frames map to pixels at the zoom and scroll, and back', () => {
  assert.equal(frameToX('0', VIEW), 0);
  assert.equal(frameToX('4800', VIEW), 48);
  assert.equal(frameToX('4850', VIEW), 48.5);
  const scrolled = { ...VIEW, scrollFrames: '1000' };
  assert.equal(frameToX('4800', scrolled), 38);
  assert.equal(frameToX('0', scrolled), -10);
  assert.equal(xToFrame(48, VIEW), 4800n);
  assert.equal(xToFrame(38, scrolled), 4800n);
  assert.equal(xToFrame(0.504, VIEW), 50n, 'rounded to the nearest frame');
  assert.equal(deltaFrames(12, VIEW), 1200n);
  assert.equal(deltaFrames(-3.5, VIEW), -350n);
});

test('positions beyond 2^53 keep every frame', () => {
  const far = { ...VIEW, framesPerPixel: 1, scrollFrames: '9007199254740000' };
  assert.equal(frameToX('9007199254740993', far), 993);
  assert.equal(xToFrame(993, far), 9007199254740993n);
  assert.equal(frameToX(9007199254740993n, far), 993);
  assert.equal(snapMove('9007199254740993', 2n), '9007199254740995');
});

test('clip rectangles follow root.trackOrder, one lane per track', () => {
  const rects = clipRects(sampleSnapshot(), VIEW);
  const byId = Object.fromEntries(rects.map((r) => [r.clipId, r]));
  // trk_b is the first lane though trk_a sorts first by id.
  assert.deepEqual(
    { x: byId.clp_1!.x, y: byId.clp_1!.y, width: byId.clp_1!.width, height: byId.clp_1!.height, trackId: byId.clp_1!.trackId },
    { x: 48, y: 20, width: 240, height: 60, trackId: 'trk_b' },
  );
  assert.equal(byId.clp_2!.y, 80);
  assert.equal(byId.clp_2!.width, 96);
  assert.equal(byId.clp_3!.x, 480);
  assert.equal(byId.clp_3!.mediaId, 'med_sq');
  assert.equal(byId.clp_3!.sourceStart, '24000');
  assert.equal(rects.length, 3);
});

test('a clip of a track missing from trackOrder, or in the music domain, is not drawn', () => {
  const base = sampleSnapshot();
  const music = { ...clip('clp_m', 'trk_a', 'med_sq', '960', '0', '100'), position: { domain: 'music' as const, value: '960' } };
  const snapshot = { ...base, clips: [...base.clips, music, clip('clp_x', 'trk_gone', 'med_sq', '0', '0', '100')] };
  assert.deepEqual(clipRects(snapshot, VIEW).map((r) => r.clipId).sort(), ['clp_1', 'clp_2', 'clp_3']);
});

test('the lane under a point names its track', () => {
  const snapshot = sampleSnapshot();
  assert.equal(trackAt(snapshot, 10, VIEW), null, 'the ruler');
  assert.equal(trackAt(snapshot, 20, VIEW), 'trk_b');
  assert.equal(trackAt(snapshot, 79.9, VIEW), 'trk_b');
  assert.equal(trackAt(snapshot, 80, VIEW), 'trk_a');
  assert.equal(trackAt(snapshot, 140, VIEW), null, 'below the last lane');
});

test('hit testing finds a clip body and its left and right trim handles', () => {
  const rects = clipRects(sampleSnapshot(), VIEW);
  // clp_1: x 48..288, y 20..80.
  assert.equal(hitTest(rects, 100, 50)?.rect.clipId, 'clp_1');
  assert.equal(hitTest(rects, 100, 50)?.part, 'body');
  assert.equal(hitTest(rects, 48, 50)?.part, 'left');
  assert.equal(hitTest(rects, 48 + HANDLE_PX - 0.5, 50)?.part, 'left');
  assert.equal(hitTest(rects, 287, 50)?.part, 'right');
  assert.equal(hitTest(rects, 288 - HANDLE_PX + 0.5, 50)?.part, 'right');
  assert.equal(hitTest(rects, 300, 50), null, 'past the clip');
  assert.equal(hitTest(rects, 100, 90), null, 'the other lane has no clip there');
  assert.equal(hitTest(rects, 50, 90)?.rect.clipId, 'clp_2');
});

test('a narrow clip keeps a body between its handles', () => {
  const narrow = clipRects(
    { ...sampleSnapshot(), clips: [clip('clp_n', 'trk_b', 'med_sq', '1000', '0', '900')] },
    VIEW,
  );
  // 9 px wide: each handle a third.
  assert.equal(hitTest(narrow, 10.5, 50)?.part, 'left');
  assert.equal(hitTest(narrow, 14.5, 50)?.part, 'body');
  assert.equal(hitTest(narrow, 18.5, 50)?.part, 'right');
});

test('a drag snaps to a non-negative position', () => {
  assert.equal(snapMove('4800', 1200n), '6000');
  assert.equal(snapMove('4800', -4800n), '0');
  assert.equal(snapMove('4800', -10000n), '0');
});

test('a trim stays inside [0, media.frames] with at least one frame', () => {
  const c = clip('clp_3', 'trk_a', 'med_sq', '48000', '24000', '24000');
  // The right handle changes the length only.
  assert.deepEqual(snapTrim(c, '48000', 'right', -4000n), { position: '48000', sourceStart: '24000', length: '20000' });
  assert.deepEqual(snapTrim(c, '48000', 'right', 100000n), { position: '48000', sourceStart: '24000', length: '24000' });
  assert.deepEqual(snapTrim(c, '48000', 'right', -30000n), { position: '48000', sourceStart: '24000', length: '1' });
  // The left handle moves the start, keeping the audio in place on the timeline.
  assert.deepEqual(snapTrim(c, '48000', 'left', 4000n), { position: '52000', sourceStart: '28000', length: '20000' });
  assert.deepEqual(snapTrim(c, '48000', 'left', -4000n), { position: '44000', sourceStart: '20000', length: '28000' });
  assert.deepEqual(snapTrim(c, '48000', 'left', -100000n), { position: '24000', sourceStart: '0', length: '48000' });
  assert.deepEqual(snapTrim(c, '48000', 'left', 100000n), { position: '71999', sourceStart: '47999', length: '1' });
  // Near the timeline's start the position is what holds it.
  const early = clip('clp_e', 'trk_a', 'med_sq', '1000', '24000', '1000');
  assert.deepEqual(snapTrim(early, '48000', 'left', -5000n), { position: '0', sourceStart: '23000', length: '2000' });
});

// m5-ui-arrange: lanes of their own height (53 px by default, 24-240 px), a
// vertical scroll of the lanes under a fixed ruler, and a canvas that starts
// right of the track list, so no clip rectangle needs the list's width.
const ARRANGE: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: 32, laneHeight: DEFAULT_LANE_HEIGHT, width: 800, height: 300, scrollY: 0 };

test('lanes default to 53 px and take their height from the map, clamped to 24-240', () => {
  assert.equal(DEFAULT_LANE_HEIGHT, 53);
  assert.equal(MIN_LANE_HEIGHT, 24);
  assert.equal(MAX_LANE_HEIGHT, 240);
  assert.equal(clampLaneHeight(10), 24);
  assert.equal(clampLaneHeight(500), 240);
  assert.equal(clampLaneHeight(60.4), 60);
  assert.equal(clampLaneHeight(Number.NaN), 53);
  const order = ['trk_b', 'trk_a', 'trk_c'];
  assert.deepEqual(laneTops(order, ARRANGE), [32, 85, 138]);
  const sized = { ...ARRANGE, laneHeights: { trk_a: 96, trk_c: 1000 } };
  assert.equal(laneHeightOf('trk_b', sized), 53);
  assert.equal(laneHeightOf('trk_a', sized), 96);
  assert.equal(laneHeightOf('trk_c', sized), 240);
  assert.deepEqual(laneTops(order, sized), [32, 85, 181]);
  assert.equal(lanesHeight(order, sized), 53 + 96 + 240);
});

test('a vertical scroll moves the lanes up under the ruler', () => {
  const order = ['trk_b', 'trk_a'];
  const scrolled = { ...ARRANGE, scrollY: 40, laneHeights: { trk_b: 80 } };
  assert.deepEqual(laneTops(order, scrolled), [32 - 40, 32 - 40 + 80]);
  const snapshot = sampleSnapshot();
  assert.equal(trackAt(snapshot, 31, scrolled), null, 'the ruler stays on top');
  assert.equal(trackAt(snapshot, 32, scrolled), 'trk_b');
  assert.equal(trackAt(snapshot, 71.9, scrolled), 'trk_b');
  assert.equal(trackAt(snapshot, 72, scrolled), 'trk_a');
  assert.equal(trackAt(snapshot, 72 + 53, scrolled), null, 'below the last lane');
});

test('clip rectangles take the lane heights and the vertical scroll', () => {
  const view = { ...ARRANGE, scrollY: 10, laneHeights: { trk_b: 120 } };
  const byId = Object.fromEntries(clipRects(sampleSnapshot(), view).map((r) => [r.clipId, r]));
  assert.deepEqual({ y: byId.clp_1!.y, height: byId.clp_1!.height }, { y: 22, height: 120 });
  assert.deepEqual({ y: byId.clp_2!.y, height: byId.clp_2!.height }, { y: 142, height: 53 });
});

test('a clip scrolled to before the left edge has a negative x: the canvas begins right of the track list', () => {
  const view = { ...ARRANGE, scrollFrames: '9600' };
  const clp1 = clipRects(sampleSnapshot(), view).find((r) => r.clipId === 'clp_1')!;
  // clp_1 starts at 4800: 48 px before the canvas's left edge, whatever the list's width.
  assert.equal(clp1.x, -48);
  assert.equal(clp1.width, 240);
});

// m5-ui-edit-basics (UI redesign spec 3.2, "Clip handles"): resize from the
// lower corners (8 px squares, smaller on a narrow clip), the edges stay a
// 4 px target, and the volume control sits just inside the lower-left corner
// on a clip wide and tall enough for it.
test('hit testing finds the lower corners, the 4 px edges and the volume control', () => {
  assert.equal(HANDLE_PX, 4);
  assert.equal(CORNER_PX, 8);
  const rects = clipRects(sampleSnapshot(), VIEW);
  // clp_1: x 48..288, y 20..80; its lower corners are y 72..80.
  assert.equal(hitTest(rects, 49, 78)?.part, 'cornerLeft');
  assert.equal(hitTest(rects, 55.5, 72)?.part, 'cornerLeft');
  assert.equal(hitTest(rects, 287, 79)?.part, 'cornerRight');
  assert.equal(hitTest(rects, 280.5, 73)?.part, 'cornerRight');
  // Above the corners, the edges.
  assert.equal(hitTest(rects, 49, 71)?.part, 'left');
  assert.equal(hitTest(rects, 51.5, 30)?.part, 'left');
  assert.equal(hitTest(rects, 52.5, 30)?.part, 'body', 'past the 4 px edge');
  assert.equal(hitTest(rects, 285, 30)?.part, 'right');
  // The volume control: right of the lower-left corner.
  assert.equal(hitTest(rects, 56, 79)?.part, 'gain');
  assert.equal(hitTest(rects, 69.5, 68)?.part, 'gain');
  assert.equal(hitTest(rects, 70.5, 75)?.part, 'body');
  assert.equal(hitTest(rects, 60, 67)?.part, 'body');
  assert.equal(hitTest(rects, 60, 50)?.part, 'body');
});

test('a narrow or short clip shrinks its corners and has no volume control', () => {
  const narrow = clipRects({ ...sampleSnapshot(), clips: [clip('clp_n', 'trk_b', 'med_sq', '1000', '0', '900')] }, VIEW);
  // 9 px wide (x 10..19): corners of 3 px.
  assert.equal(hitTest(narrow, 10.5, 78)?.part, 'cornerLeft');
  assert.equal(hitTest(narrow, 14.5, 78)?.part, 'body');
  assert.equal(hitTest(narrow, 18.5, 78)?.part, 'cornerRight');
  const short = clipRects({ ...sampleSnapshot(), clips: [clip('clp_w', 'trk_b', 'med_sq', '0', '0', '20000')] }, { ...VIEW, laneHeight: 24 });
  // 200 px wide but 24 px high: no volume control.
  assert.ok(short[0]!.height < GAIN_MIN_HEIGHT);
  for (let x = 8; x < 40; x += 1) assert.notEqual(hitTest(short, x, 20 + 23)?.part, 'gain', `x ${x}`);
  const slim = clipRects({ ...sampleSnapshot(), clips: [clip('clp_s', 'trk_b', 'med_sq', '0', '0', '4000')] }, VIEW);
  // 40 px wide: no volume control either.
  assert.ok(slim[0]!.width < GAIN_MIN_WIDTH);
  for (let x = 8; x < 32; x += 1) assert.notEqual(hitTest(slim, x, 78)?.part, 'gain', `x ${x}`);
});
