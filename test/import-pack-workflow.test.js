const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  buildImportPackCommand,
  loadImportPackManifest,
  writeImportPackCommand,
} = require('../src/workflows/import-pack');

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
    },
  };
}

test('buildImportPackCommand turns a manifest into an engine command batch', () => {
  const root = '/tmp/siann-import-pack-unit';
  const command = buildImportPackCommand(manifest(root));

  assert.equal(command.schemaVersion, 'siann.command.v0');
  assert.equal(command.journalPath, path.join(root, 'journal.json'));
  assert.equal(command.batchRisk, 'normal');
  // The native engine has no snapshot retention, track input channels, render
  // bit depth or normalisation; the command file does not carry them.
  assert.equal('snapshotRetention' in command, false);
  assert.deepEqual(command.commands.map((entry) => entry.op), [
    'create_session',
    'create_audio_track',
    'create_audio_track',
    'import_audio',
    'import_audio',
    'save_session',
    'render',
    'observe_session',
  ]);
  assert.equal(command.commands[3].trackName, 'FX Risers');
  assert.equal(command.commands[3].regionName, 'Riser 01');
  assert.equal(command.commands[3].sourceStart, '1');
  assert.equal(command.commands[3].duration, '3');
  assert.equal(command.commands[6].outputPath, path.join(root, 'preview.wav'));
  assert.deepEqual(command.commands[6], { op: 'render', outputPath: path.join(root, 'preview.wav'), sampleRate: 48000 });
  for (const track of command.commands.filter((entry) => entry.op === 'create_audio_track')) {
    assert.equal('inputChannels' in track, false);
  }
});

// siann-engine renders 32-bit float WAV at the session rate, unnormalised
// (spec, Jobs v0): a preview asking for another format is refused when the
// command file is built, not narrowed when it runs.
for (const [label, preview, pattern] of [
  ['a 16-bit preview', { bitDepth: '16' }, /bitDepth/],
  ['a normalised preview', { normalize: true }, /normalize/],
  ['a preview at another rate than the session', { sampleRate: 44100 }, /44100/],
]) {
  test(`buildImportPackCommand refuses ${label} with render_format_unsupported`, () => {
    const data = manifest('/tmp/siann-import-pack-format');
    Object.assign(data.preview, preview);
    assert.throws(() => buildImportPackCommand(data), (error) => error.code === 'render_format_unsupported'
      && pattern.test(error.message));
  });
}

test('buildImportPackCommand accepts a preview that states the engine format', () => {
  const data = manifest('/tmp/siann-import-pack-format');
  Object.assign(data.preview, { bitDepth: 'float32', normalize: false });
  const render = buildImportPackCommand(data).commands.find((entry) => entry.op === 'render');
  assert.deepEqual(Object.keys(render).sort(), ['op', 'outputPath', 'sampleRate']);
});

test('loadImportPackManifest rejects assets targeting unknown tracks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-invalid-'));
  const file = path.join(tmp, 'manifest.json');
  const data = manifest(tmp);
  data.assets[0].trackName = 'Missing Track';
  writeJson(file, data);

  assert.throws(() => loadImportPackManifest(file), /unknown trackName: Missing Track/);
});

test('writeImportPackCommand writes a generated command file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-write-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const outFile = path.join(tmp, 'generated.command.json');
  writeJson(manifestFile, manifest(tmp));

  const summary = writeImportPackCommand(manifestFile, outFile);

  assert.equal(summary.manifestFile, manifestFile);
  assert.equal(summary.commandFile, outFile);
  assert.equal(summary.commandCount, 8);
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).commands[0].op, 'create_session');
});

test('writeImportPackCommand resolves relative manifest paths from the manifest directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-relative-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const outFile = path.join(tmp, 'generated.command.json');
  const data = manifest(tmp);
  data.session.dir = 'Session';
  data.journalPath = 'journal.json';
  data.assets[0].path = 'audio/riser.wav';
  data.preview.outputPath = 'preview.wav';
  writeJson(manifestFile, data);

  writeImportPackCommand(manifestFile, outFile);
  const command = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  assert.equal(command.journalPath, path.join(tmp, 'journal.json'));
  assert.equal(command.commands[0].sessionDir, path.join(tmp, 'Session'));
  assert.equal(command.commands[3].path, path.join(tmp, 'audio', 'riser.wav'));
  assert.equal(command.commands[6].outputPath, path.join(tmp, 'preview.wav'));
});

test('siann workflow import-pack writes a command summary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-import-pack-cli-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const outFile = path.join(tmp, 'generated.command.json');
  writeJson(manifestFile, manifest(tmp));

  const cli = path.join(__dirname, '..', 'bin', 'siann.js');
  const result = spawnSync(process.execPath, [cli, 'workflow', 'import-pack', manifestFile, '--out', outFile, '--json'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.workflow, 'import-pack');
  assert.equal(summary.commandFile, outFile);
  assert.equal(summary.commandCount, 8);
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).commands.at(-2).op, 'render');
});
