// The timeline's geometry (spec, "Frontend"): sample frames to pixels and back
// at a zoom and scroll, with positions as decimal strings that may exceed 2^53;
// clip rectangles from a snapshot in root.trackOrder; hit testing of a clip's
// body and trim handles; and the snapping a gesture ends in. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIP_RADIUS,
  CLIP_TITLE_HEIGHT,
  CORNER_PX,
  DEFAULT_LANE_HEIGHT,
  GAIN_MIN_HEIGHT,
  GAIN_MIN_WIDTH,
  HANDLE_PX,
  LANES_TOP,
  MARKER_HEIGHT,
  MAX_LANE_HEIGHT,
  MIN_LANE_HEIGHT,
  REPEAT_HIT_PX,
  REPEAT_RADIUS,
  clampLaneHeight,
  clipBox,
  clipRects,
  cornerHandles,
  gainBox,
  laneHeightOf,
  laneTops,
  lanesHeight,
  repeatHandle,
  deltaFrames,
  frameToX,
  hitTest,
  snapMove,
  snapTrim,
  titleStrip,
  trackAt,
  xToFrame,
  type Viewport,
} from '../../src/renderer/timeline/geometry';
import { TOKENS } from '../../src/renderer/tokens';
import { clip, media, sampleSnapshot, snapshotOf, track } from './support/timeline';
import { RULER_HEIGHT } from '../../src/renderer/timeline/TimelineCanvas';

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

test('hit testing finds a clip body and its left and right trim handles, over the inset box', () => {
  const rects = clipRects(sampleSnapshot(), VIEW);
  // clp_1: lane rect x 48..288, y 20..80; its box (draw()'s clip()) x 49..287, y 23..76.
  assert.equal(hitTest(rects, 100, 50)?.rect.clipId, 'clp_1');
  assert.equal(hitTest(rects, 100, 50)?.part, 'body');
  assert.equal(hitTest(rects, 49, 50)?.part, 'left');
  assert.equal(hitTest(rects, 49 + HANDLE_PX - 0.5, 50)?.part, 'left');
  assert.equal(hitTest(rects, 286.5, 50)?.part, 'right');
  assert.equal(hitTest(rects, 287 - HANDLE_PX + 0.5, 50)?.part, 'right');
  assert.equal(hitTest(rects, 48.5, 50), null, 'the 1 px inset left of the box');
  assert.equal(hitTest(rects, 100, 22), null, 'the 3 px above the box');
  assert.equal(hitTest(rects, 100, 77), null, 'the 4 px below the box');
  assert.equal(hitTest(rects, 300, 50), null, 'past the clip');
  assert.equal(hitTest(rects, 100, 90), null, 'the other lane has no clip there');
  assert.equal(hitTest(rects, 50, 90)?.rect.clipId, 'clp_2');
});

test('a narrow clip keeps a body between its handles', () => {
  const narrow = clipRects(
    { ...sampleSnapshot(), clips: [clip('clp_n', 'trk_b', 'med_sq', '1000', '0', '900')] },
    VIEW,
  );
  // 9 px of lane, a 7 px box (x 11..18): each handle a third.
  assert.equal(hitTest(narrow, 11.5, 50)?.part, 'left');
  assert.equal(hitTest(narrow, 14.5, 50)?.part, 'body');
  assert.equal(hitTest(narrow, 17.5, 50)?.part, 'right');
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
const ARRANGE: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: RULER_HEIGHT, lanesTop: LANES_TOP, laneHeight: DEFAULT_LANE_HEIGHT, width: 800, height: 300, scrollY: 0 };

test('lanes default to 53 px and take their height from the map, clamped to 24-240', () => {
  assert.equal(DEFAULT_LANE_HEIGHT, 53);
  assert.equal(MIN_LANE_HEIGHT, 24);
  assert.equal(MAX_LANE_HEIGHT, 240);
  assert.equal(clampLaneHeight(10), 24);
  assert.equal(clampLaneHeight(500), 240);
  assert.equal(clampLaneHeight(60.4), 60);
  assert.equal(clampLaneHeight(Number.NaN), 53);
  const order = ['trk_b', 'trk_a', 'trk_c'];
  assert.deepEqual(laneTops(order, ARRANGE), [LANES_TOP, LANES_TOP + 53, LANES_TOP + 106]);
  const sized = { ...ARRANGE, laneHeights: { trk_a: 96, trk_c: 1000 } };
  assert.equal(laneHeightOf('trk_b', sized), 53);
  assert.equal(laneHeightOf('trk_a', sized), 96);
  assert.equal(laneHeightOf('trk_c', sized), 240);
  assert.deepEqual(laneTops(order, sized), [LANES_TOP, LANES_TOP + 53, LANES_TOP + 53 + 96]);
  assert.equal(lanesHeight(order, sized), 53 + 96 + 240);
});

test('a vertical scroll moves the lanes up under the ruler', () => {
  const order = ['trk_b', 'trk_a'];
  const scrolled = { ...ARRANGE, scrollY: 40, laneHeights: { trk_b: 80 } };
  assert.deepEqual(laneTops(order, scrolled), [LANES_TOP - 40, LANES_TOP - 40 + 80]);
  const snapshot = sampleSnapshot();
  assert.equal(trackAt(snapshot, LANES_TOP - 1, scrolled), null, 'the ruler and the marker row stay on top');
  assert.equal(trackAt(snapshot, LANES_TOP, scrolled), 'trk_b');
  assert.equal(trackAt(snapshot, LANES_TOP + 39.9, scrolled), 'trk_b');
  assert.equal(trackAt(snapshot, LANES_TOP + 40, scrolled), 'trk_a');
  assert.equal(trackAt(snapshot, LANES_TOP + 40 + 53, scrolled), null, 'below the last lane');
});

test('clip rectangles take the lane heights and the vertical scroll', () => {
  const view = { ...ARRANGE, scrollY: 10, laneHeights: { trk_b: 120 } };
  const byId = Object.fromEntries(clipRects(sampleSnapshot(), view).map((r) => [r.clipId, r]));
  assert.deepEqual({ y: byId.clp_1!.y, height: byId.clp_1!.height }, { y: LANES_TOP - 10, height: 120 });
  assert.deepEqual({ y: byId.clp_2!.y, height: byId.clp_2!.height }, { y: LANES_TOP - 10 + 120, height: 53 });
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
  // clp_1's box: x 49..287, y 23..76; its lower corners are y 68..76.
  assert.equal(hitTest(rects, 50, 75)?.part, 'cornerLeft');
  assert.equal(hitTest(rects, 56.5, 68)?.part, 'cornerLeft');
  assert.equal(hitTest(rects, 286, 75.5)?.part, 'cornerRight');
  assert.equal(hitTest(rects, 279.5, 69)?.part, 'cornerRight');
  // Above the corners, the edges.
  assert.equal(hitTest(rects, 50, 67)?.part, 'left');
  assert.equal(hitTest(rects, 52.5, 30)?.part, 'left');
  assert.equal(hitTest(rects, 53.5, 30)?.part, 'body', 'past the 4 px edge');
  assert.equal(hitTest(rects, 284, 30)?.part, 'right');
  // The volume control: draw()'s box rr(x+9, y+h-12, 38, 10), x 58..96, y 64..74.
  assert.equal(hitTest(rects, 58, 73)?.part, 'gain');
  assert.equal(hitTest(rects, 95.5, 64)?.part, 'gain');
  assert.equal(hitTest(rects, 96.5, 70)?.part, 'body');
  assert.equal(hitTest(rects, 70, 63)?.part, 'body');
  assert.equal(hitTest(rects, 70, 74.5)?.part, 'body');
  assert.equal(hitTest(rects, 60, 50)?.part, 'body');
  const gain = gainBox(rects.find((r) => r.clipId === 'clp_1')!);
  assert.deepEqual(gain, { x: 58, y: 64, width: 38, height: 10 });
});

test('a narrow or short clip shrinks its corners and has no volume control', () => {
  const narrow = clipRects({ ...sampleSnapshot(), clips: [clip('clp_n', 'trk_b', 'med_sq', '1000', '0', '900')] }, VIEW);
  // A 7 px box (x 11..18): corners of a third.
  assert.equal(hitTest(narrow, 11.5, 75)?.part, 'cornerLeft');
  assert.equal(hitTest(narrow, 14.5, 75)?.part, 'body');
  assert.equal(hitTest(narrow, 17.5, 75)?.part, 'cornerRight');
  const short = clipRects({ ...sampleSnapshot(), clips: [clip('clp_w', 'trk_b', 'med_sq', '0', '0', '20000')] }, { ...VIEW, laneHeight: 24 });
  // 200 px wide but a 17 px box: no volume control.
  assert.ok(clipBox(short[0]!).height < GAIN_MIN_HEIGHT);
  for (let x = 8; x < 50; x += 1) assert.notEqual(hitTest(short, x, 20 + 15)?.part, 'gain', `x ${x}`);
  const slim = clipRects({ ...sampleSnapshot(), clips: [clip('clp_s', 'trk_b', 'med_sq', '0', '0', '4000')] }, VIEW);
  // 40 px wide: no volume control either.
  assert.ok(clipBox(slim[0]!).width < GAIN_MIN_WIDTH);
  assert.equal(gainBox(slim[0]!), null);
  for (let x = 8; x < 40; x += 1) assert.notEqual(hitTest(slim, x, 72)?.part, 'gain', `x ${x}`);
});

// m5-ui-port-arrange-canvas (UI redesign 10.9, 10.10): the event display is
// draw()'s. Below the 40 px ruler, the --marker-h (20 px) marker track row,
// empty until m5b-ui-markers, and the lanes from LANES_TOP. A clip is
// draw()'s clip(): x = xb(start)+1, w = len*PXB-2, y = laneY+3, h = LANE-7
// with a 4 px radius, the --clip-title-h title strip, the lower corner squares
// fillRect(x-1, y+h-6, 6, 6) and fillRect(x+w-5, y+h-6, 6, 6). The numbers
// below are written by hand from mockup.html's draw() (lines 416-456).
test('the marker row and the lanes below it come from the tokens', () => {
  assert.equal(MARKER_HEIGHT, 20);
  assert.equal(MARKER_HEIGHT, Number.parseFloat(TOKENS['marker-h']));
  assert.equal(LANES_TOP, RULER_HEIGHT + MARKER_HEIGHT);
  assert.equal(LANES_TOP, 60);
  assert.equal(DEFAULT_LANE_HEIGHT, Number.parseFloat(TOKENS['track-h']));
  assert.equal(CLIP_TITLE_HEIGHT, Number.parseFloat(TOKENS['clip-title-h']));
  const snapshot = sampleSnapshot();
  assert.deepEqual(laneTops(snapshot.trackOrder, ARRANGE), [LANES_TOP, LANES_TOP + 53]);
  for (const y of [0, RULER_HEIGHT - 1, RULER_HEIGHT, RULER_HEIGHT + 10, LANES_TOP - 0.5]) assert.equal(trackAt(snapshot, y, ARRANGE), null, `y ${y}: the ruler and the marker row`);
  assert.equal(trackAt(snapshot, LANES_TOP, ARRANGE), 'trk_b');
  // Scrolled, the lanes pass under the marker row and the ruler.
  const scrolled = { ...ARRANGE, scrollY: 30 };
  assert.equal(trackAt(snapshot, LANES_TOP - 1, scrolled), null);
  assert.equal(trackAt(snapshot, LANES_TOP, scrolled), 'trk_b');
  assert.equal(trackAt(snapshot, LANES_TOP + 23, scrolled), 'trk_a');
});

test("a clip's box, title strip and corner handles are draw()'s, from its bars, its lane and the zoom", () => {
  // The mockup's "Chorus A · take 3": lane 5 (index 4), bar 9, 3.75 bars, at
  // 120 BPM and 48 kHz (a bar is 96000 frames).
  const order = ['t0', 't1', 't2', 't3', 't4'];
  const snapshot = snapshotOf(order, order.map(track), [media('med_v', String(96000 * 8))], [clip('clp_c', 't4', 'med_v', String(8 * 96000), '0', String(3.75 * 96000))]);
  // 40 px per bar, the mockup's zoom: xb(9) = 320, laneY(4) = 60 + 4 * 53 = 272.
  const mockupZoom = { ...ARRANGE, framesPerPixel: 2400, width: 1200 };
  const rect = clipRects(snapshot, mockupZoom)[0]!;
  assert.deepEqual({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, { x: 320, y: 272, width: 150, height: 53 });
  const box = clipBox(rect);
  assert.deepEqual(box, { x: 321, y: 275, width: 148, height: 46, radius: 4 });
  assert.equal(CLIP_RADIUS, 4);
  assert.deepEqual(titleStrip(box), { x: 321, y: 275, width: 148, height: 13 });
  assert.deepEqual(cornerHandles(box), [
    { x: 320, y: 315, width: 6, height: 6 },
    { x: 464, y: 315, width: 6, height: 6 },
  ]);
  // 80 px per bar: xb(9) = 640, the box 298 px wide.
  const closer = clipBox(clipRects(snapshot, { ...mockupZoom, framesPerPixel: 1200 })[0]!);
  assert.deepEqual(closer, { x: 641, y: 275, width: 298, height: 46, radius: 4 });
  assert.deepEqual(cornerHandles(closer), [
    { x: 640, y: 315, width: 6, height: 6 },
    { x: 934, y: 315, width: 6, height: 6 },
  ]);
  // The hit parts follow the box: its lower corners, its edges, the body and draw()'s volume box.
  const rects = clipRects(snapshot, mockupZoom);
  assert.equal(hitTest(rects, 322, 320)?.part, 'cornerLeft');
  assert.equal(hitTest(rects, 468, 320)?.part, 'cornerRight');
  assert.equal(hitTest(rects, 322, 290)?.part, 'left');
  assert.equal(hitTest(rects, 468, 290)?.part, 'right');
  assert.equal(hitTest(rects, 340, 312)?.part, 'gain');
  assert.equal(hitTest(rects, 400, 290)?.part, 'body');
  assert.equal(hitTest(rects, 400, 273), null, 'the inset above the box');
  assert.equal(hitTest(rects, 400, 322), null, 'the gap below the box');
});

// m5b-ui-edit-more (UI redesign 3.2, "Clip handles"): the repeat handle in the
// middle of the right border, draw()'s arc(x+w, y+HDR+(h-HDR)/2, 3.2), hit
// within REPEAT_HIT_PX of its centre inside the box, before the right edge.
test('the repeat handle sits on the right border half way down below the title strip, and is its own hit part', () => {
  assert.equal(REPEAT_RADIUS, 3.2);
  assert.equal(REPEAT_HIT_PX, 4);
  const rects = clipRects(sampleSnapshot(), VIEW);
  const rect = rects.find((r) => r.clipId === 'clp_1')!;
  // clp_1's box: x 49..287, y 23..76; the title strip is 13 px.
  assert.deepEqual(repeatHandle(clipBox(rect)), { x: 287, y: 23 + CLIP_TITLE_HEIGHT + (53 - CLIP_TITLE_HEIGHT) / 2, radius: 3.2 });
  assert.equal(hitTest(rects, 285, 56)?.part, 'repeat');
  assert.equal(hitTest(rects, 283, 52)?.part, 'repeat');
  assert.equal(hitTest(rects, 286.5, 60)?.part, 'repeat');
  assert.equal(hitTest(rects, 285, 51)?.part, 'right', 'above it, the edge');
  assert.equal(hitTest(rects, 285, 61)?.part, 'right', 'below it, the edge');
  assert.equal(hitTest(rects, 282, 56)?.part, 'body', 'left of it, the body');
  assert.equal(hitTest(rects, 287.5, 56), null, 'outside the box, nothing');
});
