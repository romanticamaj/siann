'use strict';

// src/bridge/runner.js runs siann.command.v0 files through the native client
// (m5b-bridge-native-client, acceptance items 1 and 3) against the in-process
// fake engine: session.create, media.import per file with job.status, one
// plan for the tracks and clips (submitted, approved, applied), session.save,
// render.start, session.inspect; and the siann.command_journal.v1 it writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  framesOf,
  runCommandFile,
  summarizeJournal,
  validateJournal,
} = require('../src/bridge/runner');
const { buildImportPackCommand } = require('../src/workflows/import-pack');
const { planHash } = require('../src/hash/plan-hash');
const { writeWav } = require('../scripts/create-demo-audio');
const { inProcessClient, removeTree } = require('./helpers/fake-child');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(root));
  return root;
}

// An import-pack command file: two tracks, two placed files, a save, a
// preview render and an observe, as `workflow apply-plan` writes it.
function importPack(root, overrides = {}) {
  fs.mkdirSync(path.join(root, 'audio'), { recursive: true });
  writeWav(path.join(root, 'audio', 'riser.wav'), 660);
  writeWav(path.join(root, 'audio', 'impact.wav'), 110);
  const manifest = {
    schemaVersion: 'siann.import_pack.v0',
    session: { dir: path.join(root, 'Session'), name: 'RunnerDemo', sampleRate: 48000 },
    journalPath: path.join(root, 'journal.json'),
    tracks: [{ name: 'FX' }, { name: 'Impacts', outputChannels: 1 }],
    assets: [
      { id: 'fx_01', path: path.join(root, 'audio', 'riser.wav'), trackName: 'FX', regionName: 'FX 01',
        start: '1', duration: '0.25' },
      { id: 'impact_01', path: path.join(root, 'audio', 'impact.wav'), trackName: 'Impacts',
        regionName: 'Impact 01', start: '00:02.5', sourceStart: '0.1' },
    ],
    preview: { outputPath: path.join(root, 'preview.wav') },
    ...overrides,
  };
  const command = buildImportPackCommand(manifest);
  const file = path.join(root, 'import-pack.command.json');
  writeJson(file, command);
  return { file, command, manifest };
}

const methods = (engine) => engine.calls.map((call) => call.method);

test('framesOf converts the manifest times to frames at the session rate', () => {
  assert.equal(framesOf('8', 48000), 384000);
  assert.equal(framesOf('0.25', 48000), 12000);
  assert.equal(framesOf('00:02.5', 48000), 120000);
  assert.equal(framesOf('1:00:00', 1000), 3600000);
  assert.equal(framesOf('0.0000104', 48000), 0);
  for (const bad of ['', '-1', '1e3', 'abc', '1:2', '00:60']) {
    assert.throws(() => framesOf(bad, 48000), { code: 'invalid_time' }, bad);
  }
});

test('an import-pack command file runs as session.create, imports, one plan, save, render, inspect', async (t) => {
  const root = tempRoot(t, 'siann-runner-');
  const { file } = importPack(root);
  const { engine, client } = await inProcessClient(t);

  const summary = await runCommandFile(file, { client });

  assert.equal(summary.ok, true, JSON.stringify(summary.error));
  assert.deepEqual(methods(engine), [
    'engine.status',
    'session.create',
    'session.sync',
    'media.import', 'job.status', 'job.status',
    'media.import', 'job.status', 'job.status',
    'session.inspect',
    'plan.submit', 'plan.approve', 'plan.apply',
    'session.inspect',
    'session.save',
    'render.start', 'job.status', 'job.status',
    'session.inspect',
  ]);
  const create = engine.calls.find((call) => call.method === 'session.create');
  assert.deepEqual(create.params, { path: path.join(root, 'Session'), name: 'RunnerDemo' });
  const imports = engine.calls.filter((call) => call.method === 'media.import');
  assert.deepEqual(imports.map((call) => call.params.path),
    [path.join(root, 'audio', 'riser.wav'), path.join(root, 'audio', 'impact.wav')]);
  assert.equal(new Set(imports.map((call) => call.params.clientImportId)).size, 2);

  const submit = engine.calls.find((call) => call.method === 'plan.submit');
  assert.deepEqual(submit.params.steps.map((step) => step.op), ['track.add', 'track.add', 'clip.place', 'clip.place']);
  const [fx, impacts, fxClip, impactClip] = submit.params.steps;
  assert.equal(fx.name, 'FX');
  assert.equal(fx.channels, 2);
  assert.equal(impacts.channels, 1);
  assert.equal(fxClip.trackId, fx.trackId);
  assert.deepEqual(fxClip.position, { domain: 'audio', value: '48000' });
  assert.equal(fxClip.sourceStart, '0');
  assert.equal(fxClip.length, '12000');
  assert.equal(impactClip.trackId, impacts.trackId);
  assert.deepEqual(impactClip.position, { domain: 'audio', value: '120000' });
  assert.equal(impactClip.sourceStart, '4800');
  // No duration: the rest of the file (0.5 s at 48 kHz) after sourceStart.
  assert.equal(impactClip.length, String(24000 - 4800));

  // The preview render is copied out of the bundle to its outputPath.
  assert.equal(fs.existsSync(path.join(root, 'preview.wav')), true);
  assert.equal(fs.readFileSync(path.join(root, 'preview.wav')).subarray(0, 4).toString('ascii'), 'RIFF');

  assert.deepEqual(summary.result.results.map((r) => r.op), [
    'create_session', 'create_audio_track', 'create_audio_track', 'import_audio', 'import_audio',
    'save_session', 'render', 'observe_session',
  ]);
  assert.ok(summary.result.results.every((r) => r.ok));
});

test('the journal is siann.command_journal.v1 with the bundle, plan hash, revisions and hashes', async (t) => {
  const root = tempRoot(t, 'siann-runner-journal-');
  const { file } = importPack(root);
  const inspected = [];
  const { engine, client } = await inProcessClient(t, {
    onRequest: (request, fake) => {
      if (request.method === 'session.inspect' && fake.session) inspected.push(fake.session.head.documentHash);
    },
  });

  const summary = await runCommandFile(file, { client });
  assert.equal(summary.ok, true, JSON.stringify(summary.error));

  const journal = JSON.parse(fs.readFileSync(path.join(root, 'journal.json'), 'utf8'));
  assert.equal(journal.schemaVersion, 'siann.command_journal.v1');
  assert.equal(journal.status, 'applied');
  assert.equal(journal.bundle, path.join(root, 'Session'));
  assert.equal(journal.commandFile, file);
  assert.equal(journal.batches.length, 1);
  const [batch] = journal.batches;
  const submitted = engine.calls.find((call) => call.method === 'plan.submit');
  const plan = engine.plans.get(batch.planHash);
  assert.ok(plan, 'the journal names the plan the engine holds');
  assert.equal(batch.planHash, planHash(plan));
  assert.deepEqual(plan.steps, submitted.params.steps);
  assert.equal(batch.status, 'applied');
  assert.equal(batch.baseRevision, plan.baseRevision);
  assert.equal(batch.appliedRevision, plan.appliedRevision);
  // The engine-assigned stable IDs the plan touched (ADR-0011): the applied
  // revision's diff as plan.apply returned it.
  const appliedDiff = engine.session.revision(plan.appliedRevision).diff;
  assert.deepEqual(batch.touchedIds, appliedDiff);
  assert.deepEqual(batch.touchedIds, [
    'root:root', // track.add changes the root's trackOrder
    ...plan.steps.filter((s) => s.op === 'track.add').map((s) => `track:${s.trackId}`).sort(),
    ...plan.steps.filter((s) => s.op === 'clip.place').map((s) => `clip:${s.clipId}`).sort(),
  ]);
  assert.equal(batch.preState.revision, plan.baseRevision);
  // Before plan.apply, after the imports: the hash rollback returns to.
  assert.equal(batch.preState.documentHash, inspected[0]);
  assert.equal(batch.postState.revision, plan.appliedRevision);
  assert.equal(batch.postState.documentHash, inspected[1]);
  assert.notEqual(batch.preState.documentHash, batch.postState.documentHash);
  assert.equal(batch.entries.filter((e) => e.op === 'track.add').length, 2);
  assert.equal(journal.media.length, 2);
  assert.match(journal.media[0].mediaId, /^med_/);

  assert.deepEqual(summarizeJournal(journal, '/j.json'), {
    path: '/j.json', journalId: journal.journalId, status: 'applied', risk: 'normal', entryCount: 4,
    bundle: path.join(root, 'Session'), planHash: batch.planHash, appliedRevision: batch.appliedRevision,
  });
  assert.equal(summary.journal.planHash, batch.planHash);
});

test('a plan hash the engine reports that is not the Node hash stops before approval', async (t) => {
  const root = tempRoot(t, 'siann-runner-hash-');
  const { file } = importPack(root);
  const { engine, client } = await inProcessClient(t, { handlers: {
    'plan.submit': (params, ctx) => ({ ...ctx.methods['plan.submit'](params, ctx), hash: `sha256:${'0'.repeat(64)}` }),
  } });

  const summary = await runCommandFile(file, { client });

  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'plan_hash_mismatch');
  assert.ok(!methods(engine).includes('plan.approve'));
  const journal = JSON.parse(fs.readFileSync(path.join(root, 'journal.json'), 'utf8'));
  assert.equal(journal.status, 'failed');
  assert.equal(journal.error.code, 'plan_hash_mismatch');
});

test('a create_session at a rate the engine does not run is refused before anything is created', async (t) => {
  const root = tempRoot(t, 'siann-runner-rate-');
  const { file } = importPack(root, { session: { dir: path.join(root, 'Session'), name: 'Rate', sampleRate: 44100 } });
  const { engine, client } = await inProcessClient(t, { sampleRate: 48000 });

  const summary = await runCommandFile(file, { client });

  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'sample_rate_mismatch');
  assert.match(summary.error.message, /44100/);
  assert.deepEqual(methods(engine), ['engine.status']);
  assert.equal(fs.existsSync(path.join(root, 'Session')), false);
});

// siann-engine's render.start takes {name, start?, frames?} (spec, Jobs v0) and
// writes 32-bit float WAV at the session rate, unnormalised. A render op asking
// for anything else is refused before anything is created, never narrowed.
for (const [label, fields, pattern] of [
  ['a 16-bit render', { bitDepth: '16' }, /bitDepth/],
  ['a 24-bit render', { bitDepth: 24 }, /bitDepth/],
  ['a normalised render', { normalize: true }, /normalize/],
  ['a render at another rate than the session', { sampleRate: 44100 }, /44100/],
]) {
  test(`${label} is refused with render_format_unsupported before anything is created`, async (t) => {
    const root = tempRoot(t, 'siann-runner-render-format-');
    const { file, command } = importPack(root);
    Object.assign(command.commands.find((c) => c.op === 'render'), fields);
    writeJson(file, command);
    const { engine, client } = await inProcessClient(t);

    const summary = await runCommandFile(file, { client });

    assert.equal(summary.ok, false);
    assert.equal(summary.error.code, 'render_format_unsupported');
    assert.equal(summary.error.op, 'render');
    assert.match(summary.error.message, pattern);
    assert.ok(!methods(engine).includes('session.create'), methods(engine).join(','));
    assert.ok(!methods(engine).includes('render.start'));
    assert.equal(fs.existsSync(path.join(root, 'Session')), false);
    assert.equal(fs.existsSync(path.join(root, 'preview.wav')), false);
  });
}

test('a render at another rate than an opened session is refused before render.start', async (t) => {
  const root = tempRoot(t, 'siann-runner-render-open-');
  const { file, command } = importPack(root);
  writeJson(file, command);
  const { client } = await inProcessClient(t);
  const created = await runCommandFile(file, { client });
  assert.equal(created.ok, true, JSON.stringify(created.error));

  const reopen = path.join(root, 'render.command.json');
  writeJson(reopen, {
    schemaVersion: 'siann.command.v0',
    commands: [
      { op: 'open_session', sessionDir: path.join(root, 'Session') },
      { op: 'render', outputPath: path.join(root, 'again.wav'), sampleRate: 96000 },
    ],
  });
  const { engine, client: second } = await inProcessClient(t);
  const summary = await runCommandFile(reopen, { client: second });

  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'render_format_unsupported');
  assert.match(summary.error.message, /96000/);
  assert.ok(!methods(engine).includes('render.start'));
  assert.equal(fs.existsSync(path.join(root, 'again.wav')), false);
});

test('a render that states the engine format (float32, unnormalised, the session rate) runs', async (t) => {
  const root = tempRoot(t, 'siann-runner-render-float-');
  const { file, command } = importPack(root);
  Object.assign(command.commands.find((c) => c.op === 'render'), { bitDepth: 'float32', normalize: false,
    sampleRate: 48000 });
  writeJson(file, command);
  const { client } = await inProcessClient(t);

  const summary = await runCommandFile(file, { client });

  assert.equal(summary.ok, true, JSON.stringify(summary.error));
  assert.equal(fs.existsSync(path.join(root, 'preview.wav')), true);
});

// The Ardour runner's create_audio_track inputChannels and the file's
// snapshotRetention have no native counterpart (track.add takes channels; a v1
// journal holds no snapshots), so a file that sets them is refused.
for (const [label, mutate, field] of [
  ['a track with inputChannels', (command) => { command.commands[1].inputChannels = 1; }, 'inputChannels'],
  ['a file with snapshotRetention', (command) => { command.snapshotRetention = { maxCount: 3 }; },
    'snapshotRetention'],
]) {
  test(`${label} is refused with unsupported_field before anything is created`, async (t) => {
    const root = tempRoot(t, 'siann-runner-field-');
    const { file, command } = importPack(root);
    mutate(command);
    writeJson(file, command);
    const { engine, client } = await inProcessClient(t);

    const summary = await runCommandFile(file, { client });

    assert.equal(summary.ok, false);
    assert.equal(summary.error.code, 'unsupported_field');
    assert.match(summary.error.message, new RegExp(field));
    assert.ok(!methods(engine).includes('session.create'));
    assert.equal(fs.existsSync(path.join(root, 'Session')), false);
  });
}

test('a placement on a track the file does not create is refused before its import', async (t) => {
  const root = tempRoot(t, 'siann-runner-track-');
  const { file, command } = importPack(root);
  command.commands = command.commands.filter((c) => !(c.op === 'create_audio_track' && c.name === 'Impacts'));
  writeJson(file, command);
  const { engine, client } = await inProcessClient(t);

  const summary = await runCommandFile(file, { client });

  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'unknown_track');
  assert.equal(methods(engine).filter((m) => m === 'media.import').length, 1);
  assert.ok(!methods(engine).includes('plan.submit'));
});

test('a failed import fails the run with the job error and submits no plan', async (t) => {
  const root = tempRoot(t, 'siann-runner-import-');
  const { file } = importPack(root);
  fs.rmSync(path.join(root, 'audio', 'impact.wav'));
  const { engine, client } = await inProcessClient(t);

  const summary = await runCommandFile(file, { client });

  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'not_found');
  assert.equal(summary.error.op, 'import_audio');
  assert.ok(!methods(engine).includes('plan.submit'));
});

test('rollback_plan opens the bundle and calls plan.rollback with the revision', async (t) => {
  const root = tempRoot(t, 'siann-runner-rollback-');
  const { file } = importPack(root);
  const first = await inProcessClient(t);
  assert.equal((await runCommandFile(file, { client: first.client })).ok, true);
  const journal = JSON.parse(fs.readFileSync(path.join(root, 'journal.json'), 'utf8'));
  await first.client.stop();

  const rollbackFile = path.join(root, 'rollback.command.json');
  writeJson(rollbackFile, { schemaVersion: 'siann.command.v0', commands: [
    { op: 'open_session', sessionDir: journal.bundle },
    { op: 'rollback_plan', revision: journal.batches[0].appliedRevision },
    { op: 'observe_session' },
  ] });
  const second = await inProcessClient(t);
  const summary = await runCommandFile(rollbackFile, { client: second.client });

  assert.equal(summary.ok, true, JSON.stringify(summary.error));
  assert.deepEqual(methods(second.engine), ['session.open', 'plan.rollback', 'session.inspect']);
  assert.deepEqual(second.engine.calls[1].params, { revision: journal.batches[0].appliedRevision });
  const observed = summary.result.results.at(-1);
  assert.equal(observed.documentHash, journal.batches[0].preState.documentHash);
});

test('validateJournal accepts v1 and refuses the Ardour-era v0 with a clear message', () => {
  assert.throws(() => validateJournal({ schemaVersion: 'siann.command_journal.v0', journalId: 'x', batches: [] }),
    /siann\.command_journal\.v0.*Ardour/);
  assert.throws(() => validateJournal({ schemaVersion: 'siann.command_journal.v1', journalId: 'x' }),
    /batches must be an array/);
  assert.throws(() => validateJournal({ schemaVersion: 'siann.command_journal.v1', journalId: 'x', bundle: '/b',
    status: 'applied', batches: [{ status: 'applied', risk: 'normal', entries: [], planHash: 'nope' }] }), /planHash/);
  for (const touchedIds of ['track:trk_1', ['trk_1'], [7], ['track:']]) {
    assert.throws(() => validateJournal({ schemaVersion: 'siann.command_journal.v1', journalId: 'x', bundle: '/b',
      status: 'applied', batches: [{ status: 'applied', risk: 'normal', entries: [], touchedIds }] }), /touchedIds/);
  }
  const ok = { schemaVersion: 'siann.command_journal.v1', journalId: 'x', bundle: '/b', status: 'failed', batches: [] };
  assert.equal(validateJournal(ok), ok);
});

test('runner.js no longer spawns the Ardour command runner', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge', 'runner.js'), 'utf8');
  for (const gone of ['ardour9-siann_command', 'ardev_common_waf', 'SIANN_ENGINE_DIR', 'engineDir']) {
    assert.ok(!source.includes(gone), gone);
  }
});
