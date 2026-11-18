'use strict';

// `siann live import-pack` (src/workflows/live-import-pack.js) runs a manifest
// in one native engine process (m5b-bridge-native-client, acceptance item 4):
// against the fake engine always, against siann-engine when
// SIANN_RUN_ENGINE_TESTS=1 (SIANN_ENGINE_EXE, else the core preset's build).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { runLiveImportPack } = require('../src/workflows/live-import-pack');
const { resolveEngineExe } = require('../src/runtime/client');
const { writeDemoImportPack } = require('../scripts/create-demo-import-pack');
const { inProcessClient, removeTree } = require('./helpers/fake-child');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');
const FAKE_ENGINE = path.join(__dirname, 'helpers', 'fake-engine.js');
const ENGINE_GATE = process.env.SIANN_RUN_ENGINE_TESTS === '1'
  ? false
  : 'engine-gated: set SIANN_RUN_ENGINE_TESTS=1 (and SIANN_ENGINE_EXE, else native/build/dev) to run against siann-engine';

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(root));
  return root;
}

test('runLiveImportPack runs the manifest through one engine: create, imports, one plan, save, preview', async (t) => {
  const root = tempRoot(t, 'siann-live-unit-');
  const { manifestFile } = writeDemoImportPack(root);
  const { engine, client } = await inProcessClient(t);

  const summary = await runLiveImportPack(manifestFile, { client });

  assert.equal(summary.ok, true, JSON.stringify(summary.error));
  assert.equal(summary.workflow, 'live-import-pack');
  assert.equal(summary.session.name, 'ImportPackDemo');
  assert.equal(summary.session.bundle, path.join(root, 'Session'));
  assert.equal(summary.apply.trackCount, 2);
  assert.equal(summary.apply.clipCount, 2);
  assert.match(summary.apply.planHash, /^sha256:/);
  assert.match(summary.apply.appliedRevision, /^r\d+$/);
  assert.equal(summary.preview.outputPath, path.join(root, 'preview.wav'));
  assert.equal(fs.existsSync(summary.preview.outputPath), true);
  assert.equal(summary.journal.path, path.join(root, 'journal.json'));
  assert.equal(summary.saved, true);
  const plan = engine.calls.filter((c) => c.method.startsWith('plan.')).map((c) => c.method);
  assert.deepEqual(plan, ['plan.submit', 'plan.approve', 'plan.apply']);
});

test('siann live import-pack runs the live workflow from the CLI', (t) => {
  const root = tempRoot(t, 'siann-live-cli-');
  const { manifestFile } = writeDemoImportPack(root);
  const result = spawnSync(process.execPath, [CLI, 'live', 'import-pack', manifestFile, '--runner', FAKE_ENGINE,
    '--json'], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.workflow, 'live-import-pack');
  assert.equal(summary.apply.clipCount, 2);
});

test('siann live import-pack creates a native session with its tracks, clips and preview', { skip: ENGINE_GATE }, (t) => {
  const exe = resolveEngineExe();
  const root = tempRoot(t, 'siann-live-engine-');
  const { manifestFile } = writeDemoImportPack(root);

  const result = spawnSync(process.execPath, [CLI, 'live', 'import-pack', manifestFile, '--device', 'fake', '--json'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SIANN_ENGINE_EXE: exe } });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.apply.trackCount, 2);
  assert.equal(summary.apply.clipCount, 2);
  assert.equal(fs.existsSync(path.join(root, 'Session', 'journal.ndjson')), true, 'a native bundle');
  assert.equal(fs.statSync(summary.preview.outputPath).size > 44, true);
  const journal = JSON.parse(fs.readFileSync(summary.journal.path, 'utf8'));
  assert.equal(journal.schemaVersion, 'siann.command_journal.v1');
  assert.equal(journal.batches[0].planHash, summary.apply.planHash);
});
