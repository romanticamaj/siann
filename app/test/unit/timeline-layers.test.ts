// The event display's two layers (m5-ui-arrange; UI redesign spec 5.2): the
// content layer (ruler, grid, clips, waveforms) is redrawn only when the
// snapshot, the zoom, the scroll, the size or the selection changes; the
// overlay layer (project cursor, selection outline, drag preview) redraws on
// its own, so a frame in which only the cursor moved leaves the content
// alone. Both canvases are sized to their container in device pixels and
// follow a resize and a device-pixel-ratio change. The wheel is the
// canvas's: plain wheel scrolls vertically, Shift+wheel horizontally,
// Ctrl+wheel zooms at the pointer, Ctrl+Shift+wheel changes track heights,
// and every one of them prevents the page's default (no page scroll, no
// browser zoom). Runs on fake canvases (support/surface.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MeterFrame } from '../../src/renderer/model/meter-frames';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import { LANES_TOP, clipBox, cornerHandles, xToFrame } from '../../src/renderer/timeline/geometry';
import type { PeakPyramid } from '../../src/renderer/model/peaks';
import { TOKENS } from '../../src/renderer/tokens';
import { RULER_HEIGHT, RULER_UPPER, TimelineCanvas, type GhostSource, type PlayheadSource, type LaneHeightSource, type LocatorBandSource } from '../../src/renderer/timeline/TimelineCanvas';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { bandRect, type LocatorRange } from '../../src/renderer/timeline/locators';
import type { LocatorsEntity } from '../../src/renderer/model/document';
import { clearFrames, fakeSurface, flushFrames, installSurfaceGlobals, setDevicePixelRatio } from './support/surface';
import { media, sampleSnapshot, snapshotOf, track } from './support/timeline';

installSurfaceGlobals();

// The scroll-zoom bar under the canvases (--scrollbar-h).
const SCROLLBAR = Number.parseFloat(TOKENS['scrollbar-h']);

function modelOf(initial: Snapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const model = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as ReadModel;
  return {
    model,
    set(next: Snapshot) {
      snapshot = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

function playheadOf() {
  let frame: MeterFrame | null = null;
  const listeners = new Set<() => void>();
  const source: PlayheadSource = {
    latest: () => frame,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return {
    source,
    emit(playheadSamples: string, playing = true) {
      frame = { epoch: '1', engineTimestampMicros: '0', playheadSamples, playing, entries: [] };
      for (const fn of [...listeners]) fn();
    },
  };
}

function heightsOf(initial: Record<string, number> = {}) {
  let heights = initial;
  const listeners = new Set<() => void>();
  const source: LaneHeightSource = {
    get: () => heights,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return {
    source,
    set(next: Record<string, number>) {
      heights = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

const peaks = { get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache;

function make(options: { ratio?: number; snapshot?: Snapshot } = {}) {
  clearFrames();
  setDevicePixelRatio(options.ratio ?? 1);
  const surface = fakeSurface(800, 300);
  const model = modelOf(options.snapshot ?? sampleSnapshot());
  const playhead = playheadOf();
  const heights = heightsOf();
  const located: string[] = [];
  // The cursor's clock (transport/playhead-clock.ts), moved by hand.
  const clock = { now: 1000, advance(ms: number) { this.now += ms; } };
  const timeline = new TimelineCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: model.model,
    peaks,
    execute: async () => undefined,
    playhead: playhead.source,
    laneHeights: heights.source,
    onLocate: (frames) => void located.push(frames),
    now: () => clock.now,
  });
  flushFrames();
  return { surface, model, playhead, heights, timeline, located, clock, hooks: timeline.testHooks() };
}

test('a playhead-only change redraws the overlay and not the content', () => {
  const { hooks, playhead, timeline } = make();
  const content = hooks.contentDraws();
  const overlay = hooks.overlayDraws();
  assert.equal(content, 1, 'one first content draw');
  // Locates while stopped: one overlay draw each.
  for (let i = 1; i <= 5; i += 1) {
    playhead.emit(String(i * 4800), false);
    flushFrames();
  }
  assert.equal(hooks.contentDraws(), content, 'the content layer was not redrawn');
  assert.equal(hooks.overlayDraws(), overlay + 5);
  assert.equal(hooks.cursorX(), 5 * 4800 / hooks.view().framesPerPixel);
  // A frame with the same playhead (meters only) draws nothing.
  playhead.emit('24000', false);
  assert.equal(flushFrames(), 0, 'no frame scheduled');
  // Stopped and idle: no animation frame is pending.
  playhead.emit('24000', false);
  flushFrames();
  assert.equal(flushFrames(), 0);
  timeline.destroy();
});

test('while playing the cursor follows the clock on every animation frame between realtime frames; the content is not redrawn; stopped, the loop ends', () => {
  const { hooks, playhead, timeline, clock } = make();
  const content = hooks.contentDraws();
  // 100 frames per px at 48 kHz: 1 ms is 48 frames, 0.48 px.
  playhead.emit('4800', true);
  flushFrames();
  assert.equal(hooks.cursorX(), 48);
  let overlay = hooks.overlayDraws();
  // No new realtime frame: each animation frame extrapolates (50 ms: 2400 frames).
  clock.advance(50);
  assert.equal(flushFrames(), 1, 'the overlay asked for the next animation frame itself');
  assert.equal(hooks.cursorX(), 72);
  assert.equal(hooks.overlayDraws(), overlay + 1);
  clock.advance(25);
  flushFrames();
  assert.equal(hooks.cursorX(), 84);
  overlay = hooks.overlayDraws();
  for (let i = 0; i < 10; i += 1) {
    clock.advance(1);
    flushFrames();
  }
  assert.equal(hooks.overlayDraws(), overlay + 10, 'one overlay draw per animation frame');
  assert.equal(hooks.contentDraws(), content, 'the content layer was not redrawn');
  // A late realtime frame: the lead is bounded (playhead-clock.ts MAX_LEAD_MS).
  playhead.emit('9600', true);
  flushFrames();
  clock.advance(10_000);
  flushFrames();
  assert.ok(hooks.cursorX()! <= 96 + (250 * 48) / 100, `bounded lead: ${hooks.cursorX()}`);
  // The stop frame shows the engine's position, and no frame is pending after.
  playhead.emit('12000', false);
  flushFrames();
  assert.equal(hooks.cursorX(), 120);
  clock.advance(100);
  assert.equal(flushFrames(), 0, 'stopped: the loop ended');
  assert.equal(hooks.cursorX(), 120);
  timeline.destroy();
});

test('a snapshot, a zoom, a scroll, a lane height or a size change redraws the content', () => {
  const { hooks, model, heights, surface, timeline } = make();
  let content = hooks.contentDraws();
  const expectContent = (what: string) => {
    flushFrames();
    assert.equal(hooks.contentDraws(), content + 1, what);
    content = hooks.contentDraws();
  };
  model.set({ ...sampleSnapshot(), revision: 'r8' });
  expectContent('snapshot');
  timeline.zoomIn();
  expectContent('zoom');
  surface.fire('wheel', { deltaY: 100, shiftKey: true });
  expectContent('horizontal scroll');
  heights.set({ trk_a: 200, trk_b: 200 });
  expectContent('lane heights');
  surface.fire('wheel', { deltaY: 40 });
  expectContent('vertical scroll');
  surface.resize(640, 280);
  expectContent('size');
  // Nothing changed: no draw.
  assert.equal(flushFrames(), 0);
  assert.equal(hooks.contentDraws(), content);
  timeline.destroy();
});

// The canvases end at the top of the scroll-zoom bar (--scrollbar-h, 8 px),
// where the mockup's canvas ends (m5-ui-port-arrange-canvas).
test('the canvases are the container size less the scroll-zoom bar, in device pixels, and follow a resize and a ratio change', () => {
  const { surface, hooks, timeline } = make({ ratio: 2 });
  assert.equal(SCROLLBAR, 8);
  for (const canvas of [surface.content, surface.overlay]) {
    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 2 * (300 - SCROLLBAR));
    assert.equal(canvas.style.width, '800px');
    assert.equal(canvas.style.height, `${300 - SCROLLBAR}px`);
  }
  assert.equal(hooks.view().width, 800);
  assert.equal(hooks.view().height, 300 - SCROLLBAR);
  surface.resize(1000, 420);
  flushFrames();
  for (const canvas of [surface.content, surface.overlay]) {
    assert.equal(canvas.width, 2000);
    assert.equal(canvas.height, 2 * (420 - SCROLLBAR));
  }
  assert.equal(hooks.view().width, 1000);
  setDevicePixelRatio(1.5);
  flushFrames();
  for (const canvas of [surface.content, surface.overlay]) {
    assert.equal(canvas.width, 1500);
    assert.equal(canvas.height, 1.5 * (420 - SCROLLBAR));
  }
  timeline.destroy();
});

test('the wheel: Ctrl zooms at the pointer, Shift scrolls horizontally, Ctrl+Shift changes heights, plain scrolls lanes; each prevents the default', () => {
  const tall = snapshotOf(
    ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id) => track(id)),
    [],
    [],
  );
  const { surface, hooks, timeline } = make({ snapshot: tall });
  const heightChanges: Array<[readonly string[], number]> = [];
  timeline.onLaneHeights((ids, height) => heightChanges.push([ids, height]));
  const before = hooks.view();
  const anchor = xToFrame(300, before);
  const zoom = surface.fire('wheel', { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 100 });
  assert.equal(zoom.defaultPrevented, true);
  const zoomed = hooks.view();
  assert.ok(zoomed.framesPerPixel < before.framesPerPixel, 'wheel up zooms in');
  const after = xToFrame(300, zoomed);
  assert.ok(after - anchor <= 1n && anchor - after <= 1n, `${after} vs ${anchor}`);

  const scroll = surface.fire('wheel', { deltaY: 50, shiftKey: true });
  assert.equal(scroll.defaultPrevented, true);
  assert.equal(hooks.view().framesPerPixel, zoomed.framesPerPixel);
  assert.equal(BigInt(hooks.view().scrollFrames), BigInt(zoomed.scrollFrames) + BigInt(Math.round(50 * zoomed.framesPerPixel)));
  assert.equal(hooks.view().scrollY, 0);
  const scrolledFrames = hooks.view().scrollFrames;

  const heights =surface.fire('wheel', { deltaY: -100, ctrlKey: true, shiftKey: true });
  assert.equal(heights.defaultPrevented, true);
  assert.deepEqual(heightChanges, [[tall.trackOrder, 64]]);
  assert.equal(hooks.view().framesPerPixel, zoomed.framesPerPixel, 'heights only');

  // Chromium on Windows and Linux turns a vertical wheel with Shift held into
  // deltaX (deltaY = 0): Ctrl+Shift+wheel must still change the heights.
  const swappedUp = surface.fire('wheel', { deltaX: -100, deltaY: 0, ctrlKey: true, shiftKey: true });
  assert.equal(swappedUp.defaultPrevented, true);
  assert.equal(heightChanges.length, 2, 'a Shift-swapped wheel up changes the heights');
  assert.deepEqual(heightChanges[1], heightChanges[0], 'the same step as an unswapped wheel up');
  const swappedDown = surface.fire('wheel', { deltaX: 100, deltaY: 0, ctrlKey: true, shiftKey: true });
  assert.equal(swappedDown.defaultPrevented, true);
  assert.equal(heightChanges.length, 3, 'a Shift-swapped wheel down changes the heights');
  assert.ok(heightChanges[2]![1] < heightChanges[1]![1], `shorter: ${heightChanges[2]![1]}`);
  assert.equal(hooks.view().framesPerPixel, zoomed.framesPerPixel, 'heights only');
  assert.equal(hooks.view().scrollFrames, scrolledFrames, 'no horizontal scroll');

  // 8 lanes of 53 px under a 300 px view: the lanes scroll.
  const lanes = surface.fire('wheel', { deltaY: 60 });
  assert.equal(lanes.defaultPrevented, true);
  assert.equal(hooks.view().scrollY, 60);
  timeline.destroy();
});

test("the selected clip has draw()'s 1.5 px outline on the content layer; an empty session shows the guidance", () => {
  const { surface, hooks, timeline } = make();
  const rect = hooks.clips().find((r) => r.clipId === 'clp_1')!;
  surface.fire('pointerdown', { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 });
  surface.fire('pointerup', { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 });
  surface.contentCalls.clear();
  flushFrames();
  assert.equal(timeline.getState().selectedClipId, 'clp_1');
  assert.equal(hooks.selectionOutline(), 1.5);
  assert.equal(surface.contentCalls.calls.filter((c) => c.kind === 'stroke' && c.lineWidth === 1.5).length, 1, 'one 1.5 px outline');
  assert.equal(hooks.guidance(), null);
  timeline.destroy();

  const empty = make({ snapshot: snapshotOf([], [], [], []) });
  assert.ok(empty.hooks.guidance(), 'guidance text');
  assert.ok(empty.surface.contentCalls.texts.includes(empty.hooks.guidance()!));
  empty.timeline.destroy();
});

// UI redesign spec 1.2: a muted or implicitly muted track's clips are drawn
// at 50 % (draw()'s clip()) and its lane is not dimmed; dimmedLanes() names
// those tracks (the clip alpha and the undimmed lane are held in the
// draw()-port tests below).
test('muted and implicitly muted tracks are dimmed: dimmedLanes() names them', () => {
  const base = sampleSnapshot();
  const soloed = { ...base, entities: { ...base.entities, 'track:trk_a': { ...track('trk_a'), solo: true } } };
  const solo = { ...soloed, tracks: [soloed.entities['track:trk_a'] as ReturnType<typeof track>, track('trk_b')] };
  const { hooks, timeline } = make({ snapshot: solo });
  assert.deepEqual(hooks.dimmedLanes(), ['trk_b']);
  timeline.destroy();
});

// m5-ui-transport (UI redesign spec 3.1, 3.2, 5.2): auto-scroll pages the
// view in the overlay's frame, so the content layer is redrawn only on a page
// turn; a cursor move inside the view, a locate while stopped and a playhead
// move with auto-scroll off all leave the content alone.
test('a cursor-only frame, a locate and a playhead move without a page turn do not redraw the content', () => {
  const { hooks, playhead, timeline } = make();
  timeline.setAutoScroll(true);
  flushFrames();
  const content = hooks.contentDraws();
  const view = hooks.view();
  // 800 px at 100 frames per px: frames [0, 80000) are in view.
  for (const frames of ['4800', '40000', '79000']) {
    playhead.emit(frames, true);
    flushFrames();
  }
  // A locate while stopped, past the right edge: the cursor moves, the view does not.
  playhead.emit('200000', false);
  flushFrames();
  assert.equal(hooks.cursorX(), 2000);
  assert.equal(hooks.contentDraws(), content, 'no page turn, no content draw');
  assert.equal(hooks.view().scrollFrames, view.scrollFrames);
  // Auto-scroll off: playing past the edge moves nothing either.
  timeline.setAutoScroll(false);
  playhead.emit('300000', true);
  flushFrames();
  assert.equal(hooks.contentDraws(), content);
  assert.equal(hooks.view().scrollFrames, view.scrollFrames);
  timeline.destroy();
});

test('auto-scroll pages when the cursor leaves the view while playing, once per page, and not during a clip drag', () => {
  const { hooks, playhead, timeline } = make();
  timeline.setAutoScroll(true);
  flushFrames();
  let content = hooks.contentDraws();
  playhead.emit('80000', true);
  flushFrames();
  assert.equal(hooks.view().scrollFrames, '80000', 'the cursor lands at the left edge');
  assert.equal(hooks.cursorX(), 0);
  flushFrames();
  assert.equal(hooks.contentDraws(), content + 1, 'one content draw for the page turn');
  content = hooks.contentDraws();
  playhead.emit('120000', true);
  flushFrames();
  assert.equal(hooks.view().scrollFrames, '80000');
  assert.equal(hooks.contentDraws(), content, 'inside the new page: no content draw');
  timeline.destroy();

  // A clip drag held (clp_1 is on the first page): the cursor leaves the
  // view, the view stays; after the release paging resumes.
  const second = make();
  second.timeline.setAutoScroll(true);
  flushFrames();
  const clip = second.hooks.clips().find((r) => r.clipId === 'clp_1')!;
  const grab = { clientX: clip.x + clip.width / 2, clientY: clip.y + clip.height / 2 };
  second.surface.fire('pointerdown', grab);
  second.surface.fire('pointermove', { clientX: grab.clientX + 30, clientY: grab.clientY });
  second.playhead.emit('90000', true);
  flushFrames();
  assert.equal(second.hooks.view().scrollFrames, '0', 'no page turn while the drag is held');
  second.surface.fire('pointerup', { clientX: grab.clientX + 30, clientY: grab.clientY });
  second.playhead.emit('91000', true);
  flushFrames();
  assert.equal(second.hooks.view().scrollFrames, '91000', 'paging resumes after the release');
  second.timeline.destroy();
});

test('auto-scroll follows the clock: the page turns when the extrapolated cursor leaves the view, between realtime frames', () => {
  const { hooks, playhead, timeline, clock } = make();
  timeline.setAutoScroll(true);
  playhead.emit('79000', true);
  flushFrames();
  assert.equal(hooks.view().scrollFrames, '0');
  // 50 ms later, no new frame: 79000 + 2400 is past the right edge (80000).
  clock.advance(50);
  flushFrames();
  assert.equal(hooks.view().scrollFrames, '81400', 'the cursor lands at the left edge');
  assert.equal(hooks.cursorX(), 0);
  timeline.destroy();
});

test('a press and release in the ruler\'s lower half locates once; a vertical drag zooms instead; the upper half does neither', () => {
  const { surface, hooks, timeline, located } = make();
  timeline.zoomIn();
  flushFrames();
  const view = hooks.view();
  // The lower half of the ruler: y in [RULER_UPPER, RULER_HEIGHT), [18, 40).
  surface.fire('pointerdown', { clientX: 250, clientY: 24 });
  surface.fire('pointermove', { clientX: 251, clientY: 25 });
  surface.fire('pointerup', { clientX: 251, clientY: 25 });
  assert.deepEqual(located, [xToFrame(250, view).toString()], 'one locate at the frame under the press');
  assert.deepEqual(hooks.view(), view, 'the view is unchanged');

  // A vertical drag beyond the threshold zooms about the pointer and does not locate.
  surface.fire('pointerdown', { clientX: 250, clientY: 20 });
  surface.fire('pointermove', { clientX: 250, clientY: 40 });
  surface.fire('pointerup', { clientX: 250, clientY: 60 });
  assert.equal(located.length, 1, 'no second locate');
  assert.ok(hooks.view().framesPerPixel < view.framesPerPixel, 'dragged down: zoomed in');

  // The upper half (the locators', P1-7): no locate, no zoom.
  const zoomed = hooks.view();
  surface.fire('pointerdown', { clientX: 300, clientY: 8 });
  surface.fire('pointerup', { clientX: 300, clientY: 8 });
  surface.fire('pointerdown', { clientX: 300, clientY: 8 });
  surface.fire('pointermove', { clientX: 300, clientY: 60 });
  surface.fire('pointerup', { clientX: 300, clientY: 60 });
  assert.equal(located.length, 1);
  assert.deepEqual(hooks.view(), zoomed);

  // A locate never goes before the session's start.
  timeline.destroy();
  const start = make();
  start.surface.fire('pointerdown', { clientX: 0, clientY: 24 });
  start.surface.fire('pointerup', { clientX: 0, clientY: 24 });
  assert.deepEqual(start.located, ['0']);
  start.timeline.destroy();
});

// UI redesign spec 3.2: the ruler's halves are 18 and 22 px (RULER_UPPER and
// RULER_LOWER), not two halves of its height: the press and the pointer
// switch at the upper half's height.
test("the ruler switches from the locators' half to the cursor's at RULER_UPPER, not at half the height", () => {
  const { surface, hooks, timeline, located } = make();
  assert.equal(hooks.view().rulerHeight, RULER_HEIGHT);
  assert.notEqual(RULER_UPPER, RULER_HEIGHT / 2);
  const move = (y: number) => {
    surface.fire('pointermove', { clientX: 200, clientY: y });
    return surface.overlay.style.cursor;
  };
  assert.equal(move(RULER_UPPER - 1), 'default', "the locators' half");
  assert.equal(move(RULER_UPPER), 'ns-resize', "the cursor's half starts at RULER_UPPER");
  assert.equal(move(RULER_HEIGHT / 2 - 1), 'ns-resize');
  assert.equal(move(RULER_HEIGHT - 1), 'ns-resize');
  surface.fire('pointerdown', { clientX: 200, clientY: RULER_UPPER - 1 });
  surface.fire('pointerup', { clientX: 200, clientY: RULER_UPPER - 1 });
  assert.deepEqual(located, [], "a press in the locators' half does not locate");
  surface.fire('pointerdown', { clientX: 200, clientY: RULER_UPPER });
  surface.fire('pointerup', { clientX: 200, clientY: RULER_UPPER });
  assert.equal(located.length, 1, 'a press at RULER_UPPER locates');
  timeline.destroy();
});

// UI redesign spec 3.1, "Set the cursor": Shift+Alt-click in the event
// display locates too, on an empty lane and on a clip alike, and neither
// selects, drags nor places.
test('Shift+Alt-click in the event display locates at the pressed frame and does not select or drag', () => {
  const { surface, hooks, timeline, located } = make();
  const view = hooks.view();
  const clip = hooks.clips().find((r) => r.clipId === 'clp_1')!;
  const other = hooks.clips().find((r) => r.clipId === 'clp_2')!;
  surface.fire('pointerdown', { clientX: other.x + other.width / 2, clientY: other.y + other.height / 2 });
  surface.fire('pointerup', { clientX: other.x + other.width / 2, clientY: other.y + other.height / 2 });
  assert.equal(timeline.getState().selectedClipId, 'clp_2');
  assert.deepEqual(located, [], 'a plain click on a clip does not locate');

  // On the clip: a locate, the selection stays, a following move drags nothing.
  const onClip = { clientX: clip.x + 10, clientY: clip.y + clip.height / 2, shiftKey: true, altKey: true };
  surface.fire('pointerdown', onClip);
  surface.fire('pointermove', { ...onClip, clientX: onClip.clientX + 40 });
  surface.fire('pointerup', { ...onClip, clientX: onClip.clientX + 40 });
  assert.deepEqual(located, [xToFrame(onClip.clientX, view).toString()]);
  assert.equal(timeline.getState().selectedClipId, 'clp_2', 'the selection is unchanged');
  assert.deepEqual(hooks.clips().find((r) => r.clipId === 'clp_1'), clip, 'the clip did not move');

  // On an empty stretch of a lane: a locate, and the selection is not cleared.
  const empty = { clientX: 700, clientY: clip.y + clip.height / 2, shiftKey: true, altKey: true };
  surface.fire('pointerdown', empty);
  surface.fire('pointerup', empty);
  assert.deepEqual(located.at(-1), xToFrame(700, view).toString());
  assert.equal(timeline.getState().selectedClipId, 'clp_2');

  // Shift alone or Alt alone in the event display does not locate.
  for (const mods of [{ shiftKey: true }, { altKey: true }]) {
    surface.fire('pointerdown', { clientX: 700, clientY: empty.clientY, ...mods });
    surface.fire('pointerup', { clientX: 700, clientY: empty.clientY, ...mods });
  }
  assert.equal(located.length, 2);
  timeline.destroy();
});

// m5-ui-edit-basics: a selection of several clips, each outlined; Shift-click
// adds; the snap guide and the preview of an Alt-drag copy are drawn on the
// overlay only, so the content layer is not redrawn while dragging.
test('a multi-clip selection outlines every selected clip; the snap guide and the copy preview are overlay-only', () => {
  const { surface, hooks, timeline } = make();
  const at = (id: string) => {
    const rect = hooks.clips().find((r) => r.clipId === id)!;
    return { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
  };
  surface.fire('pointerdown', at('clp_1'));
  surface.fire('pointerup', at('clp_1'));
  surface.fire('pointerdown', { ...at('clp_3'), shiftKey: true });
  surface.fire('pointerup', { ...at('clp_3'), shiftKey: true });
  assert.deepEqual(hooks.selectedClips(), ['clp_1', 'clp_3']);
  assert.equal(timeline.getState().selectedClipId, 'clp_3', 'the last clicked is the primary');
  const outlines = () => surface.contentCalls.calls.filter((c) => c.kind === 'stroke' && c.lineWidth === 1.5).length;
  surface.contentCalls.clear();
  timeline.invalidate();
  flushFrames();
  assert.equal(outlines(), 2, 'two outlines');
  timeline.selectAll();
  surface.contentCalls.clear();
  flushFrames();
  assert.deepEqual([...hooks.selectedClips()].sort(), ['clp_1', 'clp_2', 'clp_3']);
  assert.equal(outlines(), 3, 'three outlines');

  // An Alt-drag of clp_1: the copies are previewed and the snap guide shown, on the overlay.
  flushFrames();
  const content = hooks.contentDraws();
  const overlay = hooks.overlayDraws();
  const from = at('clp_1');
  surface.fire('pointerdown', { ...from, altKey: true });
  for (let dx = 10; dx <= 50; dx += 10) {
    surface.fire('pointermove', { clientX: from.clientX + dx, clientY: from.clientY, altKey: true });
    flushFrames();
  }
  assert.equal(hooks.contentDraws(), content, 'no content redraw during the drag');
  assert.ok(hooks.overlayDraws() > overlay);
  assert.notEqual(hooks.snapGuide(), null, 'the snap guide (snap is on by default)');
  assert.ok(surface.overlayCalls.alphas.some((a) => a > 0 && a < 1), 'a translucent copy preview');
  surface.fire('pointerup', { clientX: from.clientX + 50, clientY: from.clientY, altKey: true });
  flushFrames();
  assert.equal(hooks.snapGuide(), null, 'gone after the drop');
  timeline.destroy();
});

// ---------------------------------------------------------------- m5-ui-loop-click

function bandSource(initial = true) {
  let cycle = initial;
  let enabled = true;
  const listeners = new Set<() => void>();
  const edits: Array<LocatorRange | null> = [];
  let toggles = 0;
  const source: LocatorBandSource = {
    enabled: () => enabled,
    cycle: () => cycle,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setLocators: (range) => void edits.push(range),
    toggleCycle: () => {
      toggles += 1;
      return true;
    },
  };
  return {
    source,
    edits,
    toggles: () => toggles,
    setCycle(next: boolean) {
      cycle = next;
      for (const fn of [...listeners]) fn();
    },
    setEnabled(next: boolean) {
      enabled = next;
    },
  };
}

function withLocators(snapshot: Snapshot, left: string, right: string): Snapshot {
  const locators: LocatorsEntity = { schema: 'siann.entity.locators.v1', id: 'locators', left, right };
  return { ...snapshot, locators };
}

function bandRig(snapshot: Snapshot, band = bandSource()) {
  clearFrames();
  const surface = fakeSurface(800, 300);
  const m = modelOf(snapshot);
  const canvas = new TimelineCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: m.model,
    peaks,
    execute: async () => ({}),
    framesPerPixel: 100,
    locators: band.source,
  });
  flushFrames();
  return { surface, m, canvas, band, hooks: canvas.testHooks() };
}

const UPPER_Y = RULER_UPPER / 2;

test('the band is drawn light with cycle on and grey with it off, no band without locators', () => {
  const r = bandRig(withLocators(sampleSnapshot(), '10000', '30000'));
  const band = r.hooks.locatorBand();
  assert.ok(band);
  assert.deepEqual({ x: band.x, y: band.y, width: band.width, height: band.height }, { ...bandRect({ left: 10000n, right: 30000n }, r.hooks.view())! });
  assert.equal(band.cycle, true);
  assert.ok(r.surface.contentCalls.texts.includes('L') && r.surface.contentCalls.texts.includes('R'));
  r.band.setCycle(false);
  flushFrames();
  assert.equal(r.hooks.locatorBand()?.cycle, false);
  // No locators: no band.
  r.m.set(sampleSnapshot());
  flushFrames();
  assert.equal(r.hooks.locatorBand(), null);
  r.canvas.destroy();
});

test('the band fills, lines and labels in the light palette with cycle on and the grey one with it off; the tint covers the range over the lanes', () => {
  // Each token reads as its own name, so a fill names the token it drew in.
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.getComputedStyle;
  g.getComputedStyle = () => ({ getPropertyValue: (name: string) => name });
  try {
    const r = bandRig(withLocators(sampleSnapshot(), '10000', '30000'));
    const view = r.hooks.view();
    const rect = bandRect({ left: 10000n, right: 30000n }, view)!;
    const calls = r.surface.contentCalls;
    // The band's own fills are in the ruler's upper half (the grid's bar lines share --white-a060).
    const fillAt = (style: string) => calls.fills.filter((f) => f.style === style && f.rect[1] < RULER_UPPER).map((f) => f.rect);
    const tintAt = () => calls.fills.filter((f) => f.style === '--white-a028').map((f) => f.rect);
    const labelStyle = (text: string) => calls.labels.filter((l) => l.text === text).map((l) => l.style);
    const tint: [number, number, number, number] = [rect.x, LANES_TOP, rect.width, 300 - SCROLLBAR - LANES_TOP];
    const assertDrawn = (on: boolean) => {
      const fill = on ? '--tx-1-a200' : '--white-a060';
      const line = on ? '--tx-1' : '--tx-3';
      const label = on ? '--lit-1' : '--tx-3';
      assert.deepEqual(fillAt(fill), [[rect.x, rect.y, rect.width, rect.height]], `the band's fill (cycle ${on ? 'on' : 'off'})`);
      assert.ok(fillAt(line).some(([x, y, w]) => x === rect.x && y === rect.y && w === rect.width), `the band's top line (cycle ${on ? 'on' : 'off'})`);
      assert.equal(calls.paths.filter((p) => p.style === line).length, 2, 'both flags in the line colour');
      assert.deepEqual(labelStyle('L'), [label]);
      assert.deepEqual(labelStyle('R'), [label]);
      assert.deepEqual(fillAt(on ? '--white-a060' : '--tx-1-a200'), [], 'not the other palette');
      // The tint: the range, from the lanes' top to the display's bottom.
      assert.deepEqual(tintAt(), [tint], 'the tint over the lanes');
    };
    assertDrawn(true);
    calls.clear();
    r.band.setCycle(false);
    flushFrames();
    assertDrawn(false);
    // No locators: no band and no tint.
    calls.clear();
    r.m.set(sampleSnapshot());
    flushFrames();
    assert.deepEqual(tintAt(), []);
    assert.deepEqual(fillAt('--white-a060'), []);
    r.canvas.destroy();
  } finally {
    g.getComputedStyle = saved;
  }
});

test('nothing is drawn and the upper half is inert without the capability', () => {
  const band = bandSource();
  band.setEnabled(false);
  const r = bandRig(withLocators(sampleSnapshot(), '10000', '30000'), band);
  assert.equal(r.hooks.locatorBand(), null);
  assert.ok(!r.surface.contentCalls.texts.includes('R'));
  r.surface.fire('pointerdown', { clientX: 150, clientY: UPPER_Y });
  r.surface.fire('pointermove', { clientX: 250, clientY: UPPER_Y });
  r.surface.fire('pointerup', { clientX: 250, clientY: UPPER_Y });
  r.surface.fire('pointerdown', { clientX: 200, clientY: UPPER_Y });
  r.surface.fire('pointerup', { clientX: 200, clientY: UPPER_Y });
  assert.deepEqual(band.edits, []);
  assert.equal(band.toggles(), 0);
  // And with no source at all (an engine without E-1) the band is never drawn.
  const plain = make({ snapshot: withLocators(sampleSnapshot(), '10000', '30000') });
  assert.equal(plain.hooks.locatorBand(), null);
  plain.timeline.destroy();
  r.canvas.destroy();
});

test('a cycle change redraws the band from the source, not through React', () => {
  const r = bandRig(withLocators(sampleSnapshot(), '10000', '30000'));
  const before = r.hooks.contentDraws();
  r.band.setCycle(false);
  assert.equal(flushFrames(), 1);
  assert.equal(r.hooks.contentDraws(), before + 1);
  r.canvas.destroy();
});

test('the upper half: draw on release, click the band to toggle, drag the band and an end, Mod-click and Alt-click', () => {
  const r = bandRig(withLocators(sampleSnapshot(), '10000', '30000'));
  r.canvas.setSnap({ on: false, grid: 'bar' });
  const drag = (from: number, to: number, mods: Record<string, unknown> = {}) => {
    r.surface.fire('pointerdown', { clientX: from, clientY: UPPER_Y, ...mods });
    if (to !== from) r.surface.fire('pointermove', { clientX: to, clientY: UPPER_Y, ...mods });
    r.surface.fire('pointerup', { clientX: to, clientY: UPPER_Y, ...mods });
  };
  // Draw outside the band (x 400 -> 500): one edit on release, nothing before.
  r.surface.fire('pointerdown', { clientX: 400, clientY: UPPER_Y });
  r.surface.fire('pointermove', { clientX: 500, clientY: UPPER_Y });
  assert.deepEqual(r.band.edits, []);
  // The preview shows on the band while dragging.
  flushFrames();
  assert.equal(r.hooks.locatorBand()?.left, '40000');
  r.surface.fire('pointerup', { clientX: 500, clientY: UPPER_Y });
  assert.deepEqual(r.band.edits, [{ left: 40000n, right: 50000n }]);
  // Click the band (x 200): cycle toggles, nothing is edited.
  drag(200, 200);
  assert.equal(r.band.toggles(), 1);
  assert.equal(r.band.edits.length, 1);
  // Drag the band by 50 px: moved, the length kept.
  drag(200, 250);
  assert.deepEqual(r.band.edits.at(-1), { left: 15000n, right: 35000n });
  // Drag the right end past the left: stops one pixel (100 frames) before it.
  drag(300, 20);
  assert.deepEqual(r.band.edits.at(-1), { left: 10000n, right: 10100n });
  // Mod-click (Ctrl) sets the left locator, Alt-click the right one.
  drag(150, 150, { ctrlKey: true });
  assert.deepEqual(r.band.edits.at(-1), { left: 15000n, right: 30000n });
  drag(450, 450, { altKey: true });
  assert.deepEqual(r.band.edits.at(-1), { left: 10000n, right: 45000n });
  // A zero-length draw hands null (nothing to send).
  drag(600, 600);
  assert.equal(r.band.toggles(), 1);
  r.canvas.destroy();
});

test('with snap on the drawn range lands on the grid', () => {
  const r = bandRig(sampleSnapshot());
  r.canvas.setSnap({ on: true, grid: 'beat' });
  // A beat at 120 BPM is 24000 frames: x 230 (23000) and 470 (47000) snap to 24000 and 48000.
  r.surface.fire('pointerdown', { clientX: 230, clientY: UPPER_Y });
  r.surface.fire('pointermove', { clientX: 470, clientY: UPPER_Y });
  r.surface.fire('pointerup', { clientX: 470, clientY: UPPER_Y });
  assert.deepEqual(r.band.edits, [{ left: 24000n, right: 48000n }]);
  r.canvas.destroy();
});

// ---------------------------------------------------------------- m5-ui-port-arrange-canvas
//
// The content layer is the mockup's draw() (mockup.html lines 376-472), its
// parameters from tokens.ts and its colours from tokens.css; each custom
// property reads as its own name here, so a call names the token it drew in.

const RU = RULER_UPPER;

function withNamedTokens<T>(fn: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.getComputedStyle;
  g.getComputedStyle = () => ({ getPropertyValue: (name: string) => name });
  try {
    return fn();
  } finally {
    g.getComputedStyle = saved;
  }
}

function drawRig(snapshot: Snapshot, options: { framesPerPixel?: number; band?: boolean; pyramid?: PeakPyramid } = {}) {
  clearFrames();
  setDevicePixelRatio(1);
  const surface = fakeSurface(800, 300);
  const m = modelOf(snapshot);
  const playhead = playheadOf();
  const band = bandSource();
  const pyramid = options.pyramid;
  const cache = { get: () => pyramid, subscribe: () => () => undefined } as unknown as PeaksCache;
  const canvas = new TimelineCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: m.model,
    peaks: cache,
    execute: async () => ({}),
    framesPerPixel: options.framesPerPixel ?? 100,
    playhead: playhead.source,
    locators: options.band ? band.source : undefined,
  });
  flushFrames();
  return { surface, m, canvas, playhead, hooks: canvas.testHooks() };
}

const H = 300 - SCROLLBAR;
const BAR = 96000;

test("the content frame draws draw()'s lanes, tint, grid, dividers and ruler, in its order, and leaves the marker row empty", () => {
  withNamedTokens(() => {
    const three = withLocators(snapshotOf(['t0', 't1', 't2'], ['t0', 't1', 't2'].map((id) => track(id)), [], []), String(8 * BAR), String(12 * BAR));
    // 40 px per bar (the mockup's PXB): a beat is 10 px.
    const r = drawRig(three, { framesPerPixel: 2400, band: true });
    const calls = r.surface.contentCalls.calls;
    const at = (style: string, rect: readonly number[]) => calls.findIndex((c) => c.kind === 'fillRect' && c.style === style && rect.every((v, i) => c.args[i] === v));
    // Lanes in --lane-even and --lane-odd, from LANES_TOP.
    const lanes = [at('--lane-even', [0, LANES_TOP, 800, 53]), at('--lane-odd', [0, LANES_TOP + 53, 800, 53]), at('--lane-even', [0, LANES_TOP + 106, 800, 53])];
    for (const index of lanes) assert.ok(index >= 0, `lanes ${lanes}`);
    // The cycle range's tint over the lanes: bars 9 to 13.
    const tint = at('--white-a028', [320, LANES_TOP, 160, H - LANES_TOP]);
    // Beat lines, and bar lines: --white-a110 every fourth bar, --white-a060 between.
    const beat = at('--white-a026', [10, LANES_TOP, 1, H - LANES_TOP]);
    const bar1 = at('--white-a110', [0, LANES_TOP, 1, H - LANES_TOP]);
    const bar2 = at('--white-a060', [40, LANES_TOP, 1, H - LANES_TOP]);
    const bar5 = at('--white-a110', [160, LANES_TOP, 1, H - LANES_TOP]);
    for (const [name, index] of Object.entries({ tint, beat, bar1, bar2, bar5 })) assert.ok(index >= 0, name);
    assert.ok(at('--white-a026', [20, LANES_TOP, 1, H - LANES_TOP]) >= 0 && at('--white-a026', [30, LANES_TOP, 1, H - LANES_TOP]) >= 0);
    // Lane dividers at each lane's last row.
    const dividers = [1, 2, 3].map((i) => at('--divider', [0, LANES_TOP + i * 53 - 1, 800, 1]));
    for (const index of dividers) assert.ok(index >= 0, `dividers ${dividers}`);
    // The ruler: the upper half, the band, the line under it, the lower half.
    const upper = at('--ruler-upper', [0, 0, 800, RU]);
    const band = calls.findIndex((c) => c.kind === 'fillRect' && c.style === '--tx-1-a200');
    const line = at('--white-a050', [0, RU, 800, 1]);
    const lower = at('--bg-2', [0, RU + 1, 800, RULER_HEIGHT - RU - 1]);
    // Ticks: a major tick every fourth bar, minor ones, the quarters in --button-line.
    const major = at('--ruler-major', [0, RU + 3, 1, RULER_HEIGHT - RU - 3]);
    const minor = at('--ruler-minor', [40, RULER_HEIGHT - 9, 1, 9]);
    const quarter = at('--button-line', [10, RULER_HEIGHT - 5, 1, 5]);
    assert.ok(at('--ruler-major', [160, RU + 3, 1, RULER_HEIGHT - RU - 3]) >= 0, 'bar 5 is major');
    const bottom = at('--divider', [0, RULER_HEIGHT - 1, 800, 1]);
    for (const [name, index] of Object.entries({ upper, band, line, lower, major, minor, quarter, bottom })) assert.ok(index >= 0, name);
    // In draw()'s order.
    const order = [Math.max(...lanes), tint, beat, bar1, Math.max(...dividers), upper, band, line, lower, major, bottom];
    assert.deepEqual([...order].sort((a, b) => a - b), order, `the order: ${order}`);
    // Bar numbers at RU + 10 in --fw-ui --fs-micro, lit every fourth bar.
    const labels = calls.filter((c) => c.kind === 'fillText' && c.args[1] === RU + 10);
    // draw() labels every bar at its 40 px per bar: 1 to 20 across 800 px.
    assert.deepEqual(labels.slice(0, 5).map((c) => [c.text, c.args[0], c.style]), [['1', 4, '--lit-1'], ['2', 44, '--tx-3'], ['3', 84, '--tx-3'], ['4', 124, '--tx-3'], ['5', 164, '--lit-1']]);
    assert.deepEqual(labels.map((c) => c.text), Array.from({ length: 20 }, (_, i) => String(i + 1)));
    for (const label of labels) assert.ok(label.font.startsWith(`${TOKENS['fw-ui']} ${TOKENS['fs-micro']} `), label.font);
    // The marker row (RULER_HEIGHT to LANES_TOP) is empty: nothing is drawn in it.
    const inRow = calls.filter((c) => (c.kind === 'fillRect' || c.kind === 'strokeRect') && c.args[1]! < LANES_TOP && c.args[1]! + c.args[3]! > RULER_HEIGHT);
    assert.deepEqual(inRow, [], 'the marker track row is empty');
    assert.ok(!calls.some((c) => c.kind === 'fillText' && c.args[1]! >= RULER_HEIGHT && c.args[1]! < LANES_TOP), 'no text in the marker row');
    // Lanes are not dimmed (draw() does not dim them).
    for (const index of lanes) assert.equal(calls[index]!.alpha, 1);
    r.canvas.destroy();
  });
});

test("a clip is draw()'s clip(): body, title strip, title, outline; a muted track's clip at 50 %", () => {
  withNamedTokens(() => {
    const base = sampleSnapshot();
    const muted = { ...track('trk_b'), mute: true };
    const snapshot = { ...base, tracks: [track('trk_a'), muted], entities: { ...base.entities, 'track:trk_b': muted } };
    const r = drawRig(snapshot);
    const calls = r.surface.contentCalls.calls;
    const rects = r.hooks.clips();
    const bodyOf = (id: string) => {
      const box = clipBox(rects.find((c) => c.clipId === id)!);
      return calls.find((c) => c.kind === 'fill' && c.path?.some((s) => s.op === 'roundRect' && s.args.join() === [box.x, box.y, box.width, box.height, 4].join()));
    };
    // clp_1 is on the muted trk_b, clp_2 on trk_a.
    assert.equal(bodyOf('clp_1')?.alpha, 0.5, "the muted track's clip at 50 %");
    assert.equal(bodyOf('clp_2')?.alpha, 1);
    assert.deepEqual(r.hooks.dimmedLanes(), ['trk_b'], 'dimmedLanes still reports');
    // The title strip --clip-title-h high at the box's top, then the title in --bg-well.
    const box = clipBox(rects.find((c) => c.clipId === 'clp_2')!);
    const strip = calls.findIndex((c) => c.kind === 'fillRect' && c.args.join() === [box.x, box.y, box.width, Number.parseFloat(TOKENS['clip-title-h'])].join());
    assert.ok(strip >= 0, 'the title strip');
    const title = calls.findIndex((c) => c.kind === 'fillText' && c.text === 'med_si');
    assert.ok(title > strip);
    assert.deepEqual(calls[title]!.args.slice(0, 2), [box.x + 6, box.y + 7]);
    assert.equal(calls[title]!.style, '--bg-well');
    // The unselected outline: --black-a550 at 1 px, half a pixel inside the box.
    const outline = calls.find((c) => c.kind === 'stroke' && c.style === '--black-a550' && c.path?.some((s) => s.op === 'roundRect' && s.args.join() === [box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1, 4].join()));
    assert.ok(outline, 'the outline');
    assert.equal(outline.lineWidth, 1);
    r.canvas.destroy();
  });
});

test('the title is clipTitle() in --fw-strong --fs-micro, follows a media rename in the next snapshot, and needs a box wider than 26 px', () => {
  withNamedTokens(() => {
    const base = sampleSnapshot();
    const tiny = { schema: 'siann.entity.clip.v1' as const, id: 'clp_t', trackId: 'trk_a', mediaId: 'med_si', position: { domain: 'audio' as const, value: '30000' }, sourceStart: '0', length: '2000', gainMilliDb: 0 };
    const snapshot = { ...base, clips: [...base.clips, tiny], entities: { ...base.entities, 'clip:clp_t': tiny } };
    const r = drawRig(snapshot);
    const content = r.surface.content;
    const texts = () => r.surface.contentCalls.calls.filter((c) => c.kind === 'fillText' && c.font.startsWith(`${TOKENS['fw-strong']} ${TOKENS['fs-micro']} `)).map((c) => c.text);
    assert.deepEqual(texts().sort(), ['med_si', 'med_sq', 'med_sq'], 'the media id while the media has no name; nothing on an 18 px box');
    assert.deepEqual(r.hooks.clips().map((c) => [c.clipId, c.title]), [['clp_1', 'med_sq'], ['clp_2', 'med_si'], ['clp_t', 'med_si'], ['clp_3', 'med_sq']]);
    // media.rename: the next snapshot carries the name.
    const named = { ...(base.entities['media:med_sq'] as ReturnType<typeof media>), name: 'Kick 909' };
    r.surface.contentCalls.clear();
    r.m.set({ ...snapshot, revision: 'r8', media: [snapshot.media[0]!, named], entities: { ...snapshot.entities, 'media:med_sq': named } });
    flushFrames();
    assert.deepEqual(texts().sort(), ['Kick 909', 'Kick 909', 'med_si']);
    assert.equal(r.hooks.clips().find((c) => c.clipId === 'clp_1')!.title, 'Kick 909');
    assert.equal(r.surface.content, content, 'the same canvas');
    r.canvas.destroy();
  });
});

test('a selected clip has the selected outline and the two corner squares; no fade, repeat handle or ghost is drawn; a selection redraws the content', () => {
  withNamedTokens(() => {
    const r = drawRig(sampleSnapshot());
    const rect = r.hooks.clips().find((c) => c.clipId === 'clp_1')!;
    const box = clipBox(rect);
    const draws = r.hooks.contentDraws();
    const overlays = r.hooks.overlayDraws();
    r.surface.contentCalls.clear();
    r.surface.overlayCalls.clear();
    r.surface.fire('pointerdown', { clientX: box.x + 100, clientY: box.y + 20 });
    r.surface.fire('pointerup', { clientX: box.x + 100, clientY: box.y + 20 });
    flushFrames();
    assert.deepEqual(r.hooks.selectedClips(), ['clp_1']);
    assert.equal(r.hooks.contentDraws(), draws + 1, 'a selection change redraws the content layer');
    assert.ok(r.hooks.overlayDraws() > overlays);
    const calls = r.surface.contentCalls.calls;
    const outline = calls.find((c) => c.kind === 'stroke' && c.style === '--select' && c.lineWidth === 1.5);
    assert.ok(outline?.path?.some((s) => s.op === 'roundRect' && s.args.join() === [box.x + 0.25, box.y + 0.25, box.width - 0.5, box.height - 0.5, 4].join()), 'the outline 0.25 px inside the box');
    for (const corner of cornerHandles(box)) {
      assert.ok(calls.some((c) => c.kind === 'fillRect' && c.style === '--select' && c.args.join() === [corner.x, corner.y, corner.width, corner.height].join()), `the corner at ${corner.x}`);
    }
    // Pending parts (m5b-ui-fades, m5b-ui-ghosts, the repeat handle): not drawn, on either layer.
    for (const call of [...calls, ...r.surface.overlayCalls.calls]) {
      assert.ok(!call.path?.some((s) => s.op === 'quadraticCurveTo' || s.op === 'arc'), 'no fade curve and no repeat handle');
      assert.notEqual(call.style, '--bg-0-a550', 'no fade shade');
      assert.ok(!/^--ai/.test(call.style), 'no ghost');
      if (call.kind === 'fill' && call.path && call.path.length === 3 && call.path[0]!.args[1]! > RULER_HEIGHT) assert.fail(`a triangle at ${JSON.stringify(call.path)}: no fade triangle`);
    }
    r.canvas.destroy();
  });
});

test("the project cursor: a 1 px line from RU + 2 to the surface's height, the glow from LANES_TOP, and draw()'s five-point head", () => {
  withNamedTokens(() => {
    const r = drawRig(sampleSnapshot());
    r.surface.overlayCalls.clear();
    r.playhead.emit('4800', false);
    flushFrames();
    const px = 48.5;
    const calls = r.surface.overlayCalls.calls;
    const line = calls.find((c) => c.kind === 'stroke' && c.style === '--select');
    assert.deepEqual(line?.path, [{ op: 'moveTo', args: [px, RU + 2] }, { op: 'lineTo', args: [px, H] }]);
    assert.equal(line?.lineWidth, 1);
    assert.ok(calls.some((c) => c.kind === 'fillRect' && c.style === '--white-a070' && c.args.join() === [px - 3, LANES_TOP, 6, H - LANES_TOP].join()), 'the glow');
    const head = calls.find((c) => c.kind === 'fill' && c.style === '--select');
    assert.deepEqual(head?.path?.map((s) => [s.op, ...s.args]), [
      ['moveTo', px - 5.5, RU + 2],
      ['lineTo', px + 5.5, RU + 2],
      ['lineTo', px + 5.5, RU + 8],
      ['lineTo', px, RU + 13],
      ['lineTo', px - 5.5, RU + 8],
    ]);
    r.canvas.destroy();
  });
});

test("parts() names the surface's parts with their boxes and no pending part", () => {
  const r = drawRig(withLocators(sampleSnapshot(), '10000', '30000'), { band: true });
  r.playhead.emit('4800', false);
  flushFrames();
  const parts = r.hooks.parts();
  const byId = Object.fromEntries(parts.map((p) => [p.id, p]));
  assert.deepEqual(parts.map((p) => p.id), ['ruler-upper', 'ruler-lower', 'lane-1', 'lane-2', 'clip-1', 'clip-2', 'clip-3', 'locator-band', 'cursor', 'cursor-head']);
  assert.deepEqual(byId['ruler-upper'], { id: 'ruler-upper', x: 0, y: 0, w: 800, h: RU });
  assert.deepEqual(byId['ruler-lower'], { id: 'ruler-lower', x: 0, y: RU, w: 800, h: RULER_HEIGHT - RU });
  assert.deepEqual(byId['lane-2'], { id: 'lane-2', x: 0, y: LANES_TOP + 53, w: 800, h: 53 });
  const box = clipBox(r.hooks.clips()[0]!);
  assert.deepEqual(byId['clip-1'], { id: 'clip-1', x: box.x, y: box.y, w: box.width, h: box.height });
  const band = r.hooks.locatorBand()!;
  assert.deepEqual(byId['locator-band'], { id: 'locator-band', x: band.x, y: band.y, w: band.width, h: band.height });
  assert.deepEqual(byId.cursor, { id: 'cursor', x: 48, y: RU + 2, w: 1, h: H - RU - 2 });
  assert.deepEqual(byId['cursor-head'], { id: 'cursor-head', x: 43, y: RU + 2, w: 11, h: 11 });
  for (const id of parts.map((p) => p.id)) assert.doesNotMatch(id, /^(marker-track|marker-head|clip-ghost-|lane-ghost)/);
  // The waveform interiors (the fidelity run masks them): each clip's box below its title strip.
  assert.deepEqual(r.hooks.masks()[0], { x: box.x, y: box.y + 13, w: box.width, h: box.height - 13 });
  // Without locators and without a playhead: neither part.
  const bare = drawRig(sampleSnapshot());
  assert.deepEqual(bare.hooks.parts().map((p) => p.id), ['ruler-upper', 'ruler-lower', 'lane-1', 'lane-2', 'clip-1', 'clip-2', 'clip-3']);
  bare.canvas.destroy();
  r.canvas.destroy();
});

test('a press in the marker row does nothing', () => {
  const executed: unknown[] = [];
  clearFrames();
  const surface = fakeSurface(800, 300);
  const m = modelOf(sampleSnapshot());
  const located: string[] = [];
  const canvas = new TimelineCanvas({ content: surface.content, overlay: surface.overlay, container: surface.container, model: m.model, peaks, execute: async (c) => void executed.push(c), onLocate: (f) => void located.push(f) });
  flushFrames();
  const hooks = canvas.testHooks();
  const view = hooks.view();
  canvas.setPlacing('med_sq');
  surface.fire('pointerdown', { clientX: 100, clientY: RULER_HEIGHT + 5 });
  surface.fire('pointermove', { clientX: 100, clientY: RULER_HEIGHT + 30 });
  surface.fire('pointerup', { clientX: 100, clientY: RULER_HEIGHT + 30 });
  assert.deepEqual(executed, [], 'no placement');
  assert.deepEqual(located, [], 'no locate');
  assert.deepEqual(hooks.view(), view, 'no zoom');
  assert.equal(canvas.getState().placingMediaId, 'med_sq', 'still armed');
  canvas.destroy();
});

test('the waveform: two tones per device-pixel column from the peaks, the outer one at 50 % alpha by globalAlpha; waveColumns() holds the outer heights', () => {
  withNamedTokens(() => {
    // med_sq is 48000 frames: loud for the first 24000, silent after.
    const levelOf = (k: number) => {
      const binFrames = 256 * 4 ** k;
      const binCount = Math.ceil(48000 / binFrames);
      const values = Int16Array.from(Array.from({ length: binCount }, (_, i) => (i * binFrames < 24000 ? [-30000, 30000] : [0, 0])).flat());
      return { binFrames, binCount, values };
    };
    const pyramid: PeakPyramid = { channels: 1, frames: 48000, sampleRate: 48000, levels: [0, 1, 2, 3, 4].map(levelOf) };
    const base = sampleSnapshot();
    const muted = { ...track('trk_a'), mute: true };
    const snapshot = { ...base, tracks: [muted, track('trk_b')], entities: { ...base.entities, 'track:trk_a': muted } };
    const r = drawRig(snapshot, { pyramid });
    // clp_1 (trk_b): frames 0..24000 of med_sq, all loud; clp_3 (trk_a, muted): 24000..48000, silent.
    const loud = r.hooks.waveColumns('clp_1');
    assert.ok(loud.length >= 230, `${loud.length} columns`);
    const box = clipBox(r.hooks.clips().find((c) => c.clipId === 'clp_1')!);
    const half = (box.height - 13) / 2 - 2;
    for (const h of loud) assert.ok(Math.abs(h - (30000 / 32767) * half) < 1e-9, `outer ${h}`);
    assert.ok(r.hooks.waveColumns('clp_3').every((h) => h === 0.5), 'silence is half a pixel');
    assert.deepEqual(r.hooks.peakColumns('clp_1'), { drawn: loud.length, nonZero: loud.length });
    const inside = (b: ReturnType<typeof clipBox>) =>
      r.surface.contentCalls.calls.filter((c) => c.kind === 'fillRect' && c.args[2] === 1 && c.args[0]! >= b.x && c.args[0]! < b.x + b.width && c.args[1]! > b.y + 13 - 1 && c.args[1]! < b.y + b.height);
    assert.deepEqual([...new Set(inside(box).map((c) => c.alpha))].sort(), [0.5, 1], 'the outer layer at .5, the inner at 1');
    // The muted track's clip: .5 of each.
    const box3 = clipBox(r.hooks.clips().find((c) => c.clipId === 'clp_3')!);
    assert.deepEqual([...new Set(inside(box3).map((c) => c.alpha))].sort(), [0.25, 0.5]);
    r.canvas.destroy();
  });
});

test('the waveform fills between the min and the max: a one-sided signal is drawn above the middle only', () => {
  withNamedTokens(() => {
    // med_sq: 0 to +30000 throughout (never below zero).
    const levelOf = (k: number) => {
      const binFrames = 256 * 4 ** k;
      const binCount = Math.ceil(48000 / binFrames);
      return { binFrames, binCount, values: Int16Array.from(Array.from({ length: binCount }, () => [0, 30000]).flat()) };
    };
    const pyramid: PeakPyramid = { channels: 1, frames: 48000, sampleRate: 48000, levels: [0, 1, 2, 3, 4].map(levelOf) };
    const r = drawRig(sampleSnapshot(), { pyramid });
    const box = clipBox(r.hooks.clips().find((c) => c.clipId === 'clp_1')!);
    const half = (box.height - 13) / 2 - 2;
    const mid = box.y + 13 + (box.height - 13) / 2;
    const rects = r.surface.contentCalls.calls.filter((c) => c.kind === 'fillRect' && c.args[2] === 1 && c.args[0]! >= box.x && c.args[0]! < box.x + box.width && c.args[1]! > box.y + 13 - 1 && c.args[1]! < box.y + box.height);
    const outer = rects.filter((c) => c.alpha === 0.5);
    const inner = rects.filter((c) => c.alpha === 1);
    assert.ok(outer.length >= 230 && inner.length === outer.length, `${outer.length} outer, ${inner.length} inner columns`);
    for (const c of outer) {
      assert.ok(Math.abs(c.args[1]! - (mid - (30000 / 32767) * half)) < 1e-9, `outer top ${c.args[1]}`);
      assert.ok(Math.abs(c.args[1]! + c.args[3]! - mid) < 1e-9, `outer ends at the middle: ${c.args[1]! + c.args[3]!}`);
    }
    for (const c of inner) {
      assert.ok(Math.abs(c.args[1]! - (mid - (30000 / 32767) * half * 0.52)) < 1e-9, `inner top ${c.args[1]}`);
      assert.ok(Math.abs(c.args[1]! + c.args[3]! - mid) < 1e-9, `inner ends at the middle`);
    }
    r.canvas.destroy();
  });
});

// ---- m5b-ui-ghosts (UI redesign 4.2, 5.2): the ghosts are drawn on the
// content layer, which redraws when the ghosts change (the selected plan, its
// preview, its ticked steps, the toggle); the hovered step's outline is the
// overlay's, and a frame in which only the cursor moved leaves the content alone.

function ghostSource(initial: readonly Ghost[] = []) {
  let ghosts = initial;
  let outline: number | null = null;
  const pinned: number[] = [];
  const listeners = new Set<() => void>();
  const reveals = new Set<(step: number) => void>();
  const source: GhostSource = {
    ghosts: () => ghosts,
    outlineStep: () => outline,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    pin: (step) => void pinned.push(step),
    onReveal: (fn) => {
      reveals.add(fn);
      return () => void reveals.delete(fn);
    },
  };
  return {
    source,
    pinned,
    set(next: readonly Ghost[]) {
      ghosts = next;
      for (const fn of [...listeners]) fn();
    },
    hover(step: number | null) {
      outline = step;
      for (const fn of [...listeners]) fn();
    },
    reveal(step: number) {
      for (const fn of [...reveals]) fn(step);
    },
  };
}

const SAMPLE_GHOSTS: readonly Ghost[] = [
  { kind: 'track-add', step: 1, trackId: 'trk_new', name: 'Pad', channels: 2, key: 'ghost' },
  { kind: 'clip-place', step: 2, clipId: 'clp_new', trackId: 'trk_new', mediaId: 'med_sq', position: '0', sourceStart: '0', length: '9600' },
  { kind: 'clip-move', step: 3, clipId: 'clp_1', mediaId: 'med_sq', fromTrackId: 'trk_b', trackId: 'trk_b', from: '4800', position: '19200', sourceStart: '0', length: '24000' },
];

function ghostRig(initial: readonly Ghost[] = SAMPLE_GHOSTS) {
  clearFrames();
  setDevicePixelRatio(1);
  const surface = fakeSurface(800, 300);
  const m = modelOf(sampleSnapshot());
  const playhead = playheadOf();
  const ghosts = ghostSource(initial);
  const canvas = new TimelineCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: m.model,
    peaks,
    execute: async () => ({}),
    framesPerPixel: 100,
    playhead: playhead.source,
    ghosts: ghosts.source,
  });
  flushFrames();
  return { surface, canvas, playhead, ghosts, hooks: canvas.testHooks() };
}

test('new ghosts, the toggle and a ticked step redraw the content once; the hovered step redraws the overlay only', () => {
  const r = ghostRig([]);
  let content = r.hooks.contentDraws();
  const expectContent = (what: string) => {
    flushFrames();
    assert.equal(r.hooks.contentDraws(), content + 1, what);
    content = r.hooks.contentDraws();
  };
  r.ghosts.set(SAMPLE_GHOSTS);
  expectContent('ghosts of a selected plan');
  r.ghosts.set(SAMPLE_GHOSTS.filter((g) => g.step !== 2));
  expectContent('a step unticked');
  r.ghosts.set([]);
  expectContent('the toggle off');
  r.ghosts.set(SAMPLE_GHOSTS);
  expectContent('the toggle on');
  const overlay = r.hooks.overlayDraws();
  r.ghosts.hover(2);
  flushFrames();
  assert.equal(r.hooks.contentDraws(), content, 'a hover leaves the content alone');
  assert.equal(r.hooks.overlayDraws(), overlay + 1);
  assert.equal(r.hooks.ghostOutline(), 2);
  r.ghosts.hover(null);
  flushFrames();
  assert.equal(r.hooks.ghostOutline(), null);
  assert.equal(r.hooks.contentDraws(), content);
  r.canvas.destroy();
});

test('with ghosts on, a playhead-only frame does not redraw the content', () => {
  const r = ghostRig();
  const content = r.hooks.contentDraws();
  for (let i = 1; i <= 5; i += 1) {
    r.playhead.emit(String(i * 4800), true);
    flushFrames();
  }
  assert.equal(r.hooks.contentDraws(), content);
  r.canvas.destroy();
});

test('the hooks give the ghosts of the last content frame and their parts: clip-ghost-new, clip-ghost-move, lane-ghost', () => {
  withNamedTokens(() => {
    const r = ghostRig();
    assert.deepEqual(r.hooks.ghosts(), SAMPLE_GHOSTS);
    const parts = new Map(r.hooks.parts().map((p) => [p.id, p]));
    // trk_b and trk_a, 53 px each from LANES_TOP: the proposed lane is the third.
    assert.deepEqual(parts.get('lane-ghost'), { id: 'lane-ghost', x: 0, y: LANES_TOP + 2 * 53, w: 800, h: 53 });
    assert.deepEqual(parts.get('clip-ghost-new'), { id: 'clip-ghost-new', x: 1, y: LANES_TOP + 2 * 53 + 3, w: 94, h: 46 });
    assert.deepEqual(parts.get('clip-ghost-move'), { id: 'clip-ghost-move', x: 193, y: LANES_TOP + 3, w: 238, h: 46 });
    // Drawn in the agent violet, dashed and hatched; the original of the moved clip at 38 %.
    const calls = r.surface.contentCalls.calls;
    assert.ok(calls.some((c) => c.kind === 'stroke' && c.style === '--ai' && c.lineWidth === 1.25), 'the dashed outline');
    assert.ok(calls.some((c) => c.kind === 'stroke' && c.style === '--ai-a160' && c.lineWidth === 4), 'the clip hatch');
    assert.ok(calls.some((c) => c.kind === 'stroke' && c.style === '--ai-a070' && c.lineWidth === 5), 'the lane hatch');
    assert.ok(calls.some((c) => c.kind === 'fill' && c.style === '--ai-a100'), 'the ghost body');
    assert.ok(calls.some((c) => c.alpha === 0.38), 'the original at 38 %');
    r.ghosts.set([]);
    flushFrames();
    assert.deepEqual(r.hooks.ghosts(), []);
    assert.ok(!r.hooks.parts().some((p) => /ghost/.test(p.id)));
    r.canvas.destroy();
  });
});

test('a click on a ghost clip pins its step and selects nothing; a click on a moved original selects it and pins its step', () => {
  const r = ghostRig();
  const parts = new Map(r.hooks.parts().map((p) => [p.id, p]));
  const ghost = parts.get('clip-ghost-new')!;
  r.surface.fire('pointerdown', { clientX: ghost.x + 20, clientY: ghost.y + 20 });
  r.surface.fire('pointerup', { clientX: ghost.x + 20, clientY: ghost.y + 20 });
  flushFrames();
  assert.deepEqual(r.ghosts.pinned, [2]);
  assert.deepEqual(r.hooks.selectedClips(), []);
  const original = r.hooks.clips().find((c) => c.clipId === 'clp_1')!;
  const box = clipBox(original);
  r.surface.fire('pointerdown', { clientX: box.x + 10, clientY: box.y + 20 });
  r.surface.fire('pointerup', { clientX: box.x + 10, clientY: box.y + 20 });
  flushFrames();
  assert.deepEqual(r.hooks.selectedClips(), ['clp_1']);
  assert.deepEqual(r.ghosts.pinned, [2, 3]);
  r.canvas.destroy();
});

test('a reveal scrolls by the least amount that shows the step\'s ghosts', () => {
  const far: readonly Ghost[] = [{ kind: 'clip-place', step: 1, clipId: 'clp_far', trackId: 'trk_a', mediaId: 'med_sq', position: '200000', sourceStart: '0', length: '9600' }];
  const r = ghostRig(far);
  assert.equal(r.hooks.view().scrollFrames, '0');
  r.ghosts.reveal(1);
  flushFrames();
  // The ghost's box ends at x 2095 (200000 / 100 + 96 - 1); the view is 800 px wide: 1295 px of scroll.
  assert.equal(r.hooks.view().scrollFrames, String(1295 * 100));
  // Already in view: no scroll.
  r.ghosts.reveal(1);
  flushFrames();
  assert.equal(r.hooks.view().scrollFrames, String(1295 * 100));
  r.canvas.destroy();
});

test('a removed track\'s lane is cross-hatched in violet with its step disc (lane-ghost-remove), even with no clip on it', () => {
  withNamedTokens(() => {
    const removal: readonly Ghost[] = [{ kind: 'track-remove', step: 4, trackId: 'trk_a' }];
    const r = ghostRig(removal);
    const parts = new Map(r.hooks.parts().map((p) => [p.id, p]));
    // trk_b, then trk_a: the second lane.
    assert.deepEqual(parts.get('lane-ghost-remove'), { id: 'lane-ghost-remove', x: 0, y: LANES_TOP + 53, w: 800, h: 53 });
    const calls = r.surface.contentCalls.calls;
    assert.ok(calls.some((c) => c.kind === 'stroke' && c.style === '--ai-a070' && c.lineWidth === 5), 'the lane cross-hatch');
    assert.ok(calls.some((c) => c.kind === 'fill' && c.style === '--ai'), 'the step disc');
    r.ghosts.set([]);
    flushFrames();
    assert.ok(!r.hooks.parts().some((p) => p.id === 'lane-ghost-remove'));
    r.canvas.destroy();
  });
});
