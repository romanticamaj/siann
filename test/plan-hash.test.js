const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { FIXTURE_FILE } = require('../scripts/generate-plan-fixtures');
const { PLAN_HASH_EXCLUDED, PlanHashError, planHash } = require('../src/hash/plan-hash');

const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
const byName = Object.fromEntries(fixture.valid.map((c) => [c.name, c]));

test('the excluded fields match the fixture', () => {
  assert.deepEqual([...PLAN_HASH_EXCLUDED].sort(), [...fixture.excluded].sort());
});

for (const c of fixture.valid) {
  test(`planHash reproduces ${c.name}`, () => {
    assert.equal(planHash(c.plan), c.planHash);
  });
}

test('lifecycle fields do not change the hash', () => {
  assert.equal(byName.lifecycle_fields_ignored.planHash, byName.minimal_plan.planHash);
  const plan = structuredClone(byName.minimal_plan.plan);
  for (const key of PLAN_HASH_EXCLUDED) {
    const changed = { ...plan, [key]: key === 'state' ? 'rejected' : 'something else' };
    assert.equal(planHash(changed), byName.minimal_plan.planHash, key);
  }
});

test('parentPlan and step order change the hash', () => {
  assert.notEqual(byName.parent_plan_changes_hash.planHash, byName.minimal_plan.planHash);
  assert.notEqual(byName.step_order_matters.planHash, byName.two_steps.planHash);
});

// m5b-engine-project-media: media.add {name} and media.rename are ordinary steps;
// the name is part of the hash, and native reproduces both cases.
test('a media name in a step is part of the plan hash', () => {
  const withName = byName.media_add_with_name.plan;
  assert.equal(withName.steps[0].name, 'Kick 聲.wav');
  const { name, ...unnamed } = withName.steps[0];
  assert.notEqual(planHash({ ...withName, steps: [unnamed] }), byName.media_add_with_name.planHash);
  const rename = byName.media_rename.plan;
  assert.deepEqual(rename.steps.map((step) => step.name), ['Loop A.flac', null]);
  assert.equal(planHash(rename), byName.media_rename.planHash);
});

test('planHash does not modify its input', () => {
  const plan = structuredClone(byName.lifecycle_fields_ignored.plan);
  const before = JSON.stringify(plan);
  planHash(plan);
  assert.equal(JSON.stringify(plan), before);
});

for (const c of fixture.invalid) {
  test(`planHash rejects ${c.name} with ${c.error}`, () => {
    const plan = JSON.parse(c.planText);
    assert.throws(() => planHash(plan), (error) => {
      assert.ok(error instanceof PlanHashError, `${error.name}: ${error.message}`);
      assert.equal(error.code, c.error);
      return true;
    });
  });
}

test('planHash rejects values that are not plans', () => {
  for (const value of [null, [], 'plan', 42]) {
    assert.throws(() => planHash(value), { code: 'invalid_plan' });
  }
});
