// The track list's mini meters (m5-ui-arrange acceptance item 1; UI redesign
// spec 5.1 and 5.3): one canvas for the whole header column, a bar per track
// in that track's row, filled from the RealtimeClient's newest reading on
// -60..0 dBFS, coloured --ok to -12 dBFS, --warn to -3 and --err above. A
// frame is drawn only when a new meter frame arrived or the rows moved, on
// the meters' own animation frame. Runs on a fake canvas whose 2D context
// records every fillRect with its fill colour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MeterEntry } from '../../src/renderer/model/meter-frames';
import { HeaderMeters, type AnimationFrames, type MeterRow } from '../../src/renderer/timeline/HeaderMeters';

const TOKENS: Record<string, string> = { '--bg-0': 'SLOT', '--ok': 'OK', '--warn': 'WARN', '--err': 'ERR' };
(globalThis as unknown as Record<string, unknown>).getComputedStyle = () => ({
  getPropertyValue: (name: string) => TOKENS[name] ?? '',
});
(globalThis as unknown as Record<string, unknown>).devicePixelRatio = 1;

interface Fill {
  readonly style: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function fakeCanvas(width = 10, height = 200) {
  const fills: Fill[] = [];
  let clears = 0;
  const ctx = {
    fillStyle: '',
    setTransform: () => undefined,
    clearRect: () => void (clears += 1),
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: String(this.fillStyle), x, y, w, h });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: width,
    clientHeight: height,
    dataset: {} as Record<string, string>,
    getContext: () => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, dataset: canvas.dataset, fills, clears: () => clears };
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
      for (const [ref, peak] of Object.entries(levels)) {
        readings.set(ref, { entityIndex: index++, channels: peak.length, peak, rms: peak });
      }
    },
  };
}

const dB = (db: number) => Math.pow(10, db / 20);

const ROWS: MeterRow[] = [
  { ref: 'track:a', top: 0, height: 53 },
  { ref: 'track:b', top: 53, height: 53 },
];

test('one canvas draws a slot per track row and a bar per channel at the reading, with zone colours', () => {
  const surface = fakeCanvas();
  const realtime = realtimeOf();
  const frames = manualFrames();
  const meters = new HeaderMeters(surface.canvas, realtime.client, () => ROWS, frames);
  meters.start();

  // Silence: the slots, no lit bars.
  frames.flush();
  const slots = surface.fills.filter((f) => f.style === 'SLOT');
  assert.equal(slots.length, 2, 'a slot per row, on the one canvas');
  // Bar: min(36, 53 - 8) = 36 px, centred in the 53 px row.
  assert.deepEqual(
    slots.map((s) => [s.y, s.h]),
    [
      [(53 - 36) / 2, 36],
      [53 + (53 - 36) / 2, 36],
    ],
  );
  assert.equal(surface.dataset.lit, '0');
  assert.equal(surface.dataset.frames, '0');

  // Track a: -30 dBFS mono (half way, --ok); track b: -6 dBFS left (--warn), 0 dBFS right (--err).
  realtime.emit({ 'track:a': [dB(-30)], 'track:b': [dB(-6), dB(0)] });
  surface.fills.length = 0;
  frames.flush();
  assert.equal(surface.dataset.frames, '1');
  assert.equal(surface.dataset.lit, '3', 'three channels above silence');
  const bars = surface.fills.filter((f) => f.style !== 'SLOT' && f.h > 0);
  const a = bars.filter((f) => f.y < 53);
  const b = bars.filter((f) => f.y >= 53);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.style, 'OK');
  assert.equal(a[0]!.h, 18, 'half of the 36 px bar');
  assert.equal(a[0]!.y + a[0]!.h, (53 - 36) / 2 + 36, 'filled from the bottom');
  assert.equal(a[0]!.w, 9, 'the whole width but the lane gap');
  assert.deepEqual(
    b.map((f) => [f.style, f.x, f.h]),
    [
      ['WARN', 0, Math.round(36 * (54 / 60))],
      ['ERR', 5, 36],
    ],
  );
  meters.stop();
});

test('a frame is drawn only when a meter frame arrived or the rows moved; stop cancels the loop', () => {
  const surface = fakeCanvas();
  const realtime = realtimeOf();
  const frames = manualFrames();
  let rows: MeterRow[] = ROWS;
  const meters = new HeaderMeters(surface.canvas, realtime.client, () => rows, frames);
  meters.start();
  frames.flush();
  assert.equal(surface.clears(), 1);
  frames.flush();
  frames.flush();
  assert.equal(surface.clears(), 1, 'nothing new: no redraw');

  realtime.emit({ 'track:a': [dB(-20)] });
  frames.flush();
  assert.equal(surface.clears(), 2, 'a new meter frame redraws');

  // The vertical scroll moves the rows: the bars move with the headers.
  rows = ROWS.map((r) => ({ ...r, top: r.top - 20 }));
  surface.fills.length = 0;
  frames.flush();
  assert.equal(surface.clears(), 3, 'moved rows redraw');
  const lit = surface.fills.find((f) => f.style === 'OK' && f.h > 0)!;
  assert.equal(lit.y + lit.h, -20 + (53 - 36) / 2 + 36);

  assert.equal(frames.pending(), 1);
  meters.stop();
  assert.equal(frames.pending(), 0, 'stop cancels the pending frame');
  realtime.emit({ 'track:a': [dB(-1)] });
  frames.flush();
  assert.equal(surface.clears(), 3);
});
