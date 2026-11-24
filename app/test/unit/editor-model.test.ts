// The sample editor of the lower zone's Editor tab (m5b-ui-editor-channel; UI
// redesign 2.1, 5.2): which clip it shows (the app's selectedClipId, the
// primary one), where the clip's range lies over its source at the editor's
// own zoom, what a point hits (an end of the range, the volume control, the
// range's body), and the one command a release sends: dragging an end is the
// event display's trim (gestureCommand, with its snap and Ctrl without it),
// the volume control its clip.set_gain (Shift fine), through the edit guard
// and the capability rule. Pure; the expectations come from the event
// display's own builders and the clip-commands fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  editorAllows,
  editorClip,
  editorGainBox,
  editorHit,
  editorView,
  gainDragCommand,
  rangeDragCommand,
  rangePixels,
  sourcePixels,
  zoomEditor,
} from '../../src/renderer/editor/editor-model';
import { clipGainCommand, gainFromDrag } from '../../src/renderer/timeline/edit-commands';
import { gestureCommand } from '../../src/renderer/timeline/commands';
import { RULER_HEIGHT, frameToX, gainBox, xToFrame, type Viewport } from '../../src/renderer/timeline/geometry';
import { snapperFor, type SnapSettings } from '../../src/renderer/timeline/snap';
import { sampleSnapshot } from './support/timeline';

const snapshot = sampleSnapshot();
const NO_MODS = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const BEAT: SnapSettings = { on: true, grid: 'beat', type: 'grid' };
const OFF: SnapSettings = { on: false, grid: 'beat', type: 'grid' };
const all = () => true;
// 100 frames per pixel from the session's start, 1000 x 200 px.
const VIEW: Viewport = { framesPerPixel: 100, scrollFrames: '0', rulerHeight: RULER_HEIGHT, laneHeight: 200, width: 1000, height: 200 };

test('the editor shows the selected (primary) clip, and nothing without one', () => {
  assert.equal(editorClip(snapshot, 'clp_3')?.clip.id, 'clp_3');
  assert.equal(editorClip(snapshot, 'clp_3')?.media.id, 'med_sq');
  assert.equal(editorClip(snapshot, 'clp_2')?.media.id, 'med_si');
  assert.equal(editorClip(snapshot, null), null);
  assert.equal(editorClip(snapshot, 'clp_gone'), null);
  assert.equal(editorClip(null, 'clp_1'), null);
});

test('the range is the clip over its source: px and frames on the timeline', () => {
  const clp1 = editorClip(snapshot, 'clp_1')!;
  // clp_1: at 4800, from 0, 24000 long, over med_sq's 48000 frames.
  assert.deepEqual(rangePixels(clp1.clip, VIEW), { start: 48, end: 288 });
  assert.deepEqual(sourcePixels(clp1.clip, clp1.media, VIEW), { start: 48, end: 528 });
  const clp3 = editorClip(snapshot, 'clp_3')!;
  // clp_3: at 48000, from 24000: the source starts 24000 before the clip.
  assert.deepEqual(rangePixels(clp3.clip, VIEW), { start: 480, end: 720 });
  assert.deepEqual(sourcePixels(clp3.clip, clp3.media, VIEW), { start: 240, end: 720 });
});

test('the first view shows the whole source', () => {
  const { clip, media } = editorClip(snapshot, 'clp_3')!;
  const view = editorView(clip, media, 800, 200);
  assert.equal(view.width, 800);
  assert.equal(view.height, 200);
  const source = sourcePixels(clip, media, view);
  assert.ok(source.start >= 0 && source.end <= 800, `${source.start}..${source.end}`);
  assert.ok(source.end - source.start > 600, 'it fills most of the width');
});

test('a point hits an end of the range, the volume control or the body; the ruler and outside the range nothing', () => {
  const { clip } = editorClip(snapshot, 'clp_1')!;
  const y = 120;
  assert.equal(editorHit(clip, VIEW, 48, y), 'rangeStart');
  assert.equal(editorHit(clip, VIEW, 51, y), 'rangeStart');
  assert.equal(editorHit(clip, VIEW, 288, y), 'rangeEnd');
  assert.equal(editorHit(clip, VIEW, 285, y), 'rangeEnd');
  assert.equal(editorHit(clip, VIEW, 160, y), 'body');
  const gain = editorGainBox(clip, VIEW)!;
  assert.deepEqual(gain, gainBox({ x: 48, y: RULER_HEIGHT, width: 240, height: 200 - RULER_HEIGHT }));
  assert.equal(editorHit(clip, VIEW, gain.x + gain.width / 2, gain.y + gain.height / 2), 'gain');
  assert.equal(editorHit(clip, VIEW, 160, RULER_HEIGHT - 1), null, 'the ruler');
  assert.equal(editorHit(clip, VIEW, 20, y), null, 'before the range');
  assert.equal(editorHit(clip, VIEW, 400, y), null, 'after the range, over the source');
});

test('dragging the range\'s end sends the event display\'s trim for the same snapped frame', () => {
  const env = { snap: BEAT, platform: 'other' as const, flags: NO_MODS, allows: all };
  // clp_1 ends at 28800; +200 px is +20000 frames, 48800, whose nearest beat is 48000.
  const right = rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: 200, dy: 0 }, VIEW, env);
  const snap = snapperFor(BEAT, VIEW.framesPerPixel, [], 48000, false, 0n);
  assert.equal(snap(48800n), 48000n);
  assert.deepEqual(right, gestureCommand(snapshot, { kind: 'trim', clipId: 'clp_1', edge: 'right', deltaFrames: 48000n - 28800n }));
  assert.deepEqual(right?.commands, [{ op: 'clip.trim', clipId: 'clp_1', sourceStart: '0', length: '43200' }]);
  assert.equal(right?.expectedRevision, 'r7');
  // Ctrl: no snap.
  const free = rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: 200, dy: 0 }, VIEW, { ...env, flags: { ...NO_MODS, ctrlKey: true } });
  assert.deepEqual(free?.commands, [{ op: 'clip.trim', clipId: 'clp_1', sourceStart: '0', length: '44000' }]);
  // Cmd on macOS.
  const mac = rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: 200, dy: 0 }, VIEW, { ...env, platform: 'mac', flags: { ...NO_MODS, metaKey: true } });
  assert.deepEqual(mac?.commands, free?.commands);
  // Snap off in the layout: unsnapped too.
  assert.deepEqual(rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: 200, dy: 0 }, VIEW, { ...env, snap: OFF })?.commands, free?.commands);
  // The start: clp_3 starts at 48000; -150 px is 33000, nearest beat 24000; the audio stays put.
  const left = rangeDragCommand(snapshot, { clipId: 'clp_3', edge: 'left', dx: -150, dy: 0 }, VIEW, env);
  assert.deepEqual(left, gestureCommand(snapshot, { kind: 'trim', clipId: 'clp_3', edge: 'left', deltaFrames: -24000n }));
  assert.deepEqual(left?.commands, [
    { op: 'clip.trim', clipId: 'clp_3', sourceStart: '0', length: '48000' },
    { op: 'clip.move', clipId: 'clp_3', position: { domain: 'audio', value: '24000' } },
  ]);
});

test('a release where the drag started, or one that changes nothing, sends nothing', () => {
  const env = { snap: BEAT, platform: 'other' as const, flags: NO_MODS, allows: all };
  // Under the drag threshold: a click, even where snap would move the end.
  assert.equal(rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: 0, dy: 0 }, VIEW, env), null);
  assert.equal(rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: 2, dy: 1 }, VIEW, env), null);
  // clp_3 already ends at its media's end.
  assert.equal(rangeDragCommand(snapshot, { clipId: 'clp_3', edge: 'right', dx: 100, dy: 0 }, VIEW, { ...env, snap: OFF }), null);
  assert.equal(rangeDragCommand(snapshot, { clipId: 'clp_gone', edge: 'right', dx: 100, dy: 0 }, VIEW, env), null);
});

test('the volume control sends one clip.set_gain, Shift fine', () => {
  const env = { platform: 'other' as const, flags: NO_MODS, allows: all };
  const up = gainDragCommand(snapshot, { clipId: 'clp_1', dx: 0, dy: -30 }, env);
  assert.deepEqual(up, clipGainCommand(snapshot, 'clp_1', gainFromDrag(0, -30, false)));
  assert.deepEqual(up?.commands, [{ op: 'clip.set_gain', clipId: 'clp_1', gainMilliDb: 3000 }]);
  const fine = gainDragCommand(snapshot, { clipId: 'clp_1', dx: 0, dy: -30 }, { ...env, flags: { ...NO_MODS, shiftKey: true } });
  assert.deepEqual(fine?.commands, [{ op: 'clip.set_gain', clipId: 'clp_1', gainMilliDb: 300 }]);
  assert.equal(gainDragCommand(snapshot, { clipId: 'clp_1', dx: 0, dy: 1 }, env), null, 'a click');
});

test('nothing is sent while the proposal is heard, or for a command the engine does not list', () => {
  const heard = editorAllows(() => true, 'prop_1');
  const main = editorAllows(() => true, 'main');
  const env = { snap: OFF, platform: 'other' as const, flags: NO_MODS };
  assert.equal(heard('clip.trim'), false);
  assert.equal(heard('clip.set_gain'), false);
  assert.equal(main('clip.trim'), true);
  assert.equal(editorAllows(() => true, null)('clip.trim'), true, 'unknown side: not held');
  assert.equal(rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: -100, dy: 0 }, VIEW, { ...env, allows: heard }), null);
  assert.equal(gainDragCommand(snapshot, { clipId: 'clp_1', dx: 0, dy: -30 }, { ...env, allows: heard }), null);
  assert.notEqual(rangeDragCommand(snapshot, { clipId: 'clp_1', edge: 'right', dx: -100, dy: 0 }, VIEW, { ...env, allows: main }), null);
  // The start needs clip.move as well as clip.trim.
  const noMove = editorAllows((op) => op !== 'clip.move', 'main');
  assert.equal(rangeDragCommand(snapshot, { clipId: 'clp_3', edge: 'left', dx: 100, dy: 0 }, VIEW, { ...env, allows: noMove }), null);
  assert.notEqual(rangeDragCommand(snapshot, { clipId: 'clp_3', edge: 'right', dx: -100, dy: 0 }, VIEW, { ...env, allows: noMove }), null);
  assert.equal(gainDragCommand(snapshot, { clipId: 'clp_1', dx: 0, dy: -30 }, { ...env, allows: editorAllows((op) => op !== 'clip.set_gain', 'main') }), null);
});

test('H and G zoom the editor about its range\'s centre', () => {
  const { clip } = editorClip(snapshot, 'clp_1')!;
  const centre = (r: { start: number; end: number }) => (r.start + r.end) / 2;
  const before = centre(rangePixels(clip, VIEW));
  const frame = xToFrame(before, VIEW);
  const zoomedIn = zoomEditor(VIEW, clip, 1);
  assert.equal(zoomedIn.framesPerPixel, 50);
  assert.ok(Math.abs(frameToX(frame, zoomedIn) - before) <= 1, 'the centre stays');
  const zoomedOut = zoomEditor(VIEW, clip, -1);
  assert.equal(zoomedOut.framesPerPixel, 200);
  // A range scrolled out of the view zooms about the view's nearest edge.
  const away = zoomEditor({ ...VIEW, scrollFrames: '200000' }, clip, 1);
  assert.equal(away.framesPerPixel, 50);
});
