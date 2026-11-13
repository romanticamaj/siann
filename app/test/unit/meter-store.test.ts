// The meter store (m5-ui-mixer; UI redesign spec 5.3): SMTR frame ->
// RealtimeClient -> MeterStore, a plain object of Float32Arrays (peak, RMS,
// hold, clip) per legend index that the meter canvases read from their own
// animation frame. It emits nothing (no subscribe: React never hears of a
// meter value). A new legend epoch resizes the arrays; an entity missing from
// a frame reads as silence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MeterFrame, MeterLegend } from '../../src/renderer/model/meter-frames';
import { MeterStore } from '../../src/renderer/model/meter-store';
import { FLOOR_DB } from '../../src/renderer/mixer/peak-hold';

class FakeSource {
  legendValue: MeterLegend | null = null;
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
  push(entries: Array<[number, number[], number[]?]>, playing = true): void {
    this.frame = {
      epoch: this.legendValue?.epoch ?? '0',
      engineTimestampMicros: '0',
      playheadSamples: '0',
      playing,
      entries: entries.map(([entityIndex, peak, rms]) => ({ entityIndex, channels: peak.length, peak, rms: rms ?? peak.map((p) => p / 2) })),
    };
    this.count += 1;
  }
}

test('emits nothing: no subscribe', () => {
  const store = new MeterStore(new FakeSource());
  assert.equal((store as unknown as { subscribe?: unknown }).subscribe, undefined);
});

test('the arrays follow the legend: master found, sized per epoch', () => {
  const source = new FakeSource();
  const store = new MeterStore(source);
  store.sync();
  assert.equal(store.peak.length, 0);
  assert.equal(store.indexOf('master'), -1);
  source.legendValue = { epoch: '1', entities: ['master', 'track:a'] };
  store.sync();
  assert.ok(store.peak instanceof Float32Array);
  for (const array of [store.peak, store.rms, store.hold, store.clip]) assert.equal(array.length, 2);
  assert.equal(store.indexOf('master'), 0);
  assert.equal(store.indexOf('track:a'), 1);
  assert.equal(store.indexOf('track:b'), -1);

  source.push([[0, [0.5, 0.25]], [1, [0.1, 0.2], [0.05, 0.1]]]);
  store.sync();
  // The louder channel.
  assert.ok(Math.abs(store.peak[0]! - 0.5) < 1e-6);
  assert.ok(Math.abs(store.peak[1]! - 0.2) < 1e-6);
  assert.ok(Math.abs(store.rms[1]! - 0.1) < 1e-6);

  // A new epoch with another entity list: resized, everything silent.
  source.legendValue = { epoch: '2', entities: ['track:b', 'master', 'track:a'] };
  store.sync();
  assert.equal(store.peak.length, 3);
  assert.equal(store.indexOf('master'), 1);
  assert.deepEqual([...store.peak], [0, 0, 0]);
  assert.deepEqual([...store.hold], [FLOOR_DB, FLOOR_DB, FLOOR_DB]);
});

test('an entity missing from the newest frame reads as silence', () => {
  const source = new FakeSource();
  source.legendValue = { epoch: '1', entities: ['master', 'track:a'] };
  const store = new MeterStore(source);
  source.push([[0, [0.5]], [1, [0.4]]]);
  store.sync();
  assert.ok(store.peak[1]! > 0.39);
  source.push([[0, [0.5]]]);
  store.sync();
  assert.equal(store.peak[1], 0);
  assert.ok(store.peak[0]! > 0.49);
  // An index outside the legend is ignored.
  source.push([[7, [0.9]]]);
  assert.doesNotThrow(() => store.sync());
});

test('advance applies the ballistics; read and reset by ref', () => {
  const source = new FakeSource();
  source.legendValue = { epoch: '1', entities: ['master', 'track:a'] };
  const store = new MeterStore(source);
  source.push([[0, [1.2]], [1, [0.5]]]);
  store.sync();
  store.advance(1 / 60);
  const master = store.read('master')!;
  assert.ok(master.peak > 1.19);
  assert.equal(master.clip, true);
  assert.ok(master.max > 1.19);
  assert.ok(Math.abs(master.hold - 20 * Math.log10(1.2)) < 0.01);
  assert.equal(store.read('track:a')!.clip, false);
  assert.equal(store.read('track:zz'), null);
  assert.equal(store.playing(), true);
  assert.equal(store.decayed(), false);
  store.reset('master');
  assert.equal(store.read('master')!.clip, false);
  assert.equal(store.read('master')!.max, 0);

  // Silence and enough time: everything decays.
  source.push([], false);
  store.sync();
  for (let i = 0; i < 60 * 30; i += 1) store.advance(1 / 60);
  assert.equal(store.playing(), false);
  assert.equal(store.decayed(), true);
});

test('sync reports whether a new frame was taken', () => {
  const source = new FakeSource();
  source.legendValue = { epoch: '1', entities: ['master'] };
  const store = new MeterStore(source);
  assert.equal(store.sync(), false);
  source.push([[0, [0.5]]]);
  assert.equal(store.sync(), true);
  assert.equal(store.sync(), false);
});
