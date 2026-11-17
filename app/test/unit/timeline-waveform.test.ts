// The waveform of a clip (m5-ui-port-arrange-canvas; UI redesign 5.2 and
// 10.9): real peaks, not the mockup's noise function, in draw()'s two tones.
// Per device-pixel column the amplitude a is the largest |min| or |max| of the
// pyramid over the column's frames (every channel), at the level whose bins
// are the widest that still fit a device pixel (chooseLevel at ratio /
// framesPerPixel); the outer layer is max(.5, a * half) above and below the
// middle, the inner one max(.5, a * half * .52). The pyramid is built by hand
// here: 4096 mono frames, the first half at full scale, the second silent.

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
    close(column.outer, loud ? 10 : 0.5, `outer ${k}`);
    close(column.inner, loud ? 5.2 : 0.5, `inner ${k}`);
  });
  // The negative-only bin is as loud as the others: a is the larger of |min| and |max|.
  close(columns[3]!.outer, 10, 'outer 3');
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
  for (const c of columns) close(c.inner, Math.max(0.5, (c.outer === 0.5 ? 0 : 1) * 10 * 0.52), `inner at ${c.x}`);
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
