// The track list's mini meters (m5-ui-port-track-list; UI redesign spec 5.1
// and 5.3, the mockup's th() and its .hmeter rule): one canvas over the header
// column paints, inside each header's .hmeter well (DOM, drawn by
// ui/project-zone.css, with no <i>), a horizontal bar as wide as the reading
// on -60..0 dBFS, filled with the mockup's .hmeter i gradient (--meter-0 at 0,
// --play at 62 %, --meter-mid at 82 %, --err at 100 %) over
// --header-meter-scale-w from the well's left edge, repeated as the mockup's
// background-size repeats it. The colours and sizes come from tokens.ts. Slots
// are registered per header and measured when one is added or removed and
// when the owner reports a resize or a scroll, not every frame; a frame is
// drawn only when a new meter frame arrived or a slot moved. Runs on a fake
// canvas whose 2D context records every fillRect with its fill and every
// gradient with its stops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MeterEntry } from '../../src/renderer/model/meter-frames';
import { HeaderMeters, type AnimationFrames, type HeaderMeterSlot } from '../../src/renderer/timeline/HeaderMeters';
import { TOKENS } from '../../src/renderer/tokens';

const SCALE = parseFloat(TOKENS['header-meter-scale-w']);

interface Gradient {
  readonly x0: number;
  readonly x1: number;
  readonly stops: Array<[number, string]>;
}

interface Fill {
  readonly style: unknown;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function fakeCanvas(width = 200, height = 300) {
  const fills: Fill[] = [];
  const gradients: Gradient[] = [];
  let clears = 0;
  const ctx = {
    fillStyle: '' as unknown,
    setTransform: () => undefined,
    clearRect: () => void (clears += 1),
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: this.fillStyle, x, y, w, h });
    },
    createLinearGradient(x0: number, _y0: number, x1: number) {
      const gradient: Gradient = { x0, x1, stops: [] };
      gradients.push(gradient);
      return { addColorStop: (offset: number, colour: string) => void gradient.stops.push([offset, colour]) };
    },
  };
  const canvas = { width: 0, height: 0, dataset: {} as Record<string, string>, getContext: () => ctx };
  return { canvas, size: () => ({ width, height }), fills, gradients, clears: () => clears };
}

function manualFrames(): AnimationFrames & { flush(): void; pending(): number } {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    request(callback) {
      const id = next++;
      queue.set(id, callback);
      return id;
    },
    cancel: (handle) => void queue.delete(handle),
    flush() {
      const run = [...queue.values()];
      queue.clear();
      for (const fn of run) fn();
    },
    pending: () => queue.size,
  };
}

function realtimeOf() {
  let count = 0;
  const readings = new Map<string, MeterEntry>();
  return {
    client: {
      frameCount: () => count,
      meter: (ref: string) => readings.get(ref) ?? null,
    },
    // A new meter frame: linear peaks per channel for each ref.
    emit(levels: Record<string, number[]>) {
      count += 1;
      readings.clear();
      let index = 0;
      for (const [ref, peak] of Object.entries(levels)) readings.set(ref, { entityIndex: index++, channels: peak.length, peak, rms: peak });
    },
  };
}

const dB = (db: number) => Math.pow(10, db / 20);

// Two wells, as two headers' .hmeter insides measure in the canvas.
function slot(ref: string, rect: { x: number; y: number; width: number; height: number } | null) {
  let current = rect;
  let measured = 0;
  const value: HeaderMeterSlot = {
    ref,
    measure: () => {
      measured += 1;
      return current;
    },
  };
  return { value, move: (next: typeof rect) => void (current = next), measured: () => measured };
}

function setup() {
  const surface = fakeCanvas();
  const realtime = realtimeOf();
  const frames = manualFrames();
  const meters = new HeaderMeters({ canvas: surface.canvas, realtime: realtime.client, frames, size: surface.size, pixelRatio: () => 1 });
  return { surface, realtime, frames, meters };
}

const isGradient = (style: unknown) => typeof style === 'object' && style !== null;

test('a horizontal bar inside each measured well, as wide as the reading, with the mockup\'s gradient stops from tokens.ts', () => {
  const { surface, realtime, frames, meters } = setup();
  const a = slot('track:a', { x: 60, y: 40, width: 80, height: 2 });
  const b = slot('track:b', { x: 60, y: 93, width: 140, height: 2 });
  meters.addSlot(a.value);
  meters.addSlot(b.value);
  meters.start();
  frames.flush();
  assert.equal(surface.clears(), 1);
  assert.equal(surface.fills.length, 0, 'silence: no bar (the well is DOM)');
  assert.equal(surface.canvas.dataset.lit, '0');

  // a: -30 dBFS mono, half the well; b: -6 dBFS left, 0 dBFS right: the louder, the whole well.
  realtime.emit({ 'track:a': [dB(-30)], 'track:b': [dB(-6), dB(0)] });
  frames.flush();
  assert.equal(surface.canvas.dataset.frames, '1');
  assert.equal(surface.canvas.dataset.lit, '2');
  const barsA = surface.fills.filter((f) => f.y === 40);
  const barsB = surface.fills.filter((f) => f.y === 93);
  assert.ok(barsA.every((f) => isGradient(f.style) && f.h === 2));
  assert.equal(barsA[0]!.x, 60, 'from the well\'s left edge');
  assert.equal(barsA.reduce((sum, f) => sum + f.w, 0), 40, 'half of the 80 px well');
  // The gradient repeats every --header-meter-scale-w, as background-size repeats it.
  assert.equal(barsB.reduce((sum, f) => sum + f.w, 0), 140);
  assert.deepEqual(barsB.map((f) => f.x), [60, 60 + SCALE]);
  assert.deepEqual(barsB.map((f) => f.w), [SCALE, 140 - SCALE]);
  for (const gradient of surface.gradients) {
    assert.equal(gradient.x1 - gradient.x0, SCALE);
    assert.deepEqual(gradient.stops, [
      [0, TOKENS['meter-0']],
      [0.62, TOKENS.play],
      [0.82, TOKENS['meter-mid']],
      [1, TOKENS.err],
    ]);
  }
  assert.deepEqual([...new Set(surface.gradients.map((g) => g.x0))].sort((x, y) => x - y), [60, 60 + SCALE]);
  meters.stop();
});

test('no draw without a new frame or a moved slot; slots are measured on add, remove and remeasure, not every frame', () => {
  const { surface, realtime, frames, meters } = setup();
  const a = slot('track:a', { x: 60, y: 40, width: 80, height: 2 });
  meters.addSlot(a.value);
  meters.start();
  frames.flush();
  const measured = a.measured();
  assert.equal(surface.clears(), 1);
  frames.flush();
  frames.flush();
  assert.equal(surface.clears(), 1, 'nothing new: no redraw');
  assert.equal(a.measured(), measured, 'not measured every frame');

  realtime.emit({ 'track:a': [dB(-20)] });
  frames.flush();
  assert.equal(surface.clears(), 2, 'a new meter frame redraws');

  // A remeasure that finds nothing moved draws nothing.
  meters.remeasure();
  frames.flush();
  assert.equal(surface.clears(), 2);
  assert.ok(a.measured() > measured);

  // The vertical scroll or a resize moves the well: the bar moves with it.
  a.move({ x: 60, y: 20, width: 80, height: 2 });
  meters.remeasure();
  surface.fills.length = 0;
  frames.flush();
  assert.equal(surface.clears(), 3, 'a moved slot redraws');
  assert.ok(surface.fills.length > 0 && surface.fills.every((f) => f.y === 20));

  // A removed header's slot is no longer painted.
  const b = slot('track:b', { x: 60, y: 93, width: 80, height: 2 });
  const remove = meters.addSlot(b.value);
  realtime.emit({ 'track:a': [dB(-20)], 'track:b': [dB(-20)] });
  surface.fills.length = 0;
  frames.flush();
  assert.ok(surface.fills.some((f) => f.y === 93));
  remove();
  surface.fills.length = 0;
  frames.flush();
  assert.equal(surface.clears(), 5, 'a removed slot redraws');
  assert.ok(!surface.fills.some((f) => f.y === 93));

  // A well not laid out (null) is skipped.
  a.move(null);
  meters.remeasure();
  surface.fills.length = 0;
  frames.flush();
  assert.equal(surface.fills.length, 0);

  assert.equal(frames.pending(), 1);
  meters.stop();
  assert.equal(frames.pending(), 0, 'stop cancels the pending frame');
});

test('no React and no literal colour: the surface reads tokens.ts and imports nothing of React', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'timeline', 'HeaderMeters.ts'), 'utf8');
  assert.doesNotMatch(source, /from 'react'|useState|setState/);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour literal');
  assert.doesNotMatch(source, /getComputedStyle/, 'the tokens come from tokens.ts');
  assert.match(source, /TOKENS\['meter-0'\]/);
  assert.match(source, /TOKENS\['header-meter-scale-w'\]/);
});

// m5b-ui-recording (UI redesign 3.5): an armed track's header meter reads its
// input meter (input:<trackId>, protocol-events-v1 "meters.legend") while the
// legend has it, and its track meter otherwise.
test('an armed track\'s well reads input:<trackId> while the legend has it (m5b-ui-recording)', () => {
  const surface = fakeCanvas();
  const realtime = realtimeOf();
  const frames = manualFrames();
  let armed: readonly string[] = ['a'];
  const meters = new HeaderMeters({ canvas: surface.canvas, realtime: realtime.client, frames, size: surface.size, pixelRatio: () => 1, armed: () => armed });
  meters.addSlot(slot('track:a', { x: 0, y: 0, width: 100, height: 2 }).value);
  meters.start();
  // The track plays nothing; its input is at -30 dBFS: half the well.
  realtime.emit({ 'track:a': [0], 'input:a': [dB(-30)] });
  frames.flush();
  assert.equal(surface.canvas.dataset.lit, '1');
  const width = surface.fills.reduce((sum, f) => sum + f.w, 0);
  assert.ok(Math.abs(width - 50) <= 1, `the input's bar: ${width}`);
  // Disarmed: the track's meter again (silent).
  armed = [];
  realtime.emit({ 'track:a': [0], 'input:a': [dB(-30)] });
  frames.flush();
  assert.equal(surface.canvas.dataset.lit, '0');
  // Armed, but the legend has no input meter yet: the track's meter.
  armed = ['a'];
  realtime.emit({ 'track:a': [dB(-6)] });
  frames.flush();
  assert.equal(surface.canvas.dataset.lit, '1');
});

// m5b-ui-recording (protocol-engine-v0 "Monitoring"): a monitored, unarmed
// track's well reads its track meter, which carries the monitored input,
// as its strip does while the transport is stopped (mixer-meters).
test('a monitored, unarmed track\'s well reads track:<trackId>, as its strip does', () => {
  const surface = fakeCanvas();
  const realtime = realtimeOf();
  const frames = manualFrames();
  const meters = new HeaderMeters({ canvas: surface.canvas, realtime: realtime.client, frames, size: surface.size, pixelRatio: () => 1, armed: () => [] });
  meters.addSlot(slot('track:a', { x: 0, y: 0, width: 100, height: 2 }).value);
  meters.start();
  // The monitored input at -30 dBFS through the track's strip: half the well.
  realtime.emit({ 'track:a': [dB(-30)], 'input:a': [dB(-12)] });
  frames.flush();
  assert.equal(surface.canvas.dataset.lit, '1');
  const width = surface.fills.reduce((sum, f) => sum + f.w, 0);
  assert.ok(Math.abs(width - 50) <= 1, `the track's bar, not the input's: ${width}`);
});
