// The card's summary line (m5-ui-port-plans; UI redesign 10.7, 3): count
// chips from the plan's steps, in this order, a kind with no step omitted:
// "+N track" (track.add), "−N track" (track.remove), "+N clip" (clip.place),
// "−N clip" (clip.remove), "N move" (clip.move), "N mix" (gain, pan, mute,
// solo, clip gain, plug-in bypass), "N edit" (every other op). The words are
// the catalogs'; zh-Hant's are the mockup's own (its ZH table).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translator } from '../../src/renderer/i18n/t';
import { chipsOf } from '../../src/renderer/plans/chips';
import { MOCKUP_STEPS, mockupZh } from './support/mockup-plan';

const text = (chips: ReturnType<typeof chipsOf>) => chips.map((c) => `${c.figure} ${c.word}`);

test("the mockup's plan reads +1 track, +1 clip, 1 move, 3 mix", () => {
  const chips = chipsOf(MOCKUP_STEPS, translator('en'));
  assert.deepEqual(text(chips), ['+1 track', '+1 clip', '1 move', '3 mix']);
  assert.deepEqual(chips.map((c) => [c.kind, c.count]), [['trackAdd', 1], ['clipAdd', 1], ['move', 1], ['mix', 3]]);
});

test('every kind in its order, the removals with a minus sign, the rest as edits', () => {
  const steps: Record<string, unknown>[] = [
    { op: 'session.rename', name: 'X' },
    { op: 'clip.remove', clipId: 'c1' },
    { op: 'clip.remove', clipId: 'c2' },
    { op: 'track.remove', trackId: 't1' },
    { op: 'clip.move', clipId: 'c3', position: { domain: 'audio', value: '0' } },
    { op: 'track.set_solo', trackId: 't2', solo: true },
    { op: 'clip.set_gain', clipId: 'c3', gainMilliDb: 0 },
    { op: 'plugin.set_bypass', slotId: 's1', bypass: true },
    { op: 'track.add', trackId: 't3', name: 'N', channels: 2 },
    { op: 'track.add', trackId: 't4', name: 'M', channels: 1 },
    { op: 'clip.place', clipId: 'c4', trackId: 't3', mediaId: 'm', position: { domain: 'audio', value: '0' }, sourceStart: '0', length: '1' },
    { op: 'clip.trim', clipId: 'c4', length: '2' },
    { op: 'track.rename', trackId: 't2', name: 'Y' },
    { op: 'track.set_input', trackId: 't2', input: null },
    { op: 'track.explode', trackId: 't2' },
    { op: 'plugin.insert', trackId: 't2', index: 0, slotId: 's2', descriptor: { name: 'EQ' }, stateBlob: null },
    { op: 'plugin.remove', slotId: 's2' },
    { op: 'media.add', mediaId: 'm2' },
    { op: 'media.remove', mediaId: 'm2' },
    { op: 'media.rename', mediaId: 'm', name: 'k' },
    { op: 'session.set_tempo', tempo: [{ ticks: '0', milliBpm: 120000 }] },
    { op: 'track.set_gain', trackId: 't2', gainMilliDb: 0 },
    { op: 'track.set_pan', trackId: 't2', pan: 0 },
    { op: 'track.set_mute', trackId: 't2', mute: true },
    { op: 'something.new' },
  ];
  assert.deepEqual(text(chipsOf(steps, translator('en'))), ['+2 track', '−1 track', '+1 clip', '−2 clip', '1 move', '6 mix', '12 edit']);
  // A kind with no step is left out; no step, no chip.
  assert.deepEqual(text(chipsOf([{ op: 'clip.trim', clipId: 'c', length: '1' }], translator('en'))), ['1 edit']);
  assert.deepEqual(chipsOf([], translator('en')), []);
});

// m5b-ui-markers (UI redesign 4.2): the four marker ops count under "edit".
test('marker steps count under "edit"', () => {
  const steps = [
    { op: 'marker.add', markerId: 'mk_1', position: '0' },
    { op: 'marker.move', markerId: 'mk_1', position: '10' },
    { op: 'marker.rename', markerId: 'mk_1', name: 'A' },
    { op: 'marker.remove', markerId: 'mk_1' },
    { op: 'clip.move', clipId: 'c1', position: { domain: 'audio', value: '0' } },
  ];
  assert.deepEqual(text(chipsOf(steps, translator('en'))), ['1 move', '4 edit']);
});

test('the words per locale; zh-Hant is the mockup\'s', () => {
  const zh = mockupZh();
  for (const word of ['track', 'clip', 'move', 'mix']) assert.ok(zh[word], `the mockup's ZH table has ${word}`);
  assert.deepEqual(text(chipsOf(MOCKUP_STEPS, translator('zh-Hant'))), [`+1 ${zh.track}`, `+1 ${zh.clip}`, `1 ${zh.move}`, `3 ${zh.mix}`]);
  assert.deepEqual(text(chipsOf(MOCKUP_STEPS, translator('zh-Hans'))), ['+1 音轨', '+1 片段', '1 移动', '3 混音']);
  const edit = [{ op: 'track.rename', trackId: 't', name: 'x' }];
  assert.deepEqual(text(chipsOf(edit, translator('zh-Hant'))), ['1 編輯']);
  assert.deepEqual(text(chipsOf(edit, translator('zh-Hans'))), ['1 编辑']);
});
