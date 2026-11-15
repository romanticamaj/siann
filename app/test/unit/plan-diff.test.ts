// The plan review's diff and step list (m5-plan-review; spec "Frontend", plan
// review; docs/schemas/plan-v1.md, plan.preview): rows from a plan.preview
// answer, stale marks from plan.status, and the partial-approval selection
// (step wording: i18n-describe.test.ts; dB: i18n-format.test.ts). Pure functions over protocol answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffRows,
  rowChanges,
  rowLabel,
  selection,
  type PlanPreview,
} from '../../src/renderer/plans/diff';
import { NO_NAMES } from '../../src/renderer/plans/describe';
import { translator } from '../../src/renderer/i18n/t';

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

test('Approve selected is enabled only for a non-empty proper subset and yields sorted indexes', () => {
  assert.deepEqual(selection(new Set(), 3), { canApproveSelected: false, steps: [] });
  assert.deepEqual(selection(new Set([2, 0]), 3), { canApproveSelected: true, steps: [0, 2] });
  assert.deepEqual(selection(new Set([0, 1, 2]), 3), { canApproveSelected: false, steps: [0, 1, 2] });
  assert.deepEqual(selection(new Set([0]), 1), { canApproveSelected: false, steps: [0] });
  // Indexes outside the plan are ignored.
  assert.deepEqual(selection(new Set([1, 5]), 2), { canApproveSelected: true, steps: [1] });
});

// m5b-engine-buses-sends: plan.preview rows for a bus and a send are labelled and
// worded with the fields a user knows (a bus by its name, its fader like a
// track's; a send's level as a volume).
test('bus and send rows are labelled and their fader fields worded', () => {
  const t = translator('en');
  const bus = { id: 'b1', name: 'Reverb', channels: 2, gainMilliDb: 0, pan: 0, mute: false, solo: false };
  const send = { id: 's1', trackId: 'trk_a', busId: 'b1', levelMilliDb: 0, pre: false, enabled: true };
  const rows = diffRows({
    revision: 'r4',
    documentHash: 'sha256:' + 'e'.repeat(64),
    stale: [],
    entities: [
      { ref: 'bus:b1', before: bus, after: { ...bus, gainMilliDb: -6000, mute: true, pan: 2500 } },
      { ref: 'send:s1', before: send, after: { ...send, levelMilliDb: -3000 } },
    ],
  });
  const busRow = rows.find((r) => r.ref === 'bus:b1')!;
  const sendRow = rows.find((r) => r.ref === 'send:s1')!;
  assert.equal(rowLabel(busRow, NO_NAMES, t), 'Reverb');
  const busLines = rowChanges(busRow, NO_NAMES, t);
  assert.equal(busLines.length, 3);
  assert.ok(!busLines.includes(t('diff.field.other')));
  const sendLines = rowChanges(sendRow, NO_NAMES, t);
  assert.deepEqual(sendLines, [t('diff.field.volume', { before: '0.00 dB', after: '-3.00 dB' })]);
});
