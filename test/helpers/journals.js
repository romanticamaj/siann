'use strict';

// siann.command_journal.v1 fixtures (docs/schemas/command-journal-v1.md): a valid
// journal, and one invalid variant per refusal of validateJournal
// (src/bridge/runner.js) with the code the "Validation" table gives it. Shared by
// the unit test in bridge-runner.test.js and the CLI test in
// bridge-cli-journal.test.js.
const path = require('node:path');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_P = `sha256:${'c'.repeat(64)}`;

function batchV1(overrides = {}) {
  return {
    batchId: 'batch_0001',
    status: 'applied',
    risk: 'normal',
    planHash: HASH_P,
    baseRevision: 'r3',
    appliedRevision: 'r4',
    touchedIds: ['root:root', 'track:trk_1'],
    preState: { revision: 'r3', documentHash: HASH_A },
    postState: { revision: 'r4', documentHash: HASH_B },
    entries: [{ command: { op: 'track.add', trackId: 'trk_1' }, name: 'Tone' }],
    ...overrides,
  };
}

function journalV1(root, batches) {
  return {
    schemaVersion: 'siann.command_journal.v1',
    journalId: 'journal_cli',
    status: 'applied',
    risk: 'normal',
    commandFile: path.join(root, 'command.json'),
    bundle: path.join(root, 'Song.siann'),
    batches: batches || [batchV1()],
    media: [],
  };
}

// [code, label, journal(root)]: each fails validateJournal with that code, one
// per check the validator makes, in its order.
const INVALID_JOURNALS = [
  ['journal_v0_unsupported', 'the Ardour-era v0 journal',
    () => ({ schemaVersion: 'siann.command_journal.v0', journalId: 'old', batches: [] })],
  ['invalid_schema_version', 'a wrong schemaVersion',
    (root) => ({ ...journalV1(root), schemaVersion: 'siann.command_journal.v9' })],
  ['invalid_journal_id', 'a missing journalId',
    (root) => { const j = journalV1(root); delete j.journalId; return j; }],
  ['invalid_batches', 'batches that are not an array', (root) => ({ ...journalV1(root), batches: {} })],
  ['invalid_bundle', 'no bundle with an applied batch', (root) => ({ ...journalV1(root), bundle: null })],
  ['invalid_batch_status', 'an invalid batch status', (root) => journalV1(root, [batchV1({ status: 'done' })])],
  ['invalid_batch_risk', 'an invalid batch risk', (root) => journalV1(root, [batchV1({ risk: 'extreme' })])],
  ['invalid_batch_entries', 'entries that are not an array',
    (root) => journalV1(root, [batchV1({ entries: null })])],
  ['invalid_plan_hash', 'an invalid planHash', (root) => journalV1(root, [batchV1({ planHash: 'sha256:nope' })])],
  ['invalid_touched_ids', 'invalid touchedIds', (root) => journalV1(root, [batchV1({ touchedIds: ['trk_1'] })])],
  ['invalid_document_hash', 'an invalid documentHash',
    (root) => journalV1(root, [batchV1({ postState: { revision: 'r4', documentHash: 'md5:1' } })])],
];

module.exports = { HASH_A, HASH_B, HASH_P, INVALID_JOURNALS, batchV1, journalV1 };
