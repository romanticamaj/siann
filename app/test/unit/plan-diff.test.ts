// The plan review's diff and step list (m5-plan-review; spec "Frontend", plan
// review; docs/schemas/plan-v1.md, plan.preview): rows from a plan.preview
// answer, stale marks from plan.status, one-line step summaries, and the
// partial-approval selection. Pure functions over protocol answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffRows,
  formatMilliDb,
  selection,
  stepSummary,
  type PlanPreview,
} from '../../src/renderer/plans/diff';

const track = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  channels: 2,
  gainMilliDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  inserts: [],
  ...extra,
});

const preview: PlanPreview = {
  revision: 'r3',
  documentHash: 'sha256:' + 'd'.repeat(64),
  stale: [],
  entities: [
    { ref: 'root:root', before: { id: 'root', name: 'Song', trackOrder: ['trk_a'] }, after: { id: 'root', name: 'Song', trackOrder: ['trk_a', 'trk_new'] } },
    { ref: 'track:trk_a', before: track('trk_a'), after: track('trk_a', { gainMilliDb: -600 }) },
    { ref: 'track:trk_new', before: null, after: track('trk_new') },
    { ref: 'track:trk_old', before: track('trk_old'), after: null },
    { ref: 'track:trk_same', before: track('trk_same'), after: track('trk_same') },
  ],
};

test('rows are added, removed, modified with the changed fields, or unchanged', () => {
  const rows = diffRows(preview);
  assert.deepEqual(
    rows.map((r) => [r.ref, r.kind, r.fields]),
    [
      ['root:root', 'modified', ['trackOrder']],
      ['track:trk_a', 'modified', ['gainMilliDb']],
      ['track:trk_new', 'added', []],
      ['track:trk_old', 'removed', []],
      ['track:trk_same', 'unchanged', []],
    ],
  );
  const gain = rows[1]!;
  assert.equal(gain.before, preview.entities[1]!.before);
  assert.equal(gain.after, preview.entities[1]!.after);
  assert.deepEqual(gain.changes, [{ field: 'gainMilliDb', before: 0, after: -600 }]);
  assert.deepEqual(rows[0]!.changes, [{ field: 'trackOrder', before: ['trk_a'], after: ['trk_a', 'trk_new'] }]);
  assert.ok(rows.every((r) => !r.stale));
});

test('stale rows come from plan.status stale, also for a ref the preview lacks', () => {
  const rows = diffRows(preview, [
    { ref: 'track:trk_a', change: 'modified' },
    { ref: 'track:trk_gone', change: 'removed' },
  ]);
  assert.deepEqual(
    rows.filter((r) => r.stale).map((r) => [r.ref, r.staleChange]),
    [
      ['track:trk_a', 'modified'],
      ['track:trk_gone', 'removed'],
    ],
  );
  const extra = rows.find((r) => r.ref === 'track:trk_gone')!;
  assert.equal(extra.kind, 'unchanged');
  assert.equal(extra.before, null);
});

test('formatMilliDb prints decibels with two decimals (the gain is in milli-dB)', () => {
  assert.equal(formatMilliDb(-600), '-0.60 dB');
  assert.equal(formatMilliDb(-6000), '-6.00 dB');
  assert.equal(formatMilliDb(0), '0.00 dB');
  assert.equal(formatMilliDb(1250), '+1.25 dB');
  assert.equal(formatMilliDb(-2147483648), '-inf dB');
});

test('step summaries name what each op does', () => {
  const names = (id: string) => (id === 'trk_a' ? 'Lead' : undefined);
  assert.equal(stepSummary({ op: 'track.add', trackId: 'trk_b', name: 'Bass', channels: 2 }, names), 'Add track Bass');
  assert.equal(
    stepSummary({ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -6000 }, names),
    'Set gain of Lead to -6.00 dB',
  );
  assert.equal(stepSummary({ op: 'track.set_gain', trackId: 'trk_x', gainMilliDb: -600 }, names), 'Set gain of trk_x to -0.60 dB');
  assert.equal(stepSummary({ op: 'track.remove', trackId: 'trk_a' }, names), 'Remove track Lead');
  assert.equal(stepSummary({ op: 'track.set_mute', trackId: 'trk_a', mute: true }, names), 'Mute Lead');
  assert.equal(stepSummary({ op: 'track.set_pan', trackId: 'trk_a', pan: -2500 }, names), 'Set pan of Lead to -2500');
  // Anything else shows its op and parameters.
  assert.equal(stepSummary({ op: 'clip.remove', clipId: 'clp_1' }, names), 'clip.remove {"clipId":"clp_1"}');
});

test('Approve selected is enabled only for a non-empty proper subset and yields sorted indexes', () => {
  assert.deepEqual(selection(new Set(), 3), { canApproveSelected: false, steps: [] });
  assert.deepEqual(selection(new Set([2, 0]), 3), { canApproveSelected: true, steps: [0, 2] });
  assert.deepEqual(selection(new Set([0, 1, 2]), 3), { canApproveSelected: false, steps: [0, 1, 2] });
  assert.deepEqual(selection(new Set([0]), 1), { canApproveSelected: false, steps: [0] });
  // Indexes outside the plan are ignored.
  assert.deepEqual(selection(new Set([1, 5]), 2), { canApproveSelected: true, steps: [1] });
});
