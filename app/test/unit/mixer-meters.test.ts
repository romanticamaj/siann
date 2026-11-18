// The mixer's meters (m5-ui-mixer, m5-ui-port-mixer-strip; UI redesign spec
// 5.1, 5.3, 1.2 and the mockup's strip()): one Canvas2D over all strips, one
// requestAnimationFrame callback that reads the MeterStore, applies the
// ballistics with the frame's time delta and paints every meter channel
// (tracks and master; each strip has two, as the mockup draws them). The
// surface copies the mockup's parameters from tokens.ts: one gradient over
// --meter-scale-h from the channel's bottom (--meter-low at 0, --play at 55 %,
// --meter-mid at 78 %, --err at 96 %), a --hairline-1h --tx-0 hold line whose
// bottom edge sits at the hold level, and a latching clip band in --err. The
// loop is not requested while the transport is stopped and every meter has
// decayed, nor while the document is hidden. Animation frames, the clock and
// the 2D context are injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MeterFrame, MeterLegend } from '../../src/renderer/model/meter-frames';
import { MeterStore } from '../../src/renderer/model/meter-store';
import { MixerMeters } from '../../src/renderer/mixer/MixerMeters';
import { TOKENS } from '../../src/renderer/tokens';

const px = (name: keyof typeof TOKENS) => parseFloat(TOKENS[name]);
const MIXER_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'mixer');

class FakeSource {
  legendValue: MeterLegend | null = { epoch: '1', entities: ['master', 'track:a'] };
  frame: MeterFrame | null = null;
  count = 0;
  legend() {
    return this.legendValue;
  }
  latest() {
    return this.frame;
  }
  frameCount() {
    return this.count;
  }
  // [entity, peak] (mono) or [entity, [left, right]].
  push(entries: Array<[number, number | number[]]>, playing = true): void {
    this.frame = {
      epoch: '1',
      engineTimestampMicros: '0',
      playheadSamples: '0',
      playing,
      entries: entries.map(([entityIndex, value]) => {
        const peak = Array.isArray(value) ? value : [value];
        return { entityIndex, channels: peak.length, peak, rms: peak.map((p) => p / 2) };
      }),
    };
    this.count += 1;
  }
}

class FakeFrames {
  readonly queue = new Map<number, () => void>();
  requested = 0;
  #next = 1;
  request = (callback: () => void): number => {
    const id = this.#next++;
    this.requested += 1;
    this.queue.set(id, callback);
    return id;
  };
  cancel = (id: number): void => {
    this.queue.delete(id);
  };
  // Runs the callbacks pending now (not the ones they request).
  run(): number {
    const pending = [...this.queue.entries()];
    this.queue.clear();
    for (const [, callback] of pending) callback();
    return pending.length;
  }
}

interface Gradient {
  readonly kind: 'gradient';
  readonly from: [number, number];
  readonly to: [number, number];
  readonly stops: Array<[number, string]>;
}

interface Rect {
  style: string | Gradient;
  x: number;
  y: number;
  w: number;
  h: number;
}

function fakeCanvas() {
  const rects: Rect[] = [];
  const gradients: Gradient[] = [];
  const context = {
    fillStyle: '' as unknown,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ style: this.fillStyle as string | Gradient, x, y, w, h });
    },
    clearRect() {
      rects.length = 0;
    },
    setTransform() {},
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const gradient = { kind: 'gradient' as const, from: [x0, y0] as [number, number], to: [x1, y1] as [number, number], stops: [] as Array<[number, string]> };
      gradients.push(gradient);
      return { ...gradient, addColorStop: (offset: number, colour: string) => gradient.stops.push([offset, colour]), stops: gradient.stops };
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  return { canvas, rects, gradients };
}

// Channel wells, canvas CSS px: the master's two at x 200 and 211 (9 px), the track's at 20 and 28 (6 px).
const MASTER = [200, 211];
const TRACK = [20, 28];
const TOP = 10;
const HEIGHT = 200;
const BOTTOM = TOP + HEIGHT;

function setup() {
  const source = new FakeSource();
  const store = new MeterStore(source);
  const frames = new FakeFrames();
  let now = 0;
  let hidden = false;
  const { canvas, rects, gradients } = fakeCanvas();
  const meters = new MixerMeters({
    canvas,
    store,
    frames,
    clock: () => now,
    hidden: () => hidden,
    pixelRatio: () => 1,
    size: () => ({ width: 300, height: 220 }),
  });
  const masterText = { textContent: '' as string | null };
  const trackText = { textContent: '' as string | null };
  MASTER.forEach((x, channel) => meters.addSlot({ ref: 'master', channel, measure: () => ({ x, y: TOP, width: 9, height: HEIGHT }) }));
  TRACK.forEach((x, channel) => meters.addSlot({ ref: 'track:a', channel, measure: () => ({ x, y: TOP, width: 6, height: HEIGHT }) }));
  meters.addPeak('master', masterText);
  meters.addPeak('track:a', trackText);
  meters.measure();
  const tick = (ms = 1000 / 60) => {
    now += ms;
    return frames.run();
  };
  return { source, store, frames, meters, rects, gradients, masterText, trackText, tick, setHidden: (h: boolean) => (hidden = h) };
}

const at = (rects: Rect[], x: number) => rects.filter((r) => r.x === x);
const bars = (rects: Rect[], x: number) => at(rects, x).filter((r) => typeof r.style !== 'string');

test('one canvas callback draws every channel, tracks and master', () => {
  const { source, frames, meters, rects, tick } = setup();
  source.push([[0, 0.5], [1, 0.1]]);
  meters.onFrame();
  assert.equal(frames.requested, 1);
  assert.equal(tick(), 1, 'one callback for all slots');
  for (const x of [...MASTER, ...TRACK]) assert.equal(bars(rects, x).length, 1, `a bar in the channel at ${x}`);
  assert.equal(meters.testHooks().canvases, 1);
  assert.equal(meters.testHooks().frames(), 1);
  assert.ok(meters.testHooks().read('master')!.peak > 0.49);
  // A second wake while running asks for nothing more.
  meters.onFrame();
  assert.equal(frames.queue.size, 1);
  meters.destroy();
  assert.equal(frames.queue.size, 0);
});

test('the bar is the mockup\'s gradient over --meter-scale-h from the channel\'s bottom, as tall as the level on the taper', () => {
  const { source, meters, rects, tick } = setup();
  source.push([[0, [1.0, 0.25]], [1, 0.1]]); // master 0 dBFS and -12 dBFS, track -20 dBFS
  meters.onFrame();
  tick();
  const [left] = bars(rects, MASTER[0]!);
  const [right] = bars(rects, MASTER[1]!);
  const gradient = left!.style as Gradient;
  assert.deepEqual(gradient.from, [MASTER[0], BOTTOM]);
  assert.deepEqual(gradient.to, [MASTER[0], BOTTOM - px('meter-scale-h')]);
  assert.deepEqual(gradient.stops, [
    [0, TOKENS['meter-low']],
    [0.55, TOKENS.play],
    [0.78, TOKENS['meter-mid']],
    [0.96, TOKENS.err],
  ]);
  // On the fader's taper: 0 dB at 75 %, -12 dB at 50 % of 200 px; the bar fills the well's width.
  assert.equal(left!.w, 9);
  assert.ok(Math.abs(left!.h - 150) < 0.5, `left ${left!.h}`);
  assert.ok(Math.abs(left!.y + left!.h - BOTTOM) < 1e-9);
  assert.ok(Math.abs(right!.h - 100) < 0.5, `right ${right!.h}: each channel from its own peak`);
  // A mono track shows its value in both channels.
  const [a] = bars(rects, TRACK[0]!);
  const [b] = bars(rects, TRACK[1]!);
  assert.equal(a!.w, 6);
  assert.ok(Math.abs(a!.h - b!.h) < 1e-9 && a!.h > 0);
});

test('a --hairline-1h --tx-0 hold line whose bottom edge is the hold level; a latching clip band in --err', () => {
  const { source, meters, rects, tick } = setup();
  source.push([[0, [1.0, 0.25]], [1, 0.1]]);
  meters.onFrame();
  tick();
  const hold = at(rects, MASTER[0]!).filter((r) => r.style === TOKENS['tx-0']);
  assert.equal(hold.length, 1);
  assert.equal(hold[0]!.h, px('hairline-1h'));
  assert.equal(hold[0]!.w, 9);
  assert.ok(Math.abs(hold[0]!.y + hold[0]!.h - (BOTTOM - 150)) < 0.5, `hold line at ${hold[0]!.y}`);
  // The clip is the entity's (its louder channel reached full scale): both channels show it.
  for (const x of MASTER) {
    const clip = at(rects, x).filter((r) => r.style === TOKENS.err);
    assert.equal(clip.length, 1, `clip band at ${x}`);
    assert.equal(clip[0]!.y, TOP);
    assert.equal(clip[0]!.h, px('space-3q'));
  }
  assert.equal(at(rects, TRACK[0]!).filter((r) => r.style === TOKENS.err).length, 0);
});

test('the peak value is written with textContent and resets on reset()', () => {
  const { source, meters, masterText, trackText, tick } = setup();
  source.push([[0, 0.5], [1, 0.1]]);
  meters.onFrame();
  tick();
  assert.equal(masterText.textContent, '-6.0');
  assert.equal(trackText.textContent, '-20.0');
  source.push([[0, 0.25]]);
  tick();
  assert.equal(masterText.textContent, '-6.0', 'the maximum since reset');
  meters.reset('master');
  tick();
  assert.equal(masterText.textContent, '-12.0');
});

test('stopped and decayed: the loop ends and a silent frame does not restart it', () => {
  const { source, frames, meters, tick } = setup();
  source.push([[0, 0.5]]);
  meters.onFrame();
  tick();
  source.push([], false);
  let callbacks = 0;
  for (let i = 0; i < 60 * 30 && frames.queue.size > 0; i += 1) callbacks += tick();
  assert.equal(frames.queue.size, 0, 'the loop stopped by itself');
  assert.ok(callbacks > 60, 'it ran while the meters decayed');
  const before = frames.requested;
  source.push([], false);
  meters.onFrame();
  assert.equal(frames.requested, before, 'nothing requested while stopped and decayed');
  // Playing again wakes it.
  source.push([[0, 0.5]]);
  meters.onFrame();
  assert.equal(frames.requested, before + 1);
});

test('hidden: nothing requested, and a running loop stops', () => {
  const { source, frames, meters, tick, setHidden } = setup();
  source.push([[0, 0.5]]);
  meters.onFrame();
  tick();
  assert.equal(frames.queue.size, 1);
  setHidden(true);
  tick();
  assert.equal(frames.queue.size, 0, 'stopped when hidden');
  source.push([[0, 0.5]]);
  meters.onFrame();
  assert.equal(frames.queue.size, 0);
  setHidden(false);
  meters.onFrame();
  assert.equal(frames.queue.size, 1);
});

test('the meter surface names its colours by token: no colour literal, and no meter value through React state', () => {
  const meters = fs.readFileSync(path.join(MIXER_DIR, 'MixerMeters.ts'), 'utf8');
  assert.doesNotMatch(meters, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'MixerMeters.ts holds no colour literal');
  assert.match(meters, /TOKENS\[/);
  assert.doesNotMatch(meters, /DEFAULT_PALETTE|setPalette/);
  for (const file of ['Mixer.tsx', 'Strip.tsx']) {
    const source = fs.readFileSync(path.join(MIXER_DIR, file), 'utf8');
    // React state in the MixConsole is the editing flag of a typed value, never a meter reading.
    for (const m of source.matchAll(/useState(?:<[^>]*>)?\(/g)) {
      const line = source.slice(source.lastIndexOf('\n', m.index) + 1, source.indexOf('\n', m.index));
      assert.doesNotMatch(line, /\b(level|peak|hold|clip|reading|meters?)\b/i, `${file}: ${line.trim()}`);
    }
  }
});

// m5b-ui-recording (UI redesign 3.5): an armed track's strip meter and peak
// value read its input meter (input:<trackId>) while the legend has it; the
// input is metered while the transport is stopped too (the engine measures it
// whether the transport plays or not, protocol-events-v1 "meters.legend").
test('an armed track\'s strip reads input:<trackId>, stopped or playing (m5b-ui-recording)', () => {
  const source = new FakeSource();
  source.legendValue = { epoch: '1', entities: ['master', 'track:a', 'input:a'] };
  const store = new MeterStore(source);
  const frames = new FakeFrames();
  let now = 0;
  let armed: readonly string[] = ['a'];
  const { canvas, rects } = fakeCanvas();
  const meters = new MixerMeters({ canvas, store, frames, clock: () => now, hidden: () => false, pixelRatio: () => 1, size: () => ({ width: 300, height: 220 }), armed: () => armed });
  const text = { textContent: '' as string | null };
  TRACK.forEach((x, channel) => meters.addSlot({ ref: 'track:a', channel, measure: () => ({ x, y: TOP, width: 6, height: HEIGHT }) }));
  meters.addPeak('track:a', text);
  meters.measure();
  // Stopped: the track repeats its last reading (nothing), the input is live at -12 dBFS.
  source.push([[1, 0.5], [2, 0.25]], false);
  meters.onFrame();
  now += 1000 / 60;
  frames.run();
  assert.equal(bars(rects, TRACK[0]!).length, 1, 'the input\'s bar while stopped');
  assert.equal(text.textContent, '-12.0');
  assert.ok(store.read('input:a')!.peak > 0.24);
  assert.equal(store.read('track:a')!.peak, 0, 'a track\'s stale reading while stopped stays silent');
  // Disarmed: the track's meter, silent while stopped.
  armed = [];
  source.push([[1, 0.5], [2, 0.25]], false);
  meters.wake();
  now += 5000;
  frames.run();
  assert.equal(bars(rects, TRACK[0]!).length, 0);
});
