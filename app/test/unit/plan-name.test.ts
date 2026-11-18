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
import { planName } from '../../src/renderer/plans/plan-name';
import { entry, hashOf, MIX_STEPS, planSnapshot } from './support/plans';

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
