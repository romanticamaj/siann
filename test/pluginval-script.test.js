'use strict';

// m4-juce-formats, acceptance 1 (pluginval at strictness 5 on siann_test_plugin in
// CI and on the chosen plugins on maintainer runs; manifest human gate
// "real-plugins"): scripts/pluginval.js against a stub pluginval, a Node script
// that records its arguments and exits with a code it is told. No real pluginval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pluginval.js');
const COMPAT = path.join(ROOT, 'scripts', 'compat-plugins.json');

// Every variable the compatibility set names, so the maintainer's own do not leak in.
const COMPAT_VARIABLES = [
  'SIANN_PLUGIN_TDR_NOVA',
  'SIANN_PLUGIN_SLICKEQ',
  'SIANN_PLUGIN_SURGE_XT_VST3',
  'SIANN_PLUGIN_SD3',
  'SIANN_PLUGIN_UAD_1176',
  'SIANN_PLUGIN_HALION_SONIC',
  'SIANN_PLUGIN_TDR_NOVA_AU',
  'SIANN_PLUGIN_SURGE_XT_AU',
];

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siann-pluginval-'));
}

// A pluginval stand-in: appends its argv (one JSON line per run) to log, and exits
// with the code in the STUB_EXIT environment variable, or with the code mapped to
// the plugin path (the last argument) in STUB_EXIT_FOR.
function writeStub(dir) {
  const stub = path.join(dir, 'pluginval-stub.js');
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(
    stub,
    [
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
      "const byPlugin = JSON.parse(process.env.STUB_EXIT_FOR || '{}');",
      'const plugin = args[args.length - 1];',
      "process.exit(plugin in byPlugin ? byPlugin[plugin] : Number(process.env.STUB_EXIT || '0'));",
      '',
    ].join('\n'),
  );
  return { stub, log };
}

function runs(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakePlugin(dir, name) {
  const plugin = path.join(dir, name);
  fs.mkdirSync(plugin, { recursive: true });
  return plugin;
}

function run(args, env = {}) {
  const base = { ...process.env };
  for (const name of [...COMPAT_VARIABLES, 'SIANN_PLUGINVAL', 'STUB_EXIT', 'STUB_EXIT_FOR']) delete base[name];
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
}

// The value after a flag in one recorded run.
function flag(argv, name) {
  const at = argv.indexOf(name);
  assert.ok(at >= 0, `${name} passed (${argv.join(' ')})`);
  return argv[at + 1];
}

test('a plugin is validated at strictness 5 with a timeout and an output directory, the plugin last', () => {
  const dir = scratch();
  const { stub, log } = writeStub(dir);
  const plugin = fakePlugin(dir, 'siann_test_plugin.vst3');
  const out = path.join(dir, 'logs');
  const result = run(['--pluginval', stub, '--output-dir', out, plugin]);
  assert.equal(result.status, 0, result.stderr);
  const [argv] = runs(log);
  assert.equal(flag(argv, '--strictness-level'), '5');
  assert.ok(Number(flag(argv, '--timeout-ms')) >= 60000, 'a generous timeout');
  assert.equal(flag(argv, '--output-dir'), out);
  assert.equal(flag(argv, '--validate'), plugin);
  assert.equal(argv[argv.length - 1], plugin);
  assert.match(result.stdout, /PASS/);
});

test('the strictness and the timeout can be given', () => {
  const dir = scratch();
  const { stub, log } = writeStub(dir);
  const plugin = fakePlugin(dir, 'a.vst3');
  const result = run(['--pluginval', stub, '--strictness-level', '7', '--timeout-ms', '1234', plugin]);
  assert.equal(result.status, 0, result.stderr);
  const [argv] = runs(log);
  assert.equal(flag(argv, '--strictness-level'), '7');
  assert.equal(flag(argv, '--timeout-ms'), '1234');
});

test('pluginval comes from SIANN_PLUGINVAL when --pluginval is not given', () => {
  const dir = scratch();
  const { stub, log } = writeStub(dir);
  const plugin = fakePlugin(dir, 'a.vst3');
  const result = run([plugin], { SIANN_PLUGINVAL: stub });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runs(log).length, 1);
});

test('without pluginval the script exits 2 with a hint', () => {
  const dir = scratch();
  const plugin = fakePlugin(dir, 'a.vst3');
  const unset = run([plugin]);
  assert.equal(unset.status, 2);
  assert.match(unset.stderr, /SIANN_PLUGINVAL/);
  assert.match(unset.stderr, /--pluginval/);
  const missing = run(['--pluginval', path.join(dir, 'no-such-pluginval'), plugin]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no-such-pluginval/);
});

test('a plugin path that does not exist fails, naming the path, without running pluginval', () => {
  const dir = scratch();
  const { stub, log } = writeStub(dir);
  const gone = path.join(dir, 'gone.vst3');
  const result = run(['--pluginval', stub, gone]);
  assert.equal(result.status, 1);
  assert.ok(`${result.stdout}${result.stderr}`.includes(gone), 'the message names the path');
  assert.equal(runs(log).length, 0);
});

test('a pluginval failure fails the run', () => {
  const dir = scratch();
  const { stub } = writeStub(dir);
  const plugin = fakePlugin(dir, 'a.vst3');
  const result = run(['--pluginval', stub, plugin], { STUB_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL/);
});

test('the compatibility set is the human gate: three always, three when authorised, AU on macOS', () => {
  const compat = JSON.parse(fs.readFileSync(COMPAT, 'utf8'));
  assert.equal(compat.schemaVersion, 'siann.compat_plugins.v1');
  const byEnv = new Map(compat.plugins.map((plugin) => [plugin.env, plugin]));
  assert.deepEqual([...byEnv.keys()].sort(), [...COMPAT_VARIABLES].sort());
  const ids = compat.plugins.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const env of ['SIANN_PLUGIN_TDR_NOVA', 'SIANN_PLUGIN_SLICKEQ', 'SIANN_PLUGIN_SURGE_XT_VST3']) {
    assert.equal(byEnv.get(env).run, 'always', env);
    assert.equal(byEnv.get(env).format, 'vst3', env);
  }
  for (const env of ['SIANN_PLUGIN_SD3', 'SIANN_PLUGIN_UAD_1176', 'SIANN_PLUGIN_HALION_SONIC']) {
    assert.equal(byEnv.get(env).run, 'authorised', env);
  }
  for (const env of ['SIANN_PLUGIN_TDR_NOVA_AU', 'SIANN_PLUGIN_SURGE_XT_AU']) {
    assert.equal(byEnv.get(env).format, 'au', env);
    assert.deepEqual(byEnv.get(env).platforms, ['darwin'], env);
  }
});

// The entries this platform runs, as the script reads them.
function platformEntries() {
  const compat = JSON.parse(fs.readFileSync(COMPAT, 'utf8'));
  return compat.plugins.filter((plugin) => !plugin.platforms || plugin.platforms.includes(process.platform));
}

test('--compat skips every plugin whose variable is unset and passes', () => {
  const dir = scratch();
  const { stub, log } = writeStub(dir);
  const result = run(['--pluginval', stub, '--compat', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const entries = platformEntries();
  assert.equal(summary.plugins.length, entries.length);
  for (const plugin of summary.plugins) assert.equal(plugin.result, 'skip', plugin.id);
  assert.equal(runs(log).length, 0);
});

test('--compat prints SKIP, PASS and FAIL lines and continues past a skip and a failure', () => {
  const entries = platformEntries();
  assert.ok(entries.length >= 3, 'this platform has at least three compatibility plugins');
  const [passing, missing, failing] = entries;
  const dir = scratch();
  const { stub, log } = writeStub(dir);
  const passPath = fakePlugin(dir, 'pass.vst3');
  const failPath = fakePlugin(dir, 'fail.vst3');
  const result = run(['--pluginval', stub, '--compat'], {
    [passing.env]: passPath,
    [missing.env]: path.join(dir, 'not-installed.vst3'),
    [failing.env]: failPath,
    STUB_EXIT_FOR: JSON.stringify({ [failPath]: 1 }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`PASS\\s+${passing.id}`));
  assert.match(result.stdout, new RegExp(`FAIL\\s+${missing.id}.*not-installed`));
  assert.match(result.stdout, new RegExp(`FAIL\\s+${failing.id}`));
  for (const skipped of entries.slice(3)) {
    assert.match(result.stdout, new RegExp(`SKIP\\s+${skipped.id}.*${skipped.env}`));
  }
  assert.deepEqual(
    runs(log).map((argv) => argv[argv.length - 1]),
    [passPath, failPath],
  );
});

test('--json summarises each plugin as pass, fail or skip', () => {
  const entries = platformEntries();
  const dir = scratch();
  const { stub } = writeStub(dir);
  const passPath = fakePlugin(dir, 'pass.vst3');
  const result = run(['--pluginval', stub, '--compat', '--json'], {
    [entries[0].env]: passPath,
    [entries[1].env]: path.join(dir, 'not-installed.vst3'),
  });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  const resultOf = new Map(summary.plugins.map((plugin) => [plugin.id, plugin.result]));
  assert.equal(resultOf.get(entries[0].id), 'pass');
  assert.equal(resultOf.get(entries[1].id), 'fail');
  for (const skipped of entries.slice(2)) assert.equal(resultOf.get(skipped.id), 'skip');
  assert.equal(summary.ok, false);
});

test('--json for plugins given by path names each by its path', () => {
  const dir = scratch();
  const { stub } = writeStub(dir);
  const plugin = fakePlugin(dir, 'siann_test_plugin.vst3');
  const result = run(['--pluginval', stub, '--json', plugin]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, plugins: [{ id: plugin, path: plugin, result: 'pass' }] });
});
