'use strict';

// Every `--run` flag of bin/siann.js (m5b-bridge-cli-coverage, acceptance items 3
// and 4; test-matrix layers B and G). The flags come from the CLI's option table
// (COMMANDS); COVERED names, per subcommand that takes --run, the gated test
// against siann-engine (SIANN_RUN_ENGINE_TESTS=1, --device fake; check-all's
// bridge step and CI's bridge-engine job run it) and the ungated test of its error
// path against the fake engine (test/helpers/fake-engine.js through --runner). A
// subcommand that gains --run without an entry, or an entry whose subcommand lost
// it, fails the first test.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { COMMANDS } = require('../bin/siann.js');
const { resolveEngineExe } = require('../src/runtime/client');
const { writeWav } = require('../scripts/create-demo-audio');
const { journalV1 } = require('./helpers/journals');
const { removeTree } = require('./helpers/fake-child');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');
const FAKE_ENGINE = path.join(__dirname, 'helpers', 'fake-engine.js');
const GATE = process.env.SIANN_RUN_ENGINE_TESTS === '1'
  ? false
  : 'engine-gated: set SIANN_RUN_ENGINE_TESTS=1 (and SIANN_ENGINE_EXE, else native/build/dev) to run against siann-engine';

// Per subcommand that takes --run: the names of its tests in this file.
const COVERED = {
  'workflow import-pack': {
    gated: 'G: workflow import-pack --out --run against siann-engine',
    fakeError: 'workflow import-pack --out --run: the engine refuses a step, and its launch fails',
  },
  'workflow apply-plan': {
    gated: 'G: workflow apply-plan --run against siann-engine',
    fakeError: 'workflow apply-plan --run: the engine refuses a step, and its launch fails',
  },
  rollback: {
    gated: 'G: rollback --run against siann-engine',
    fakeError: 'rollback --run: the engine refuses a step, and its launch fails',
  },
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function siann(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(root));
  return root;
}

// An import-pack manifest with one tone on one track and a preview render.
function writeManifest(root) {
  writeWav(path.join(root, 'tone.wav'), 440);
  const file = path.join(root, 'manifest.json');
  writeJson(file, {
    schemaVersion: 'siann.import_pack.v0',
    session: { dir: path.join(root, 'Session'), name: 'RunFlags', sampleRate: 48000 },
    journalPath: path.join(root, 'journal.json'),
    tracks: [{ name: 'Tone', outputChannels: 2 }],
    assets: [{ id: 'tone', path: path.join(root, 'tone.wav'), trackName: 'Tone', regionName: 'Tone 1', start: '0.5' }],
    preview: { outputPath: path.join(root, 'preview.wav') },
  });
  return file;
}

// The manifest's plan, approved: the file apply-plan takes.
function approvedPlan(root, manifestFile) {
  const planFile = path.join(root, 'plan.json');
  const approved = path.join(root, 'approved.json');
  assert.equal(siann(['workflow', 'import-pack', manifestFile, '--plan', planFile]).status, 0);
  assert.equal(siann(['workflow', 'approve-plan', planFile, '--out', approved, '--approved-by', 'test']).status, 0);
  return approved;
}

// A failed run: exit 1, summary.ok false, the run's error code, the command file written.
function runFailed(result, commandFile) {
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.run.ok, false);
  assert.equal(typeof summary.run.error.code, 'string');
  assert.ok(summary.run.error.code.length > 0);
  assert.equal(summary.commandFile, commandFile);
  assert.ok(fs.existsSync(commandFile), 'the command file is written before the run');
  assert.equal(readJson(commandFile).schemaVersion, 'siann.command.v0');
  return summary;
}

function runOk(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.run.ok, true, JSON.stringify(summary.run.error));
  return summary;
}

// ---- The table ----------------------------------------------------------------

test('every subcommand the option table gives --run has an entry in COVERED, and no entry is stale', () => {
  const withRun = COMMANDS.filter((row) => row.options.includes('--run')).map((row) => row.name).sort();
  assert.ok(withRun.length > 0, 'the table lists --run somewhere');
  const missing = withRun.filter((name) => !Object.hasOwn(COVERED, name));
  const stale = Object.keys(COVERED).filter((name) => !withRun.includes(name));
  assert.deepEqual(missing, [], `--run of ${missing.join(', ')} has no entry in COVERED (bridge-cli-run-flags.test.js)`);
  assert.deepEqual(stale, [], `COVERED lists ${stale.join(', ')}, which takes no --run`);
  const source = fs.readFileSync(__filename, 'utf8');
  for (const [name, { gated, fakeError }] of Object.entries(COVERED)) {
    for (const title of [gated, fakeError]) {
      assert.ok(source.includes(`test('${title}'`), `${name}: this file has a test named "${title}"`);
    }
    assert.match(gated, /^G: /, `${name}: the gated test is a G test`);
  }
});

test('--help shows [--run] exactly on the usage lines of the subcommands that take it', () => {
  const help = siann(['--help']);
  assert.equal(help.status, 0, help.stderr);
  const lines = help.stdout.split(/\r?\n/).filter((line) => /^ {2}siann /.test(line)).map((line) => line.trim());
  assert.deepEqual(lines, COMMANDS.flatMap((row) => row.usage), 'the usage lines are the table\'s');
  const nameOf = (line) => COMMANDS.map((row) => row.name).filter((name) => line.startsWith(`siann ${name} `))
    .sort((a, b) => b.length - a.length)[0];
  const shown = [...new Set(lines.filter((line) => line.includes('[--run]')).map(nameOf))].sort();
  assert.deepEqual(shown, Object.keys(COVERED).sort());
});

test('--run on a subcommand that does not take it is a usage error', () => {
  for (const args of [
    ['run', 'command.json', '--run'],
    ['workflow', 'validate-plan', 'plan.json', '--run'],
    ['workflow', 'approve-plan', 'plan.json', '--out', 'x.json', '--run'],
    ['export', 'dawproject', 'm.json', '--out', 'x.dawproject', '--run'],
    ['live', 'import-pack', 'm.json', '--run'],
  ]) {
    const result = siann(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage:/, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

// ---- Ungated: the fake engine -------------------------------------------------

test('workflow import-pack --out --run: the engine refuses a step, and its launch fails', (t) => {
  const root = tempRoot(t, 'siann-run-import-');
  const manifestFile = writeManifest(root);
  const commandFile = path.join(root, 'cmd.json');
  const args = ['workflow', 'import-pack', manifestFile, '--out', commandFile, '--run', '--runner', FAKE_ENGINE, '--json'];
  // A device at another rate than the session: create_session is refused.
  const refused = runFailed(siann(args, { SIANN_FAKE_ENGINE_RATE: '44100' }), commandFile);
  assert.equal(refused.run.error.code, 'sample_rate_mismatch');
  fs.rmSync(commandFile);
  const launch = runFailed(siann(args, { SIANN_FAKE_ENGINE_MODE: 'exit' }), commandFile);
  assert.equal(launch.run.error.code, 'session_locked');
});

test('workflow import-pack --plan --run is refused: a reviewed plan runs through apply-plan', (t) => {
  const root = tempRoot(t, 'siann-run-import-plan-');
  const planFile = path.join(root, 'plan.json');
  const result = siann(['workflow', 'import-pack', writeManifest(root), '--plan', planFile, '--run',
    '--runner', FAKE_ENGINE, '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /use workflow apply-plan to run a reviewed plan/);
  assert.equal(fs.existsSync(planFile), false);
});

test('workflow apply-plan --run: the engine refuses a step, and its launch fails', (t) => {
  const root = tempRoot(t, 'siann-run-apply-');
  const approved = approvedPlan(root, writeManifest(root));
  const commandFile = path.join(root, 'cmd.json');
  const args = ['workflow', 'apply-plan', approved, '--out', commandFile, '--run', '--runner', FAKE_ENGINE, '--json'];
  const refused = runFailed(siann(args, { SIANN_FAKE_ENGINE_RATE: '44100' }), commandFile);
  assert.equal(refused.run.error.code, 'sample_rate_mismatch');
  fs.rmSync(commandFile);
  const launch = runFailed(siann(args, { SIANN_FAKE_ENGINE_MODE: 'exit' }), commandFile);
  assert.equal(launch.run.error.code, 'session_locked');
});

test('rollback --run: the engine refuses a step, and its launch fails', (t) => {
  const root = tempRoot(t, 'siann-run-rollback-');
  const journalFile = path.join(root, 'journal.json');
  // The journal's bundle does not exist: session.open is refused.
  writeJson(journalFile, journalV1(root));
  const commandFile = path.join(root, 'rb.json');
  const args = ['rollback', journalFile, '--out', commandFile, '--run', '--runner', FAKE_ENGINE, '--json'];
  const refused = runFailed(siann(args), commandFile);
  assert.equal(refused.run.error.code, 'not_found');
  fs.rmSync(commandFile);
  const launch = runFailed(siann(args, { SIANN_FAKE_ENGINE_MODE: 'exit' }), commandFile);
  assert.equal(launch.run.error.code, 'session_locked');
});

test('a failed --run without --json prints the text summary', (t) => {
  const root = tempRoot(t, 'siann-run-text-');
  const commandFile = path.join(root, 'cmd.json');
  const result = siann(['workflow', 'import-pack', writeManifest(root), '--out', commandFile, '--run',
    '--runner', FAKE_ENGINE], { SIANN_FAKE_ENGINE_RATE: '44100' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ok: false$/m);
  assert.ok(result.stdout.includes(`commandFile: ${commandFile}`), result.stdout);
});

// ---- Gated: siann-engine ------------------------------------------------------

function engineEnv() {
  return { SIANN_ENGINE_EXE: resolveEngineExe() };
}

test('G: workflow import-pack --out --run against siann-engine', { skip: GATE }, (t) => {
  const root = tempRoot(t, 'siann-g-import-');
  const summary = runOk(siann(['workflow', 'import-pack', writeManifest(root), '--out', path.join(root, 'cmd.json'),
    '--run', '--device', 'fake', '--json'], engineEnv()));
  const journal = readJson(path.join(root, 'journal.json'));
  assert.equal(journal.schemaVersion, 'siann.command_journal.v1');
  assert.equal(journal.batches[0].status, 'applied');
  assert.equal(summary.run.journal.planHash, journal.batches[0].planHash);
  assert.ok(fs.existsSync(path.join(root, 'preview.wav')), 'the render was copied to the preview path');
});

test('G: workflow apply-plan --run against siann-engine', { skip: GATE }, (t) => {
  const root = tempRoot(t, 'siann-g-apply-');
  const approved = approvedPlan(root, writeManifest(root));
  runOk(siann(['workflow', 'apply-plan', approved, '--out', path.join(root, 'cmd.json'), '--run',
    '--device', 'fake', '--json'], engineEnv()));
  const journal = readJson(path.join(root, 'journal.json'));
  assert.equal(journal.batches[0].status, 'applied');
  assert.match(journal.batches[0].appliedRevision, /^r\d+$/);
});

// relative path -> sha256 of every file under <bundle>/<dir>, in sorted order.
function hashTree(bundle, dirs) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push([path.relative(bundle, full).split(path.sep).join('/'),
        crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  };
  for (const dir of dirs) {
    const full = path.join(bundle, dir);
    if (fs.existsSync(full)) walk(full);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// m3-rollback acceptance item 2 through the bridge (architecture spec, "Plans":
// a rollback changes only the document; "Session bundle": renders/ is never
// touched by rollback): the imported media, its peaks and the render stay byte
// for byte.
test('G: rollback --run against siann-engine', { skip: GATE }, (t) => {
  const root = tempRoot(t, 'siann-g-rollback-');
  const env = engineEnv();
  writeWav(path.join(root, 'tone.wav'), 440);
  const bundle = path.join(root, 'Keep.siann');
  const journalFile = path.join(root, 'journal.json');
  const commandFile = path.join(root, 'cmd.json');
  writeJson(commandFile, {
    schemaVersion: 'siann.command.v0',
    journalPath: journalFile,
    commands: [
      { op: 'create_session', sessionDir: bundle, sessionName: 'Keep', sampleRate: 48000 },
      { op: 'create_audio_track', name: 'Tone' },
      { op: 'import_audio', path: path.join(root, 'tone.wav'), trackName: 'Tone', regionName: 'Tone 1', start: '0' },
      { op: 'save_session' },
      { op: 'render', outputPath: path.join(root, 'out.wav') },
    ],
  });
  runRun(siann(['run', commandFile, '--device', 'fake', '--json'], env));
  const journal = readJson(journalFile);
  const dirs = ['media', 'renders', 'peaks'];
  const before = hashTree(journal.bundle, dirs);
  for (const dir of dirs) {
    assert.ok(before.some(([file]) => file.startsWith(`${dir}/`)), `${dir}/ is not empty: ${before.map(([f]) => f)}`);
  }

  const rolledBack = runOk(siann(['rollback', journalFile, '--run', '--device', 'fake', '--json'], env));

  assert.deepEqual(hashTree(journal.bundle, dirs), before);
  assert.equal(rolledBack.run.result.results.at(-1).documentHash, journal.batches[0].preState.documentHash);
});

function runRun(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true, JSON.stringify(summary.error));
  return summary;
}
