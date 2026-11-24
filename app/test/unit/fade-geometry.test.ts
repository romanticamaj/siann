// A clip's fades as the event display draws and hits them (m5b-ui-fades; UI
// redesign 3.2, "Clip handles" and "How a fade is drawn"; 10.11, 23). The
// expectations come from outside the code under test:
//
// - the gain curve is the architecture spec's ("siann-graph and
//   siann-engine", clip fades): curve(x) = x for linear and sin(x * pi / 2)
//   for equal power; g(n) = in(n) * out(n) with in(n) = curve(n / Lin) for
//   n < Lin, out(n) = curve(m / Lout) with m = C - 1 - n for m < Lout, else 1;
// - the handle is the mockup's draw() triangle: moveTo(x+f-4, y+HDR-1),
//   lineTo(x+f+4, y+HDR-1), lineTo(x+f, y+HDR+5), for the fade out at
//   x+w-f; HDR is --clip-title-h;
// - the hit test (3.2, as 10.11, 23 corrects it): with fades enabled the
//   handle's box (the triangle with the 4 px margin of the other handles) is
//   hit before the 4 px edge and the body, the nearer handle where the fades
//   meet; the shaded area (between the curve and the top edge below the title
//   strip) is 'fadeInArea' / 'fadeOutArea'; with fades disabled nothing of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLIP_TITLE_HEIGHT, HANDLE_PX, clipBox, clipRects, hitTest, type Viewport } from '../../src/renderer/timeline/geometry';
import {
  FADE_HANDLE_HALF_W,
  clipFadeGain,
  fadeAreaContains,
  fadeGain,
  fadeHandle,
  fadeHandleHitBox,
  fadePx,
  fadeScaledColumns,
} from '../../src/renderer/timeline/fades';
import type { WaveColumn } from '../../src/renderer/timeline/waveform';
import { TOKENS } from '../../src/renderer/tokens';
import { clip, media, snapshotOf, track } from './support/timeline';

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} != ${expected}`);

test('fadeGain is the architecture spec\'s curve: x for linear, sin(x pi / 2) for equal power', () => {
  close(fadeGain('linear', 0.25), 0.25);
  close(fadeGain('linear', 0), 0);
  close(fadeGain('linear', 1), 1);
  close(fadeGain('equal_power', 0.5), 0.70710678118654752);
  close(fadeGain('equal_power', 0), 0);
  close(fadeGain('equal_power', 1), 1);
  // Outside [0, 1] the curve holds its ends.
  close(fadeGain('linear', -1), 0);
  close(fadeGain('equal_power', 2), 1);
});

test('the clip\'s gain at an offset: the fade in from silence, the fade out mirrored to a silent last frame, 1 between', () => {
  const fades = { length: '1000', fadeIn: { length: '100', curve: 'linear' as const }, fadeOut: { length: '200', curve: 'equal_power' as const } };
  close(clipFadeGain(fades, 0), 0, 'the first frame is silent');
  close(clipFadeGain(fades, 25), 0.25);
  close(clipFadeGain(fades, 99), 0.99);
  close(clipFadeGain(fades, 100), 1, 'the fade in ends');
  close(clipFadeGain(fades, 500), 1);
  close(clipFadeGain(fades, 799), 1, 'm = 200: outside the fade out');
  close(clipFadeGain(fades, 899), Math.sin((100 / 200) * Math.PI / 2), 'm = 100');
  close(clipFadeGain(fades, 999), 0, 'the last frame is silent');
  // Mirrored: the fade out at m from the end is the curve at m / Lout.
  for (const m of [0, 1, 50, 150, 199]) close(clipFadeGain(fades, 999 - m), Math.sin((m / 200) * Math.PI / 2), `m ${m}`);
  // No fades: 1 everywhere.
  for (const n of [0, 1, 999]) close(clipFadeGain({ length: '1000' }, n), 1);
  // Overlapping coverage (they meet): the product.
  const meet = { length: '100', fadeIn: { length: '50', curve: 'linear' as const }, fadeOut: { length: '50', curve: 'linear' as const } };
  close(clipFadeGain(meet, 49), 0.98);
  close(clipFadeGain(meet, 50), 49 / 50);
});

test('fadePx is the fade\'s real length at the zoom', () => {
  assert.equal(fadePx('4800', 100), 48);
  assert.equal(fadePx(480n, 100), 4.8);
  assert.equal(fadePx('0', 100), 0);
});

test('fadeHandle: the mockup\'s 8 x 6 triangle at the fade\'s end on the title strip\'s lower edge', () => {
  const HDR = Number.parseFloat(TOKENS['clip-title-h']);
  assert.equal(HDR, CLIP_TITLE_HEIGHT);
  const box = { x: 100, y: 23, width: 300, height: 46 };
  // Fade in of 8 px (the mockup's fi = 8): x+f-4 .. x+f+4, y+HDR-1 .. y+HDR+5.
  const fin = fadeHandle(box, 'fadeIn', 8);
  assert.deepEqual(fin.points, [[104, 23 + HDR - 1], [112, 23 + HDR - 1], [108, 23 + HDR + 5]]);
  assert.deepEqual({ x: fin.x, y: fin.y, width: fin.width, height: fin.height }, { x: 104, y: 23 + HDR - 1, width: 8, height: 6 });
  assert.equal(FADE_HANDLE_HALF_W, 4);
  // Fade out of 22 px (fo = 22): at x+w-f.
  const fout = fadeHandle(box, 'fadeOut', 22);
  assert.deepEqual(fout.points, [[374, 23 + HDR - 1], [382, 23 + HDR - 1], [378, 23 + HDR + 5]]);
  // No fade: the triangle sits on the corner.
  assert.equal(fadeHandle(box, 'fadeIn', 0).points[2]![0], 100);
  assert.equal(fadeHandle(box, 'fadeOut', 0).points[2]![0], 400);
  // Its hit box: the triangle with the 4 px margin of the other handles.
  assert.deepEqual(fadeHandleHitBox(fin), { x: 104 - HANDLE_PX, y: 23 + HDR - 1 - HANDLE_PX, width: 8 + 2 * HANDLE_PX, height: 6 + 2 * HANDLE_PX });
});

test('the shaded area lies between the curve and the top edge below the title strip', () => {
  const box = { x: 0, y: 0, width: 400, height: 46 };
  const HDR = CLIP_TITLE_HEIGHT;
  const body = 46 - HDR;
  // A linear fade in of 100 px: at x = 50 the curve is half way up the body.
  assert.ok(fadeAreaContains(box, 'fadeIn', 100, 'linear', 50, HDR + body / 2 - 1));
  assert.ok(!fadeAreaContains(box, 'fadeIn', 100, 'linear', 50, HDR + body / 2 + 1), 'below the curve');
  assert.ok(!fadeAreaContains(box, 'fadeIn', 100, 'linear', 50, HDR - 1), 'in the title strip');
  assert.ok(!fadeAreaContains(box, 'fadeIn', 100, 'linear', 101, HDR + 2), 'past the fade\'s end');
  // Equal power rises faster: at x = 50 its curve is at sin(pi / 4) of the body.
  const y = HDR + body * (1 - Math.SQRT1_2);
  assert.ok(fadeAreaContains(box, 'fadeIn', 100, 'equal_power', 50, y - 0.5));
  assert.ok(!fadeAreaContains(box, 'fadeIn', 100, 'equal_power', 50, y + 0.5));
  // The fade out is mirrored from the right edge.
  assert.ok(fadeAreaContains(box, 'fadeOut', 100, 'linear', 350, HDR + body / 2 - 1));
  assert.ok(!fadeAreaContains(box, 'fadeOut', 100, 'linear', 350, HDR + body / 2 + 1));
  assert.ok(!fadeAreaContains(box, 'fadeOut', 100, 'linear', 299, HDR + 2));
  // No fade: no area.
  assert.ok(!fadeAreaContains(box, 'fadeIn', 0, 'linear', 0, HDR + 1));
});

// A clip with fades on a 53 px lane: its box x 49..1049 (rect x 48, 1000 px), y 23..69.
const VIEW: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: 20, laneHeight: 53, width: 2000 };
function rectsWith(fadeIn?: string, fadeOut?: string) {
  const c = {
    ...clip('clp_f', 'trk_a', 'med_a', '4800', '0', '100000'),
    ...(fadeIn ? { fadeIn: { length: fadeIn, curve: 'linear' as const } } : {}),
    ...(fadeOut ? { fadeOut: { length: fadeOut, curve: 'equal_power' as const } } : {}),
  };
  return clipRects(snapshotOf(['trk_a'], [track('trk_a')], [media('med_a', '480000')], [c]), VIEW);
}

test('hitTest: the fade handles before the edge and the body, only with fades enabled', () => {
  const rects = rectsWith('4800', '9600');
  const rect = rects[0]!;
  assert.equal(rect.fadeIn?.length, '4800', 'the rect carries the clip\'s fades');
  assert.equal(rect.fadeOut?.curve, 'equal_power');
  const box = clipBox(rect);
  const on = { fades: true };
  const handleY = box.y + CLIP_TITLE_HEIGHT + 1;
  // The fade in's end: 48 px in; the fade out's: 96 px from the right.
  assert.equal(hitTest(rects, box.x + 48, handleY, on)?.part, 'fadeIn');
  assert.equal(hitTest(rects, box.x + box.width - 96, handleY, on)?.part, 'fadeOut');
  // Disabled (the default: existing callers keep their result): the body.
  assert.equal(hitTest(rects, box.x + 48, handleY)?.part, 'body');
  assert.equal(hitTest(rects, box.x + 48, handleY, { fades: false })?.part, 'body');
  // The shaded area, for the double-click, under the handle's box.
  assert.equal(hitTest(rects, box.x + 30, box.y + CLIP_TITLE_HEIGHT + 12, on)?.part, 'fadeInArea');
  assert.equal(hitTest(rects, box.x + box.width - 40, box.y + CLIP_TITLE_HEIGHT + 12, on)?.part, 'fadeOutArea');
  assert.equal(hitTest(rects, box.x + 30, box.y + CLIP_TITLE_HEIGHT + 12)?.part, 'body');
  // Below the curve: the body.
  assert.equal(hitTest(rects, box.x + 40, box.y + box.height - 14, on)?.part, 'body');
  // The lower corners, the volume control and the repeat handle are where they were.
  assert.equal(hitTest(rects, box.x + 1, box.y + box.height - 1, on)?.part, 'cornerLeft');
  assert.equal(hitTest(rects, box.x + box.width - 1, box.y + box.height - 1, on)?.part, 'cornerRight');
  assert.equal(hitTest(rects, box.x + 20, box.y + box.height - 6, on)?.part, 'gain');
});

test('hitTest: a zero-length fade\'s handle is hit on the corner, before the 4 px edge', () => {
  const rects = rectsWith();
  const box = clipBox(rects[0]!);
  const y = box.y + CLIP_TITLE_HEIGHT;
  assert.equal(hitTest(rects, box.x + 1, y, { fades: true })?.part, 'fadeIn');
  assert.equal(hitTest(rects, box.x + box.width - 1, y, { fades: true })?.part, 'fadeOut');
  // Without fades enabled the same points are the edges' resize targets.
  assert.equal(hitTest(rects, box.x + 1, y)?.part, 'left');
  assert.equal(hitTest(rects, box.x + box.width - 1, y)?.part, 'right');
  // Lower down the edge stays the edge.
  assert.equal(hitTest(rects, box.x + 1, box.y + box.height - 12, { fades: true })?.part, 'left');
});

test('hitTest: where the two fades meet, the handle nearer the pointer', () => {
  // The box is 998 px (1000 less the insets): a fade in of 500 px and a fade
  // out of 498 px put both triangles at box.x + 500, as draw() places them
  // (x + f and x + w - f).
  const rects = rectsWith('50000', '49800');
  const box = clipBox(rects[0]!);
  assert.equal(box.width, 998);
  const y = box.y + CLIP_TITLE_HEIGHT + 1;
  const mid = box.x + 500;
  assert.equal(hitTest(rects, mid - 3, y, { fades: true })?.part, 'fadeIn');
  assert.equal(hitTest(rects, mid + 3, y, { fades: true })?.part, 'fadeOut');
  // Two fades whose handles overlap without meeting: still the nearer one.
  const near = rectsWith('49500', '50000');
  const b = clipBox(near[0]!);
  assert.equal(hitTest(near, b.x + 495 - 1, y, { fades: true })?.part, 'fadeIn');
  assert.equal(hitTest(near, b.x + 500 + 1, y, { fades: true })?.part, 'fadeOut');
});

test('fadeScaledColumns: a column\'s half height times the gain at its frame', () => {
  const column = (x: number, up: number, down: number): WaveColumn => ({
    x,
    w: 1,
    amplitude: 0.5,
    outerSpan: { up, down },
    innerSpan: { up: up * 0.52, down: down * 0.52 },
    outer: (up + down) / 2,
    inner: ((up + down) / 2) * 0.52,
  });
  // A clip at x 0 of 100 px at 10 frames per pixel (1000 frames), a linear
  // fade in of 400 frames (40 px) and a linear fade out of 200 (20 px).
  const rect = { x: 0, length: '1000', fadeIn: { length: '400', curve: 'linear' as const }, fadeOut: { length: '200', curve: 'linear' as const } };
  const columns = [column(10, 10, 10), column(50, 10, 10), column(90, 8, 12)];
  const out = fadeScaledColumns(columns, rect, 10);
  // Each column reads the gain at its middle frame: (x + w / 2) * 10.
  const g0 = 105 / 400;
  close(out[0]!.outerSpan.up, 10 * g0);
  close(out[0]!.outerSpan.down, 10 * g0);
  close(out[0]!.outer, 10 * g0);
  close(out[0]!.innerSpan.up, 5.2 * g0);
  // Outside both fades: unchanged.
  assert.deepEqual(out[1], columns[1]);
  // In the fade out, frame 905: m = 94, gain 94 / 200; the asymmetry stays.
  const g2 = 94 / 200;
  close(out[2]!.outerSpan.up, 8 * g2);
  close(out[2]!.outerSpan.down, 12 * g2);
  // No fades: the same columns back.
  assert.equal(fadeScaledColumns(columns, { x: 0, length: '1000' }, 10), columns);
});
