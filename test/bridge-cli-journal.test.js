'use strict';

// `siann validate-journal` through bin/siann.js (m5b-bridge-cli-coverage,
// acceptance item 2; docs/schemas/command-journal-v1.md, "Validation"): a valid
// journal exits 0 with its summary, every refusal of validateJournal exits 1 with
// its code in the JSON on stdout, and usage errors exit 1 with the usage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { removeTree } = require('./helpers/fake-child');
const { HASH_P, INVALID_JOURNALS, journalV1 } = require('./helpers/journals');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');

function siann(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-cli-journal-'));
  t.after(() => removeTree(root));
  return root;
}

function writeJournal(root, name, journal) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(journal, null, 2));
  return file;
}

test('validate-journal on a valid v1 journal exits 0 with its summary', (t) => {
  const root = tempRoot(t);
  const file = writeJournal(root, 'journal.json', journalV1(root));
  const result = siann(['validate-journal', file, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.journal, {
    path: file,
    journalId: 'journal_cli',
    status: 'applied',
    risk: 'normal',
    entryCount: 1,
    bundle: path.join(root, 'Song.siann'),
    planHash: HASH_P,
    appliedRevision: 'r4',
  });
});

test('validate-journal without --json prints the text form with the journal line', (t) => {
  const root = tempRoot(t);
  const file = writeJournal(root, 'journal.json', journalV1(root));
  const result = siann(['validate-journal', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: true$/m);
  assert.ok(result.stdout.includes(`journal: ${file} (applied, normal, 1 entries)`), result.stdout);
});

for (const [code, label, make] of INVALID_JOURNALS) {
  test(`validate-journal refuses ${label} with ${code}`, (t) => {
    const root = tempRoot(t);
    const file = writeJournal(root, 'journal.json', make(root));
    const result = siann(['validate-journal', file, '--json']);
    assert.equal(result.status, 1, result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.status, 'failed');
    assert.equal(summary.error.code, code);
    assert.equal(typeof summary.error.message, 'string');
    assert.ok(summary.error.message.length > 0);
  });
}

test('validate-journal on a file it cannot read exits 1 with journal_unreadable', (t) => {
  const root = tempRoot(t);
  const result = siann(['validate-journal', path.join(root, 'none.json'), '--json']);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'journal_unreadable');
  assert.match(summary.error.message, /none\.json/);
});

test('validate-journal on a file that is not JSON exits 1 with journal_not_json', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'journal.json');
  fs.writeFileSync(file, '{"schemaVersion": "siann.command_journal.v1",');
  const result = siann(['validate-journal', file, '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'journal_not_json');
});

test('validate-journal without --json prints the error line of a refusal', (t) => {
  const root = tempRoot(t);
  const file = writeJournal(root, 'journal.json', { ...journalV1(root), batches: {} });
  const result = siann(['validate-journal', file]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ok: false$/m);
  assert.match(result.stdout, /^error: invalid_batches: journal batches must be an array$/m);
});

test('validate-journal usage errors exit 1 with the usage on stderr', (t) => {
  const root = tempRoot(t);
  const file = writeJournal(root, 'journal.json', journalV1(root));
  for (const args of [['validate-journal'], ['validate-journal', '--json'], ['validate-journal', file, '--out', 'x']]) {
    const result = siann(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage:/, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});
