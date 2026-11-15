'use strict';

// bin/siann.js against the fake engine process (test/helpers/fake-engine.js)
// through `--runner` (m5b-bridge-native-client): the CLI runs command files
// through the native client, and the Ardour-era --engine-dir option and
// SIANN_ENGINE_DIR are gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { writeWav } = require('../scripts/create-demo-audio');
const { removeTree } = require('./helpers/fake-child');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');
const FAKE_ENGINE = path.join(__dirname, 'helpers', 'fake-engine.js');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function siann(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(root));
  return root;
}

test('siann run drives a command file through the engine and prints a machine-readable summary', (t) => {
  const tmp = tempRoot(t, 'siann-cli-');
  const journalPath = path.join(tmp, 'journal.json');
  const commandPath = path.join(tmp, 'command.json');
  const callsFile = path.join(tmp, 'calls.json');
  writeWav(path.join(tmp, 'tone.wav'), 440);
  writeJson(commandPath, {
    schemaVersion: 'siann.command.v0',
    journalPath,
    batchRisk: 'low',
    commands: [
      { op: 'create_session', sessionDir: path.join(tmp, 'Session'), sessionName: 'CliDemo', sampleRate: 48000 },
      { op: 'create_audio_track', name: 'Tone' },
      { op: 'import_audio', path: path.join(tmp, 'tone.wav'), trackName: 'Tone', regionName: 'Tone 1', start: '0' },
      { op: 'save_session' },
    ],
  });

  const result = siann(['run', commandPath, '--runner', FAKE_ENGINE, '--json'], { SIANN_FAKE_ENGINE_CALLS: callsFile });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.commandFile, commandPath);
  assert.equal(summary.journal.risk, 'low');
  assert.match(summary.journal.planHash, /^sha256:[0-9a-f]{64}$/);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.schemaVersion, 'siann.command_journal.v1');
  const [calls] = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
  assert.deepEqual(calls.map((c) => c.method).filter((m) => m.startsWith('plan.')),
    ['plan.submit', 'plan.approve', 'plan.apply']);
});

test('siann run exits 1 with the error when the engine refuses a step', (t) => {
  const tmp = tempRoot(t, 'siann-cli-fail-');
  const commandPath = path.join(tmp, 'command.json');
  writeJson(commandPath, {
    schemaVersion: 'siann.command.v0',
    commands: [{ op: 'create_session', sessionDir: path.join(tmp, 'Session'), sessionName: 'X', sampleRate: 44100 }],
  });
  const result = siann(['run', commandPath, '--runner', FAKE_ENGINE, '--json']);
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'sample_rate_mismatch');
});

test('an engine that fails its launch fails the run with its error', (t) => {
  const tmp = tempRoot(t, 'siann-cli-launch-');
  const commandPath = path.join(tmp, 'command.json');
  writeJson(commandPath, { schemaVersion: 'siann.command.v0', commands: [{ op: 'observe_session' }] });
  const result = siann(['run', commandPath, '--runner', FAKE_ENGINE, '--json'], { SIANN_FAKE_ENGINE_MODE: 'exit' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'session_locked');
});

test('the engine exiting mid-run fails the run instead of hanging', (t) => {
  const tmp = tempRoot(t, 'siann-cli-exit-');
  const commandPath = path.join(tmp, 'command.json');
  writeWav(path.join(tmp, 'tone.wav'), 440);
  writeJson(commandPath, { schemaVersion: 'siann.command.v0', commands: [
    { op: 'create_session', sessionDir: path.join(tmp, 'Session'), sessionName: 'X', sampleRate: 48000 },
    { op: 'create_audio_track', name: 'Tone' },
    { op: 'import_audio', path: path.join(tmp, 'tone.wav'), trackName: 'Tone', regionName: 'T', start: '0' },
  ] });
  const result = siann(['run', commandPath, '--runner', FAKE_ENGINE, '--json'],
    { SIANN_FAKE_ENGINE_MODE: 'exit-on-import' });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error.code, /^(engine_exited|connection_closed)$/);
});

test('--engine-dir is an unknown option', () => {
  const result = siann(['run', 'command.json', '--engine-dir', '../siann-engine']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option --engine-dir/);
});

test('siann --help names the native engine and no longer the Ardour checkout', () => {
  const result = siann(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /siann run <command-file\.json>/);
  assert.match(result.stdout, /SIANN_ENGINE_EXE/);
  assert.match(result.stdout, /native\/build\/dev/);
  assert.doesNotMatch(result.stdout, /SIANN_ENGINE_DIR|--engine-dir|\.\.\/siann-engine/);
});
