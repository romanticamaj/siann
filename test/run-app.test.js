'use strict';

// `npm run app` (m5b-package-windows, acceptance 1): scripts/run-app.js plans
// what a source checkout needs before Electron can start on the engine, and
// runs it. The planning function is driven over every state on every desktop OS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runApp = require('../scripts/run-app');

const { planRun, detectState, main } = runApp;

const STATES = {
  'nothing built': { depsFresh: false, engineBuilt: false },
  'app built': { depsFresh: true, engineBuilt: false },
  'engine built': { depsFresh: false, engineBuilt: true },
  both: { depsFresh: true, engineBuilt: true },
};
const PLATFORMS = ['win32', 'darwin', 'linux'];

const APP = path.join(ROOT, 'app');
const NATIVE = path.join(ROOT, 'native');
const engineFor = (platform) =>
  path.join(NATIVE, 'build', 'desktop', 'apps', 'engine', platform === 'win32' ? 'siann-engine.exe' : 'siann-engine');

// What each step must run, on each OS: npm is a .cmd shim on Windows (cmd.exe
// runs it), and cmake runs inside the Visual Studio environment there.
function npm(platform, args) {
  return platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'npm', ...args]] : ['npm', args];
}
function cmake(platform, args) {
  return platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', path.join('tools', 'msvc-env.cmd'), 'cmake', ...args]]
    : ['cmake', args];
}

function expectedNames(state) {
  return [
    ...(state.depsFresh ? [] : ['npm ci']),
    'npm run build',
    ...(state.engineBuilt ? [] : ['cmake --preset desktop', 'cmake --build --preset desktop --target siann-engine']),
    'electron',
  ];
}

for (const platform of PLATFORMS) {
  for (const [label, state] of Object.entries(STATES)) {
    test(`${platform}, ${label}: the steps in order`, () => {
      const steps = planRun({ platform, root: ROOT, ...state });
      assert.deepEqual(steps.map((s) => s.name), expectedNames(state));
      for (const step of steps) {
        if (step.name.startsWith('npm ')) {
          const [command, args] = npm(platform, step.name.slice(4).split(' '));
          assert.equal(step.command, command, step.name);
          assert.deepEqual(step.args, args, step.name);
          assert.equal(step.cwd, APP, step.name);
        } else if (step.name.startsWith('cmake ')) {
          const [command, args] = cmake(platform, step.name.slice(6).split(' '));
          assert.equal(step.command, command, step.name);
          assert.deepEqual(step.args, args, step.name);
          assert.equal(step.cwd, NATIVE, step.name);
          // The shared caches check-all's native steps use.
          assert.ok(step.env && step.env.SIANN_DEPS_CACHE_DIR, `${step.name} carries the dependency cache`);
        } else {
          assert.equal(step.name, 'electron');
          assert.equal(step.command, process.execPath);
          assert.deepEqual(step.args, [path.join(APP, 'node_modules', 'electron', 'cli.js'), '.']);
          assert.equal(step.cwd, APP);
          assert.equal(step.env.SIANN_ENGINE_EXE, engineFor(platform));
        }
      }
    });
  }
}

test('the state: deps are fresh when node_modules/.package-lock.json is not older than package-lock.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-run-app-'));
  try {
    const app = path.join(root, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package-lock.json'), '{}');
    const lock = path.join(app, 'package-lock.json');
    assert.deepEqual(detectState({ root, platform: 'linux' }), { depsFresh: false, engineBuilt: false });

    const installed = path.join(app, 'node_modules', '.package-lock.json');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '{}');
    fs.utimesSync(lock, new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.utimesSync(installed, new Date(2026, 0, 2), new Date(2026, 0, 2));
    assert.equal(detectState({ root, platform: 'linux' }).depsFresh, true);
    // A newer lock file (a dependency bump pulled in): install again.
    fs.utimesSync(lock, new Date(2026, 0, 3), new Date(2026, 0, 3));
    assert.equal(detectState({ root, platform: 'linux' }).depsFresh, false);

    for (const platform of PLATFORMS) {
      const exe = path.join(root, 'native', 'build', 'desktop', 'apps', 'engine',
        platform === 'win32' ? 'siann-engine.exe' : 'siann-engine');
      assert.equal(detectState({ root, platform }).engineBuilt, false, platform);
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '');
      assert.equal(detectState({ root, platform }).engineBuilt, true, platform);
      fs.rmSync(exe);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--plan prints every step and runs none', async () => {
  const lines = [];
  const ran = [];
  const code = await main(['--plan'], {
    platform: 'win32',
    root: ROOT,
    state: STATES['nothing built'],
    write: (text) => lines.push(text),
    run: (step) => {
      ran.push(step);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(ran, []);
  const text = lines.join('');
  for (const name of expectedNames(STATES['nothing built'])) assert.ok(text.includes(name), `${name} in ${text}`);
  assert.ok(text.includes(engineFor('win32')), 'the plan names the engine Electron starts on');
});

test('without --plan the steps run in order and the first failure stops the rest', async () => {
  const ran = [];
  const code = await main([], {
    platform: 'linux',
    root: ROOT,
    state: STATES['nothing built'],
    write: () => {},
    run: (step) => {
      ran.push(step.name);
      return step.name === 'cmake --preset desktop' ? 3 : 0;
    },
  });
  assert.notEqual(code, 0);
  assert.deepEqual(ran, ['npm ci', 'npm run build', 'cmake --preset desktop']);

  const all = [];
  assert.equal(await main([], {
    platform: 'darwin', root: ROOT, state: STATES.both, write: () => {}, run: (step) => { all.push(step.name); return 0; },
  }), 0);
  assert.deepEqual(all, ['npm run build', 'electron']);
});

test('an unknown argument is refused before anything runs', async () => {
  const ran = [];
  const code = await main(['--bogus'], {
    platform: 'linux', root: ROOT, state: STATES.both, write: () => {}, run: (step) => { ran.push(step); return 0; },
  });
  assert.notEqual(code, 0);
  assert.deepEqual(ran, []);
});

test('run-app.js needs nothing outside Node built-ins and check-all.js', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'run-app.js'), 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(required.length > 0);
  for (const name of required) {
    assert.ok(name.startsWith('node:') || name === './check-all' || name === './check-all.js', name);
  }
  assert.doesNotMatch(source, /\bimport\s*\(/);
});

test('the root package runs it as `npm run app` and stays dependency-free', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.app, 'node scripts/run-app.js');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
