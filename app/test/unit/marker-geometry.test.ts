// The marker track's geometry (m5b-ui-markers; UI redesign 3.2, "How markers
// are drawn"): a position marker takes the numbers of the mockup's draw()
//
//   g.fillStyle=rgba(c,.14);g.fillRect(x+1,RULER+2,x2-x-2,MK-5);
//   g.fillStyle=c;g.fillRect(x,RULER+2,2,MK-5);
//   g.fillText((k+1)+'  '+name,x+7,RULER+MK/2)
//
// with x2 the next position marker or the end of the last clip (no tint past
// it); a cycle marker is a tinted range with a bar at each end and its name;
// a marker's colour is a track-palette token by the FNV-1a hash of its id
// (track-colour.ts). The expected boxes below are worked out by hand from
// those numbers (RULER 40, MK 20 from tokens.css) at two zooms, not by the
// code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MarkerEntity } from '../../src/renderer/model/document';
import { TOKENS } from '../../src/renderer/tokens';
import { fnv1a32, trackColourVar } from '../../src/renderer/timeline/track-colour';
import { cycleBox, flagBox, markerColourVar, markerHit, markerLabel, markerShapes, MARKER_TINT_ALPHA } from '../../src/renderer/timeline/markers';
import type { Viewport } from '../../src/renderer/timeline/geometry';

const RULER = 40;
const MK = 20;
const BAR = 96000n;

test('the tokens are the mockup\'s: a 40 px ruler and a 20 px marker row', () => {
  assert.equal(TOKENS['ruler-h'], '40px');
  assert.equal(TOKENS['marker-h'], '20px');
  assert.equal(MARKER_TINT_ALPHA, 0.14);
});

const view = (framesPerPixel: number, scrollFrames = '0'): Viewport => ({ framesPerPixel, scrollFrames, rulerHeight: RULER, lanesTop: RULER + MK, laneHeight: 53, width: 800, height: 400 });

const marker = (id: string, number: number, position: bigint, name: string, length?: bigint): MarkerEntity => ({
  schema: 'siann.entity.marker.v1',
  id,
  number,
  name,
  position: position.toString(),
  ...(length !== undefined ? { length: length.toString() } : {}),
});

// The mockup's three markers: 1 Intro at bar 1, 2 Verse 1 at bar 5, 3 Chorus at bar 9; its clips end at bar 17.
const MOCKUP = [marker('mk_1', 1, 0n, 'Intro'), marker('mk_2', 2, 4n * BAR, 'Verse 1'), marker('mk_3', 3, 8n * BAR, 'Chorus')];
const END = 16n * BAR;
const measure = (text: string) => text.length * 5;

test('flagBox: the 2 px bar at RULER + 2, MK - 5 high; the tint from x + 1 to the next x less 1', () => {
  assert.deepEqual(flagBox(160, 320), { bar: { x: 160, y: 42, width: 2, height: 15 }, tint: { x: 161, y: 42, width: 158, height: 15 } });
  assert.deepEqual(flagBox(0, 80), { bar: { x: 0, y: 42, width: 2, height: 15 }, tint: { x: 1, y: 42, width: 78, height: 15 } });
  // No end, or an end too close for a tint: the bar alone.
  assert.deepEqual(flagBox(100, null), { bar: { x: 100, y: 42, width: 2, height: 15 }, tint: null });
  assert.equal(flagBox(100, 101).tint, null);
  assert.equal(flagBox(100, 102).tint, null);
});

test('cycleBox: the range tinted, a 2 px bar inside each end', () => {
  assert.deepEqual(cycleBox(160, 320), {
    tint: { x: 160, y: 42, width: 160, height: 15 },
    left: { x: 160, y: 42, width: 2, height: 15 },
    right: { x: 318, y: 42, width: 2, height: 15 },
  });
});

test('the label is "N  name" (two spaces), the number alone for an unnamed marker', () => {
  assert.equal(markerLabel(2, 'Verse 1'), '2  Verse 1');
  assert.equal(markerLabel(7, ''), '7');
});

test("markerShapes at the mockup's zoom (40 px a bar): draw()'s three flags, tints and labels", () => {
  const shapes = markerShapes(MOCKUP, END, view(2400), measure);
  assert.deepEqual(
    shapes.map((s) => [s.kind, s.id]),
    [['position', 'mk_1'], ['position', 'mk_2'], ['position', 'mk_3']],
  );
  const [intro, verse, chorus] = shapes as Array<Extract<(typeof shapes)[number], { kind: 'position' }>>;
  assert.deepEqual(intro!.bar, { x: 0, y: 42, width: 2, height: 15 });
  assert.deepEqual(intro!.tint, { x: 1, y: 42, width: 158, height: 15 });
  assert.deepEqual(intro!.label, { text: '1  Intro', x: 7, y: RULER + MK / 2, width: 40 });
  assert.deepEqual(verse!.tint, { x: 161, y: 42, width: 158, height: 15 });
  assert.deepEqual(verse!.label, { text: '2  Verse 1', x: 167, y: 50, width: 50 });
  // The last one tints to the end of the last clip, bar 17.
  assert.deepEqual(chorus!.tint, { x: 321, y: 42, width: 318, height: 15 });
  assert.equal(chorus!.colourVar, markerColourVar('mk_3'));
});

test('markerShapes at half the zoom (20 px a bar) and scrolled by a bar', () => {
  const [a, b, c] = markerShapes(MOCKUP, END, view(4800), measure) as Array<Extract<ReturnType<typeof markerShapes>[number], { kind: 'position' }>>;
  assert.deepEqual([a!.bar.x, b!.bar.x, c!.bar.x], [0, 80, 160]);
  assert.deepEqual([a!.tint, b!.tint, c!.tint], [
    { x: 1, y: 42, width: 78, height: 15 },
    { x: 81, y: 42, width: 78, height: 15 },
    { x: 161, y: 42, width: 158, height: 15 },
  ]);
  const scrolled = markerShapes(MOCKUP, END, view(2400, String(BAR)), measure) as Array<Extract<ReturnType<typeof markerShapes>[number], { kind: 'position' }>>;
  assert.deepEqual(scrolled.map((s) => s.bar.x), [-40, 120, 280]);
  assert.deepEqual(scrolled[1]!.label, { text: '2  Verse 1', x: 127, y: 50, width: 50 });
});

test('the tint runs to the next position marker in position order, not in number or id order; past the last clip none', () => {
  const unordered = [marker('mk_z', 1, 8n * BAR, 'Late'), marker('mk_a', 9, 0n, 'Early')];
  const [early, late] = markerShapes(unordered, 4n * BAR, view(2400), measure) as Array<Extract<ReturnType<typeof markerShapes>[number], { kind: 'position' }>>;
  assert.equal(early!.id, 'mk_a');
  assert.deepEqual(early!.tint, { x: 1, y: 42, width: 318, height: 15 }, 'to the next marker, past the clips\' end');
  assert.equal(late!.id, 'mk_z');
  assert.equal(late!.tint, null, 'at or past the end of the last clip: no tint');
  // No clips at all: the last marker has no tint either.
  const [only] = markerShapes([marker('mk_1', 1, BAR, 'Solo')], null, view(2400), measure) as Array<Extract<ReturnType<typeof markerShapes>[number], { kind: 'position' }>>;
  assert.equal(only!.tint, null);
});

test('a cycle marker is a range with a bar at each end and its name; cycles follow the position markers (drawn above their tints)', () => {
  const shapes = markerShapes([marker('mk_c', 1, 4n * BAR, 'Loop', 4n * BAR), ...MOCKUP], END, view(2400), measure);
  assert.deepEqual(shapes.map((s) => s.kind), ['position', 'position', 'position', 'cycle']);
  const cycle = shapes[3] as Extract<(typeof shapes)[number], { kind: 'cycle' }>;
  assert.deepEqual(cycle.tint, { x: 160, y: 42, width: 160, height: 15 });
  assert.deepEqual(cycle.left, { x: 160, y: 42, width: 2, height: 15 });
  assert.deepEqual(cycle.right, { x: 318, y: 42, width: 2, height: 15 });
  assert.deepEqual(cycle.label, { text: '1  Loop', x: 167, y: 50, width: 35 });
  // A cycle marker does not end a position marker's tint.
  assert.deepEqual((shapes[0] as Extract<(typeof shapes)[number], { kind: 'position' }>).tint, { x: 1, y: 42, width: 158, height: 15 });
});

test("markerColourVar is a track-palette token by the FNV-1a hash of the id, track-colour.ts's rule, stable", () => {
  for (const id of ['mk_1', 'mk_2', 'mk_a7f3', 'm']) {
    assert.equal(markerColourVar(id), `--track-${fnv1a32(id) % 12}`);
    assert.equal(markerColourVar(id), trackColourVar(id));
    assert.equal(markerColourVar(id), markerColourVar(id));
    assert.match(markerColourVar(id), /^--track-(\d|1[01])$/);
  }
});

test('markerHit: flag, name, the cycle marker\'s body and edges, empty space, and nothing outside the marker row', () => {
  // Position markers at 0, 160, 320 (tinting to 640); a cycle marker over bars 11 to 15 (400 to 560).
  const shapes = markerShapes([...MOCKUP, marker('mk_c', 1, 10n * BAR, 'Loop', 4n * BAR)], END, view(2400), measure);
  const at = (x: number, y = 50) => markerHit(shapes, x, y);
  assert.deepEqual(at(161), { part: 'flag', markerId: 'mk_2' });
  assert.deepEqual(at(158), { part: 'flag', markerId: 'mk_2' }, 'a few pixels either side of the bar');
  // The label "2  Verse 1" from 167, 50 px wide.
  assert.deepEqual(at(180), { part: 'name', markerId: 'mk_2' });
  assert.deepEqual(at(216), { part: 'name', markerId: 'mk_2' });
  assert.deepEqual(at(250), { part: 'empty' }, 'a tint is empty space');
  assert.deepEqual(at(402), { part: 'cycle-left', markerId: 'mk_c' });
  assert.deepEqual(at(558), { part: 'cycle-right', markerId: 'mk_c' });
  assert.deepEqual(at(562), { part: 'cycle-right', markerId: 'mk_c' });
  // The cycle's label "1  Loop" from 407, 35 px wide; its body around it.
  assert.deepEqual(at(420), { part: 'name', markerId: 'mk_c' });
  assert.deepEqual(at(480), { part: 'cycle-body', markerId: 'mk_c' });
  assert.deepEqual(at(700), { part: 'empty' });
  // The ruler above and the lanes below are not the marker row's.
  assert.equal(markerHit(shapes, 161, RULER - 1), null);
  assert.equal(markerHit(shapes, 161, RULER + MK), null);
  assert.equal(markerHit(shapes, 480, 200), null);
  assert.deepEqual(markerHit(shapes, 161, RULER), { part: 'flag', markerId: 'mk_2' });
  assert.deepEqual(markerHit(shapes, 161, RULER + MK - 1), { part: 'flag', markerId: 'mk_2' });
  assert.deepEqual(markerHit([], 100, 50), { part: 'empty' });
});
