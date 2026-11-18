// The renderer's frame marks (m5b-nightly-quality, acceptance item 6; UI
// redesign spec 5.6): the display-rate draw callbacks (timeline layers, meters)
// bracket their work with performance.mark / performance.measure, and a
// recorder sums the work of one animation frame. They exist only under the test
// hook (window.siannTest, SIANN_SHELL_TEST=1): in a plain run the marks are a
// no-op that touches no performance API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  FRAME_MARK,
  FRAME_MEASURE,
  FrameRecorder,
  createFrameRecorder,
  frameMarks,
  installFrameMarks,
  readyLineAt,
  type PerfLike,
} from '../../src/renderer/perf/frame-marks';

class FakePerf implements PerfLike {
  t = 0;
  readonly calls: string[] = [];
  now(): number {
    return this.t;
  }
  mark(name: string): void {
    this.calls.push(`mark ${name}`);
  }
  measure(name: string, start: string): void {
    this.calls.push(`measure ${name} ${start}`);
  }
  clearMarks(name?: string): void {
    this.calls.push(`clearMarks ${name}`);
  }
  clearMeasures(name?: string): void {
    this.calls.push(`clearMeasures ${name}`);
  }
}

function recorder(capacity?: number) {
  const perf = new FakePerf();
  let frame = 0;
  const rec = new FrameRecorder({ perf, frameTime: () => frame, ...(capacity ? { capacity } : {}) });
  return { perf, rec, setFrame: (t: number) => (frame = t) };
}

test('one callback brackets its work with a mark and a measure', () => {
  assert.equal(FRAME_MEASURE, 'siann.frame');
  const { perf, rec } = recorder();
  perf.t = 10;
  rec.begin();
  perf.t = 12.5;
  rec.end();
  assert.deepEqual(perf.calls, [`mark ${FRAME_MARK}`, `measure ${FRAME_MEASURE} ${FRAME_MARK}`]);
  assert.deepEqual(rec.samples(), [2.5]);
});

test('the callbacks of one animation frame add up; a new frame time starts a new sample', () => {
  const { perf, rec, setFrame } = recorder();
  setFrame(1000);
  for (const [from, to] of [[0, 1], [2, 3.5]]) {
    perf.t = from!;
    rec.begin();
    perf.t = to!;
    rec.end();
  }
  setFrame(1016.7);
  perf.t = 20;
  rec.begin();
  perf.t = 23;
  rec.end();
  assert.deepEqual(rec.samples(), [2.5, 3]);
  assert.equal(rec.count(), 2);
});

test('clear() drops the samples and the performance entries', () => {
  const { perf, rec } = recorder();
  rec.begin();
  perf.t = 1;
  rec.end();
  rec.clear();
  assert.deepEqual(rec.samples(), []);
  assert.ok(perf.calls.includes(`clearMarks ${FRAME_MARK}`));
  assert.ok(perf.calls.includes(`clearMeasures ${FRAME_MEASURE}`));
});

test('the recorder keeps a bounded window of the newest frames', () => {
  const { perf, rec, setFrame } = recorder(4);
  for (let i = 0; i < 10; i += 1) {
    setFrame(i);
    perf.t = i * 10;
    rec.begin();
    perf.t = i * 10 + i;
    rec.end();
  }
  assert.deepEqual(rec.samples(), [6, 7, 8, 9]);
});

test('an end() without a begin() records nothing', () => {
  const { perf, rec } = recorder();
  rec.end();
  assert.deepEqual(rec.samples(), []);
  assert.deepEqual(perf.calls, []);
});

// The cold start of UI redesign 5.6 runs from the engine's ready line (read by
// the main process supervisor, which hands its time to the renderer under the
// test hook) to the first content frame that draws a session's clips. The
// ready line's time is on the wall clock (epoch ms); readyLineAt() puts it on
// the renderer's performance clock.
test('cold start: from the ready line to the first painted session, each taken once', () => {
  const { perf, rec } = recorder();
  assert.equal(rec.coldStartMs(), null);
  perf.t = 100;
  rec.sessionPainted(); // before the client connected: not a session of this engine
  assert.equal(rec.coldStartMs(), null);
  perf.t = 600;
  rec.connected();
  perf.t = 1100;
  rec.sessionPainted();
  assert.equal(rec.coldStartMs(), null, 'no ready line time yet');
  // The ready line came before the connection; its time arrives after the paint.
  rec.engineReadyAt(-200);
  rec.engineReadyAt(50);
  perf.t = 1300;
  rec.sessionPainted();
  rec.connected();
  assert.equal(rec.coldStartMs(), 1300, 'ready line at -200 to the paint at 1100');
});

test('readyLineAt puts the epoch time of the ready line on the performance clock of the renderer', () => {
  assert.equal(readyLineAt(1_700_000_000_250, 1_700_000_000_000), 250);
  assert.equal(readyLineAt(1_699_999_999_900, 1_700_000_000_000), -100, 'before the page loaded');
  assert.equal(readyLineAt(null, 1_700_000_000_000), null);
  assert.equal(readyLineAt(Number.NaN, 1_700_000_000_000), null);
  assert.equal(readyLineAt('1' as unknown as number, 1_700_000_000_000), null);
});

test('without the test hook there is no recorder and the marks touch no performance API', () => {
  const perf = new FakePerf();
  assert.equal(createFrameRecorder(undefined, { perf, frameTime: () => 0 }), null);
  installFrameMarks(null);
  const marks = frameMarks();
  marks.begin();
  marks.end();
  marks.sessionPainted();
  assert.deepEqual(perf.calls, []);
});

test('under the test hook the installed marks are the recorder', () => {
  const perf = new FakePerf();
  const rec = createFrameRecorder({}, { perf, frameTime: () => 0 });
  assert.ok(rec instanceof FrameRecorder);
  installFrameMarks(rec);
  try {
    frameMarks().begin();
    perf.t = 3;
    frameMarks().end();
    assert.deepEqual(rec.samples(), [3]);
  } finally {
    installFrameMarks(null);
  }
});

// dist/test/unit -> the sources (app/src/renderer).
const RENDERER = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');

test('the renderer creates the recorder from window.siannTest only, and the draw paths mark their frames', () => {
  const index = fs.readFileSync(path.join(RENDERER, 'index.tsx'), 'utf8');
  assert.match(index, /createFrameRecorder\(testHooks,/);
  assert.match(index, /window\.__siannFrames/);
  // The cold start's start is the supervisor's ready line, not the client's
  // first authenticated connection.
  assert.match(index, /testHooks\.engineReadyAt\(\)/);
  assert.match(index, /readyLineAt\(at, performance\.timeOrigin\)/);
  assert.match(index, /frames\.engineReadyAt\(/);
  assert.doesNotMatch(index, /frames\.engineReady\(\)/);
  for (const file of ['timeline/TimelineCanvas.ts', 'mixer/MixerMeters.ts', 'timeline/HeaderMeters.ts', 'shell/Transport.tsx']) {
    const source = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    assert.match(source, /frameMarks\(\)\.begin\(\)/, file);
    assert.match(source, /frameMarks\(\)\.end\(\)/, file);
  }
});
