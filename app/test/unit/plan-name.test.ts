// How a plan is named until E-7 gives plans a title (m5b-ui-ghosts; UI
// redesign 4.2, 4.3): one helper, plans/plan-name.ts, gives the first step in
// user wording and "N steps". The audition banner, the toolbar's proposal
// pill and the Inspector's Agent changes section take their plan's name from
// it; a plan without steps has none.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMilliDb } from '../../src/renderer/format';
import { translator } from '../../src/renderer/i18n/t';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { isolateName } from '../../src/renderer/plans/isolate';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { heardPlanName, planName } from '../../src/renderer/plans/plan-name';
import { BRANCH, entry, hashOf, MIX_STEPS, planObject, planSnapshot } from './support/plans';

const names = namesFromSnapshot(planSnapshot());

test('a plan is named by its first step in user wording and its step count', () => {
  const t = translator('en');
  assert.deepEqual(planName(entry(hashOf('1'), 'validated'), t, names), {
    lead: `Set ${isolateName('Keys')} volume to ${formatMilliDb(-3000)}`,
    steps: '3 steps',
  });
  assert.deepEqual(planName(entry(hashOf('2'), 'validated', MIX_STEPS.slice(0, 1)), t, names)?.steps, '1 step');
});

test('the name is worded in the locale it is given', () => {
  const zh = translator('zh-Hant');
  const name = planName(entry(hashOf('1'), 'validated'), zh, names);
  assert.equal(name?.steps, zh('plans.steps', { count: 3 }));
  assert.notEqual(name?.lead, planName(entry(hashOf('1'), 'validated'), translator('en'), names)?.lead);
});

test('a plan without steps has no name', () => {
  assert.equal(planName(entry(hashOf('3'), 'validated', []), translator('en'), names), null);
});

// m5b-ui-audition (UI redesign 4.3): the banner and the branch chip name the
// heard proposal through one helper, heardPlanName: the plan whose branch is
// heard, named by planName, or no name when no held plan owns the branch (the
// generic word); null while main is heard or the side is unknown.
test('heardPlanName names the plan whose branch is heard, or none for a branch no plan owns', () => {
  const t = translator('en');
  const store = new PlanStore({ now: () => 0 });
  store.fromList({ plans: [planObject(hashOf('1'), 'validated', MIX_STEPS), planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH })] });
  store.setHeard(BRANCH);
  assert.deepEqual(heardPlanName(store.getSnapshot(), t, names), { branch: BRANCH, name: planName(store.getSnapshot().byHash.get(hashOf('2'))!, t, names) });
  store.setHeard('p9');
  assert.deepEqual(heardPlanName(store.getSnapshot(), t, names), { branch: 'p9', name: null });
  store.setHeard('main');
  assert.equal(heardPlanName(store.getSnapshot(), t, names), null);
  store.setHeard(null);
  assert.equal(heardPlanName(store.getSnapshot(), t, names), null);
});
