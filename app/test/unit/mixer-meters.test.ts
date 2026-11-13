// The mixer's meters (m5-ui-mixer; UI redesign spec 5.1 and 5.3): one
// Canvas2D behind all strips, one requestAnimationFrame callback that reads
// the MeterStore, applies the ballistics with the frame's time delta and
// draws every slot (tracks and master). Colours by threshold (spec 1.2:
// green to -12 dB, yellow to -3 dB, red above; a 1.5 px hold line; a latching
// clip indicator). The loop is not requested while the transport is stopped
// and every meter has decayed, nor while the document is hidden. Animation
// frames, the clock and the 2D context are injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MeterFrame, MeterLegend } from '../../src/renderer/model/meter-frames';
import { MeterStore } from '../../src/renderer/model/meter-store';
import { MixerMeters, type MeterPalette } from '../../src/renderer/mixer/MixerMeters';

const PALETTE: MeterPalette = { well: 'well', green: 'green', yellow: 'yellow', red: 'red', hold: 'hold', clip: 'clip' };

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
  push(entries: Array<[number, number]>, playing = true): void {
    this.frame = {
      epoch: '1',
      engineTimestampMicros: '0',
      playheadSamples: '0',
      playing,
      entries: entries.map(([entityIndex, peak]) => ({ entityIndex, channels: 1, peak: [peak], rms: [peak / 2] })),
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

interface Rect {
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function fakeCanvas() {
  const rects: Rect[] = [];
  const context = {
    fillStyle: '',
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ style: this.fillStyle, x, y, w, h });
    },
    clearRect() {
      rects.length = 0;
    },
    setTransform() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  return { canvas, rects };
}

function setup() {
  const source = new FakeSource();
  const store = new MeterStore(source);
  const frames = new FakeFrames();
  let now = 0;
  let hidden = false;
  const { canvas, rects } = fakeCanvas();
  const meters = new MixerMeters({
    canvas,
    store,
    frames,
    clock: () => now,
    hidden: () => hidden,
    palette: PALETTE,
    pixelRatio: () => 1,
    size: () => ({ width: 300, height: 220 }),
  });
  const masterText = { textContent: '' as string | null };
  const trackText = { textContent: '' as string | null };
  meters.addSlot({ ref: 'master', measure: () => ({ x: 200, y: 10, width: 8, height: 200 }), peakText: masterText });
  meters.addSlot({ ref: 'track:a', measure: () => ({ x: 20, y: 10, width: 8, height: 200 }), peakText: trackText });
  meters.measure();
  const tick = (ms = 1000 / 60) => {
    now += ms;
    return frames.run();
  };
  return { source, store, frames, meters, rects, masterText, trackText, tick, setHidden: (h: boolean) => (hidden = h) };
}

const inSlot = (rects: Rect[], x: number) => rects.filter((r) => r.x >= x && r.x < x + 8);

test('one canvas callback draws every slot, tracks and master', () => {
  const { source, frames, meters, rects, tick } = setup();
  source.push([[0, 0.5], [1, 0.1]]);
  meters.onFrame();
  assert.equal(frames.requested, 1);
  assert.equal(tick(), 1, 'one callback for all slots');
  assert.ok(inSlot(rects, 200).some((r) => r.style === 'green'), 'master drawn');
  assert.ok(inSlot(rects, 20).some((r) => r.style === 'green'), 'track drawn');
  assert.equal(meters.testHooks().canvases, 1);
  assert.equal(meters.testHooks().frames(), 1);
  assert.ok(meters.testHooks().read('master')!.peak > 0.49);
  // A second wake while running asks for nothing more.
  meters.onFrame();
  assert.equal(frames.queue.size, 1);
  meters.destroy();
  assert.equal(frames.queue.size, 0);
});

test('colours by threshold: green to -12 dB, yellow to -3 dB, red above; a 1.5 px hold line', () => {
  const { source, meters, rects, tick } = setup();
  source.push([[0, 1.0], [1, 0.1]]); // master 0 dBFS, track -20 dBFS
  meters.onFrame();
  tick();
  const master = inSlot(rects, 200);
  const height = (style: string) => master.filter((r) => r.style === style).reduce((sum, r) => sum + r.h, 0);
  // On the fader's taper: -12 dB at 50 %, -3 dB at 68.75 %, 0 dB at 75 % of 200 px.
  assert.ok(Math.abs(height('green') - 100) < 0.5, `green ${height('green')}`);
  assert.ok(Math.abs(height('yellow') - 37.5) < 0.5, `yellow ${height('yellow')}`);
  assert.ok(Math.abs(height('red') - 12.5) < 0.5, `red ${height('red')}`);
  const hold = master.filter((r) => r.style === 'hold');
  assert.equal(hold.length, 1);
  assert.equal(hold[0]!.h, 1.5);
  assert.ok(Math.abs(hold[0]!.y - (10 + 200 - 150)) < 1, `hold line at ${hold[0]!.y}`);
  assert.ok(master.some((r) => r.style === 'clip'), 'clip latched at 1.0');

  const track = inSlot(rects, 20);
  assert.ok(track.some((r) => r.style === 'green'));
  assert.ok(!track.some((r) => r.style === 'yellow' || r.style === 'red' || r.style === 'clip'));
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
