'use strict';

// `check-all --changed` (issue #88): which local steps a set of changed paths needs.
// The same table picks the CI jobs (.github/workflows/ci.yml, the changes job).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALL_STEPS, cacheRoot, dependencySource, nativeEnv, PACKAGE_NATIVE, packageStep, parseArgs, selectSteps, stepsForPath,
  stepsForPaths,
} = require('../scripts/check-all');

const none = { desktop: false, gcc: false, app: false, json: false, only: null,
  changed: false, all: false, base: null, plan: false, jobs: null };

test('every step, in run order', () => {
  assert.deepEqual(ALL_STEPS, ['node', 'native', 'desktop', 'app', 'package', 'gcc']);
});

// m5b-package-windows: what goes into the Windows installer runs the package step.
test('what the installer is built from runs the package step', () => {
  for (const file of ['app/electron-builder.json', 'app/package.json', 'app/package-lock.json',
    'app/build/licenses/AGPL-3.0.txt', 'app/scripts/collect-licenses.js', 'app/src/main/main.ts',
    'app/src/main/supervisor.ts', 'app/test/e2e/packaged.spec.ts']) {
    assert.deepEqual(stepsForPaths([file]), ['node', 'app', 'package'], file);
  }
  for (const file of ['scripts/run-app.js', 'scripts/pe-imports.js', 'test/package/licences.test.js',
    'test/package/imports.test.js']) {
    assert.deepEqual(stepsForPaths([file]), ['node', 'package'], file);
  }
  for (const file of ['native/apps/engine/src/main.cpp', 'native/CMakePresets.json', 'native/cmake/SiannJuce.cmake',
    'native/libs/host_desktop/src/juce_plugin_host.cpp', 'native/libs/graph/CMakeLists.txt']) {
    assert.ok(stepsForPath(file).includes('package'), file);
  }
});

// The shipped engine links the CRT statically: its crash tests (no dialog, exit code 3;
// spec, "Process model", Crash) run in that configuration before the installer is built.
test('the package step builds the desktop-release engine and runs its crash tests', () => {
  const commands = PACKAGE_NATIVE.map(([tool, args]) => [tool, ...args].join(' '));
  assert.equal(commands[0], 'cmake --preset desktop-release');
  const build = commands.find((c) => c.startsWith('cmake --build --preset desktop-release --target '));
  assert.ok(build, commands.join('\n'));
  for (const target of ['siann-engine', 'siann_engine_host_tests', 'siann_engine_launch_tests', 'siann_host_clap_tests']) {
    assert.ok(build.split(' ').includes(target), target);
  }
  assert.ok(commands.indexOf('ctest --preset desktop-release -R crash') > commands.indexOf(build), commands.join('\n'));
});

test('the package step reports skipped off Windows and runs nothing there', async () => {
  for (const platform of ['darwin', 'linux']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await packageStep({ platform, run: () => { throw new Error('ran a command'); } });
    assert.equal(result.ok, true, platform);
    assert.match(result.note, /skipped/, platform);
  }
  assert.deepEqual(parseArgs(['--only', 'package']).only, 'package');
});

test('docs, prose, the renderer and the core never run the package step', () => {
  for (const file of ['docs/harness/runbook.md', 'README.md', 'app/README.md', 'docs/adr/0017-x.md',
    'app/src/renderer/App.tsx', 'app/test/e2e/editor.spec.ts', 'native/libs/graph/src/graph.cpp',
    'test/run-app.test.js', '.github/workflows/ci.yml']) {
    assert.ok(!stepsForPath(file).includes('package'), file);
  }
});

test('docs, prose and agent files run the Node tests only', () => {
  for (const file of ['docs/harness/runbook.md', 'README.md', 'AGENTS.md', 'native/README.md', 'app/README.md',
    '.claude/workflows/siann-milestone.js', '.claude/milestones/M5.json', '.codex/skills/siann-intake/SKILL.md',
    'docs/adr/0000-adr-index.md']) {
    assert.deepEqual(stepsForPaths([file]), ['node'], file);
  }
});

test('the bridge, its scripts, tests and CI files run the Node tests', () => {
  for (const file of ['src/hash/jcs.js', 'bin/siann.js', 'test/ci-workflow.test.js', 'scripts/create-demo-audio.js',
    'examples/import-pack.json', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', '.gitignore']) {
    assert.deepEqual(stepsForPaths([file]), ['node'], file);
  }
});

test('app/ runs node and the Electron shell', () => {
  for (const file of ['app/src/renderer/main.ts', 'app/tsconfig.json', 'app/test/e2e/editor.spec.ts']) {
    assert.deepEqual(stepsForPaths([file]), ['node', 'app'], file);
  }
});

test('native/ runs native and g++; the core alone leaves the JUCE preset out', () => {
  for (const file of ['native/libs/graph/src/graph.cpp', 'native/libs/realtime/include/siann/rt/queue.h',
    'native/apps/cli/src/main.cpp', 'native/tools/msvc-env.cmd']) {
    assert.deepEqual(stepsForPaths([file]), ['node', 'native', 'gcc'], file);
  }
});

test('JUCE, plugin hosting, siann-engine and the build files add the desktop preset and the installer', () => {
  for (const file of ['native/libs/host_desktop/src/juce_plugin_host.cpp', 'native/libs/host_clap/src/clap_host.cpp',
    'native/libs/host_common/include/x.h', 'native/libs/host_api/include/siann/host/plugin.h',
    'native/apps/engine/src/main.cpp', 'native/cmake/SiannJuce.cmake', 'native/cmake/SiannThirdParty.cmake',
    'native/CMakePresets.json', 'native/CMakeLists.txt', 'native/libs/graph/CMakeLists.txt']) {
    assert.deepEqual(stepsForPaths([file]), ['node', 'native', 'desktop', 'package', 'gcc'], file);
  }
});

test('scripts belong to their step: pluginval to desktop, check-all to every step', () => {
  assert.deepEqual(stepsForPaths(['scripts/pluginval.js']), ['node', 'desktop']);
  assert.deepEqual(stepsForPaths(['scripts/check-all.js']), ALL_STEPS);
});

test('shared fixtures run the native tests too', () => {
  assert.deepEqual(stepsForPaths(['fixtures/jcs/vectors.json']), ['node', 'native']);
});

test('an unknown path runs everything', () => {
  for (const file of ['.gitattributes', 'tools/new-thing.sh', 'Makefile']) {
    assert.deepEqual(stepsForPaths([file]), ALL_STEPS, file);
  }
});

test('paths add up, Windows separators included, and no change still runs node', () => {
  assert.deepEqual(stepsForPaths([]), ['node']);
  assert.deepEqual(stepsForPaths(['docs/x.md', 'app/src/a.ts', 'native\\libs\\graph\\src\\g.cpp']),
    ['node', 'native', 'app', 'gcc']);
  assert.deepEqual(stepsForPath('native\\libs\\host_desktop\\src\\x.cpp'), ['node', 'native', 'desktop', 'package', 'gcc']);
  assert.deepEqual(stepsForPath('app\\src\\main\\main.ts'), ['node', 'app', 'package']);
});

test('--changed replaces the default steps; the other flags add to it', () => {
  assert.deepEqual(selectSteps(none, null), ['node', 'native']);
  assert.deepEqual(selectSteps({ ...none, changed: true }, ['docs/a.md']), ['node']);
  assert.deepEqual(selectSteps({ ...none, changed: true, desktop: true }, ['docs/a.md']), ['node', 'desktop']);
  // When git cannot list the changes, everything runs.
  assert.deepEqual(selectSteps({ ...none, changed: true }, null), ALL_STEPS);
  assert.deepEqual(selectSteps({ ...none, all: true }, null), ALL_STEPS);
  assert.deepEqual(selectSteps({ ...none, gcc: true, app: true }, null), ['node', 'native', 'app', 'gcc']);
  assert.deepEqual(selectSteps({ ...none, changed: true, only: 'gcc' }, ['docs/a.md']), ['gcc']);
});

test('native steps share one cache root outside the worktree', () => {
  const root = path.join(os.tmpdir(), 'siann-cache-test');
  const env = nativeEnv({ jobs: 4 }, { SIANN_CACHE_DIR: root });
  assert.equal(env.SIANN_DEPS_CACHE_DIR, path.join(root, 'fetchcontent'));
  assert.equal(env.SCCACHE_DIR, path.join(root, 'sccache'));
  assert.equal(env.SCCACHE_CACHE_SIZE, '20G');
  assert.equal(env.CMAKE_BUILD_PARALLEL_LEVEL, '4');
  // What the environment already says wins.
  const own = nativeEnv({}, { SIANN_CACHE_DIR: root, SCCACHE_DIR: 'x', SIANN_DEPS_CACHE_DIR: 'y' });
  assert.equal(own.SCCACHE_DIR, 'x');
  assert.equal(own.SIANN_DEPS_CACHE_DIR, 'y');
  assert.equal(own.CMAKE_BUILD_PARALLEL_LEVEL, undefined);
  const repo = path.resolve(__dirname, '..');
  assert.ok(!path.resolve(cacheRoot({})).startsWith(repo), 'the default cache is outside the checkout');
});

test("the g++ step finds a dependency in the shared cache, or in the build tree's _deps", () => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-build-'));
  try {
    assert.equal(dependencySource(build, 'Catch2'), path.join(build, '_deps', 'catch2-src'));
    fs.writeFileSync(path.join(build, 'CMakeCache.txt'), [
      'SIANN_DEP_SOURCE_DIR_CATCH2:INTERNAL=D:/siann-cache/fetchcontent/catch2-0123456789abcdef',
      'SIANN_DEP_SOURCE_DIR_CLAP:INTERNAL=',
      '',
    ].join('\n'));
    assert.equal(dependencySource(build, 'Catch2'), path.normalize('D:/siann-cache/fetchcontent/catch2-0123456789abcdef'));
    assert.equal(dependencySource(build, 'clap'), path.join(build, '_deps', 'clap-src'));
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
});

// The CMake side of the caches (native/cmake/SiannCompilerCache.cmake and
// SiannDependencyCache.cmake), read as text: running CMake is the native step's job.
const NATIVE = path.join(__dirname, '..', 'native');
const read = (rel) => fs.readFileSync(path.join(NATIVE, rel), 'utf8');

test('the compiler cache: sccache, then ccache, an opt-out, and /Z7 for MSVC', () => {
  const text = read('cmake/SiannCompilerCache.cmake');
  assert.match(text, /SIANN_NO_COMPILER_CACHE/);
  assert.match(text, /ENV\{SIANN_SCCACHE\}/);
  assert.match(text, /Mozilla\.sccache_\*/, 'the winget install location');
  assert.ok(text.indexOf('NAMES sccache') < text.indexOf('NAMES ccache'), 'sccache first');
  assert.match(text, /CMAKE_CXX_COMPILER_LAUNCHER/);
  assert.match(text, /CMAKE_MSVC_DEBUG_INFORMATION_FORMAT[^\n]*Embedded/);
  assert.match(text, /CMAKE_POLICY_DEFAULT_CMP0141 NEW/);
  // Ninja tracks headers through cl's /showIncludes prefix; a launcher that mangles it is not used.
  assert.match(text, /\/showIncludes/);
  assert.match(text, /NOT _siann_prefix STREQUAL CMAKE_CL_SHOWINCLUDES_PREFIX/);
  assert.match(read('CMakeLists.txt'), /include\("\$\{CMAKE_CURRENT_SOURCE_DIR\}\/cmake\/SiannCompilerCache\.cmake"\)/);
});

test('every third-party dependency goes through the shared source cache', () => {
  const files = ['CMakeLists.txt', 'cmake/SiannThirdParty.cmake', 'cmake/SiannJuce.cmake'];
  for (const rel of files) {
    assert.doesNotMatch(read(rel), /FetchContent_Declare\(/, `${rel} declares through siann_declare_dependency`);
  }
  const all = files.map(read).join('\n');
  for (const name of ['Catch2', 'dr_libs', 'r8brain', 'ixwebsocket', 'clap', 'juce']) {
    assert.match(all, new RegExp(`siann_declare_dependency\\(\\s*${name}\\b`), name);
  }
  const cache = read('cmake/SiannDependencyCache.cmake');
  assert.match(cache, /file\(LOCK/, 'concurrent configures lock each dependency');
  assert.match(cache, /\.siann-complete/, 'a half-fetched copy is never used');
  assert.match(cache, /FETCHCONTENT_SOURCE_DIR_\$\{upper\}/, 'only sources are shared, never a build tree');
});
