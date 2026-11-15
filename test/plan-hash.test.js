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
  const values = { state: 'rejected', actor: { kind: 'ui', name: 'someone' } };
  for (const key of PLAN_HASH_EXCLUDED) {
    const changed = { ...plan, [key]: values[key] ?? 'something else' };
    assert.equal(planHash(changed), byName.minimal_plan.planHash, key);
  }
});

// m5b-engine-plan-metadata: title, intent and actor are accepted and outside the
// hash; each fixture case has the hash of its untitled twin.
test('a plan hashed with and without a title, an intent or an actor has the same hash', () => {
  for (const key of ['title', 'intent', 'actor']) assert.ok(PLAN_HASH_EXCLUDED.includes(key), key);
  assert.equal(byName.titled_plan.plan.title, 'Lower the drums');
  for (const name of ['titled_plan', 'plan_with_intent', 'plan_with_actor']) {
    assert.equal(byName[name].planHash, byName.minimal_plan.planHash, name);
  }
  assert.equal(byName.non_ascii_title.planHash, byName.two_steps.planHash);
  assert.equal(byName.non_ascii_title.plan.title, '鼓聲降低 \u{1F941}');
  const { title, intent, actor, ...untitled } = byName.non_ascii_title.plan;
  assert.deepEqual(actor, { kind: 'ui', name: 'SIANN' });
  assert.equal(planHash(untitled), planHash(byName.non_ascii_title.plan));
  assert.equal(planHash({ ...byName.minimal_plan.plan, title: 'x'.repeat(500) }), byName.minimal_plan.planHash);
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
