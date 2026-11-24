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

import type { LocatorsEntity, PluginSlotEntity, TrackEntity } from '../../src/renderer/model/document';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { PlanPreview } from '../../src/renderer/plans/diff';
import { busGhosts, ghostsOf, hasStripGhost, masterGhosts, sendGhosts, slotGhosts, type Ghost } from '../../src/renderer/plans/ghosts';
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

test('a cascade stays with the track.remove when entity-homes would home it to an earlier step that only shares its media', () => {
  // Step 1 places a clip of med_3, the removed track's clip's media; step 2 removes the track.
  const steps = [
    { op: 'clip.place', clipId: 'clp_x', trackId: A, mediaId: 'med_3', position: audio('0'), sourceStart: '0', length: '100' },
    { op: 'track.remove', trackId: C },
  ];
  const p = preview();
  const only: PlanPreview = { ...p, entities: p.entities.filter((e) => e.ref === 'clip:clp_3' || e.ref === `track:${C}`) };
  assert.deepEqual(ofKind(ghostsOf(steps, only, session(), null), 'clip-remove').map((g) => [g.clipId, g.step]), [['clp_3', 2]]);
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

// ---- m5b-ui-inserts-master (UI redesign 4.2): the master gain and the insert
// kinds. A session with two slots on A (slt_1 bypassed) and none elsewhere.

const slot = (id: string, trackId: string, name: string, bypass = false): PluginSlotEntity => ({
  schema: 'siann.entity.plugin_slot.v1',
  id,
  trackId,
  format: 'clap',
  uid: `org.test.${id}`,
  name,
  path: `/plugins/${id}.clap`,
  bypass,
});

function rackSession(master: number | null = null): Snapshot {
  const base = session();
  const a = { ...(base.entities[`track:${A}`] as TrackEntity), inserts: ['slt_1', 'slt_2'] };
  const entities: Record<string, unknown> = { ...base.entities, [`track:${A}`]: a, 'plugin_slot:slt_1': slot('slt_1', A, 'Comp', true), 'plugin_slot:slt_2': slot('slt_2', A, 'EQ') };
  if (master !== null) entities['master:master'] = { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb: master };
  return { ...base, entities: entities as Snapshot['entities'] };
}

const RACK_STEPS: ReadonlyArray<Record<string, unknown>> = [
  /* 1 */ { op: 'master.set_gain', gainMilliDb: -3000 },
  /* 2 */ { op: 'plugin.insert', trackId: B, index: 0, slotId: 'slt_9', descriptor: { format: 'clap', uid: 'org.siann.test-plugin', name: 'SIANN Test Plugin', path: '/p/t.clap' }, stateBlob: null },
  /* 3 */ { op: 'plugin.remove', slotId: 'slt_2' },
  /* 4 */ { op: 'plugin.set_bypass', slotId: 'slt_1', bypass: false },
  /* 5 */ { op: 'master.set_gain', gainMilliDb: -6000 },
  /* 6 */ { op: 'track.add', trackId: NEW, name: 'Pad', channels: 2 },
  /* 7 */ { op: 'plugin.insert', trackId: NEW, index: 0, slotId: 'slt_10', descriptor: { format: 'clap', uid: 'org.x', name: 'X' }, stateBlob: null },
  /* 8 */ { op: 'plugin.insert', trackId: A, index: 99, slotId: 'slt_11', descriptor: { format: 'clap', uid: 'org.y' }, stateBlob: null },
];

function rackPreview(masterBefore: Record<string, unknown> | null): PlanPreview {
  const s = rackSession();
  const e = (ref: string) => s.entities[ref] as unknown as Record<string, unknown>;
  return {
    revision: 'r7',
    documentHash: `sha256:${'c'.repeat(64)}`,
    stale: [],
    entities: [
      { ref: 'master:master', before: masterBefore, after: { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb: -6000 } },
      { ref: `track:${B}`, before: e(`track:${B}`), after: { ...e(`track:${B}`), inserts: ['slt_9'] } },
      { ref: 'plugin_slot:slt_9', before: null, after: slot('slt_9', B, 'SIANN Test Plugin') as unknown as Record<string, unknown> },
      { ref: `track:${A}`, before: e(`track:${A}`), after: { ...e(`track:${A}`), inserts: ['slt_1', 'slt_11'] } },
      { ref: 'plugin_slot:slt_2', before: e('plugin_slot:slt_2'), after: null },
      { ref: 'plugin_slot:slt_1', before: e('plugin_slot:slt_1'), after: { ...e('plugin_slot:slt_1'), bypass: false } },
    ],
  };
}

const rack = (ticked: ReadonlySet<number> | null = null, masterBefore: Record<string, unknown> | null = null) => ghostsOf(RACK_STEPS, rackPreview(masterBefore), rackSession(), ticked);
const rackWithout = (...steps: number[]) => new Set(RACK_STEPS.map((_, i) => i).filter((i) => !steps.includes(i + 1)));

test('master.set_gain: before from the preview\'s master:master, or 0 dB while it is absent; two steps chain', () => {
  assert.deepEqual(ofKind(rack(), 'master-gain'), [
    { kind: 'master-gain', step: 1, before: 0, after: -3000 },
    { kind: 'master-gain', step: 5, before: -3000, after: -6000 },
  ]);
  const set = { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb: -1500 };
  assert.deepEqual(ofKind(rack(null, set), 'master-gain').map((g) => g.before), [-1500, -3000]);
  // Step 1 unticked: step 5 starts from the head.
  assert.deepEqual(ofKind(rack(rackWithout(1)), 'master-gain'), [{ kind: 'master-gain', step: 5, before: 0, after: -6000 }]);
  assert.deepEqual(ofKind(rack(rackWithout(1), set), 'master-gain')[0]!.before, -1500);
  // A value that is not a gain gives none.
  assert.deepEqual(ghostsOf([{ op: 'master.set_gain', gainMilliDb: 'loud' }], rackPreview(null), rackSession(), null), []);
});

test('plugin.insert: an insert-add on its track with the slot id, the plugin\'s name and its index (clamped to the end)', () => {
  assert.deepEqual(ofKind(rack(), 'insert-add'), [
    { kind: 'insert-add', step: 2, trackId: B, slotId: 'slt_9', name: 'SIANN Test Plugin', index: 0 },
    // After step 3 removed slt_2, A holds one slot: index 99 clamps to 1; no name: the uid.
    { kind: 'insert-add', step: 8, trackId: A, slotId: 'slt_11', name: 'org.y', index: 1 },
  ]);
  // With step 3 unticked, A still holds two slots.
  assert.equal(ofKind(rack(rackWithout(3)), 'insert-add').find((g) => g.step === 8)?.index, 2);
});

test('plugin.remove: an insert-remove on the slot\'s track', () => {
  assert.deepEqual(ofKind(rack(), 'insert-remove'), [{ kind: 'insert-remove', step: 3, trackId: A, slotId: 'slt_2' }]);
  // An unknown slot gives none.
  assert.deepEqual(ghostsOf([{ op: 'plugin.remove', slotId: 'slt_none' }], rackPreview(null), rackSession(), null), []);
});

test('plugin.set_bypass: an insert-bypass with the old and the new value', () => {
  assert.deepEqual(ofKind(rack(), 'insert-bypass'), [{ kind: 'insert-bypass', step: 4, trackId: A, slotId: 'slt_1', before: true, after: false }]);
});

test('an unticked insert or master step contributes none; an insert on a proposed track yields none', () => {
  const less = rack(rackWithout(2, 3, 4));
  assert.deepEqual(ofKind(less, 'insert-add').map((g) => g.step), [8]);
  assert.deepEqual(ofKind(less, 'insert-remove'), []);
  assert.deepEqual(ofKind(less, 'insert-bypass'), []);
  assert.deepEqual(rack(new Set()), []);
  // Step 7 inserts on the track step 6 proposes: its ghost strip's rack stays empty.
  assert.ok(!ofKind(rack(), 'insert-add').some((g) => g.trackId === NEW));
  assert.deepEqual(ofKind(rack(), 'track-add').map((g) => g.trackId), [NEW]);
});

test('the slot ghosts of a track and the master\'s ghosts, by kind', () => {
  const ghosts = rack();
  const onA = slotGhosts(ghosts, A);
  assert.deepEqual(onA.add.map((g) => g.slotId), ['slt_11']);
  assert.deepEqual(onA.remove.map((g) => g.slotId), ['slt_2']);
  assert.deepEqual(onA.bypass.map((g) => g.slotId), ['slt_1']);
  assert.deepEqual(slotGhosts(ghosts, B).add.map((g) => g.step), [2]);
  assert.deepEqual(masterGhosts(ghosts).map((g) => g.step), [1, 5]);
  for (const step of [1, 2, 3, 4]) assert.equal(hasStripGhost(ghosts, step), true, `step ${step} is on a strip`);
});

// ---- m5b-ui-fades (UI redesign 4.2; 10.11, 23): the kind 'fade'. Its box is
// the clip's as the ticked steps before it leave it (the ghost clip of a
// placed, moved or trimmed clip, else the clip itself); its old fades are the
// preview's before with the ticked steps applied, a ticked clip.trim
// shortening them by the engine's rule (protocol-engine v0, "Clip fades": the
// fade in keeps its length first, the fade out takes the rest, a side
// shortened to 0 is removed); an omitted side is unchanged, "0" removes one.

function fadedSession(): Snapshot {
  const base = session();
  const faded = { ...(base.entities['clip:clp_2'] as ReturnType<typeof clip>), fadeIn: { length: '30000', curve: 'linear' as const }, fadeOut: { length: '40000', curve: 'equal_power' as const } };
  return { ...base, clips: base.clips.map((c) => (c.id === 'clp_2' ? faded : c)), entities: { ...base.entities, 'clip:clp_2': faded } };
}

function fadePreview(snapshot: Snapshot, refs: readonly string[]): PlanPreview {
  const e = (ref: string) => (snapshot.entities[ref] as unknown as Record<string, unknown> | undefined) ?? null;
  return { revision: 'r7', documentHash: `sha256:${'c'.repeat(64)}`, stale: [], entities: refs.map((ref) => ({ ref, before: e(ref), after: e(ref) })) };
}

const FADE_STEPS: ReadonlyArray<Record<string, unknown>> = [
  /* 1 */ { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '4800', curve: 'equal_power' } },
  /* 2 */ { op: 'clip.trim', clipId: 'clp_2', sourceStart: '1000', length: '50000' },
  /* 3 */ { op: 'clip.set_fade', clipId: 'clp_2', fadeOut: { length: '0', curve: 'equal_power' } },
  /* 4 */ { op: 'clip.place', clipId: 'clp_new', trackId: A, mediaId: 'med_1', position: audio('384000'), sourceStart: '0', length: '96000' },
  /* 5 */ { op: 'clip.set_fade', clipId: 'clp_new', fadeIn: { length: '960', curve: 'linear' }, fadeOut: { length: '1920', curve: 'equal_power' } },
  /* 6 */ { op: 'clip.move', clipId: 'clp_1', position: audio('192000') },
  /* 7 */ { op: 'clip.set_fade', clipId: 'clp_1', fadeOut: { length: '2400', curve: 'linear' } },
  /* 8 */ { op: 'clip.set_fade', clipId: 'clp_unknown', fadeIn: { length: '10', curve: 'linear' } },
];

const fades = (ticked: ReadonlySet<number> | null = null) => {
  const s = fadedSession();
  return ofKind(ghostsOf(FADE_STEPS, fadePreview(s, ['clip:clp_1', 'clip:clp_2']), s, ticked), 'fade');
};
const unticked = (...steps: number[]) => new Set(FADE_STEPS.map((_, i) => i).filter((i) => !steps.includes(i + 1)));

test('clip.set_fade: a fade ghost on the clip, its before and after per side; an omitted side is unchanged', () => {
  assert.deepEqual(fades()[0], {
    kind: 'fade',
    step: 1,
    clipId: 'clp_1',
    trackId: A,
    position: '0',
    length: '96000',
    before: { fadeIn: null, fadeOut: null },
    after: { fadeIn: { length: '4800', curve: 'equal_power' }, fadeOut: null },
  });
});

test('after a ticked clip.trim the old fades are shortened by the engine\'s rule; a side set to 0 is removed', () => {
  // clp_2 trimmed to 50000: the fade in keeps 30000, the fade out takes the 20000 left.
  assert.deepEqual(fades()[1], {
    kind: 'fade',
    step: 3,
    clipId: 'clp_2',
    trackId: B,
    position: '96000',
    length: '50000',
    before: { fadeIn: { length: '30000', curve: 'linear' }, fadeOut: { length: '20000', curve: 'equal_power' } },
    after: { fadeIn: { length: '30000', curve: 'linear' }, fadeOut: null },
  });
  // The trim unticked: the clip's own length and fades.
  const own = fades(unticked(2)).find((g) => g.step === 3)!;
  assert.equal(own.length, '96000');
  assert.deepEqual(own.before, { fadeIn: { length: '30000', curve: 'linear' }, fadeOut: { length: '40000', curve: 'equal_power' } });
});

test('on a ticked clip.place\'s clip, and on a moved clip at its new place', () => {
  const placed = fades().find((g) => g.step === 5)!;
  assert.deepEqual(placed, {
    kind: 'fade',
    step: 5,
    clipId: 'clp_new',
    trackId: A,
    position: '384000',
    length: '96000',
    before: { fadeIn: null, fadeOut: null },
    after: { fadeIn: { length: '960', curve: 'linear' }, fadeOut: { length: '1920', curve: 'equal_power' } },
  });
  // clp_1 moved by step 6: step 7's ghost is at 192000, with step 1's fade in as its old one.
  const moved = fades().find((g) => g.step === 7)!;
  assert.equal(moved.position, '192000');
  assert.deepEqual(moved.before, { fadeIn: { length: '4800', curve: 'equal_power' }, fadeOut: null });
  assert.deepEqual(moved.after, { fadeIn: { length: '4800', curve: 'equal_power' }, fadeOut: { length: '2400', curve: 'linear' } });
  // Step 1 unticked: no old fade in; step 6 unticked: the clip where it is.
  assert.deepEqual(fades(unticked(1)).find((g) => g.step === 7)!.before, { fadeIn: null, fadeOut: null });
  assert.equal(fades(unticked(6)).find((g) => g.step === 7)!.position, '0');
});

test('an unticked fade step gives none; a clip neither the snapshot nor a ticked clip.place holds gives none', () => {
  assert.deepEqual(fades().map((g) => g.step), [1, 3, 5, 7]);
  assert.deepEqual(fades(unticked(1, 3)).map((g) => g.step), [5, 7]);
  // The placement unticked: its clip does not exist, so its fade has no ghost.
  assert.deepEqual(fades(unticked(4)).map((g) => g.step), [1, 3, 7]);
  // A fade ghost sits on the clip, not on a strip.
  assert.equal(hasStripGhost(ghostsOf(FADE_STEPS, fadePreview(fadedSession(), []), fadedSession(), null), 1), false);
});

// ---- m5b-ui-sends-buses (UI redesign 4.2; 10.11, 24): the kinds bus-add,
// bus-remove, send-add and send-remove. The first bus.add keeps the id
// strip-bus-ghost (key "bus-ghost"), later ones take -2, -3 in step order; a
// bus.remove dims the bus's strip and the send slots that go with it (the
// bus's sends as the ticked steps before it leave them); a send ghost needs
// its track in the snapshot and its bus in the snapshot or in a ticked
// bus.add. The other bus and send steps get no ghost.

function busSession(): Snapshot {
  const base = session();
  const a = { ...(base.entities[`track:${A}`] as TrackEntity), sends: ['snd_1'] };
  const b = { ...(base.entities[`track:${B}`] as TrackEntity), sends: ['snd_2'] };
  const verb = { schema: 'siann.entity.bus.v1', id: 'bus_v', name: 'Verb', channels: 2, gainMilliDb: 0, pan: 0, mute: false, solo: false };
  const s1 = { schema: 'siann.entity.send.v1', id: 'snd_1', trackId: A, busId: 'bus_v', levelMilliDb: 0, pre: false, enabled: true };
  const s2 = { schema: 'siann.entity.send.v1', id: 'snd_2', trackId: B, busId: 'bus_v', levelMilliDb: -6000, pre: true, enabled: true };
  const root = { ...base.root!, busOrder: ['bus_v'] };
  const entities: Record<string, unknown> = { ...base.entities, 'root:root': root, [`track:${A}`]: a, [`track:${B}`]: b, 'bus:bus_v': verb, 'send:snd_1': s1, 'send:snd_2': s2 };
  return { ...base, root, entities: entities as Snapshot['entities'] };
}

const BUS_STEPS: ReadonlyArray<Record<string, unknown>> = [
  /* 1 */ { op: 'bus.add', busId: 'bus_new', name: 'Delay' },
  /* 2 */ { op: 'send.add', sendId: 'snd_9', trackId: C, busId: 'bus_new', levelMilliDb: 0, pre: false },
  /* 3 */ { op: 'send.add', sendId: 'snd_10', trackId: A, busId: 'bus_v' },
  /* 4 */ { op: 'send.remove', sendId: 'snd_1' },
  /* 5 */ { op: 'bus.add', busId: 'bus_two', name: 'Room' },
  /* 6 */ { op: 'bus.remove', busId: 'bus_v' },
  /* 7 */ { op: 'send.add', sendId: 'snd_11', trackId: NEW, busId: 'bus_new' },
  /* 8 */ { op: 'send.add', sendId: 'snd_12', trackId: A, busId: 'bus_none' },
  /* 9 */ { op: 'bus.set_gain', busId: 'bus_new', gainMilliDb: -3000 },
  /* 10 */ { op: 'send.set_pre', sendId: 'snd_9', pre: true },
  /* 11 */ { op: 'track.set_output', trackId: A, output: { busId: 'bus_new' } },
  /* 12 */ { op: 'track.add', trackId: NEW, name: 'Pad', channels: 2 },
  /* 13 */ { op: 'bus.rename', busId: 'bus_two', name: 'Hall' },
];

function busPreview(): PlanPreview {
  const s = busSession();
  const e = (ref: string) => s.entities[ref] as unknown as Record<string, unknown>;
  return {
    revision: 'r7',
    documentHash: `sha256:${'d'.repeat(64)}`,
    stale: [],
    entities: [
      { ref: 'bus:bus_new', before: null, after: { id: 'bus_new', name: 'Delay' } },
      { ref: 'bus:bus_v', before: e('bus:bus_v'), after: null },
      { ref: 'send:snd_1', before: e('send:snd_1'), after: null },
      { ref: 'send:snd_2', before: e('send:snd_2'), after: null },
    ],
  };
}

const buses = (ticked: ReadonlySet<number> | null = null) => ghostsOf(BUS_STEPS, busPreview(), busSession(), ticked);
const busWithout = (...steps: number[]) => new Set(BUS_STEPS.map((_, i) => i).filter((i) => !steps.includes(i + 1)));

test('bus.add: a dashed strip per proposed bus, the first keyed bus-ghost, later ones -2 in step order', () => {
  assert.deepEqual(ofKind(buses(), 'bus-add'), [
    { kind: 'bus-add', step: 1, busId: 'bus_new', name: 'Delay', key: 'bus-ghost' },
    { kind: 'bus-add', step: 5, busId: 'bus_two', name: 'Room', key: 'bus-ghost-2' },
  ]);
  assert.deepEqual(ofKind(buses(busWithout(1)), 'bus-add').map((g) => [g.busId, g.key]), [['bus_two', 'bus-ghost']]);
});

test('bus.remove: the bus dims, and the send slots its removal takes dim with its step', () => {
  assert.deepEqual(ofKind(buses(), 'bus-remove'), [{ kind: 'bus-remove', step: 6, busId: 'bus_v' }]);
  // snd_1 was removed by step 4: snd_2 and step 3's snd_10 go with the bus, in send id order.
  assert.deepEqual(ofKind(buses(), 'send-remove'), [
    { kind: 'send-remove', step: 4, sendId: 'snd_1', trackId: A, busId: 'bus_v', cascade: false },
    { kind: 'send-remove', step: 6, sendId: 'snd_10', trackId: A, busId: 'bus_v', cascade: true },
    { kind: 'send-remove', step: 6, sendId: 'snd_2', trackId: B, busId: 'bus_v', cascade: true },
  ]);
  // With step 4 unticked, snd_1 goes with the bus too.
  assert.deepEqual(ofKind(buses(busWithout(4)), 'send-remove').map((g) => [g.step, g.sendId]), [[6, 'snd_1'], [6, 'snd_10'], [6, 'snd_2']]);
  assert.deepEqual(ghostsOf([{ op: 'bus.remove', busId: 'bus_x' }], busPreview(), busSession(), null), [], 'an unknown bus');
});

test('send.add: on a track of the snapshot, to a bus of the snapshot or of a ticked bus.add; else none', () => {
  assert.deepEqual(ofKind(buses(), 'send-add'), [
    { kind: 'send-add', step: 2, sendId: 'snd_9', trackId: C, busId: 'bus_new', busName: 'Delay' },
    { kind: 'send-add', step: 3, sendId: 'snd_10', trackId: A, busId: 'bus_v', busName: 'Verb' },
  ]);
  // Step 7 is on a track no snapshot holds (step 12 proposes it later); step 8's bus is nowhere.
  assert.ok(!ofKind(buses(), 'send-add').some((g) => g.step === 7 || g.step === 8));
  // Unticking the bus.add takes its send ghost with it.
  assert.deepEqual(ofKind(buses(busWithout(1)), 'send-add').map((g) => g.step), [3]);
});

test('send.remove: the slot dims; the other bus and send steps get no ghost; untick filters', () => {
  assert.deepEqual(ofKind(buses(busWithout(6)), 'send-remove'), [{ kind: 'send-remove', step: 4, sendId: 'snd_1', trackId: A, busId: 'bus_v', cascade: false }]);
  const kinds = new Set(buses().filter((g) => g.step >= 9 && g.step !== 12).map((g) => g.kind));
  assert.deepEqual([...kinds], [], 'bus.set_gain, send.set_pre, track.set_output, bus.rename: no ghost');
  assert.deepEqual(buses(new Set()), []);
});

test('the bus and send ghosts by owner, and the strip ghosts of their steps', () => {
  const ghosts = buses();
  const onA = sendGhosts(ghosts, A);
  assert.deepEqual(onA.add.map((g) => g.sendId), ['snd_10']);
  assert.deepEqual(onA.remove.map((g) => g.sendId), ['snd_1', 'snd_10']);
  assert.deepEqual(sendGhosts(ghosts, C).add.map((g) => g.step), [2]);
  assert.equal(busGhosts(ghosts, 'bus_v').remove?.step, 6);
  assert.equal(busGhosts(ghosts, 'bus_new').remove, null);
  for (const step of [1, 2, 3, 4, 5, 6]) assert.equal(hasStripGhost(ghosts, step), true, `step ${step} is on a strip`);
  assert.equal(hasStripGhost(ghosts, 9), false);
});
