'use strict';

// The Node bridge against the native siann-engine (m5b-bridge-native-client,
// acceptance items 3 and 4; test-matrix layer G). Gated: SIANN_RUN_ENGINE_TESTS=1
// runs it, with SIANN_ENGINE_EXE or else the core preset's build under
// native/build/dev (resolveEngineExe fails the test when neither exists, so
// a gated run never passes by skipping). The engine runs with `--device fake`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { EngineClient, RuntimeError, resolveEngineExe } = require('../src/runtime/client');
const { planHash } = require('../src/hash/plan-hash');
const { writeWav } = require('../scripts/create-demo-audio');
const { removeTree } = require('./helpers/fake-child');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');
const GATE = process.env.SIANN_RUN_ENGINE_TESTS === '1'
  ? false
  : 'engine-gated: set SIANN_RUN_ENGINE_TESTS=1 (and SIANN_ENGINE_EXE, else native/build/dev) to run against siann-engine';

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(root));
  return root;
}

// A _DAW / _SpliceSFX pack the intake planner recognises (no placement sheet:
// the files play whole), with real WAVs (scripts/create-demo-audio.js).
function fixturePack(root) {
  const source = path.join(root, 'pack');
  fs.mkdirSync(path.join(source, '_DAW'), { recursive: true });
  fs.mkdirSync(path.join(source, '_SpliceSFX'), { recursive: true });
  writeWav(path.join(source, '_DAW', '00m01s_BGM01_ToneBed_a.wav'), 220);
  writeWav(path.join(source, '_SpliceSFX', 'SFX_C01_00m02s_wood-hit.wav'), 880);
  return source;
}

function siann(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(result.status, 0, `siann ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

// One engine process for fn, stopped afterwards: it releases the bundle lock, so
// the next process (the CLI's, or the next withEngine) can open the bundle.
async function withEngine(t, fn) {
  const client = new EngineClient({ exe: resolveEngineExe(), args: ['--device', 'fake'] });
  t.after(() => client.stop());
  try {
    await client.start();
    return await fn(client);
  } finally {
    await client.stop();
  }
}

// The head document through session.sync, every chunk.
async function headDocument(client) {
  const doc = { tracks: [], clips: [], media: [] };
  let cursor;
  let first = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await client.request('session.sync', cursor ? { cursor } : {});
    first = first || chunk;
    doc.tracks.push(...chunk.chunk.tracks);
    doc.clips.push(...chunk.chunk.clips);
    doc.media.push(...chunk.chunk.media);
    cursor = chunk.next;
  } while (cursor);
  return { ...doc, revision: first.revision, documentHash: first.documentHash };
}

test('the client starts siann-engine, authenticates, maps errors and stops it', { skip: GATE }, async (t) => {
  const root = tempRoot(t, 'siann-engine-client-');
  await withEngine(t, async (client) => {
    const caps = await client.request('engine.capabilities');
    for (const method of ['session.create', 'media.import', 'plan.submit', 'plan.rollback', 'session.sync']) {
      assert.ok(caps.methods.includes(method), method);
    }
    await assert.rejects(client.request('no.such.method'), (error) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.code, 'unknown_method');
      return true;
    });
    const before = client.sessionId;
    const created = await client.request('session.create', { path: path.join(root, 'Song.siann') });
    assert.notEqual(created.sessionId, before);
    assert.equal(client.sessionId, created.sessionId);
    writeWav(path.join(root, 'tone.wav'), 440);
    const job = await client.request('media.import', { path: path.join(root, 'tone.wav'), clientImportId: 'one' });
    const done = await client.waitJob(job.jobId);
    assert.equal(done.state, 'done');
    assert.match(done.result.mediaId, /^med_/);
    assert.equal(done.result.frames, '24000');
    const missing = await client.request('media.import', { path: path.join(root, 'none.wav'), clientImportId: 'two' });
    await assert.rejects(client.waitJob(missing.jobId), { code: 'not_found' });
    // plan.rollback {revision}: exactly one of plan and revision.
    await assert.rejects(client.request('plan.rollback', {}), { code: 'invalid_params' });
  });
});

test('plan intake, validate, approve, apply --run and rollback --run against siann-engine', { skip: GATE }, async (t) => {
  const exe = resolveEngineExe();
  const env = { ...process.env, SIANN_ENGINE_EXE: exe };
  const root = tempRoot(t, 'siann-engine-workflow-');
  const source = fixturePack(root);
  const work = path.join(root, 'work');

  const intake = siann(['plan', 'intake', source, '--out', path.join(work, 'intake-plan.json')], env);
  assert.equal(intake.strategy, 'daw_zip_heuristic');
  assert.equal(intake.manifest.assetCount, 2);
  const { manifest } = JSON.parse(fs.readFileSync(path.join(work, 'intake-plan.json'), 'utf8'));
  const manifestFile = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const planFile = path.join(work, 'plan.json');
  siann(['workflow', 'import-pack', manifestFile, '--plan', planFile], env);
  assert.equal(siann(['workflow', 'validate-plan', planFile], env).ok, true);
  const approved = path.join(work, 'approved.json');
  siann(['workflow', 'approve-plan', planFile, '--out', approved, '--approved-by', 'gated-test'], env);
  const commandFile = path.join(work, 'apply.command.json');
  const applied = siann(['workflow', 'apply-plan', approved, '--out', commandFile, '--run', '--device', 'fake'], env);
  assert.equal(applied.ok, true);
  assert.equal(applied.run.ok, true);

  const journal = JSON.parse(fs.readFileSync(manifest.journalPath, 'utf8'));
  assert.equal(journal.schemaVersion, 'siann.command_journal.v1');
  assert.equal(journal.bundle, manifest.session.dir);
  const [batch] = journal.batches;
  assert.match(batch.appliedRevision, /^r\d+$/);
  assert.match(batch.preState.documentHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(batch.postState.documentHash, batch.preState.documentHash);

  // A later engine process: the plan's hash as the engine computes it equals the Node
  // hash, and session.sync shows the planned tracks and clips at the applied revision.
  await withEngine(t, async (client) => {
    await client.request('session.open', { path: journal.bundle });
    const doc = await headDocument(client);
    assert.equal(doc.revision, batch.appliedRevision);
    assert.equal(doc.documentHash, batch.postState.documentHash);
    assert.deepEqual(doc.tracks.map((tr) => tr.name).sort(), manifest.tracks.map((tr) => tr.name).sort());
    assert.equal(doc.clips.length, manifest.assets.length);
    assert.equal(doc.media.length, manifest.assets.length);
    for (const clip of doc.clips) {
      assert.ok(doc.tracks.some((tr) => tr.id === clip.trackId), `clip ${clip.id} is on a planned track`);
    }
    const steps = batch.entries.map((entry) => entry.command);
    const resubmitted = await client.request('plan.submit', { steps, baseRevision: batch.baseRevision });
    assert.equal(resubmitted.hash, batch.planHash);
    assert.equal(planHash(resubmitted), resubmitted.hash);
  });

  const rolledBack = siann(['rollback', manifest.journalPath, '--run', '--device', 'fake'], env);
  assert.equal(rolledBack.ok, true);

  await withEngine(t, async (client) => {
    await client.request('session.open', { path: journal.bundle });
    const inspected = await client.request('session.inspect');
    assert.equal(inspected.documentHash, batch.preState.documentHash);
    const doc = await headDocument(client);
    assert.deepEqual(doc.tracks, []);
    assert.deepEqual(doc.clips, []);
    assert.equal(doc.media.length, manifest.assets.length, 'rollback keeps the imported media');
  });
});
