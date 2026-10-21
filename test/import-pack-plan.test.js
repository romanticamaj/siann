const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  applyImportPackPlan,
  approveImportPackPlan,
  buildImportPackPlan,
  validateImportPackPlan,
  writeImportPackPlan,
} = require('../src/workflows/import-pack-plan');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function manifest(root) {
  return {
    schemaVersion: 'siann.import_pack.v0',
    session: {
      dir: path.join(root, 'Session'),
      name: 'ImportPackDemo',
      sampleRate: 48000,
    },
    journalPath: path.join(root, 'journal.json'),
    batchRisk: 'normal',
    snapshotRetention: { maxCount: 3 },
    tracks: [
      { name: 'FX Risers', inputChannels: 1, outputChannels: 2 },
      { name: 'Impacts', inputChannels: 1, outputChannels: 2 },
    ],
    assets: [
      {
        id: 'riser_01',
        path: path.join(root, 'audio', 'riser.wav'),
        trackName: 'FX Risers',
        regionName: 'Riser 01',
        start: '8',
        sourceStart: '1',
        duration: '3',
      },
      {
        id: 'impact_01',
        path: path.join(root, 'audio', 'impact.wav'),
        trackName: 'Impacts',
        regionName: 'Impact 01',
        start: '12',
      },
    ],
    preview: {
      outputPath: path.join(root, 'preview.wav'),
      sampleRate: 48000,
      bitDepth: '16',
    },
  };
}

test('buildImportPackPlan creates a reviewable plan before apply', () => {
  const root = '/tmp/siann-import-pack-plan-unit';
  const plan = buildImportPackPlan(manifest(root), '/repo/examples/import-pack/manifest.json');

  assert.equal(plan.schemaVersion, 'siann.import_pack_plan.v1');
  assert.equal(plan.integrity.canonicalization, 'jcs-rfc8785');
  assert.match(plan.integrity.commandHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.workflow, 'import-pack');
  assert.equal(plan.manifestFile, '/repo/examples/import-pack/manifest.json');
  assert.deepEqual(plan.review, {
    required: true,
    state: 'pending',
    instructions: 'Review this plan before running workflow apply-plan.',
  });
  assert.deepEqual(plan.summary, {
    sessionName: 'ImportPackDemo',
    sessionDir: path.join(root, 'Session'),
    trackCount: 2,
    assetCount: 2,
    previewOutputPath: path.join(root, 'preview.wav'),
    risk: 'normal',
    journalPath: path.join(root, 'journal.json'),
    commandCount: 8,
  });
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    'create_session',
    'create_track',
    'create_track',
    'place_asset',
    'place_asset',
    'save_session',
    'render_preview',
    'observe_session',
  ]);
  assert.equal(plan.steps[3].assetId, 'riser_01');
  assert.equal(plan.steps[3].trackName, 'FX Risers');
  assert.equal(plan.steps[3].start, '8');
  assert.equal(plan.steps[3].sourceStart, '1');
  assert.equal(plan.steps[3].duration, '3');
  assert.equal(plan.command.schemaVersion, 'siann.command.v0');
  assert.equal(plan.command.commands[3].op, 'import_audio');
});

test('writeImportPackPlan writes a review file and applyImportPackPlan materializes a command file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  const approvedPlanFile = path.join(tmp, 'approved-plan.json');
  const commandFile = path.join(tmp, 'import-pack.command.json');
  writeJson(manifestFile, manifest(tmp));

  const planSummary = writeImportPackPlan(manifestFile, planFile);

  assert.equal(planSummary.ok, true);
  assert.equal(planSummary.workflow, 'import-pack');
  assert.equal(planSummary.planFile, planFile);
  assert.equal(planSummary.reviewState, 'pending');
  assert.equal(planSummary.commandCount, 8);
  assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf8')).steps[3].kind, 'place_asset');

  assert.throws(
    () => applyImportPackPlan(planFile, commandFile),
    /plan must be approved before apply/,
  );

  const approvalSummary = approveImportPackPlan(planFile, approvedPlanFile, {
    approvedBy: 'test-user',
  });

  assert.equal(approvalSummary.ok, true);
  assert.equal(approvalSummary.reviewState, 'approved');
  const approvedPlan = JSON.parse(fs.readFileSync(approvedPlanFile, 'utf8'));
  assert.equal(approvedPlan.review.approvedBy, 'test-user');
  assert.match(approvedPlan.review.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(approvedPlan.review.commandHash, approvedPlan.integrity.commandHash);

  const applySummary = applyImportPackPlan(approvedPlanFile, commandFile);

  assert.equal(applySummary.ok, true);
  assert.equal(applySummary.workflow, 'apply-plan');
  assert.equal(applySummary.planFile, approvedPlanFile);
  assert.equal(applySummary.commandFile, commandFile);
  assert.equal(applySummary.commandCount, 8);
  assert.equal(JSON.parse(fs.readFileSync(commandFile, 'utf8')).commands[6].op, 'render');
});

test('validateImportPackPlan reports approval and integrity state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-validate-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  const approvedPlanFile = path.join(tmp, 'approved-plan.json');
  writeJson(manifestFile, manifest(tmp));
  writeImportPackPlan(manifestFile, planFile);

  const pending = validateImportPackPlan(planFile);

  assert.equal(pending.ok, true);
  assert.equal(pending.reviewState, 'pending');
  assert.equal(pending.approvable, true);
  assert.deepEqual(pending.issues, []);

  approveImportPackPlan(planFile, approvedPlanFile, { approvedBy: 'test-user' });
  const approved = validateImportPackPlan(approvedPlanFile);

  assert.equal(approved.ok, true);
  assert.equal(approved.reviewState, 'approved');
  assert.equal(approved.applicable, true);
  assert.deepEqual(approved.issues, []);
});

test('applyImportPackPlan rejects tampered approved plans', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-tamper-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  const approvedPlanFile = path.join(tmp, 'approved-plan.json');
  const commandFile = path.join(tmp, 'import-pack.command.json');
  writeJson(manifestFile, manifest(tmp));
  writeImportPackPlan(manifestFile, planFile);
  approveImportPackPlan(planFile, approvedPlanFile, { approvedBy: 'test-user' });

  const approvedPlan = JSON.parse(fs.readFileSync(approvedPlanFile, 'utf8'));
  approvedPlan.command.commands[3].regionName = 'Tampered Region';
  writeJson(approvedPlanFile, approvedPlan);

  assert.throws(
    () => applyImportPackPlan(approvedPlanFile, commandFile),
    /plan command hash does not match approved hash/,
  );
});

test('siann writes, validates, approves, and applies an import-pack plan through the CLI', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-cli-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  const approvedPlanFile = path.join(tmp, 'approved-plan.json');
  const commandFile = path.join(tmp, 'import-pack.command.json');
  writeJson(manifestFile, manifest(tmp));

  const cli = path.join(__dirname, '..', 'bin', 'siann.js');
  const planResult = spawnSync(process.execPath, [
    cli,
    'workflow',
    'import-pack',
    manifestFile,
    '--plan',
    planFile,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(planResult.status, 0, planResult.stderr);
  const planSummary = JSON.parse(planResult.stdout);
  assert.equal(planSummary.planFile, planFile);
  assert.equal(planSummary.reviewState, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf8')).schemaVersion, 'siann.import_pack_plan.v1');

  const validateResult = spawnSync(process.execPath, [
    cli,
    'workflow',
    'validate-plan',
    planFile,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(validateResult.status, 0, validateResult.stderr);
  assert.equal(JSON.parse(validateResult.stdout).approvable, true);

  const rejectedApplyResult = spawnSync(process.execPath, [
    cli,
    'workflow',
    'apply-plan',
    planFile,
    '--out',
    commandFile,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.notEqual(rejectedApplyResult.status, 0);
  assert.match(rejectedApplyResult.stderr, /plan must be approved before apply/);

  const approveResult = spawnSync(process.execPath, [
    cli,
    'workflow',
    'approve-plan',
    planFile,
    '--out',
    approvedPlanFile,
    '--approved-by',
    'test-user',
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(approveResult.status, 0, approveResult.stderr);
  const approvalSummary = JSON.parse(approveResult.stdout);
  assert.equal(approvalSummary.planFile, approvedPlanFile);
  assert.equal(approvalSummary.reviewState, 'approved');

  const applyResult = spawnSync(process.execPath, [
    cli,
    'workflow',
    'apply-plan',
    approvedPlanFile,
    '--out',
    commandFile,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(applyResult.status, 0, applyResult.stderr);
  const applySummary = JSON.parse(applyResult.stdout);
  assert.equal(applySummary.workflow, 'apply-plan');
  assert.equal(applySummary.commandFile, commandFile);
  assert.equal(JSON.parse(fs.readFileSync(commandFile, 'utf8')).commands.at(-1).op, 'observe_session');
});

test('validateImportPackPlan still accepts v0 plans and verifies them with JCS', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-v0-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  writeJson(manifestFile, manifest(tmp));
  writeImportPackPlan(manifestFile, planFile);

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.schemaVersion = 'siann.import_pack_plan.v0';
  delete plan.integrity.canonicalization;
  writeJson(planFile, plan);

  const result = validateImportPackPlan(planFile);
  assert.equal(result.ok, true);
  assert.equal(result.commandHash, plan.integrity.commandHash);
});

test('validateImportPackPlan rejects unknown plan schema versions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-version-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  writeJson(manifestFile, manifest(tmp));
  writeImportPackPlan(manifestFile, planFile);

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.schemaVersion = 'siann.import_pack_plan.v9';
  writeJson(planFile, plan);

  assert.throws(() => validateImportPackPlan(planFile), /schemaVersion must be one of/);
});

test('validateImportPackPlan reports v1 plans with a different canonicalization', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-canon-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  writeJson(manifestFile, manifest(tmp));
  writeImportPackPlan(manifestFile, planFile);

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.integrity.canonicalization = 'sorted-json';
  writeJson(planFile, plan);

  const result = validateImportPackPlan(planFile);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), ['unsupported_canonicalization']);
});

test('validateImportPackPlan reports commands that cannot be canonicalized', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-plan-surrogate-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const planFile = path.join(tmp, 'plan.json');
  writeJson(manifestFile, manifest(tmp));
  writeImportPackPlan(manifestFile, planFile);

  const text = fs.readFileSync(planFile, 'utf8').replaceAll('Riser 01', 'Riser \\ud800');
  fs.writeFileSync(planFile, text);

  const result = validateImportPackPlan(planFile);
  assert.equal(result.ok, false);
  assert.equal(result.commandHash, null);
  assert.ok(result.issues.some((issue) => issue.code === 'command_not_canonicalizable'));
});
