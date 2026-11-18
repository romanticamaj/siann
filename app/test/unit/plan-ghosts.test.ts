// The ghost model (m5b-ui-ghosts; UI redesign 4.2, P2-1): a pure function of
// a plan's steps, its plan.preview answer, the snapshot and the ticked steps
// to one descriptor per change, each with its step number. One test per kind
// of 4.2, then the rules: an unticked step contributes none, a ghost's values
// come from the preview's before with the ticked steps applied in order
// (never from after wholesale), the step number is the 1-based index in the
// full plan, a cascade belongs to the step plans/entity-homes.ts homes it to,
// and a ghost on a track that exists neither in the snapshot nor through a
// ticked track.add is not produced. Every expected value is written out here
// from the fixture, not computed by the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LocatorsEntity } from '../../src/renderer/model/document';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { PlanPreview } from '../../src/renderer/plans/diff';
import { ghostsOf, type Ghost } from '../../src/renderer/plans/ghosts';
import { clip, media, snapshotOf, track } from './support/timeline';

const A = 'trk_a';
const B = 'trk_b';
const C = 'trk_c';
const NEW = 'trk_new';
const TWO = 'trk_two';
const THREE = 'trk_three';
const audio = (value: string) => ({ domain: 'audio', value });

function session(): Snapshot {
  const base = snapshotOf(
    [A, B, C],
    [{ ...track(A), name: 'Keys', gainMilliDb: -9000 }, { ...track(B), name: 'Bass', mute: true }, { ...track(C), name: 'FX' }],
    [media('med_1', '480000'), media('med_2', '480000'), media('med_3', '480000')],
    [
      clip('clp_1', A, 'med_1', '0', '0', '96000'),
      clip('clp_2', B, 'med_2', '96000', '1000', '96000'),
      clip('clp_3', C, 'med_3', '48000', '0', '48000'),
      clip('clp_4', A, 'med_2', '288000', '0', '24000'),
    ],
  );
  const locators: LocatorsEntity = { schema: 'siann.entity.locators.v1', id: 'locators', left: '0', right: '96000' };
  return { ...base, locators, entities: { ...base.entities, 'locators:locators': locators } };
}

const STEPS: ReadonlyArray<Record<string, unknown>> = [
  /* 1 */ { op: 'track.add', trackId: NEW, name: 'Pad', channels: 2 },
  /* 2 */ { op: 'clip.place', clipId: 'clp_new', trackId: NEW, mediaId: 'med_1', position: audio('192000'), sourceStart: '0', length: '96000' },
  /* 3 */ { op: 'track.set_gain', trackId: A, gainMilliDb: -6000 },
  /* 4 */ { op: 'clip.move', clipId: 'clp_1', position: audio('48000') },
  /* 5 */ { op: 'clip.trim', clipId: 'clp_2', sourceStart: '2000', length: '48000' },
  /* 6 */ { op: 'clip.remove', clipId: 'clp_4' },
  /* 7 */ { op: 'track.remove', trackId: C },
  /* 8 */ { op: 'track.set_pan', trackId: A, pan: -2000 },
  /* 9 */ { op: 'track.set_mute', trackId: B, mute: false },
  /* 10 */ { op: 'track.set_solo', trackId: A, solo: true },
  /* 11 */ { op: 'track.rename', trackId: B, name: 'Bass DI' },
  /* 12 */ { op: 'session.set_locators', left: '96000', right: '192000' },
  /* 13 */ { op: 'track.add', trackId: TWO, name: 'Two', channels: 1 },
  /* 14 */ { op: 'track.set_gain', trackId: A, gainMilliDb: -3000 },
  /* 15 */ { op: 'track.add', trackId: THREE, name: 'Three', channels: 2 },
];

// plan.preview of the whole plan: before is the head, after every step applied.
function preview(): PlanPreview {
  const s = session();
  const e = (ref: string) => s.entities[ref] as unknown as Record<string, unknown>;
  return {
    revision: 'r7',
    documentHash: `sha256:${'b'.repeat(64)}`,
    stale: [],
    entities: [
      { ref: 'root:root', before: e('root:root'), after: { ...e('root:root'), trackOrder: [A, B, NEW, TWO, THREE] } },
      { ref: `track:${NEW}`, before: null, after: { ...track(NEW), name: 'Pad' } },
      { ref: 'clip:clp_new', before: null, after: clip('clp_new', NEW, 'med_1', '192000', '0', '96000') as unknown as Record<string, unknown> },
      { ref: `track:${A}`, before: e(`track:${A}`), after: { ...e(`track:${A}`), gainMilliDb: -3000, pan: -2000, solo: true } },
      { ref: 'clip:clp_1', before: e('clip:clp_1'), after: { ...e('clip:clp_1'), position: audio('48000') } },
      { ref: 'clip:clp_2', before: e('clip:clp_2'), after: { ...e('clip:clp_2'), sourceStart: '2000', length: '48000' } },
      { ref: 'clip:clp_4', before: e('clip:clp_4'), after: null },
      { ref: `track:${C}`, before: e(`track:${C}`), after: null },
      // The cascade: the removed track's clip, named by no step.
      { ref: 'clip:clp_3', before: e('clip:clp_3'), after: null },
      { ref: `track:${B}`, before: e(`track:${B}`), after: { ...e(`track:${B}`), mute: false, name: 'Bass DI' } },
      { ref: 'locators:locators', before: e('locators:locators'), after: { ...e('locators:locators'), left: '96000', right: '192000' } },
      { ref: `track:${TWO}`, before: null, after: { ...track(TWO), name: 'Two', channels: 1 } },
      { ref: `track:${THREE}`, before: null, after: { ...track(THREE), name: 'Three' } },
    ],
  };
}

const all = (ticked: ReadonlySet<number> | null = null) => ghostsOf(STEPS, preview(), session(), ticked);
const ofKind = <K extends Ghost['kind']>(ghosts: readonly Ghost[], kind: K) => ghosts.filter((g): g is Ghost & { kind: K } => g.kind === kind);
const without = (...steps: number[]) => new Set(STEPS.map((_, i) => i).filter((i) => !steps.includes(i + 1)));

test('track.add: the first proposed track keeps the mockup\'s ids, later ones take ghost-2, ghost-3 in step order', () => {
  assert.deepEqual(ofKind(all(), 'track-add'), [
    { kind: 'track-add', step: 1, trackId: NEW, name: 'Pad', channels: 2, key: 'ghost' },
    { kind: 'track-add', step: 13, trackId: TWO, name: 'Two', channels: 1, key: 'ghost-2' },
    { kind: 'track-add', step: 15, trackId: THREE, name: 'Three', channels: 2, key: 'ghost-3' },
  ]);
  // The ids follow the step order of the ticked ones: with step 1 unticked, Two is the first.
  assert.deepEqual(ofKind(all(without(1)), 'track-add').map((g) => [g.trackId, g.key]), [[TWO, 'ghost'], [THREE, 'ghost-2']]);
});

test('clip.place: a ghost clip on its track (a proposed one here) at the step\'s position and length', () => {
  assert.deepEqual(ofKind(all(), 'clip-place'), [
    { kind: 'clip-place', step: 2, clipId: 'clp_new', trackId: NEW, mediaId: 'med_1', position: '192000', sourceStart: '0', length: '96000' },
  ]);
});

test('clip.move: the original where it is and the ghost at the new place', () => {
  assert.deepEqual(ofKind(all(), 'clip-move'), [
    { kind: 'clip-move', step: 4, clipId: 'clp_1', mediaId: 'med_1', fromTrackId: A, trackId: A, from: '0', position: '48000', sourceStart: '0', length: '96000' },
  ]);
});

test('clip.trim: the original and the trimmed box', () => {
  assert.deepEqual(ofKind(all(), 'clip-trim'), [
    { kind: 'clip-trim', step: 5, clipId: 'clp_2', mediaId: 'med_2', trackId: B, position: '96000', from: { sourceStart: '1000', length: '96000' }, to: { sourceStart: '2000', length: '48000' } },
  ]);
});

test('clip.remove and track.remove: the removed clip, the removed track, and its clips under the step entity-homes gives them', () => {
  assert.deepEqual(ofKind(all(), 'clip-remove'), [
    { kind: 'clip-remove', step: 6, clipId: 'clp_4', mediaId: 'med_2', trackId: A, position: '288000', sourceStart: '0', length: '24000', cascade: false },
    { kind: 'clip-remove', step: 7, clipId: 'clp_3', mediaId: 'med_3', trackId: C, position: '48000', sourceStart: '0', length: '48000', cascade: true },
  ]);
  assert.deepEqual(ofKind(all(), 'track-remove'), [{ kind: 'track-remove', step: 7, trackId: C }]);
  // Unticked, the track stays, and so do its clips.
  assert.deepEqual(ofKind(all(without(7)), 'clip-remove').map((g) => g.clipId), ['clp_4']);
  assert.deepEqual(ofKind(all(without(7)), 'track-remove'), []);
});

test('gain: one ghost per step, the old value the one the earlier ticked steps leave', () => {
  assert.deepEqual(ofKind(all(), 'gain'), [
    { kind: 'gain', step: 3, trackId: A, before: -9000, after: -6000 },
    { kind: 'gain', step: 14, trackId: A, before: -6000, after: -3000 },
  ]);
});

test('pan, mute and solo: the old and the new value', () => {
  assert.deepEqual(ofKind(all(), 'pan'), [{ kind: 'pan', step: 8, trackId: A, before: 0, after: -2000 }]);
  assert.deepEqual(ofKind(all(), 'mute'), [{ kind: 'mute', step: 9, trackId: B, before: true, after: false }]);
  assert.deepEqual(ofKind(all(), 'solo'), [{ kind: 'solo', step: 10, trackId: A, before: false, after: true }]);
});

test('rename: both names', () => {
  assert.deepEqual(ofKind(all(), 'rename'), [{ kind: 'rename', step: 11, trackId: B, before: 'Bass', after: 'Bass DI' }]);
});

test('locators: the new range from the step, the old one from the preview\'s locators entity, none allowed', () => {
  assert.deepEqual(ofKind(all(), 'locators'), [
    { kind: 'locators', step: 12, before: { left: '0', right: '96000' }, after: { left: '96000', right: '192000' } },
  ]);
  // A session without locators: before is null.
  const bare = preview();
  const none: PlanPreview = { ...bare, entities: bare.entities.map((e) => (e.ref === 'locators:locators' ? { ...e, before: null } : e)) };
  const snapshot = { ...session(), locators: null };
  assert.deepEqual(ofKind(ghostsOf(STEPS, none, snapshot, null), 'locators'), [{ kind: 'locators', step: 12, before: null, after: { left: '96000', right: '192000' } }]);
});

test('an unticked step contributes none, and only its own', () => {
  const full = all();
  for (let step = 1; step <= STEPS.length; step += 1) {
    const less = all(without(step));
    assert.ok(!less.some((g) => g.step === step), `step ${step} unticked: none of its ghosts`);
  }
  // Unticking step 8 (pan) removes exactly its one ghost.
  assert.deepEqual(all(without(8)), full.filter((g) => g.step !== 8));
  assert.deepEqual(all(new Set()), []);
});

test('values: the preview\'s before with only the ticked steps applied, never after wholesale', () => {
  // Steps 3 and 14 set the gain of A; with 3 unticked, 14 starts from the head (-9000), not from after (-3000).
  assert.deepEqual(ofKind(all(without(3)), 'gain'), [{ kind: 'gain', step: 14, trackId: A, before: -9000, after: -3000 }]);
  // Nothing of after leaks into a before: A's after has pan -2000, its pan ghost starts from 0.
  assert.equal(ofKind(all(), 'pan')[0]!.before, 0);
});

test('the step number is the 1-based index in the full plan, also with an earlier step unticked', () => {
  const less = all(without(1, 2, 3));
  assert.deepEqual(ofKind(less, 'clip-move').map((g) => g.step), [4]);
  assert.deepEqual(ofKind(less, 'rename').map((g) => g.step), [11]);
});

test('no ghost on a track that exists neither in the snapshot nor through a ticked track.add', () => {
  // Step 1 adds trk_new; unticked, the clip placed on it in step 2 has no ghost.
  assert.deepEqual(ofKind(all(without(1)), 'clip-place'), []);
  const strays: ReadonlyArray<Record<string, unknown>> = [
    { op: 'track.set_gain', trackId: 'trk_none', gainMilliDb: -1000 },
    { op: 'clip.place', clipId: 'clp_x', trackId: 'trk_none', mediaId: 'med_1', position: audio('0'), sourceStart: '0', length: '100' },
  ];
  assert.deepEqual(ghostsOf(strays, { ...preview(), entities: [] }, session(), null), []);
});

test('without a preview there are no ghosts', () => {
  assert.deepEqual(ghostsOf(STEPS, null, session(), null), []);
});
