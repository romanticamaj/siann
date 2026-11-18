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
import { LoudnessStore } from '../../src/renderer/model/loudness-store';
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

// m5b-ui-meter (UI redesign 5.3, UR-14): the surface writes the master's
// loudness texts (the strip's LUFS-S; the Meter tab's momentary, short-term
// and integrated) from the LoudnessStore in its animation frame, as it writes
// the peak values: formatLufs, -inf for silence. A loudness change wakes a
// stopped loop only when a written text would change.
function loudnessSetup() {
  const rig = setup();
  const loudness = new LoudnessStore();
  const meters = new MixerMeters({
    canvas: fakeCanvas().canvas,
    store: rig.store,
    loudness,
    frames: rig.frames,
    clock: () => 0,
    hidden: () => false,
    pixelRatio: () => 1,
    size: () => ({ width: 100, height: 100 }),
  });
  rig.meters.destroy();
  const texts = { shortTerm: { textContent: '' as string | null }, momentary: { textContent: '' as string | null }, integrated: { textContent: '' as string | null } };
  meters.addLoudness('shortTerm', texts.shortTerm);
  meters.addLoudness('momentary', texts.momentary);
  meters.addLoudness('integrated', texts.integrated);
  return { ...rig, meters, loudness, texts };
}

test('the loudness texts are written from the LoudnessStore in the frame callback, -inf for silence', () => {
  const { source, frames, meters, loudness, texts } = loudnessSetup();
  // Written once when added: silence.
  assert.deepEqual(Object.values(texts).map((t) => t.textContent), ['-inf', '-inf', '-inf']);
  source.push([[0, 0.5]]);
  loudness.set({ engineTimestampMicros: '1', momentary: -22.54, shortTerm: -13.84, integrated: -23 });
  meters.onFrame();
  assert.equal(texts.shortTerm.textContent, '-inf', 'nothing is written outside the frame callback');
  frames.run();
  assert.equal(texts.shortTerm.textContent, '-13.8');
  assert.equal(texts.momentary.textContent, '-22.5');
  assert.equal(texts.integrated.textContent, '-23.0');
  loudness.clear();
  frames.run();
  assert.deepEqual(Object.values(texts).map((t) => t.textContent), ['-inf', '-inf', '-inf']);
});

test('a loudness change wakes a stopped loop only when a text would change; nothing is requested while idle or hidden', () => {
  const { source, frames, meters, loudness, texts } = loudnessSetup();
  source.push([], false);
  meters.onFrame();
  for (let i = 0; i < 60 * 30 && frames.queue.size > 0; i += 1) frames.run();
  assert.equal(frames.queue.size, 0, 'idle');
  const before = frames.requested;
  // The same values: nothing to write, nothing requested.
  meters.onLoudness();
  assert.equal(frames.requested, before);
  // Stopped after a programme: the integrated value holds, the others fall to -inf.
  loudness.set({ engineTimestampMicros: '2', momentary: -Infinity, shortTerm: -Infinity, integrated: -14.125 });
  meters.onLoudness();
  assert.equal(frames.requested, before + 1);
  frames.run();
  assert.equal(texts.integrated.textContent, '-14.1');
  assert.equal(frames.queue.size, 0, 'and the loop stops again');
  meters.onLoudness();
  assert.equal(frames.requested, before + 1, 'idle again');
});

test('the Meter tab\'s surface: the master\'s two channels with peak hold and clip, and its peak value, from the shared store', () => {
  const { source, store, frames } = setup();
  const { canvas, rects } = fakeCanvas();
  const tab = new MixerMeters({ canvas, store, frames, clock: () => 0, hidden: () => false, pixelRatio: () => 1, size: () => ({ width: 100, height: 120 }) });
  const peak = { textContent: '' as string | null, classList: { on: false, toggle(_name: string, force?: boolean) { this.on = force === true; return this.on; } } };
  [10, 21].forEach((x, channel) => tab.addSlot({ ref: 'master', channel, measure: () => ({ x, y: 0, width: 9, height: 100 }) }));
  tab.addPeak('master', peak);
  tab.measure();
  source.push([[0, [2, 0.25]]]); // the left channel clips
  tab.onFrame();
  frames.run();
  assert.equal(bars(rects, 10).length, 1, 'the left channel\'s bar');
  assert.equal(bars(rects, 21).length, 1, 'the right channel\'s bar');
  assert.ok(at(rects, 10).some((r) => r.style === TOKENS['tx-0']), 'the hold line');
  assert.ok(at(rects, 10).some((r) => r.style === TOKENS.err), 'the clip band');
  assert.equal(peak.textContent, '+6.0');
  assert.equal(peak.classList.on, true);
  tab.reset('master');
  frames.run();
  assert.equal(peak.classList.on, false, 'a click on the peak value resets the clip');
  tab.destroy();
});

test('two surfaces over one store advance the ballistics once per animation frame', () => {
  const source = new FakeSource();
  const store = new MeterStore(source);
  source.push([[0, 1]]);
  store.sync();
  store.advance(0, 1);
  source.push([[0, 0]]);
  store.sync();
  store.advance(0.1, 2);
  const once = store.read('master')!.level;
  assert.ok(once < 0, 'the bar falls');
  store.advance(0.1, 2);
  assert.equal(store.read('master')!.level, once, 'the same frame is not advanced twice');
  store.advance(0.1, 3);
  assert.ok(store.read('master')!.level < once, 'the next frame is');
  // Without a frame id every call advances, as before.
  const before = store.read('master')!.level;
  store.advance(0.1);
  assert.ok(store.read('master')!.level < before);
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
