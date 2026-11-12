// The plan review's actions (m5-plan-review; spec "Frontend", plan review):
// each button is one protocol request (Audition is plan.propose then
// audition.hear of the new branch), offered only where the plan lifecycle
// admits it; a refusal is reported, plan_stale with its changed entities, and
// nothing is retried or changed optimistically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProtocolError } from '../../src/renderer/model/session-client';
import type { PlanEntry } from '../../src/renderer/model/plan-store';
import { availableActions, landedLabel, runAction, type ActionClient, type PlanAction } from '../../src/renderer/plans/actions';

const PLAN = 'sha256:' + '1'.repeat(64);

class FakeActionClient implements ActionClient {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {}
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    try {
      return Promise.resolve(this.answer(method, params));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

test('each action maps to its protocol request', async () => {
  const cases: Array<[PlanAction, Array<{ method: string; params: Record<string, unknown> }>]> = [
    [{ kind: 'approve', plan: PLAN }, [{ method: 'plan.approve', params: { plan: PLAN } }]],
    [{ kind: 'approveSelected', plan: PLAN, steps: [0, 2] }, [{ method: 'plan.approve', params: { plan: PLAN, steps: [0, 2] } }]],
    [{ kind: 'reject', plan: PLAN, note: 'too loud' }, [{ method: 'plan.reject', params: { plan: PLAN, note: 'too loud' } }]],
    [{ kind: 'apply', plan: PLAN }, [{ method: 'plan.apply', params: { plan: PLAN } }]],
    [
      { kind: 'audition', plan: PLAN },
      [
        { method: 'plan.propose', params: { plan: PLAN } },
        { method: 'audition.hear', params: { side: 'p4' } },
      ],
    ],
    [{ kind: 'merge', branch: 'p4' }, [{ method: 'proposal.merge', params: { branch: 'p4' } }]],
    [{ kind: 'discard', branch: 'p4' }, [{ method: 'proposal.discard', params: { branch: 'p4' } }]],
    [{ kind: 'hear', side: 'main' }, [{ method: 'audition.hear', params: { side: 'main' } }]],
    [{ kind: 'hear', side: 'p4' }, [{ method: 'audition.hear', params: { side: 'p4' } }]],
  ];
  for (const [action, expected] of cases) {
    const client = new FakeActionClient((method) => (method === 'plan.propose' ? { branch: 'p4', revision: { id: 'r5' } } : {}));
    const outcome = await runAction(client, action);
    assert.equal(outcome.ok, true, action.kind);
    assert.deepEqual(client.sent, expected, action.kind);
  }
});

test('plan_stale is reported with its changed entities and nothing is retried', async () => {
  const client = new FakeActionClient(() => {
    throw new ProtocolError('plan_stale', 'stale', undefined, {
      plan: PLAN,
      changedEntities: [{ ref: 'track:trk_a', change: 'modified' }],
    });
  });
  const outcome = await runAction(client, { kind: 'approve', plan: PLAN });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'plan_stale');
  assert.deepEqual(outcome.changedEntities, ['track:trk_a']);
  assert.match(outcome.message, /plan_stale/);
  assert.match(outcome.message, /track:trk_a/);
  assert.equal(client.sent.length, 1, 'one request, no retry');
});

test('a refused propose never hears; another refusal carries its code', async () => {
  const client = new FakeActionClient(() => {
    throw new ProtocolError('invalid_state', 'only an approved plan can be proposed');
  });
  const outcome = await runAction(client, { kind: 'audition', plan: PLAN });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'invalid_state');
  assert.deepEqual(outcome.changedEntities, []);
  assert.deepEqual(client.sent.map((s) => s.method), ['plan.propose']);
});

test('Audition is two requests: a refused hear after a proposed plan reports the refusal', async () => {
  const client = new FakeActionClient((method) => {
    if (method === 'plan.propose') return { branch: 'p4', revision: { id: 'r5' } };
    throw new ProtocolError('audition_budget_exceeded', 'the branch does not fit the budget');
  });
  const outcome = await runAction(client, { kind: 'audition', plan: PLAN });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'audition_budget_exceeded');
  assert.deepEqual(client.sent, [
    { method: 'plan.propose', params: { plan: PLAN } },
    { method: 'audition.hear', params: { side: 'p4' } },
  ]);
  // The plan stays proposed (plan.changed names its branch): main is still
  // heard, so it offers Hear proposal, Merge and Discard.
  assert.deepEqual(availableActions(entry('approved', 'p4'), 'main'), ['hearProposal', 'merge', 'discard']);
});

const entry = (state: PlanEntry['state'], proposalBranch?: string, appliedRevision?: string): PlanEntry => ({
  hash: PLAN,
  state,
  steps: [{ op: 'track.add', trackId: 'trk_b', name: 'Bass', channels: 2 }],
  stale: [],
  ...(proposalBranch ? { proposalBranch } : {}),
  ...(appliedRevision ? { appliedRevision } : {}),
  raw: {},
});

test('the actions follow the plan lifecycle', () => {
  assert.deepEqual(availableActions(entry('validated'), 'main'), ['approve', 'approveSelected', 'reject']);
  assert.deepEqual(availableActions(entry('approved'), 'main'), ['audition', 'apply', 'reject']);
  assert.deepEqual(availableActions(entry('approved', 'p1'), 'main'), ['hearProposal', 'merge', 'discard']);
  assert.deepEqual(availableActions(entry('approved', 'p1'), 'p1'), ['hearMain', 'merge', 'discard']);
  for (const state of ['rejected', 'applied', 'rolled_back', 'draft'] as const) {
    assert.deepEqual(availableActions(entry(state), 'main'), [], state);
  }
});

test('without an auditioner (heard unknown) Audition and the Hear buttons are not offered', () => {
  assert.deepEqual(availableActions(entry('approved'), null), ['apply', 'reject']);
  assert.deepEqual(availableActions(entry('approved', 'p1'), null), ['merge', 'discard']);
  assert.deepEqual(availableActions(entry('validated'), null), ['approve', 'approveSelected', 'reject']);
});

test('an applied or rolled-back plan names where it landed instead of previewing', () => {
  assert.equal(landedLabel(entry('applied', undefined, 'r7')), 'applied at r7');
  assert.equal(landedLabel(entry('rolled_back', undefined, 'r7')), 'rolled back (applied at r7)');
  assert.equal(landedLabel(entry('applied')), 'applied');
  for (const state of ['draft', 'validated', 'approved', 'rejected'] as const) {
    assert.equal(landedLabel(entry(state)), null, state);
  }
});
