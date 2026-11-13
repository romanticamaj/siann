// The Plans tab's actions (m5-ui-plan-panel; spec "Frontend", plan review;
// UI redesign 4.5 C4): per plan state the action set has one primary and the
// secondary actions, and nothing else; a valid action that cannot run now
// (stale plan, nothing ticked) is in the set but disabled with its reason.
// "Approve and apply" and "Audition" are chains of today's methods: each stops
// at the first refusal, reports where (failedAt) and what the engine reached
// (reached), and retries nothing. The plan's state is left to plan.changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProtocolError } from '../../src/renderer/model/session-client';
import type { PlanEntry } from '../../src/renderer/model/plan-store';
import { translator } from '../../src/renderer/i18n/t';
import {
  actionLabel,
  actionSet,
  landedLabel,
  runAction,
  type ActionClient,
  type ActionId,
  type ActionSet,
  type PlanAction,
} from '../../src/renderer/plans/actions';
import { selection } from '../../src/renderer/plans/diff';

const PLAN = 'sha256:' + '1'.repeat(64);
const SUB = 'sha256:' + '5'.repeat(64);

type Sent = { method: string; params: Record<string, unknown> };

class FakeActionClient implements ActionClient {
  readonly sent: Sent[] = [];
  constructor(private readonly answer: (method: string, params: Record<string, unknown>, index: number) => unknown = () => ({})) {}
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const index = this.sent.length;
    this.sent.push({ method, params });
    try {
      return Promise.resolve(this.answer(method, params, index));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

const entry = (
  state: PlanEntry['state'],
  extra: { proposalBranch?: string; appliedRevision?: string; stale?: boolean; steps?: number } = {},
): PlanEntry => ({
  hash: PLAN,
  state,
  steps: Array.from({ length: extra.steps ?? 5 }, (_, i) => ({ op: 'track.set_mute', trackId: 'trk_a', mute: i % 2 === 0 })),
  stale: extra.stale ? [{ ref: 'track:trk_a', change: 'modified' }] : [],
  ...(extra.proposalBranch ? { proposalBranch: extra.proposalBranch } : {}),
  ...(extra.appliedRevision ? { appliedRevision: extra.appliedRevision } : {}),
  raw: {},
});

const ALL = selection(new Set([0, 1, 2, 3, 4]), 5);
const SUBSET = selection(new Set([0, 1, 3]), 5);
const NONE = selection(new Set(), 5);

// The ids in display order: primary first.
function ids(set: ActionSet): ActionId[] {
  return [...(set.primary ? [set.primary.id] : []), ...set.secondary.map((a) => a.id)];
}

function disabled(set: ActionSet): Record<string, string> {
  return Object.fromEntries(set.disabled);
}

test('the action set per state: one primary, the secondary actions, nothing else', () => {
  const cases: Array<[string, ActionSet, ActionId[], Record<string, string>]> = [
    ['validated fresh, all ticked', actionSet(entry('validated'), 'main', ALL), ['approveApply', 'audition', 'reject'], {}],
    ['validated, heard unknown', actionSet(entry('validated'), null, ALL), ['approveApply', 'reject'], {}],
    ['validated, subset', actionSet(entry('validated'), 'main', SUBSET), ['approveApply', 'audition', 'reject'], {}],
    [
      'validated, none ticked',
      actionSet(entry('validated'), 'main', NONE),
      ['approveApply', 'audition', 'reject'],
      { approveApply: 'noneTicked', audition: 'noneTicked' },
    ],
    [
      'validated stale',
      actionSet(entry('validated', { stale: true }), 'main', ALL),
      ['approveApply', 'audition', 'reject'],
      { approveApply: 'stale', audition: 'stale' },
    ],
    ['approved', actionSet(entry('approved'), 'main', ALL), ['apply', 'audition', 'reject'], {}],
    ['approved, heard unknown', actionSet(entry('approved'), null, ALL), ['apply', 'reject'], {}],
    [
      'approved stale',
      actionSet(entry('approved', { stale: true }), 'main', ALL),
      ['apply', 'audition', 'reject'],
      { apply: 'stale', audition: 'stale' },
    ],
    ['proposed, branch heard', actionSet(entry('approved', { proposalBranch: 'p1' }), 'p1', ALL), ['merge', 'hearMain', 'discard'], {}],
    ['proposed, main heard', actionSet(entry('approved', { proposalBranch: 'p1' }), 'main', ALL), ['merge', 'hearProposal', 'discard'], {}],
    ['proposed, another branch heard', actionSet(entry('approved', { proposalBranch: 'p1' }), 'p2', ALL), ['merge', 'hearProposal', 'discard'], {}],
    ['proposed, heard unknown', actionSet(entry('approved', { proposalBranch: 'p1' }), null, ALL), ['merge', 'discard'], {}],
  ];
  for (const [name, set, expected, reasons] of cases) {
    assert.deepEqual(ids(set), expected, name);
    assert.deepEqual(disabled(set), reasons, name);
    assert.ok(set.primary !== null, `${name}: one primary`);
    assert.ok(!set.secondary.some((a) => a.id === set.primary!.id), `${name}: the primary is not repeated`);
    for (const id of set.disabled.keys()) assert.ok(expected.includes(id), `${name}: ${id} is disabled but not in the set`);
  }
  for (const state of ['rejected', 'applied', 'rolled_back', 'draft'] as const) {
    const set = actionSet(entry(state), 'main', ALL);
    assert.equal(set.primary, null, state);
    assert.deepEqual(set.secondary, [], state);
    assert.equal(set.disabled.size, 0, state);
  }
});

test('the primary carries the ticked subset and reads "Approve N of M"; all ticked is the whole plan', () => {
  const t = translator('en');
  const whole = actionSet(entry('validated'), 'main', ALL);
  assert.equal(whole.primary!.steps, undefined, 'the whole plan: no steps sent');
  assert.equal(actionLabel(whole.primary!, 5, t), 'Approve and apply');
  const part = actionSet(entry('validated'), 'main', SUBSET);
  assert.deepEqual(part.primary!.steps, [0, 1, 3]);
  assert.equal(actionLabel(part.primary!, 5, t), 'Approve 3 of 5');
  assert.deepEqual(part.secondary.find((a) => a.id === 'audition')!.steps, [0, 1, 3], 'Audition approves the same subset');
  assert.equal(actionLabel({ id: 'audition' }, 5, t), 'Audition');
  assert.equal(actionLabel({ id: 'hearMain' }, 5, t), 'Hear main');
  for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
    const label = actionLabel(part.primary!, 5, translator(locale));
    assert.ok(label.includes('3') && label.includes('5') && /\p{Script=Han}/u.test(label), `${locale}: ${label}`);
  }
});

const refusal = (code = 'invalid_state') => new ProtocolError(code, `refused: ${code}`);

// Plays the engine: answers by method, refusing the request at `refuseAt` (0-based).
function engine(refuseAt: number | null, answers: Record<string, unknown> = {}) {
  return new FakeActionClient((method, _params, index) => {
    if (index === refuseAt) throw refusal(method === 'audition.hear' ? 'audition_budget_exceeded' : 'invalid_state');
    if (method in answers) return answers[method];
    if (method === 'plan.propose') return { branch: 'p4', revision: { id: 'r5' } };
    return {};
  });
}

test('Approve and apply: plan.approve then plan.apply; a refusal stops the chain where it happened', async () => {
  const expected: Sent[] = [
    { method: 'plan.approve', params: { plan: PLAN } },
    { method: 'plan.apply', params: { plan: PLAN } },
  ];
  const ok = engine(null);
  const done = await runAction(ok, { kind: 'approveApply', plan: PLAN });
  assert.equal(done.ok, true);
  assert.equal(done.failedAt, null);
  assert.equal(done.reached, 'applied');
  assert.deepEqual(ok.sent, expected);

  const first = engine(0);
  const atApprove = await runAction(first, { kind: 'approveApply', plan: PLAN });
  assert.equal(atApprove.ok, false);
  assert.equal(atApprove.failedAt, 'plan.approve');
  assert.equal(atApprove.reached, null);
  assert.deepEqual(first.sent, expected.slice(0, 1), 'nothing else sent');

  const second = engine(1);
  const atApply = await runAction(second, { kind: 'approveApply', plan: PLAN });
  assert.equal(atApply.ok, false);
  if (atApply.ok) return;
  assert.equal(atApply.failedAt, 'plan.apply');
  assert.equal(atApply.reached, 'approved', 'the plan stays approved');
  assert.equal(atApply.code, 'invalid_state');
  assert.deepEqual(second.sent, expected, 'no retry');
});

test('Approve N of M: plan.approve {steps}, then plan.apply of the sub-plan the answer names', async () => {
  const answers = { 'plan.approve': { schema: 'siann.plan.v1', hash: SUB, state: 'approved', parentPlan: PLAN } };
  const expected: Sent[] = [
    { method: 'plan.approve', params: { plan: PLAN, steps: [0, 1, 3] } },
    { method: 'plan.apply', params: { plan: SUB } },
  ];
  const ok = engine(null, answers);
  const done = await runAction(ok, { kind: 'approveApply', plan: PLAN, steps: [0, 1, 3] });
  assert.equal(done.ok, true);
  assert.equal(done.plan, SUB, 'the outcome names the plan the chain ended on');
  assert.deepEqual(ok.sent, expected);

  for (const [at, failedAt, reached] of [
    [0, 'plan.approve', null],
    [1, 'plan.apply', 'approved'],
  ] as const) {
    const client = engine(at, answers);
    const outcome = await runAction(client, { kind: 'approveApply', plan: PLAN, steps: [0, 1, 3] });
    assert.equal(outcome.ok, false, `refused at ${at}`);
    assert.equal(outcome.failedAt, failedAt);
    assert.equal(outcome.reached, reached);
    assert.deepEqual(client.sent, expected.slice(0, at + 1));
  }

  // An approve answer without a hash: nothing to apply.
  const nameless = engine(null, { 'plan.approve': { state: 'approved' } });
  const broken = await runAction(nameless, { kind: 'approveApply', plan: PLAN, steps: [0] });
  assert.equal(broken.ok, false);
  if (broken.ok) return;
  assert.equal(broken.code, 'internal_error');
  assert.equal(broken.failedAt, 'plan.approve');
  assert.deepEqual(nameless.sent.map((s) => s.method), ['plan.approve'], 'plan.apply is not sent');
});

test('Audition from a validated plan: approve, propose, hear; a refusal at each position', async () => {
  const expected: Sent[] = [
    { method: 'plan.approve', params: { plan: PLAN } },
    { method: 'plan.propose', params: { plan: PLAN } },
    { method: 'audition.hear', params: { side: 'p4' } },
  ];
  const ok = engine(null);
  const done = await runAction(ok, { kind: 'audition', plan: PLAN, approved: false });
  assert.equal(done.ok, true);
  assert.equal(done.reached, 'proposed');
  assert.deepEqual(ok.sent, expected);
  for (const [at, failedAt, reached] of [
    [0, 'plan.approve', null],
    [1, 'plan.propose', 'approved'],
    [2, 'audition.hear', 'proposed'],
  ] as const) {
    const client = engine(at);
    const outcome = await runAction(client, { kind: 'audition', plan: PLAN, approved: false });
    assert.equal(outcome.ok, false, `refused at ${at}`);
    assert.equal(outcome.failedAt, failedAt, `refused at ${at}`);
    assert.equal(outcome.reached, reached, `refused at ${at}`);
    assert.deepEqual(client.sent, expected.slice(0, at + 1), `refused at ${at}`);
  }

  // With a subset ticked the propose targets the sub-plan.
  const sub = engine(null, { 'plan.approve': { hash: SUB, state: 'approved', parentPlan: PLAN } });
  await runAction(sub, { kind: 'audition', plan: PLAN, steps: [0, 2], approved: false });
  assert.deepEqual(sub.sent, [
    { method: 'plan.approve', params: { plan: PLAN, steps: [0, 2] } },
    { method: 'plan.propose', params: { plan: SUB } },
    { method: 'audition.hear', params: { side: 'p4' } },
  ]);
});

test('Audition from an approved plan: propose, hear; a refusal at each position', async () => {
  const expected: Sent[] = [
    { method: 'plan.propose', params: { plan: PLAN } },
    { method: 'audition.hear', params: { side: 'p4' } },
  ];
  const ok = engine(null);
  assert.equal((await runAction(ok, { kind: 'audition', plan: PLAN, approved: true })).ok, true);
  assert.deepEqual(ok.sent, expected);
  for (const [at, failedAt, reached] of [
    [0, 'plan.propose', 'approved'],
    [1, 'audition.hear', 'proposed'],
  ] as const) {
    const client = engine(at);
    const outcome = await runAction(client, { kind: 'audition', plan: PLAN, approved: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failedAt, failedAt);
    assert.equal(outcome.reached, reached);
    assert.deepEqual(client.sent, expected.slice(0, at + 1));
  }
  // A propose answer without a branch: nothing to hear.
  const nameless = engine(null, { 'plan.propose': { revision: { id: 'r5' } } });
  const broken = await runAction(nameless, { kind: 'audition', plan: PLAN, approved: true });
  assert.equal(broken.ok, false);
  assert.equal(broken.ok ? null : broken.code, 'internal_error');
  assert.deepEqual(nameless.sent.map((s) => s.method), ['plan.propose']);
});

test('single-request actions map to their protocol request', async () => {
  const cases: Array<[PlanAction, Sent]> = [
    [{ kind: 'reject', plan: PLAN, note: 'too loud' }, { method: 'plan.reject', params: { plan: PLAN, note: 'too loud' } }],
    [{ kind: 'apply', plan: PLAN }, { method: 'plan.apply', params: { plan: PLAN } }],
    [{ kind: 'merge', branch: 'p4' }, { method: 'proposal.merge', params: { branch: 'p4' } }],
    [{ kind: 'discard', branch: 'p4' }, { method: 'proposal.discard', params: { branch: 'p4' } }],
    [{ kind: 'hear', side: 'main' }, { method: 'audition.hear', params: { side: 'main' } }],
    [{ kind: 'hear', side: 'p4' }, { method: 'audition.hear', params: { side: 'p4' } }],
  ];
  for (const [action, expected] of cases) {
    const client = engine(null);
    const outcome = await runAction(client, action);
    assert.equal(outcome.ok, true, action.kind);
    assert.deepEqual(client.sent, [expected], action.kind);
    const refused = engine(0);
    const failed = await runAction(refused, action);
    assert.equal(failed.ok, false, action.kind);
    assert.equal(failed.failedAt, expected.method, action.kind);
    assert.equal(refused.sent.length, 1, `${action.kind}: no retry`);
  }
});

test('plan_stale is reported with its changed entities and nothing is retried', async () => {
  const client = new FakeActionClient(() => {
    throw new ProtocolError('plan_stale', 'stale', undefined, {
      plan: PLAN,
      changedEntities: [{ ref: 'track:trk_a', change: 'modified' }],
    });
  });
  const outcome = await runAction(client, { kind: 'approveApply', plan: PLAN });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'plan_stale');
  assert.deepEqual(outcome.changedEntities, ['track:trk_a']);
  assert.match(outcome.message, /plan_stale/);
  assert.equal(client.sent.length, 1, 'one request, no retry');
});

test('an applied or rolled-back plan names where it landed instead of previewing', () => {
  assert.equal(landedLabel(entry('applied', { appliedRevision: 'r7' })), 'applied at r7');
  assert.equal(landedLabel(entry('rolled_back', { appliedRevision: 'r7' })), 'rolled back (applied at r7)');
  assert.equal(landedLabel(entry('applied')), 'applied');
  for (const state of ['draft', 'validated', 'approved', 'rejected'] as const) {
    assert.equal(landedLabel(entry(state)), null, state);
  }
});
