// The waveform of a clip (m5-ui-port-arrange-canvas; UI redesign 5.2 and
// 10.9): real peaks, not the mockup's noise function, in draw()'s two tones.
// Per device-pixel column the range is the lowest min and the highest max of
// the pyramid over the column's frames (every channel), at the level whose
// bins are the widest that still fit a device pixel (chooseLevel at ratio /
// framesPerPixel); the outer layer fills from max * half above the middle to
// min * half below it, the inner one the same at .52, each at least 1 px
// high. The pyramid is built by hand here: 4096 mono frames, the first half
// at full scale (one bin on the negative side only), the second silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PeakPyramid } from '../../src/renderer/model/peaks';
import { waveformColumns } from '../../src/renderer/timeline/waveform';

// 256-frame bins: level 0 has 16, level 1 (1024 frames) 4, level 2 (4096) 1.
function level(binFrames: number, bins: Array<[number, number]>) {
  return { binFrames, binCount: bins.length, values: Int16Array.from(bins.flat()) };
}
const LOUD: [number, number] = [-32767, 32767];
const QUIET: [number, number] = [0, 0];
// One bin of the loud half reaches full scale on the negative side only.
const NEGATIVE: [number, number] = [-32767, 0];
const PYRAMID: PeakPyramid = {
  channels: 1,
  frames: 4096,
  sampleRate: 48000,
  levels: [
    level(256, [LOUD, LOUD, LOUD, NEGATIVE, LOUD, LOUD, LOUD, LOUD, ...Array.from({ length: 8 }, () => QUIET)]),
    level(1024, [LOUD, LOUD, QUIET, QUIET]),
    level(4096, [LOUD]),
  ],
};

const BASE = { sourceStart: 0, length: 4096, x: 0, clipLeft: 0, clipRight: 1000, mid: 50, half: 10 };
const close = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test('one column per pixel at 256 frames per pixel, from level 0: a loud half and a silent half', () => {
  const { level: chosen, columns } = waveformColumns(PYRAMID, { ...BASE, framesPerPixel: 256, ratio: 1 });
  assert.equal(chosen, 0, 'the 256-frame bins fit one pixel');
  assert.equal(columns.length, 16);
  columns.forEach((column, k) => {
    assert.equal(column.x, k);
    assert.equal(column.w, 1);
    const loud = k < 8;
    close(column.outer, loud ? (k === 3 ? 5 : 10) : 0.5, `outer ${k}`);
    close(column.inner, loud ? (k === 3 ? 2.6 : 5.2) : 0.5, `inner ${k}`);
  });
  // The negative-only bin keeps its polarity: the outer layer fills from the
  // middle down to the min, nothing above it (acceptance 3: between the
  // pyramid's min and max). Its amplitude is still full scale.
  assert.deepEqual(columns[3]!.outerSpan, { up: 0, down: 10 });
  close(columns[3]!.innerSpan.up, 0, 'inner up 3');
  close(columns[3]!.innerSpan.down, 5.2, 'inner down 3');
  close(columns[3]!.outer, 5, 'outer half-height 3');
  close(columns[3]!.amplitude, 1, 'amplitude 3');
  for (const k of [0, 1, 2, 4]) assert.deepEqual(columns[k]!.outerSpan, { up: 10, down: 10 }, `symmetric ${k}`);
});

test('a column fills between the min and the max of every channel: a DC offset and a stereo pair stay asymmetric', () => {
  // Channel 0 between +8192 and +16384 (a DC offset, never below zero);
  // channel 1 between -8192 and +4096.
  const dc: PeakPyramid = {
    channels: 2,
    frames: 256,
    sampleRate: 48000,
    levels: [{ binFrames: 256, binCount: 1, values: Int16Array.from([8192, 16384, -8192, 4096]) }],
  };
  const mono = { ...dc, channels: 1, levels: [{ binFrames: 256, binCount: 1, values: Int16Array.from([8192, 16384]) }] };
  const request = { ...BASE, length: 256, framesPerPixel: 256, ratio: 1, half: 32767 / 1024 };
  // Units of 1/1024 of full scale: half = 32 px per full scale.
  const [only] = waveformColumns(mono, request).columns;
  close(only!.outerSpan.up, 16, 'the max: 16 px above the middle');
  close(only!.outerSpan.down, -8, 'the min: 8 px above the middle too (the fill starts above it)');
  close(only!.innerSpan.up, 16 * 0.52, 'inner up');
  close(only!.innerSpan.down, -8 * 0.52, 'inner down');
  const [both] = waveformColumns(dc, request).columns;
  close(both!.outerSpan.up, 16, 'the highest max of the two channels');
  close(both!.outerSpan.down, 8, 'the lowest min of the two channels');
  close(both!.amplitude, 16384 / 32767, 'the amplitude');
  // A narrow range keeps a 1 px layer, centred on it.
  const flat = { ...mono, levels: [{ binFrames: 256, binCount: 1, values: Int16Array.from([1024, 1024]) }] };
  const [line] = waveformColumns(flat, request).columns;
  close(line!.outerSpan.up + line!.outerSpan.down, 1, '1 px high');
  close(line!.outerSpan.up, 1.5, 'around +1 px');
});

test('at 1024 frames per pixel the 1024-frame bins of level 1 are read', () => {
  const { level: chosen, columns } = waveformColumns(PYRAMID, { ...BASE, framesPerPixel: 1024, ratio: 1 });
  assert.equal(chosen, 1);
  assert.deepEqual(columns.map((c) => c.x), [0, 1, 2, 3]);
  assert.deepEqual(columns.map((c) => c.outer), [10, 10, 0.5, 0.5]);
  // Silence is half a pixel high, never nothing.
  assert.deepEqual(columns.map((c) => c.inner > 0), [true, true, true, true]);
});

test('at a device pixel ratio of 2 a column is half a CSS pixel and the level fits a device pixel', () => {
  // 512 frames per CSS px: 256 per device pixel, so level 0.
  const { level: chosen, columns } = waveformColumns(PYRAMID, { ...BASE, framesPerPixel: 512, ratio: 2 });
  assert.equal(chosen, 0);
  assert.equal(columns.length, 16);
  assert.deepEqual(columns.slice(0, 3).map((c) => [c.x, c.w]), [[0, 0.5], [0.5, 0.5], [1, 0.5]]);
  assert.deepEqual(columns.map((c) => c.outer > 0.5), [...Array(8).fill(true), ...Array(8).fill(false)]);
  for (const c of columns) close(c.inner, c.outer === 0.5 ? 0.5 : c.outer * 0.52, `inner at ${c.x}`);
});

test('the columns follow sourceStart and stay inside the visible part of the clip', () => {
  // The clip shows frames 1024..3072 from x = 100: two pixels' worth of the
  // loud half's level-0 bins are 4 columns, then 4 silent ones.
  const trimmed = { ...BASE, sourceStart: 1024, length: 2048, x: 100, framesPerPixel: 256, ratio: 1 };
  const { columns } = waveformColumns(PYRAMID, trimmed);
  assert.deepEqual(columns.map((c) => c.x), [100, 101, 102, 103, 104, 105, 106, 107]);
  assert.deepEqual(columns.map((c) => c.outer), [10, 10, 10, 10, 0.5, 0.5, 0.5, 0.5]);
  // Clipped to the view: only what lies between clipLeft and clipRight.
  const clipped = waveformColumns(PYRAMID, { ...trimmed, clipLeft: 102, clipRight: 105 }).columns;
  assert.deepEqual(clipped.map((c) => c.x), [102, 103, 104]);
  assert.deepEqual(clipped.map((c) => c.outer), [10, 10, 0.5]);
  // Inner is 52 % of outer where the column is not silent.
  for (const c of columns) if (c.outer > 0.5) close(c.inner, c.outer * 0.52, `inner at ${c.x}`);
});

test('a column with no media frame is not drawn', () => {
  // A clip longer than its media's frames (beyond them nothing is read).
  const { columns } = waveformColumns(PYRAMID, { ...BASE, length: 8192, framesPerPixel: 256, ratio: 1 });
  assert.equal(columns.length, 16);
});
