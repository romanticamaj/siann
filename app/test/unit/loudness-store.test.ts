// The loudness store (UI redesign 5.3; m5b-ui-meter): SLUD frame ->
// RealtimeClient -> LoudnessStore, a plain object holding the master's
// momentary, short-term and integrated loudness in LUFS. Minus infinity is
// silence, and what it reads before the first frame and after a clear (a
// disconnect). No React subscription API: the meter surfaces read it from
// their own animation frame (ADR-0019 point 3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LoudnessStore } from '../../src/renderer/model/loudness-store';

test('a new store reads minus infinity on all three values', () => {
  const store = new LoudnessStore();
  assert.deepEqual([store.momentary, store.shortTerm, store.integrated], [-Infinity, -Infinity, -Infinity]);
  assert.equal(store.frames, 0);
});

test('set() keeps the newest frame\'s values and counts it; clear() returns them to minus infinity', () => {
  const store = new LoudnessStore();
  store.set({ engineTimestampMicros: '1', momentary: -22.5, shortTerm: -23.25, integrated: -23 });
  assert.deepEqual([store.momentary, store.shortTerm, store.integrated], [-22.5, -23.25, -23]);
  store.set({ engineTimestampMicros: '2', momentary: -Infinity, shortTerm: -Infinity, integrated: -14.125 });
  assert.deepEqual([store.momentary, store.shortTerm, store.integrated], [-Infinity, -Infinity, -14.125]);
  assert.equal(store.frames, 2);
  store.clear();
  assert.deepEqual([store.momentary, store.shortTerm, store.integrated], [-Infinity, -Infinity, -Infinity]);
});

test('read(field) names the three values, and the store has no React subscription API', () => {
  const store = new LoudnessStore();
  store.set({ engineTimestampMicros: '1', momentary: -1, shortTerm: -2, integrated: -3 });
  assert.equal(store.read('momentary'), -1);
  assert.equal(store.read('shortTerm'), -2);
  assert.equal(store.read('integrated'), -3);
  const api = store as unknown as Record<string, unknown>;
  for (const name of ['subscribe', 'getSnapshot', 'getServerSnapshot']) assert.equal(api[name], undefined, name);
});
