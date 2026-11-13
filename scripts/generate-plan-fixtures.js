#!/usr/bin/env node
// Regenerates fixtures/plan/plan-hash.json.
//
// The expected plan hashes are computed here with a deliberately separate,
// minimal strip-then-hash function. It does not import src/hash/plan-hash.js,
// only the JCS serializer, which is itself anchored by fixtures/jcs/. Node
// (test/plan-hash.test.js) and the C++ engine (native/libs/command/tests/
// plan_hash_test.cpp) must both reproduce every valid case and reject every
// invalid one with the listed code.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { sha256Jcs } = require('../src/hash/jcs');

// The architecture spec, "Canonical JSON and hashes": planHash excludes exactly these.
const EXCLUDED = ['hash', 'state', 'approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt', 'rejectionNote',
  'appliedRevision'];

function expectedPlanHash(plan) {
  const hashed = {};
  for (const [key, value] of Object.entries(plan)) {
    if (!EXCLUDED.includes(key)) hashed[key] = value;
  }
  return sha256Jcs(hashed);
}

const h = (text) => `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
const entry = (type, id, hash = h(`${type}/${id}`)) => ({ type, id, hash });

const setGain = { op: 'track.set_gain', trackId: 'trk_1', gainMilliDb: -600 };
const setPan = { op: 'track.set_pan', trackId: 'trk_1', pan: -2500 };

const minimal = {
  schema: 'siann.plan.v1',
  baseRevision: 'r4',
  steps: [setGain],
  readSet: [],
  writeSet: [entry('track', 'trk_1')],
};

function buildFixture() {
  const valid = [
    ['minimal_plan', minimal],
    ['lifecycle_fields_ignored', {
      ...minimal,
      hash: `sha256:${'0'.repeat(64)}`,
      state: 'applied',
      approvedBy: 'user',
      approvedAt: '2026-11-04T10:00:00Z',
      rejectedBy: 'someone',
      rejectedAt: '2026-11-04T09:00:00Z',
      rejectionNote: 'not this one',
      appliedRevision: 'r9',
    }],
    ['absent_entity_null_hash', {
      schema: 'siann.plan.v1',
      baseRevision: 'r4',
      steps: [{ op: 'track.add', trackId: 'trk_4', name: 'Bass', channels: 2 }],
      readSet: [entry('track', 'trk_2')],
      writeSet: [entry('root', 'root'), entry('track', 'trk_4', null)],
    }],
    ['parent_plan_changes_hash', { ...minimal, parentPlan: h('parent plan') }],
    ['two_steps', { ...minimal, steps: [setGain, setPan] }],
    ['step_order_matters', { ...minimal, steps: [setPan, setGain] }],
    ['sixty_four_bit_strings_in_steps', {
      schema: 'siann.plan.v1',
      baseRevision: 'r12',
      steps: [{
        op: 'clip.place',
        clipId: 'clp_1',
        trackId: 'trk_1',
        mediaId: 'med_1',
        position: { domain: 'audio', value: '96000' },
        sourceStart: '0',
        length: '9007199254740993',
      }],
      readSet: [entry('media', 'med_1'), entry('track', 'trk_1')],
      writeSet: [entry('clip', 'clp_1', null)],
    }],
    // m5-ui-engine-loop-click: the singleton locators entity, absent at the base.
    ['locators_write_set', {
      schema: 'siann.plan.v1',
      baseRevision: 'r7',
      steps: [{ op: 'session.set_locators', left: '96000', right: '480000' }],
      readSet: [],
      writeSet: [entry('locators', 'locators', null)],
    }],
    ['non_bmp_key_in_step', {
      ...minimal,
      steps: [{ op: 'session.rename', name: 'Song \u{1F3B5}', '': 'private use', '\u{1F3B5}': 'note' }],
      writeSet: [entry('root', 'root')],
    }],
  ].map(([name, plan]) => ({ name, plan, planHash: expectedPlanHash(plan) }));

  const text = (plan) => JSON.stringify(plan);
  const minimalText = text(minimal);
  const invalid = [
    ['non_finite_number_in_step', minimalText.replace('-600', '1e400'), 'plan_not_canonicalizable'],
    ['lone_surrogate_in_step', text({ ...minimal, steps: [{ op: 'session.rename', name: 'x' }] })
      .replace('"name":"x"', '"name":"\\ud800"'), 'plan_not_canonicalizable'],
    ['malformed_entity_hash', text({ ...minimal, writeSet: [entry('track', 'trk_1', `sha256:${'A'.repeat(64)}`)] }),
      'invalid_entity_set'],
    ['entity_hash_without_prefix', text({ ...minimal, writeSet: [entry('track', 'trk_1', 'f'.repeat(64))] }),
      'invalid_entity_set'],
    ['unsorted_read_set', text({ ...minimal, readSet: [entry('track', 'trk_2'), entry('media', 'med_1')] }),
      'invalid_entity_set'],
    ['unsorted_ids_in_write_set', text({ ...minimal, writeSet: [entry('track', 'trk_2'), entry('track', 'trk_1')] }),
      'invalid_entity_set'],
    ['duplicate_write_set_entry', text({ ...minimal, writeSet: [entry('track', 'trk_1'), entry('track', 'trk_1')] }),
      'invalid_entity_set'],
    ['unknown_entity_type', text({ ...minimal, readSet: [entry('send', 'snd_1')] }), 'invalid_entity_set'],
    ['invalid_entity_id', text({ ...minimal, readSet: [entry('track', 'trk 1')] }), 'invalid_entity_set'],
    ['locators_with_another_id', text({ ...minimal, readSet: [entry('locators', 'loc_1')] }), 'invalid_entity_set'],
    ['unknown_field', text({ ...minimal, comment: 'not part of v1' }), 'invalid_plan'],
    ['wrong_schema', text({ ...minimal, schema: 'siann.plan.v0' }), 'invalid_plan'],
    ['empty_steps', text({ ...minimal, steps: [] }), 'invalid_plan'],
    ['step_without_op', text({ ...minimal, steps: [{ trackId: 'trk_1' }] }), 'invalid_plan'],
    ['malformed_parent_plan', text({ ...minimal, parentPlan: 'sha256:abc' }), 'invalid_plan'],
    ['unknown_state', text({ ...minimal, state: 'pending' }), 'invalid_plan'],
    ['missing_read_set', text({ ...minimal, readSet: undefined }), 'invalid_entity_set'],
  ].map(([name, planText, error]) => ({ name, planText, error }));

  return {
    schemaVersion: 'siann.plan_hash_fixtures.v1',
    description: 'SIANN planHash: sha256 over the RFC 8785 JCS of a siann.plan.v1 object without hash, state, approvedBy, approvedAt, rejectedBy, rejectedAt, rejectionNote and appliedRevision. readSet and writeSet entries are {type, id, hash} sorted by (type, id) without duplicates; type is one of clip, locators, media, plugin_slot, root, track (root and locators are singletons whose id is their type); hash is "sha256:" plus 64 lowercase hex digits, or null for an entity absent at baseRevision. Invalid cases are JSON texts that must be rejected with the listed code. Generated by scripts/generate-plan-fixtures.js.',
    excluded: EXCLUDED,
    valid,
    invalid,
  };
}

const FIXTURE_FILE = path.join(__dirname, '..', 'fixtures', 'plan', 'plan-hash.json');

module.exports = { FIXTURE_FILE, buildFixture };

if (require.main === module) {
  const out = buildFixture();
  fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
  fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${FIXTURE_FILE}: valid=${out.valid.length} invalid=${out.invalid.length}`);
}
