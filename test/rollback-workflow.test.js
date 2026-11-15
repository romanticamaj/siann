'use strict';

// src/workflows/rollback.js (m5b-bridge-native-client, acceptance item 3): a
// rollback command built from a siann.command_journal.v1 opens the bundle the
// journal names and calls plan.rollback {revision: the applied revision}, so it
// runs in a later engine process than the apply. A v0 journal (the Ardour
// engine's tar snapshots) is refused.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  buildRollbackCommand,
  writeRollbackCommand,
} = require('../src/workflows/rollback');
const { writeWav } = require('../scripts/create-demo-audio');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');
const FAKE_ENGINE = path.join(__dirname, 'helpers', 'fake-engine.js');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_P = `sha256:${'c'.repeat(64)}`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function journalV1(root, batches) {
  return {
    schemaVersion: 'siann.command_journal.v1',
    journalId: 'journal',
    status: 'applied',
    bundle: path.join(root, 'Session'),
    batches: batches || [{
      batchId: 'batch_0001', status: 'applied', risk: 'normal', planHash: HASH_P,
      baseRevision: 'r3', appliedRevision: 'r4',
      preState: { revision: 'r3', documentHash: HASH_A }, postState: { revision: 'r4', documentHash: HASH_B },
      entries: [{ entryId: 'entry_0001', op: 'track.add', status: 'applied' }],
    }],
  };
}

test('buildRollbackCommand opens the journal bundle and rolls back the applied revision', () => {
  const root = path.join(os.tmpdir(), 'siann-rollback-unit');
  const rollback = buildRollbackCommand(journalV1(root));

  assert.equal(rollback.schemaVersion, 'siann.command.v0');
  assert.deepEqual(rollback.commands, [
    { op: 'open_session', sessionDir: path.join(root, 'Session') },
    { op: 'rollback_plan', revision: 'r4', planHash: HASH_P },
    { op: 'observe_session' },
  ]);
});

test('several applied batches roll back newest first; failed batches are skipped', () => {
  const root = path.join(os.tmpdir(), 'siann-rollback-many');
  const batch = (n, status) => ({ batchId: `batch_000${n}`, status, risk: 'normal', planHash: HASH_P,
    baseRevision: `r${n}`, appliedRevision: status === 'applied' ? `r${n + 1}` : undefined,
    preState: { revision: `r${n}`, documentHash: HASH_A }, postState: {}, entries: [] });
  const rollback = buildRollbackCommand(journalV1(root, [batch(2, 'applied'), batch(4, 'applied'), batch(6, 'failed')]));
  assert.deepEqual(rollback.commands.filter((c) => c.op === 'rollback_plan').map((c) => c.revision), ['r5', 'r3']);
});

test('a journal with nothing applied, or the Ardour-era v0, is refused with a clear message', () => {
  const root = path.join(os.tmpdir(), 'siann-rollback-refused');
  assert.throws(() => buildRollbackCommand(journalV1(root, [])), /no applied plan/);
  assert.throws(() => buildRollbackCommand({
    schemaVersion: 'siann.command_journal.v0', journalId: 'old', batches: [{ status: 'applied', risk: 'normal',
      preState: { snapshot: { path: '/tmp/x.tar.gz' } }, entries: [] }],
  }), /siann\.command_journal\.v0 .*Ardour engine.*cannot be rolled back/);
  assert.throws(() => buildRollbackCommand({ ...journalV1(root), bundle: undefined }), /bundle/);
});

test('writeRollbackCommand writes rollback.command.json next to the journal by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-rollback-write-'));
  const journalFile = path.join(root, 'journal.json');
  writeJson(journalFile, journalV1(root));

  const summary = writeRollbackCommand(journalFile);

  assert.equal(summary.ok, true);
  assert.equal(summary.workflow, 'rollback');
  assert.equal(summary.commandCount, 3);
  assert.equal(summary.commandFile, path.join(root, 'rollback.command.json'));
  assert.equal(summary.bundle, path.join(root, 'Session'));
  assert.deepEqual(summary.revisions, ['r4']);
  assert.equal(JSON.parse(fs.readFileSync(summary.commandFile, 'utf8')).commands[1].op, 'rollback_plan');
  fs.rmSync(root, { recursive: true, force: true });
});

test('siann run then siann rollback --run, each in its own engine process, restores the pre-apply hash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-rollback-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalFile = path.join(root, 'journal.json');
  const commandFile = path.join(root, 'import.command.json');
  const callsFile = path.join(root, 'calls.json');
  writeWav(path.join(root, 'tone.wav'), 440);
  writeJson(commandFile, { schemaVersion: 'siann.command.v0', journalPath: journalFile, commands: [
    { op: 'create_session', sessionDir: path.join(root, 'Session'), sessionName: 'Rollback', sampleRate: 48000 },
    { op: 'create_audio_track', name: 'Tone' },
    { op: 'import_audio', path: path.join(root, 'tone.wav'), trackName: 'Tone', regionName: 'Tone', start: '0.5' },
  ] });
  const env = { ...process.env, SIANN_FAKE_ENGINE_CALLS: callsFile };
  const run = spawnSync(process.execPath, [CLI, 'run', commandFile, '--runner', FAKE_ENGINE, '--json'],
    { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));

  const outFile = path.join(root, 'restore.command.json');
  const result = spawnSync(process.execPath, [CLI, 'rollback', journalFile, '--out', outFile, '--run',
    '--runner', FAKE_ENGINE, '--json'], { cwd: ROOT, encoding: 'utf8', env });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.commandFile, outFile);
  assert.equal(summary.run.ok, true);
  const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
  assert.equal(calls.length, 2, 'two engine processes');
  const second = calls[1];
  assert.deepEqual(second.map((c) => c.method), ['session.open', 'plan.rollback', 'session.inspect']);
  assert.deepEqual(second[0].params, { path: journal.bundle });
  assert.deepEqual(second[1].params, { revision: journal.batches[0].appliedRevision });
  assert.equal(summary.run.result.results.at(-1).documentHash, journal.batches[0].preState.documentHash);
});

test('rollback refuses a session whose head moved away from what the journal applied', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-rollback-moved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalFile = path.join(root, 'journal.json');
  // The applied revision does not exist in a fresh session: plan.rollback answers not_found.
  writeJson(journalFile, journalV1(root));
  writeJson(path.join(root, 'create.json'), { schemaVersion: 'siann.command.v0', commands: [
    { op: 'create_session', sessionDir: path.join(root, 'Session'), sessionName: 'Moved', sampleRate: 48000 },
  ] });
  assert.equal(spawnSync(process.execPath, [CLI, 'run', path.join(root, 'create.json'), '--runner', FAKE_ENGINE],
    { cwd: ROOT, encoding: 'utf8' }).status, 0);

  const result = spawnSync(process.execPath, [CLI, 'rollback', journalFile, '--run', '--runner', FAKE_ENGINE,
    '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.run.error.code, 'not_found');
});
