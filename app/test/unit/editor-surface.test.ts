// The sample editor's surface (m5b-ui-editor-channel; UI redesign 5.1 "the
// same renderer class", 5.2): the event display's two-layer surface
// (timeline/LayeredSurface.ts). The content layer (the ruler, the whole
// source's waveform from the peak pyramid with the clip's range marked and
// the rest dimmed, the volume control) is redrawn only when the snapshot,
// the zoom, the size or the peaks change; the overlay (a drag's preview, the
// snap guide, the gain value) on its own animation frame, which stops when
// idle. The waveform is one min/max column per device pixel at the level
// chooseLevel picks; the only data it asks for is PeaksCache.get(contentHash).
// A release sends one command.execute. Runs on fake canvases (support/surface.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SampleEditorCanvas } from '../../src/renderer/editor/SampleEditorCanvas';
import { chooseLevel, type PeakPyramid } from '../../src/renderer/model/peaks';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import { DEFAULT_SNAP } from '../../src/renderer/timeline/snap';
import { clearFrames, fakeSurface, flushFrames, installSurfaceGlobals, setDevicePixelRatio } from './support/surface';
import { sampleSnapshot } from './support/timeline';

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

// med_sq is 48000 frames, loud for its first 24000.
function pyramid(): PeakPyramid {
  const levelOf = (k: number) => {
    const binFrames = 256 * 4 ** k;
    const binCount = Math.ceil(48000 / binFrames);
    const values = Int16Array.from(Array.from({ length: binCount }, (_, i) => (i * binFrames < 24000 ? [-30000, 30000] : [0, 0])).flat());
    return { binFrames, binCount, values };
  };
  return { channels: 1, frames: 48000, sampleRate: 48000, levels: [0, 1, 2, 3, 4].map(levelOf) };
}

function peaksOf(initial: PeakPyramid | null) {
  let current = initial;
  const asked: string[] = [];
  const listeners = new Set<() => void>();
  const cache = {
    get: (hash: string) => {
      asked.push(hash);
      return current;
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  } as unknown as PeaksCache;
  return {
    cache,
    asked,
    ready(next: PeakPyramid) {
      current = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

function make(options: { ratio?: number; pyramid?: PeakPyramid | null; clipId?: string | null } = {}) {
  clearFrames();
  setDevicePixelRatio(options.ratio ?? 1);
  const surface = fakeSurface(800, 200);
  const model = modelOf(sampleSnapshot());
  const peaks = peaksOf(options.pyramid === undefined ? pyramid() : options.pyramid);
  const sent: Array<{ commands: ReadonlyArray<Record<string, unknown>>; expectedRevision: string }> = [];
  const editor = new SampleEditorCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: model.model,
    peaks: peaks.cache,
    execute: async (commands, expectedRevision) => void sent.push({ commands, expectedRevision }),
    snap: () => ({ ...DEFAULT_SNAP, on: false }),
  });
  editor.setClip(options.clipId === undefined ? 'clp_1' : options.clipId);
  flushFrames();
  return { surface, model, peaks, editor, sent, hooks: editor.testHooks() };
}

test('the content layer draws once and again only for the snapshot, the zoom, the size and the peaks', () => {
  const { hooks, model, editor, surface, peaks } = make({ pyramid: null });
  const first = hooks.contentDraws();
  assert.ok(first >= 1);
  assert.equal(flushFrames(), 0, 'idle: no frame is pending');
  model.set({ ...sampleSnapshot(), revision: 'r8' });
  flushFrames();
  assert.equal(hooks.contentDraws(), first + 1, 'the snapshot');
  assert.equal(editor.zoomIn(), true);
  flushFrames();
  assert.equal(hooks.contentDraws(), first + 2, 'the zoom');
  surface.resize(600, 200);
  flushFrames();
  assert.equal(hooks.contentDraws(), first + 3, 'the size');
  peaks.ready(pyramid());
  flushFrames();
  assert.equal(hooks.contentDraws(), first + 4, 'the peaks');
  assert.equal(flushFrames(), 0);
});

test('a hover or a drag preview redraws the overlay only', () => {
  const { hooks, surface } = make();
  const content = hooks.contentDraws();
  const overlay = hooks.overlayDraws();
  const end = hooks.range()!.end;
  surface.fire('pointermove', { clientX: end, clientY: 120 });
  flushFrames();
  assert.equal(hooks.overlayDraws(), overlay + 1);
  surface.fire('pointerdown', { clientX: end, clientY: 120 });
  surface.fire('pointermove', { clientX: end + 30, clientY: 120 });
  flushFrames();
  assert.equal(hooks.contentDraws(), content, 'the content layer was not redrawn');
  assert.ok(hooks.overlayDraws() >= overlay + 2);
  assert.equal(flushFrames(), 0, 'idle again');
});

test('the waveform: one min/max column per device pixel of the source, at the level chooseLevel picks', () => {
  for (const ratio of [1, 2]) {
    const { hooks } = make({ ratio });
    const view = hooks.view();
    const source = hooks.source()!;
    const columns = hooks.columns();
    const expected = Math.ceil(Math.min(source.end, view.width) * ratio) - Math.floor(Math.max(source.start, 0) * ratio);
    assert.ok(Math.abs(columns - expected) <= 1, `ratio ${ratio}: ${columns} columns for ${expected} device pixels`);
    assert.equal(hooks.level(), chooseLevel(pyramid(), ratio / view.framesPerPixel), `ratio ${ratio}`);
  }
});

test('the only data the editor asks for is the peaks of the clip\'s media', () => {
  const { peaks, editor, model } = make();
  editor.zoomIn();
  model.set({ ...sampleSnapshot(), revision: 'r9' });
  flushFrames();
  assert.ok(peaks.asked.length > 0);
  // med_sq's hash (support/timeline.ts).
  assert.deepEqual([...new Set(peaks.asked)], [`sha256:${'0'.repeat(63)}1`]);
});

test('with no clip it draws nothing and asks for nothing', () => {
  const { hooks, peaks } = make({ clipId: null });
  assert.equal(hooks.columns(), 0);
  assert.equal(hooks.range(), null);
  assert.deepEqual(peaks.asked, []);
});

test('a drag of the range\'s end sends one command.execute on release, none on a click', async () => {
  const { surface, sent, hooks } = make();
  const end = hooks.range()!.end;
  surface.fire('pointerdown', { clientX: end, clientY: 120 });
  surface.fire('pointerup', { clientX: end, clientY: 120 });
  await Promise.resolve();
  assert.equal(sent.length, 0, 'a click sends nothing');
  const view = hooks.view();
  surface.fire('pointerdown', { clientX: end, clientY: 120 });
  surface.fire('pointermove', { clientX: end - 40, clientY: 120 });
  surface.fire('pointerup', { clientX: end - 40, clientY: 120 });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.expectedRevision, 'r7');
  assert.deepEqual(sent[0]!.commands, [{ op: 'clip.trim', clipId: 'clp_1', sourceStart: '0', length: String(24000 - 40 * view.framesPerPixel) }]);
});

test('H and G change the editor\'s zoom about the range\'s centre', () => {
  const { editor, hooks } = make();
  const before = hooks.view().framesPerPixel;
  assert.equal(editor.zoomIn(), true);
  assert.equal(hooks.view().framesPerPixel, Math.round(before / 2));
  assert.equal(editor.zoomOut(), true);
  assert.equal(hooks.view().framesPerPixel, Math.round(before / 2) * 2);
});
