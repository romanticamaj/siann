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
import { xToFrame } from '../../src/renderer/timeline/geometry';
import { TimelineCanvas, type PlayheadSource, type LaneHeightSource } from '../../src/renderer/timeline/TimelineCanvas';
import { clearFrames, fakeSurface, flushFrames, installSurfaceGlobals, setDevicePixelRatio } from './support/surface';
import { sampleSnapshot, snapshotOf, track } from './support/timeline';

installSurfaceGlobals();

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
  const timeline = new TimelineCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: model.model,
    peaks,
    execute: async () => undefined,
    playhead: playhead.source,
    laneHeights: heights.source,
  });
  flushFrames();
  return { surface, model, playhead, heights, timeline, hooks: timeline.testHooks() };
}

test('a playhead-only change redraws the overlay and not the content', () => {
  const { hooks, playhead, timeline } = make();
  const content = hooks.contentDraws();
  const overlay = hooks.overlayDraws();
  assert.equal(content, 1, 'one first content draw');
  for (let i = 1; i <= 5; i += 1) {
    playhead.emit(String(i * 4800));
    flushFrames();
  }
  assert.equal(hooks.contentDraws(), content, 'the content layer was not redrawn');
  assert.equal(hooks.overlayDraws(), overlay + 5);
  assert.equal(hooks.cursorX(), 5 * 4800 / hooks.view().framesPerPixel);
  // A frame with the same playhead (meters only) draws nothing.
  playhead.emit('24000');
  assert.equal(flushFrames(), 0, 'no frame scheduled');
  // Stopped and idle: no animation frame is pending.
  playhead.emit('24000', false);
  flushFrames();
  assert.equal(flushFrames(), 0);
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

test('the canvases are the container size in device pixels and follow a resize and a ratio change', () => {
  const { surface, hooks, timeline } = make({ ratio: 2 });
  for (const canvas of [surface.content, surface.overlay]) {
    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 600);
    assert.equal(canvas.style.width, '800px');
    assert.equal(canvas.style.height, '300px');
  }
  assert.equal(hooks.view().width, 800);
  assert.equal(hooks.view().height, 300);
  surface.resize(1000, 420);
  flushFrames();
  for (const canvas of [surface.content, surface.overlay]) {
    assert.equal(canvas.width, 2000);
    assert.equal(canvas.height, 840);
  }
  assert.equal(hooks.view().width, 1000);
  setDevicePixelRatio(1.5);
  flushFrames();
  for (const canvas of [surface.content, surface.overlay]) {
    assert.equal(canvas.width, 1500);
    assert.equal(canvas.height, 630);
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

test('the selected clip has a 2 px outline on the overlay; an empty session shows the guidance', () => {
  const { surface, hooks, timeline } = make();
  const rect = hooks.clips().find((r) => r.clipId === 'clp_1')!;
  surface.fire('pointerdown', { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 });
  surface.fire('pointerup', { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 });
  flushFrames();
  assert.equal(timeline.getState().selectedClipId, 'clp_1');
  assert.equal(hooks.selectionOutline(), 2);
  assert.ok(surface.overlayCalls.strokes.some((s) => s.lineWidth === 2), 'a 2 px stroke on the overlay');
  assert.equal(hooks.guidance(), null);
  timeline.destroy();

  const empty = make({ snapshot: snapshotOf([], [], [], []) });
  assert.ok(empty.hooks.guidance(), 'guidance text');
  assert.ok(empty.surface.contentCalls.texts.includes(empty.hooks.guidance()!));
  empty.timeline.destroy();
});

test('muted and implicitly muted lanes are dimmed', () => {
  const base = sampleSnapshot();
  const soloed = { ...base, entities: { ...base.entities, 'track:trk_a': { ...track('trk_a'), solo: true } } };
  const solo = { ...soloed, tracks: [soloed.entities['track:trk_a'] as ReturnType<typeof track>, track('trk_b')] };
  const { hooks, timeline } = make({ snapshot: solo });
  assert.deepEqual(hooks.dimmedLanes(), ['trk_b']);
  timeline.destroy();
});
