// How a plan is named (m5b-ui-plan-metadata; UI redesign 4.3: one shared
// helper for the card, the history rows, the audition banner and the toast):
// with features.planMetadata and a title, the title; without a title, the
// first step in user wording and "N steps"; without the feature, the M5
// wording even when the plan carries a title; no steps, the generic word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { describeStep, namesFromSnapshot } from '../../src/renderer/plans/describe';
import { heardPlanName, planName, planNameParts } from '../../src/renderer/plans/plan-name';
import { BRANCH, entry, hashOf, MIX_STEPS, planObject, planSnapshot } from './support/plans';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = capabilitySelector(read('capabilities-full.json'));
const REDUCED = capabilitySelector(read('capabilities-reduced.json'));
const t = translator('en');
const names = namesFromSnapshot(planSnapshot());

test('with features.planMetadata a titled plan is named by its title', () => {
  const plan = entry(hashOf('1'), 'validated', MIX_STEPS, { title: 'Lift the chorus' });
  assert.deepEqual(planName(plan, t, names, FULL), { kind: 'title', title: 'Lift the chorus' });
});

test('a plan without a title is named by its first step in user wording and its step count', () => {
  const plan = entry(hashOf('1'), 'validated');
  assert.deepEqual(planName(plan, t, names, FULL), {
    kind: 'steps',
    lead: describeStep(MIX_STEPS[0]!, t, names),
    steps: t('plans.steps', { count: 3 }),
  });
  // An empty title is no title.
  const empty = entry(hashOf('2'), 'validated', MIX_STEPS, { title: '' });
  assert.equal(planName(empty, t, names, FULL).kind, 'steps');
});

test('without features.planMetadata the M5 wording, even for a plan that carries a title', () => {
  const plan = entry(hashOf('1'), 'validated', MIX_STEPS, { title: 'Lift the chorus' });
  assert.deepEqual(planName(plan, t, names, REDUCED), {
    kind: 'steps',
    lead: describeStep(MIX_STEPS[0]!, t, names),
    steps: t('plans.steps', { count: 3 }),
  });
  assert.equal(planName(plan, t, names, capabilitySelector(null)).kind, 'steps', 'unknown capabilities: M5 wording');
});

test('a plan with no steps, or no plan, is named by the generic word', () => {
  assert.deepEqual(planName(entry(hashOf('1'), 'validated', []), t, names, FULL), { kind: 'generic' });
  assert.deepEqual(planName(undefined, t, names, FULL), { kind: 'generic' });
  // A titled plan with no steps still has its title.
  assert.deepEqual(planName(entry(hashOf('2'), 'validated', [], { title: 'Empty' }), t, names, FULL), { kind: 'title', title: 'Empty' });
});

// The pill and the Agent changes section (m5b-ui-ghosts) read the name as a
// lead and a step count: the title leads a titled plan, as the mockup's pill
// reads "<b>Lift the chorus</b> · 6 changes"; a plan without steps has none.
test('the pill and the Agent changes take the title as the lead with the step count, the first step without a title, nothing without steps', () => {
  const steps = t('plans.steps', { count: 3 });
  assert.deepEqual(planNameParts(entry(hashOf('1'), 'validated', MIX_STEPS, { title: 'Lift the chorus' }), t, names, FULL), { lead: 'Lift the chorus', steps });
  assert.deepEqual(planNameParts(entry(hashOf('1'), 'validated', MIX_STEPS, { title: 'Lift the chorus' }), t, names, REDUCED), { lead: describeStep(MIX_STEPS[0]!, t, names), steps });
  assert.deepEqual(planNameParts(entry(hashOf('1'), 'validated'), t, names, FULL), { lead: describeStep(MIX_STEPS[0]!, t, names), steps });
  assert.equal(planNameParts(entry(hashOf('2'), 'validated', [], { title: 'Empty' }), t, names, FULL), null);
  assert.equal(planNameParts(entry(hashOf('3'), 'validated', []), t, names, FULL), null);
});

// m5b-ui-audition (UI redesign 4.3): the banner and the branch chip name the
// heard proposal through one helper, heardPlanName: the plan whose branch is
// heard, named by planName (its title with features.planMetadata), or the
// generic word when no held plan owns the branch; null while main is heard
// or the side is unknown.
test('heardPlanName names the plan whose branch is heard, or the generic word for a branch no plan owns', () => {
  const store = new PlanStore({ now: () => 0 });
  store.fromList({
    plans: [planObject(hashOf('1'), 'validated', MIX_STEPS), planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH, title: 'Lift the chorus' })],
  });
  store.setHeard(BRANCH);
  const plan = store.getSnapshot().byHash.get(hashOf('2'))!;
  assert.deepEqual(heardPlanName(store.getSnapshot(), t, names, FULL), { branch: BRANCH, name: planName(plan, t, names, FULL) });
  assert.deepEqual(heardPlanName(store.getSnapshot(), t, names, FULL)?.name, { kind: 'title', title: 'Lift the chorus' });
  assert.equal(heardPlanName(store.getSnapshot(), t, names, REDUCED)?.name.kind, 'steps');
  store.setHeard('p9');
  assert.deepEqual(heardPlanName(store.getSnapshot(), t, names, FULL), { branch: 'p9', name: { kind: 'generic' } });
  store.setHeard('main');
  assert.equal(heardPlanName(store.getSnapshot(), t, names, FULL), null);
  store.setHeard(null);
  assert.equal(heardPlanName(store.getSnapshot(), t, names, FULL), null);
});
