'use strict';

// `siann workflow reject-plan` through bin/siann.js (m5b-bridge-cli-coverage,
// acceptance item 1; docs/schemas/import-pack-plan-v1.md, "Rejection"): the
// rejected plan keeps its hash chain, approved and tampered plans are rejected
// without a hash being recomputed, a rejected plan is refused, usage errors
// exit 1, and approve-plan and apply-plan refuse a rejected plan.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { removeTree } = require('./helpers/fake-child');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');

function siann(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function json(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A pending plan (workflow import-pack --plan) and its approved copy.
function plans(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(tmp));
  const manifestFile = path.join(tmp, 'manifest.json');
  writeJson(manifestFile, {
    schemaVersion: 'siann.import_pack.v0',
    session: { dir: path.join(tmp, 'Session'), name: 'RejectDemo', sampleRate: 48000 },
    journalPath: path.join(tmp, 'journal.json'),
    tracks: [{ name: 'Tone', outputChannels: 2 }],
    assets: [{ id: 'tone', path: path.join(tmp, 'tone.wav'), trackName: 'Tone', regionName: 'Tone 1', start: '0' }],
  });
  const planFile = path.join(tmp, 'plan.json');
  json(siann(['workflow', 'import-pack', manifestFile, '--plan', planFile, '--json']));
  const approvedFile = path.join(tmp, 'approved.json');
  json(siann(['workflow', 'approve-plan', planFile, '--out', approvedFile, '--approved-by', 'ben', '--json']));
  return { tmp, planFile, approvedFile };
}

function validate(file) {
  return JSON.parse(siann(['workflow', 'validate-plan', file, '--json']).stdout);
}

test('reject-plan with a reviewer and a reason writes a rejected plan whose hash chain is intact', (t) => {
  const { tmp, planFile } = plans(t, 'siann-cli-reject-');
  const sourceBytes = fs.readFileSync(planFile, 'utf8');
  const out = path.join(tmp, 'r.json');

  const summary = json(siann(['workflow', 'reject-plan', planFile, '--out', out,
    '--rejected-by', 'ana', '--reason', 'wrong tempo', '--json']));

  assert.equal(summary.ok, true);
  assert.equal(summary.workflow, 'reject-plan');
  assert.equal(summary.reviewState, 'rejected');
  assert.equal(summary.rejectedBy, 'ana');
  assert.equal(summary.reason, 'wrong tempo');
  assert.equal(summary.planFile, out);
  const source = JSON.parse(sourceBytes);
  const rejected = readJson(out);
  assert.equal(rejected.review.state, 'rejected');
  assert.equal(rejected.review.rejectedBy, 'ana');
  assert.equal(rejected.review.reason, 'wrong tempo');
  assert.match(rejected.review.rejectedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(rejected.command), JSON.stringify(source.command));
  assert.equal(rejected.integrity.commandHash, source.integrity.commandHash);
  const validation = validate(out);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.equal(validation.commandHash, source.integrity.commandHash);
  assert.equal(validation.approvable, false);
  assert.equal(validation.applicable, false);
  assert.equal(fs.readFileSync(planFile, 'utf8'), sourceBytes, 'the source plan is untouched');
});

test('reject-plan without --json prints the text summary', (t) => {
  const { tmp, planFile } = plans(t, 'siann-cli-reject-text-');
  const result = siann(['workflow', 'reject-plan', planFile, '--out', path.join(tmp, 'r.json')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: true$/m);
});

test('reject-plan on an approved plan rejects it, and apply-plan then refuses it', (t) => {
  const { tmp, approvedFile } = plans(t, 'siann-cli-reject-approved-');
  const out = path.join(tmp, 'r.json');
  assert.equal(json(siann(['workflow', 'reject-plan', approvedFile, '--out', out, '--json'])).reviewState, 'rejected');
  assert.equal(readJson(out).review.state, 'rejected');
  assert.equal(validate(out).applicable, false);
  const commandFile = path.join(tmp, 'cmd.json');
  const apply = siann(['workflow', 'apply-plan', out, '--out', commandFile, '--json']);
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /plan must be approved before apply/);
  assert.equal(fs.existsSync(commandFile), false);
});

test('reject-plan on a rejected plan exits 1, writes nothing and keeps the first rejection', (t) => {
  const { tmp, planFile } = plans(t, 'siann-cli-reject-twice-');
  const once = path.join(tmp, 'once.json');
  const twice = path.join(tmp, 'twice.json');
  json(siann(['workflow', 'reject-plan', planFile, '--out', once, '--rejected-by', 'ana', '--reason', 'first', '--json']));
  const onceBytes = fs.readFileSync(once, 'utf8');
  const result = siann(['workflow', 'reject-plan', once, '--out', twice,
    '--rejected-by', 'ben', '--reason', 'second', '--json']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /plan is already rejected/);
  assert.equal(fs.existsSync(twice), false);
  assert.equal(fs.readFileSync(once, 'utf8'), onceBytes);
});

test('reject-plan on a tampered plan rejects it and validate-plan still reports command_hash_mismatch', (t) => {
  const { tmp, planFile } = plans(t, 'siann-cli-reject-tampered-');
  const plan = readJson(planFile);
  plan.command.commands.find((c) => c.op === 'import_audio').regionName = 'Tampered';
  writeJson(planFile, plan);
  const out = path.join(tmp, 'r.json');

  assert.equal(json(siann(['workflow', 'reject-plan', planFile, '--out', out, '--json'])).reviewState, 'rejected');
  const rejected = readJson(out);
  assert.equal(rejected.integrity.commandHash, plan.integrity.commandHash, 'the hash is not recomputed');
  const result = siann(['workflow', 'validate-plan', out, '--json']);
  assert.equal(result.status, 1);
  const validation = JSON.parse(result.stdout);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => issue.code === 'command_hash_mismatch'), result.stdout);
});

test('approve-plan and apply-plan refuse a rejected plan and write nothing', (t) => {
  const { tmp, planFile } = plans(t, 'siann-cli-reject-refused-');
  const rejected = path.join(tmp, 'r.json');
  json(siann(['workflow', 'reject-plan', planFile, '--out', rejected, '--json']));

  const approved = path.join(tmp, 'approved-again.json');
  const approve = siann(['workflow', 'approve-plan', rejected, '--out', approved, '--json']);
  assert.equal(approve.status, 1);
  assert.match(approve.stderr, /only pending plans can be approved/);
  assert.equal(fs.existsSync(approved), false);

  const commandFile = path.join(tmp, 'cmd.json');
  const apply = siann(['workflow', 'apply-plan', rejected, '--out', commandFile, '--json']);
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /plan must be approved before apply/);
  assert.equal(fs.existsSync(commandFile), false);
});

test('reject-plan usage errors exit 1 with the usage on stderr', (t) => {
  const { tmp, planFile } = plans(t, 'siann-cli-reject-usage-');
  for (const args of [
    ['workflow', 'reject-plan'],
    ['workflow', 'reject-plan', '--out', path.join(tmp, 'r.json')],
    ['workflow', 'reject-plan', planFile],
    ['workflow', 'reject-plan', planFile, '--out', path.join(tmp, 'r.json'), '--approved-by', 'x'],
    ['workflow', 'reject-plan', planFile, '--out', path.join(tmp, 'r.json'), '--run'],
    ['workflow', 'reject-plan', planFile, '--out'],
  ]) {
    const result = siann(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage:/, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(tmp, 'r.json')), false);
});

test('reject-plan on an unreadable plan file exits 1 with the message', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-cli-reject-missing-'));
  t.after(() => removeTree(tmp));
  const missing = siann(['workflow', 'reject-plan', path.join(tmp, 'none.json'), '--out', path.join(tmp, 'r.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT|no such file/i);
  const notPlan = path.join(tmp, 'not-a-plan.json');
  writeJson(notPlan, { schemaVersion: 'something.else' });
  const wrong = siann(['workflow', 'reject-plan', notPlan, '--out', path.join(tmp, 'r.json')]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /schemaVersion must be one of/);
  assert.equal(fs.existsSync(path.join(tmp, 'r.json')), false);
});
