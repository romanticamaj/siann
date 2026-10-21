const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { runLiveImportPack } = require('../src/workflows/live-import-pack');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeFakeRuntime(file) {
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    'const calls = [];',
    'let sessionId = "session_fake";',
    'let hash = "sha256:" + "0".repeat(64);',
    'const rl = readline.createInterface({ input: process.stdin });',
    'function response(request, body) {',
    '  calls.push({ method: request.method, body: request.body });',
    '  process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, type: "response", body }) + "\\n");',
    '}',
    'rl.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  if (request.method === "runtime.start") response(request, { protocolVersion: 0, capabilities: ["session.create", "commands.apply", "render.preview", "session.close", "runtime.stop"] });',
    '  else if (request.method === "session.create") response(request, { sessionId, sessionDir: request.body.sessionDir, sessionName: request.body.sessionName });',
    '  else if (request.method === "session.observe") response(request, { sessionId, observationHash: hash, observation: { routes: [] } });',
    '  else if (request.method === "commands.apply") { hash = "sha256:" + String(calls.length).padStart(64, "1"); response(request, { sessionId, results: request.body.commands.map((command, index) => ({ op: command.op, ok: true, regionId: `region_${index}` })), observationHash: hash, rollback: { rollbackId: "rollback_1" }, journal: { path: "/tmp/fake-runtime-journal.json", entryCount: 1 } }); }',
    '  else if (request.method === "render.preview") { fs.writeFileSync(request.body.outputPath, "fake wav"); response(request, { sessionId, outputPath: request.body.outputPath, sampleRate: request.body.sampleRate, bitDepth: request.body.bitDepth }); }',
    '  else if (request.method === "session.save") response(request, { sessionId, saved: true });',
    '  else if (request.method === "session.close") response(request, { sessionId, closed: true });',
    '  else if (request.method === "runtime.stop") { calls.push({ method: request.method, body: request.body }); fs.writeFileSync(process.env.SIANN_FAKE_RUNTIME_CALLS, JSON.stringify(calls, null, 2)); calls.pop(); response(request, { stopped: true }); process.exit(0); }',
    '});',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

function manifest(root) {
  return {
    schemaVersion: 'siann.import_pack.v0',
    session: {
      dir: path.join(root, 'Session'),
      name: 'LiveImportPack',
      sampleRate: 48000,
    },
    tracks: [
      { name: 'FX' },
      { name: 'Impacts' },
    ],
    assets: [
      {
        id: 'fx_01',
        path: path.join(root, 'audio', 'riser.wav'),
        trackName: 'FX',
        regionName: 'FX 01',
        start: '1',
        duration: '0.2',
      },
      {
        id: 'impact_01',
        path: path.join(root, 'audio', 'impact.wav'),
        trackName: 'Impacts',
        regionName: 'Impact 01',
        start: '2',
      },
    ],
    preview: {
      outputPath: path.join(root, 'preview.wav'),
      sampleRate: 48000,
      bitDepth: '16',
    },
  };
}

test('runLiveImportPack drives a manifest through the live runtime lifecycle', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-live-import-unit-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const callsFile = path.join(tmp, 'calls.json');
  const runtimePath = path.join(tmp, 'fake-runtime.js');
  writeJson(manifestFile, manifest(tmp));
  writeFakeRuntime(runtimePath);

  const summary = await runLiveImportPack(manifestFile, {
    runtime: {
      command: process.execPath,
      args: [runtimePath],
      env: { SIANN_FAKE_RUNTIME_CALLS: callsFile },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.workflow, 'live-import-pack');
  assert.equal(summary.session.name, 'LiveImportPack');
  assert.equal(summary.apply.commandCount, 4);
  assert.equal(summary.preview.outputPath, path.join(tmp, 'preview.wav'));
  assert.equal(summary.journal.path, '/tmp/fake-runtime-journal.json');
  assert.equal(summary.closed, true);

  const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
  assert.deepEqual(calls.map((call) => call.method), [
    'runtime.start',
    'session.create',
    'session.observe',
    'commands.apply',
    'render.preview',
    'session.save',
    'session.close',
    'runtime.stop',
  ]);
  assert.deepEqual(calls[3].body.commands.map((command) => command.op), [
    'create_audio_track',
    'create_audio_track',
    'import_audio',
    'import_audio',
  ]);
});

test('siann live import-pack runs the live workflow from the CLI', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-live-import-cli-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  const callsFile = path.join(tmp, 'calls.json');
  const runtimePath = path.join(tmp, 'fake-runtime.js');
  writeJson(manifestFile, manifest(tmp));
  writeFakeRuntime(runtimePath);

  const cli = path.join(__dirname, '..', 'bin', 'siann.js');
  const result = spawnSync(process.execPath, [
    cli,
    'live',
    'import-pack',
    manifestFile,
    '--runtime',
    runtimePath,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SIANN_FAKE_RUNTIME_CALLS: callsFile },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.workflow, 'live-import-pack');
  assert.equal(JSON.parse(fs.readFileSync(callsFile, 'utf8')).at(-1).method, 'runtime.stop');
});

test('siann live import-pack creates an engine session and preview', {
  skip: !process.env.SIANN_RUN_ENGINE_TESTS,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-live-import-engine-'));
  const manifestFile = path.join(tmp, 'manifest.json');
  spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'create-demo-audio.js'), path.join(tmp, 'audio')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  writeJson(manifestFile, manifest(tmp));

  const cli = path.join(__dirname, '..', 'bin', 'siann.js');
  const result = spawnSync(process.execPath, [
    cli,
    'live',
    'import-pack',
    manifestFile,
    '--engine-dir',
    process.env.SIANN_ENGINE_DIR,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.apply.commandCount, 4);
  assert.equal(fs.existsSync(summary.preview.outputPath), true);
  assert.equal(fs.statSync(summary.preview.outputPath).size > 44, true);
  assert.equal(fs.existsSync(summary.journal.path), true);
  assert.equal(JSON.parse(fs.readFileSync(summary.journal.path, 'utf8')).schemaVersion, 'siann.runtime_journal.v0');
});
