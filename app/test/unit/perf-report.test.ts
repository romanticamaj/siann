// The performance scenario's report (m5b-nightly-quality, acceptance item 6;
// UI redesign spec 5.6): the pure half of app/test/e2e/perf.spec.ts. Median and
// 99th percentile of the per-frame main-thread work, the report's shape against
// the 5.6 budgets, and the missing-measurement check that fails the spec (the
// budgets themselves never fail it: report only at first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BUDGETS,
  MIN_FRAMES,
  MIN_METER_FRAMES,
  assertComplete,
  buildPerfReport,
  median,
  missingMeasurements,
  percentile,
  type PerfInput,
} from '../e2e/support/perf-report';

const frames = (n: number, value = 1): number[] => Array.from({ length: n }, () => value);

const input = (over: Partial<PerfInput> = {}): PerfInput => ({
  commit: 'abc1234',
  platform: 'linux',
  scenario: { tracks: 64, clips: 2000 },
  frameWorkMs: frames(MIN_FRAMES, 2),
  heapBytes: 120 * 1024 * 1024,
  coldStartMs: 900,
  playback: { playingAtStart: true, playingAtEnd: true, meterFrames: 300 },
  ...over,
});

test('the budgets are the ones of UI redesign 5.6', () => {
  assert.deepEqual(BUDGETS, { frameMedianMs: 4, frameP99Ms: 8, heapMb: 300, coldStartMs: 1500 });
});

test('median: the middle sample, or the mean of the two middle ones; unsorted input is fine', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.ok(Number.isNaN(median([])));
});

test('percentile: nearest rank, so p99 of 100 samples is the 99th smallest', () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // 100 .. 1
  assert.equal(percentile(samples, 99), 99);
  assert.equal(percentile(samples, 100), 100);
  assert.equal(percentile(samples, 50), 50);
  assert.equal(percentile([5, 1], 99), 5);
  assert.equal(percentile([2], 99), 2);
  assert.ok(Number.isNaN(percentile([], 99)));
  // One slow frame in 1,000 does not move p99; eleven do.
  assert.equal(percentile([...frames(999, 1), 50], 99), 1);
  assert.equal(percentile([...frames(989, 1), ...frames(11, 50)], 99), 50);
});

test('the report: commit, platform, scenario, measurements and one budget row each', () => {
  const report = buildPerfReport(input({ frameWorkMs: [...frames(MIN_FRAMES - 1, 2), 9] }));
  assert.equal(report.schema, 'siann.perf-report.v0');
  assert.equal(report.commit, 'abc1234');
  assert.equal(report.platform, 'linux');
  assert.deepEqual(report.scenario, { tracks: 64, clips: 2000 });
  assert.equal(report.measurements.frames, MIN_FRAMES);
  assert.equal(report.measurements.frameMedianMs, 2);
  assert.equal(report.measurements.frameP99Ms, 9);
  assert.equal(report.measurements.heapMb, 120);
  assert.equal(report.measurements.coldStartMs, 900);
  assert.equal(report.measurements.playing, true);
  assert.equal(report.measurements.meterFrames, 300);
  assert.deepEqual(
    report.budgets.map((row) => [row.name, row.value, row.budget, row.unit, row.withinBudget]),
    [
      ['frameMedianMs', 2, 4, 'ms', true],
      ['frameP99Ms', 9, 8, 'ms', false],
      ['heapMb', 120, 300, 'MB', true],
      ['coldStartMs', 900, 1500, 'ms', true],
    ],
  );
  // A JSON file: round-trips unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('a budget is "within" strictly under its value, as 5.6 words it', () => {
  const report = buildPerfReport(input({ frameWorkMs: frames(MIN_FRAMES, 4), coldStartMs: 1500 }));
  const within = Object.fromEntries(report.budgets.map((row) => [row.name, row.withinBudget]));
  assert.equal(within.frameMedianMs, false);
  assert.equal(within.coldStartMs, false);
});

test('a complete report misses nothing; over budget is still complete (report only)', () => {
  assert.deepEqual(missingMeasurements(buildPerfReport(input())), []);
  const slow = buildPerfReport(input({ frameWorkMs: frames(MIN_FRAMES, 30), heapBytes: 900 * 1024 * 1024, coldStartMs: 9000 }));
  assert.ok(slow.budgets.every((row) => row.withinBudget === false));
  assert.deepEqual(missingMeasurements(slow), []);
});

test('a missing measurement is named, its row has no value and no verdict', () => {
  const report = buildPerfReport(input({ heapBytes: null, coldStartMs: null }));
  assert.deepEqual(missingMeasurements(report), ['heapMb', 'coldStartMs']);
  const heap = report.budgets.find((row) => row.name === 'heapMb')!;
  assert.equal(heap.value, null);
  assert.equal(heap.withinBudget, null);
});

test('too few frames is a missing frame measurement, not a fast one', () => {
  for (const samples of [[], frames(MIN_FRAMES - 1, 1)]) {
    const report = buildPerfReport(input({ frameWorkMs: samples }));
    assert.deepEqual(missingMeasurements(report), ['frameMedianMs', 'frameP99Ms']);
    assert.equal(report.measurements.frames, samples.length);
  }
  // A sample that is not a finite non-negative number makes the frames missing too.
  assert.deepEqual(missingMeasurements(buildPerfReport(input({ frameWorkMs: [...frames(MIN_FRAMES, 1), Number.NaN] }))),
    ['frameMedianMs', 'frameP99Ms']);
});

test('the scenario must be the 64-track, 2,000-clip session', () => {
  assert.deepEqual(missingMeasurements(buildPerfReport(input({ scenario: { tracks: 8, clips: 2000 } }))), ['scenario']);
});

test('assertComplete throws on a missing measurement and not on one over its budget', () => {
  assert.throws(() => assertComplete(buildPerfReport(input({ heapBytes: null }))), /heapMb/);
  assert.throws(() => assertComplete(buildPerfReport(input({ frameWorkMs: [] }))), /frameMedianMs, frameP99Ms/);
  const slow = buildPerfReport(input({ frameWorkMs: frames(MIN_FRAMES, 30), heapBytes: 900 * 1024 * 1024, coldStartMs: 9000 }));
  assert.doesNotThrow(() => assertComplete(slow));
  for (const row of slow.budgets) {
    assert.deepEqual(Object.keys(row).filter((k) => ['value', 'budget', 'withinBudget'].includes(k)).sort(),
      ['budget', 'value', 'withinBudget']);
  }
});

// The frame figures are those of a playing transport with the meters running
// (5.6 row 1): the spec hands the transport's playing state at the start and
// the end of the measured window and the meter frames drawn inside it. Frame
// samples taken on an idle window (the meters' animation frame runs whether or
// not the transport plays) are no frame measurement.
test('frames measured on a transport that was not playing are missing, not idle figures', () => {
  for (const playback of [
    { playingAtStart: false, playingAtEnd: true, meterFrames: 300 },
    { playingAtStart: true, playingAtEnd: false, meterFrames: 300 },
    { playingAtStart: false, playingAtEnd: false, meterFrames: 0 },
  ]) {
    const report = buildPerfReport(input({ playback }));
    assert.equal(report.measurements.playing, false);
    assert.equal(report.measurements.frameMedianMs, null);
    assert.equal(report.measurements.frameP99Ms, null);
    assert.ok(missingMeasurements(report).includes('playing'), JSON.stringify(playback));
    assert.ok(missingMeasurements(report).includes('frameMedianMs'));
    assert.throws(() => assertComplete(report), /playing/);
  }
});

test('frames measured without meter frames arriving are missing', () => {
  for (const meterFrames of [0, MIN_METER_FRAMES - 1, Number.NaN]) {
    const report = buildPerfReport(input({ playback: { playingAtStart: true, playingAtEnd: true, meterFrames } }));
    assert.deepEqual(missingMeasurements(report), ['meterFrames', 'frameMedianMs', 'frameP99Ms']);
    assert.throws(() => assertComplete(report), /meterFrames/);
  }
  const report = buildPerfReport(input({ playback: { playingAtStart: true, playingAtEnd: true, meterFrames: MIN_METER_FRAMES } }));
  assert.deepEqual(missingMeasurements(report), []);
  assert.equal(report.measurements.meterFrames, MIN_METER_FRAMES);
});

test('a report without the playback evidence is incomplete', () => {
  const { playback: _omitted, ...rest } = input();
  const report = buildPerfReport(rest as PerfInput);
  assert.deepEqual(missingMeasurements(report), ['playing', 'meterFrames', 'frameMedianMs', 'frameP99Ms']);
});

// dist/test/unit -> app/test/e2e/perf.spec.ts (it runs only under SIANN_PERF=1,
// so its order of steps is checked here, on every run).
const PERF_SPEC = path.resolve(__dirname, '..', '..', '..', 'test', 'e2e', 'perf.spec.ts');

test('perf.spec.ts starts the window once playing with a meter frame drawn, and hands the report its evidence', () => {
  const source = fs.readFileSync(PERF_SPEC, 'utf8');
  const at = (pattern: RegExp): number => {
    const match = pattern.exec(source);
    assert.ok(match, `perf.spec.ts has ${pattern}`);
    return match.index;
  };
  const click = at(/await play\.click\(\)/);
  const pressed = at(/toHaveAttribute\('aria-pressed', 'true'/);
  const firstMeter = at(/meterFramesDrawn\(\)\)\.toBeGreaterThan\(/);
  const clear = at(/await frames\('clear', page\)/);
  const samples = at(/const frameWorkMs = await frames/);
  const endState = at(/playingAtEnd = /);
  assert.ok(click < pressed && pressed < firstMeter && firstMeter < clear && clear < samples && samples < endState,
    'play, playing, a meter frame, then clear, the samples and the end state');
  assert.match(source, /playback: \{ playingAtStart, playingAtEnd, meterFrames/);
});
