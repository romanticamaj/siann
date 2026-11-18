// Ghosts while the proposal is heard (m5b-ui-audition; UI redesign 4.3):
// plans/heard-ghosts.ts turns the plan's ghosts (plans/ghosts.ts, dashed) into
// solid ones, with their new values from the branch snapshot (what is
// playing) and the value each replaces (main's, the faint outline) as
// `replaced`. Without a snapshot, or with one of another branch, the
// descriptors come back unchanged (the dashed ghosts of plan.preview). A
// value of a track the snapshot holds that differs from main and that no
// step names (a gesture made while the proposal is heard) is a solid ghost
// without a step number (step 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BranchSnapshot } from '../../src/renderer/model/branch-snapshot';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { heardGhosts } from '../../src/renderer/plans/heard-ghosts';
import { clip, media, snapshotOf, track } from './support/timeline';

const main = snapshotOf(
  ['trk_keys', 'trk_vox'],
  [
    { ...track('trk_keys'), name: 'Keys', gainMilliDb: -9000, pan: -3500 },
    { ...track('trk_vox'), name: 'Vox', gainMilliDb: 0 },
  ],
  [media('med_1', '480000')],
  [clip('clp_1', 'trk_keys', 'med_1', '96000', '0', '96000')],
);

const GHOSTS: readonly Ghost[] = [
  { kind: 'gain', step: 1, trackId: 'trk_keys', before: -9000, after: -6000 },
  { kind: 'pan', step: 2, trackId: 'trk_keys', before: -3500, after: -2000 },
  { kind: 'clip-move', step: 3, clipId: 'clp_1', mediaId: 'med_1', fromTrackId: 'trk_keys', trackId: 'trk_keys', from: '96000', position: '192000', sourceStart: '0', length: '96000' },
  { kind: 'track-add', step: 4, trackId: 'trk_pad', name: 'Pad', channels: 2, key: 'ghost' },
];

function branch(entities: Record<string, object>, name = 'p1'): BranchSnapshot {
  return { branch: name, revision: 'r9', entities: new Map(Object.entries(entities) as Array<[string, Record<string, unknown>]>) };
}

const branchKeys = (gainMilliDb: number, extra: Record<string, unknown> = {}) => ({ ...track('trk_keys'), name: 'Keys', gainMilliDb, pan: -2000, ...extra });

test('without a snapshot the ghosts come back unchanged (dashed)', () => {
  assert.equal(heardGhosts(GHOSTS, null, main), GHOSTS);
  for (const g of heardGhosts(GHOSTS, null, main)) assert.equal(g.mode, undefined);
});

test('with the snapshot every ghost is solid, its value the branch\'s and `replaced` main\'s', () => {
  const out = heardGhosts(GHOSTS, branch({ 'track:trk_keys': branchKeys(-4500), 'clip:clp_1': { ...clip('clp_1', 'trk_keys', 'med_1', '240000', '0', '96000') } }), main);
  assert.equal(out.length, GHOSTS.length);
  for (const g of out) assert.equal(g.mode, 'solid', g.kind);
  const gain = out.find((g) => g.kind === 'gain') as Extract<Ghost, { kind: 'gain' }>;
  assert.equal(gain.step, 1);
  assert.equal(gain.after, -4500, 'the branch value (a gesture moved it past the step\'s)');
  assert.equal(gain.replaced, -9000, 'main\'s value is the outline');
  const pan = out.find((g) => g.kind === 'pan') as Extract<Ghost, { kind: 'pan' }>;
  assert.equal(pan.after, -2000);
  assert.equal(pan.replaced, -3500);
  const move = out.find((g) => g.kind === 'clip-move') as Extract<Ghost, { kind: 'clip-move' }>;
  assert.equal(move.position, '240000', 'the clip where the branch has it');
  assert.equal(move.from, '96000');
  const add = out.find((g) => g.kind === 'track-add')!;
  assert.equal(add.mode, 'solid');
});

test('a field the snapshot does not hold keeps the step\'s value, solid', () => {
  const out = heardGhosts(GHOSTS, branch({}), main);
  const gain = out.find((g) => g.kind === 'gain') as Extract<Ghost, { kind: 'gain' }>;
  assert.equal(gain.mode, 'solid');
  assert.equal(gain.after, -6000);
  assert.equal(gain.replaced, -9000);
});

test('a branch value no step names is a solid ghost without a step number', () => {
  const out = heardGhosts(GHOSTS, branch({ 'track:trk_keys': branchKeys(-6000), 'track:trk_vox': { ...track('trk_vox'), name: 'Vox', gainMilliDb: -2500, mute: true } }), main);
  const vox = out.filter((g) => 'trackId' in g && g.trackId === 'trk_vox');
  assert.deepEqual(
    vox.map((g) => [g.kind, g.step, (g as { after: unknown }).after, g.replaced, g.mode]),
    [
      ['gain', 0, -2500, 0, 'solid'],
      ['mute', 0, true, false, 'solid'],
    ],
  );
  // A field a step names gets no second ghost; a value equal to main's gets none.
  assert.equal(out.filter((g) => g.kind === 'gain' && g.trackId === 'trk_keys').length, 1);
  assert.equal(out.filter((g) => g.kind === 'solo').length, 0);
});

test('a track main does not hold (a proposed track) adds no un-numbered ghost', () => {
  const out = heardGhosts(GHOSTS, branch({ 'track:trk_pad': { ...track('trk_pad'), name: 'Pad', gainMilliDb: -1000 } }), main);
  assert.equal(out.filter((g) => g.step === 0).length, 0);
});

// m5b-ui-inserts-master's ghosts while heard: the master gain takes the
// branch's value where the snapshot holds master:master, main's as replaced;
// the insert ghosts are solid as they are.
test('the master gain and the insert ghosts are solid while heard', () => {
  const ghosts: readonly Ghost[] = [
    { kind: 'master-gain', step: 1, before: 0, after: -6000 },
    { kind: 'insert-add', step: 2, trackId: 'trk_keys', slotId: null, name: 'Limiter', index: 0 },
    { kind: 'insert-remove', step: 3, trackId: 'trk_keys', slotId: 'slt_1' },
    { kind: 'insert-bypass', step: 4, trackId: 'trk_keys', slotId: 'slt_2', before: false, after: true },
  ];
  const mainWithMaster = { ...main, entities: { ...main.entities, 'master:master': { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb: -1000 } } } as unknown as typeof main;
  const out = heardGhosts(ghosts, branch({ 'master:master': { id: 'master', gainMilliDb: -4500 } }), mainWithMaster);
  assert.deepEqual(out.map((g) => [g.kind, g.mode]), [['master-gain', 'solid'], ['insert-add', 'solid'], ['insert-remove', 'solid'], ['insert-bypass', 'solid']]);
  const master = out[0] as Extract<Ghost, { kind: 'master-gain' }>;
  assert.equal(master.after, -4500);
  assert.equal(master.replaced, -1000);
  // Without the entity on either side: the step's values.
  const plain = heardGhosts(ghosts, branch({}), main)[0] as Extract<Ghost, { kind: 'master-gain' }>;
  assert.equal(plain.after, -6000);
  assert.equal(plain.replaced, 0);
});
