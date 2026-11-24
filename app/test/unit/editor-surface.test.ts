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
import type { MeterFrame } from '../../src/renderer/model/meter-frames';
import { chooseLevel, type PeakPyramid } from '../../src/renderer/model/peaks';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { ClipEntity } from '../../src/renderer/model/document';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import { frameToX } from '../../src/renderer/timeline/geometry';
import { DEFAULT_SNAP, SNAP_MAGNET_PX, type SnapSettings } from '../../src/renderer/timeline/snap';
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

function make(options: { ratio?: number; pyramid?: PeakPyramid | null; clipId?: string | null; snap?: SnapSettings; playhead?: string | null } = {}) {
  clearFrames();
  setDevicePixelRatio(options.ratio ?? 1);
  const surface = fakeSurface(800, 200);
  const model = modelOf(sampleSnapshot());
  const peaks = peaksOf(options.pyramid === undefined ? pyramid() : options.pyramid);
  const sent: Array<{ commands: ReadonlyArray<Record<string, unknown>>; expectedRevision: string }> = [];
  // The realtime frame, stopped at the project cursor (none: no cursor).
  const frame: MeterFrame | null = options.playhead == null ? null : { epoch: '1', engineTimestampMicros: '0', playheadSamples: options.playhead, playing: false, entries: [] };
  const editor = new SampleEditorCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model: model.model,
    peaks: peaks.cache,
    execute: async (commands, expectedRevision) => void sent.push({ commands, expectedRevision }),
    snap: () => options.snap ?? { ...DEFAULT_SNAP, on: false },
    playhead: { playhead: () => frame },
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

test('with Magnetic Cursor the range\'s end snaps to the project cursor, in the preview and the command, as the event display\'s trim does', async () => {
  // clp_1 sits at 4800 and is 24000 long: its end is at 28800. The drag of
  // -40 px ends 3 px from the cursor, inside the magnet.
  const fpp = make().hooks.view().framesPerPixel;
  const cursor = 28800 - 37 * fpp;
  assert.ok(3 < SNAP_MAGNET_PX);
  const { surface, sent, hooks } = make({ snap: { on: true, grid: 'adapt', type: 'cursor' }, playhead: String(cursor) });
  const view = hooks.view();
  const end = hooks.range()!.end;
  surface.fire('pointerdown', { clientX: end, clientY: 120 });
  surface.fire('pointermove', { clientX: end - 40, clientY: 120 });
  surface.overlayCalls.clear();
  flushFrames();
  const x = Math.round(frameToX(BigInt(cursor), view));
  assert.ok(surface.overlayCalls.fills.some((f) => f.rect[0] === x - 1 && f.rect[2] === 1), 'the preview shows the end on the cursor');
  assert.ok(surface.overlayCalls.fills.some((f) => f.rect[0] === x && f.rect[1] === 0), 'the snap guide is on the cursor');
  surface.fire('pointerup', { clientX: end - 40, clientY: 120 });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.commands, [{ op: 'clip.trim', clipId: 'clp_1', sourceStart: '0', length: String(cursor - 4800) }]);
});

test('H and G change the editor\'s zoom about the range\'s centre', () => {
  const { editor, hooks } = make();
  const before = hooks.view().framesPerPixel;
  assert.equal(editor.zoomIn(), true);
  assert.equal(hooks.view().framesPerPixel, Math.round(before / 2));
  assert.equal(editor.zoomOut(), true);
  assert.equal(hooks.view().framesPerPixel, Math.round(before / 2) * 2);
});

// The snapshot with clp_1 at `position` (a drag, a nudge, a typed Start, an undo of a move) or trimmed.
function withClp1(position: string, sourceStart = '0', length = '24000', revision = 'r8'): Snapshot {
  const base = sampleSnapshot();
  const moved: ClipEntity = { ...(base.entities['clip:clp_1'] as ClipEntity), position: { domain: 'audio', value: position }, sourceStart, length };
  return Object.freeze({ ...base, revision, entities: { ...base.entities, 'clip:clp_1': moved }, clips: base.clips.map((c) => (c.id === 'clp_1' ? moved : c)) });
}

test('a move of the shown clip keeps its source and range where they were drawn, at the same zoom', () => {
  for (const zoomed of [false, true]) {
    const { editor, hooks, model } = make();
    if (zoomed) editor.zoomIn();
    flushFrames();
    const fpp = hooks.view().framesPerPixel;
    const source = hooks.source()!;
    const range = hooks.range()!;
    // +60 s, back by an undo, then a nudge to the session's start.
    for (const position of [String(4800 + 60 * 48000), '4800', '0']) {
      model.set(withClp1(position));
      flushFrames();
      assert.equal(hooks.view().framesPerPixel, fpp, `zoomed ${zoomed}: the zoom is kept at ${position}`);
      assert.deepEqual(hooks.source(), source, `zoomed ${zoomed}: the source at ${position}`);
      assert.deepEqual(hooks.range(), range, `zoomed ${zoomed}: the range at ${position}`);
      assert.ok(hooks.columns() > 0, `zoomed ${zoomed}: the waveform is drawn at ${position}`);
    }
  }
});

test('a trim of the shown clip\'s start leaves the source where it was; only the range moves', () => {
  const { hooks, model } = make();
  const view = hooks.view();
  const source = hooks.source()!;
  model.set(withClp1('9600', '4800', '19200'));
  flushFrames();
  assert.deepEqual(hooks.view(), view);
  assert.deepEqual(hooks.source(), source);
  assert.equal(hooks.range()!.start, frameToX(9600n, view));
});
