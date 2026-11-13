// A plan card (m5-ui-plan-panel; UI redesign 4.5 C1 and C6, P1-5): the lead
// is the first step in user wording, then the step count, a relative time
// (when this renderer first learnt of the plan, else rejectedAt or approvedAt,
// else none), the state badge and the short hash. A rejected parent of a
// partial approval reads "Split, N of M approved" instead of the engine's own
// note; another rejection shows its note; a sub-plan names its parent. A stale
// plan's reason is in user units, from plan.preview's before (the head) and
// session.fetch at the plan's base revision; never an id or a raw value.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMilliDb } from '../../src/renderer/format';
import { relativeTime, translator } from '../../src/renderer/i18n/t';
import { LOCALES } from '../../src/renderer/i18n/locale';
import { planEntry, type PlanEntry } from '../../src/renderer/model/plan-store';
import { cardOf, staleReasons } from '../../src/renderer/plans/card';
import type { StepNames } from '../../src/renderer/plans/describe';

const H = (digit: string) => 'sha256:' + digit.repeat(64);
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

const NAMES: StepNames = {
  track: (id) => ({ trk_keys: 'Keys', trk_vox: 'Vox Lead' } as Record<string, string>)[id],
  clip: (id) => ({ clp_k: { trackId: 'trk_keys', position: '48000' } } as Record<string, { trackId: string; position: string }>)[id],
  slot: () => undefined,
  sampleRate: 48000,
};

function plan(hash: string, state: string, extra: Record<string, unknown> = {}): PlanEntry {
  return planEntry({
    schema: 'siann.plan.v1',
    hash,
    state,
    baseRevision: 'r4',
    steps: [
      { op: 'track.set_gain', trackId: 'trk_keys', gainMilliDb: -3000 },
      { op: 'track.set_pan', trackId: 'trk_keys', pan: -2000 },
      { op: 'track.set_mute', trackId: 'trk_vox', mute: true },
      { op: 'track.set_solo', trackId: 'trk_vox', solo: false },
      { op: 'track.rename', trackId: 'trk_vox', name: 'Vox' },
    ],
    readSet: [],
    writeSet: [],
    stale: [],
    ...extra,
  })!;
}

test('a card leads with its first step, counts the steps, and shows the time, badge and short hash', () => {
  const fresh = plan(H('1'), 'validated');
  const card = cardOf(fresh, [fresh], 'main', NOW, NOW - 5 * 60_000, 'en', NAMES);
  assert.equal(card.lead, `Set Keys volume to ${formatMilliDb(-3000)}`);
  assert.equal(card.stepCount, 5);
  assert.equal(card.steps, '5 steps');
  assert.equal(card.time, relativeTime(NOW - 5 * 60_000, NOW, 'en'));
  assert.equal(card.time, '5 minutes ago');
  assert.equal(card.badge, 'needsReview');
  assert.equal(card.shortHash, '11111111');
  assert.equal(card.stale, false);
  assert.equal(card.split, null);
  assert.equal(card.reason, null);
  assert.equal(card.partOf, null);
});

test('the time falls back to rejectedAt or approvedAt, and is absent otherwise', () => {
  const approved = plan(H('2'), 'approved', { approvedAt: '2026-11-14T11:00:00Z' });
  assert.equal(cardOf(approved, [approved], 'main', NOW, undefined, 'en', NAMES).time, '1 hour ago');
  const rejected = plan(H('3'), 'rejected', { approvedAt: '2026-11-14T10:00:00Z', rejectedAt: '2026-11-14T11:58:00Z', rejectionNote: 'no' });
  assert.equal(cardOf(rejected, [rejected], 'main', NOW, undefined, 'en', NAMES).time, '2 minutes ago');
  const applied = plan(H('4'), 'applied');
  assert.equal(cardOf(applied, [applied], 'main', NOW, undefined, 'en', NAMES).time, null);
  // firstSeen wins over the lifecycle times.
  assert.equal(cardOf(approved, [approved], 'main', NOW, NOW - 30_000, 'en', NAMES).time, '30 seconds ago');
  // A clock read before the plan arrived never reads as the future.
  assert.equal(cardOf(approved, [approved], 'main', NOW, NOW + 6_000, 'en', NAMES).time, 'now');
});

test('badges per state; an approved plan with a proposal branch is approved for audition', () => {
  const cases: Array<[PlanEntry, string]> = [
    [plan(H('1'), 'validated'), 'needsReview'],
    [plan(H('1'), 'approved'), 'approved'],
    [plan(H('1'), 'approved', { proposalBranch: 'p1' }), 'approvedForAudition'],
    [plan(H('1'), 'rejected'), 'rejected'],
    [plan(H('1'), 'applied'), 'applied'],
    [plan(H('1'), 'rolled_back'), 'rolledBack'],
  ];
  for (const [entry, badge] of cases) assert.equal(cardOf(entry, [entry], 'main', NOW, undefined, 'en', NAMES).badge, badge, entry.state);
  const stale = plan(H('1'), 'approved', { stale: [{ ref: 'track:trk_keys', change: 'modified' }] });
  const card = cardOf(stale, [stale], 'main', NOW, undefined, 'en', NAMES);
  assert.equal(card.stale, true);
  assert.equal(card.badge, 'approved', 'a stale approved plan keeps its Approved badge (C6)');
  const t = translator('en');
  assert.equal(t('badge.approvedForAudition'), 'Approved for audition');
  assert.equal(t('badge.needsReview'), 'Needs review');
  assert.equal(t('badge.stale'), 'Stale');
});

test('a split parent reads "Split, N of M approved"; another rejection shows its note; a sub-plan names its parent', () => {
  const parent = plan(H('5'), 'rejected', { rejectionNote: `partially approved as ${H('6')}` });
  const child = planEntry({
    schema: 'siann.plan.v1',
    hash: H('6'),
    state: 'approved',
    baseRevision: 'r4',
    parentPlan: H('5'),
    steps: [
      { op: 'track.set_gain', trackId: 'trk_keys', gainMilliDb: -3000 },
      { op: 'track.set_mute', trackId: 'trk_vox', mute: true },
      { op: 'track.rename', trackId: 'trk_vox', name: 'Vox' },
    ],
    readSet: [],
    writeSet: [],
    stale: [],
  })!;
  const all = [parent, child];
  const split = cardOf(parent, all, 'main', NOW, undefined, 'en', NAMES);
  assert.equal(split.split, 'Split, 3 of 5 approved');
  assert.equal(split.reason, null, "the engine's own note is not shown");
  const sub = cardOf(child, all, 'main', NOW, undefined, 'en', NAMES);
  assert.equal(sub.partOf, '(part of 55555555)');
  assert.equal(sub.split, null);

  const refused = plan(H('7'), 'rejected', { rejectionNote: 'Keep the FX riser' });
  const card = cardOf(refused, [refused, child], 'main', NOW, undefined, 'en', NAMES);
  assert.equal(card.reason, 'Keep the FX riser');
  assert.equal(card.split, null);
  for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
    const text = cardOf(parent, all, 'main', NOW, undefined, locale, NAMES).split!;
    assert.ok(text.includes('3') && text.includes('5') && /\p{Script=Han}/u.test(text), `${locale}: ${text}`);
  }
});

const track = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  schema: 'siann.entity.track.v1',
  id,
  name,
  kind: 'audio',
  channels: 2,
  gainMilliDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  ...extra,
});

test('stale reasons are in user units', () => {
  const stalePlan = plan(H('8'), 'validated', {
    stale: [
      { ref: 'track:trk_vox', change: 'modified' },
      { ref: 'track:trk_keys', change: 'removed' },
      { ref: 'track:trk_pad', change: 'added' },
      { ref: 'clip:clp_k', change: 'modified' },
      { ref: 'plugin_slot:slt_1', change: 'modified' },
    ],
  });
  const head = new Map<string, Record<string, unknown> | null>([
    ['track:trk_vox', track('trk_vox', 'Vox Lead', { gainMilliDb: 500, pan: 0, mute: true })],
    ['track:trk_keys', null],
    ['track:trk_pad', track('trk_pad', 'Pad')],
  ]);
  const base = new Map<string, Record<string, unknown> | null>([
    ['track:trk_vox', track('trk_vox', 'Vox Lead', { gainMilliDb: 1500, pan: -2000, mute: false })],
    ['track:trk_keys', track('trk_keys', 'Keys')],
  ]);
  const reasons = staleReasons(stalePlan, head, base, 'en', NAMES);
  assert.deepEqual(reasons, [
    `Vox Lead: volume was ${formatMilliDb(1500)}, now ${formatMilliDb(500)}`,
    'Vox Lead: pan was L20, now C',
    'Vox Lead: mute was off, now on',
    'Keys was removed',
    'Pad was added',
    'A clip on Keys changed since the plan was made',
    'Something this plan changes was changed since the plan was made',
  ]);
  // session.fetch at the base revision refused: the current value, no "was".
  const fallback = staleReasons(stalePlan, head, null, 'en', NAMES);
  assert.equal(fallback[0], `Vox Lead changed since the plan was made: now volume ${formatMilliDb(500)}, pan C`);
  for (const locale of LOCALES) {
    for (const text of [...staleReasons(stalePlan, head, base, locale, NAMES), ...staleReasons(stalePlan, head, null, locale, NAMES)]) {
      assert.ok(!/trk_|clp_|med_|slt_|\d{4,}/.test(text), `${locale}: ${text}`);
    }
  }
});
