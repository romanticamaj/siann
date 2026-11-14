#!/usr/bin/env node
// One command for every local check the milestone harness relies on.
//
//   node scripts/check-all.js --changed       the steps the changes against origin/main
//                                             need (merge-base, plus uncommitted and
//                                             untracked files): the default before a push
//   node scripts/check-all.js --all           every step: milestone exits, or when asked
//   node scripts/check-all.js                 Node tests + native dev build and tests
//   node scripts/check-all.js --desktop       also the JUCE desktop preset
//   node scripts/check-all.js --gcc           also a g++ -Werror syntax check (WSL on Windows),
//                                             of the JUCE sources too once the desktop preset
//                                             has configured (run --desktop first)
//   node scripts/check-all.js --app           also the Electron shell (app/): npm ci on first
//                                             use or a changed package-lock.json, build,
//                                             unit and Playwright tests against
//                                             native/build/dev's siann-engine
//   node scripts/check-all.js --only package  the Windows installer (Windows only; reports
//                                             skipped elsewhere): the desktop-release engine
//                                             and its crash tests,
//                                             npm run dist in app/, the package tests and the
//                                             packaged e2e against app/release/win-unpacked
//   node scripts/check-all.js --only native   one step: node | native | desktop | app | package | gcc
//   node scripts/check-all.js --json          machine-readable summary
//
//   --base <ref>    with --changed: diff against <ref> itself instead of the merge-base
//   --plan          print the selected steps (and the changed paths) and run nothing
//   -j, --jobs <n>  build parallelism (CMAKE_BUILD_PARALLEL_LEVEL) and parallel g++ checks
//
// Flags add up: `--changed --desktop` is the changed steps plus desktop.
//
// Native builds use a compiler cache (sccache, else ccache) when one is installed and
// share third-party sources across worktrees (native/cmake/SiannDependencyCache.cmake).
// The cache root is SIANN_CACHE_DIR, by default <drive>:\siann-cache on Windows and
// ~/.cache/siann elsewhere; SIANN_NO_COMPILER_CACHE=1 turns the compiler cache off.
//
// Exit code 0 when every selected step passes, 1 otherwise.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const isWindows = process.platform === 'win32';

const ALL_STEPS = ['node', 'native', 'desktop', 'app', 'package', 'gcc'];

function parseArgs(argv) {
  const options = {
    desktop: false, gcc: false, app: false, json: false, only: null,
    changed: false, all: false, base: null, plan: false, jobs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--desktop') options.desktop = true;
    else if (arg === '--gcc') options.gcc = true;
    else if (arg === '--app') options.app = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--only') options.only = argv[++i];
    else if (arg === '--changed') options.changed = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--plan') options.plan = true;
    else if (arg === '-j' || arg === '--jobs') {
      const jobs = Number(argv[++i]);
      if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`${arg} needs a positive integer`);
      options.jobs = jobs;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.only && !ALL_STEPS.includes(options.only)) throw new Error(`unknown step ${options.only}`);
  if (options.base !== null && !options.base) throw new Error('--base needs a ref');
  return options;
}

// ---- Which steps a change needs ------------------------------------------------

// What the desktop preset (JUCE) compiles differently or only: the JUCE host, the
// plugin hosting it builds on, siann-engine (which links it in that preset), and the
// build files that choose all of that.
const DESKTOP_PATHS = [
  /^native\/libs\/host_[^/]+\//,
  /^native\/apps\/engine\//,
  /^native\/cmake\//,
  /^native\/CMakePresets\.json$/,
  /(^|\/)CMakeLists\.txt$/,
  /\.cmake$/,
];

// What goes into the Windows installer (m5b-package-windows) besides the desktop
// paths above (siann-engine and the build files): app/'s packaging and main
// process, the packaged e2e, `npm run app`, and the package tests.
const PACKAGE_APP_PATHS = [
  /^app\/package(-lock)?\.json$/,
  /^app\/electron-builder\.json$/,
  /^app\/build\//,
  /^app\/scripts\/collect-licenses\.js$/,
  /^app\/src\/main\//,
  /^app\/test\/e2e\/packaged\.spec\.ts$/,
];
const PACKAGE_OTHER_PATHS = [
  /^scripts\/run-app\.js$/,
  /^scripts\/pe-imports\.js$/,
  /^test\/package\//,
];

// The redesign's mockup (docs/harness/agent-rules.md, "UI fidelity").
const MOCKUP_DIR = 'docs/superpowers/specs/2026-11-13-siann-ui-redesign/';

// Steps for one changed path (forward slashes, relative to the repository root).
// The Node tests run for every change; the rest follow the table below.
function stepsForPath(file) {
  const p = file.replace(/\\/g, '/');
  // check-all drives every step; a change to it is checked by running them all.
  if (p === 'scripts/check-all.js') return [...ALL_STEPS];
  // pluginval runs against the desktop preset's test plugin.
  if (p === 'scripts/pluginval.js') return ['node', 'desktop'];
  // Prose builds nothing, wherever it lives.
  if (/\.md$/i.test(p)) return ['node'];
  // The UI mockup is what the app's fidelity gate compares the window with.
  if (p.startsWith(MOCKUP_DIR)) return ['node', 'app'];
  if (/^native\//.test(p)) {
    return DESKTOP_PATHS.some((re) => re.test(p))
      ? ['node', 'native', 'desktop', 'package', 'gcc']
      : ['node', 'native', 'gcc'];
  }
  if (/^app\//.test(p)) return PACKAGE_APP_PATHS.some((re) => re.test(p)) ? ['node', 'app', 'package'] : ['node', 'app'];
  if (PACKAGE_OTHER_PATHS.some((re) => re.test(p))) return ['node', 'package'];
  // The native tests read the shared fixtures too.
  if (/^fixtures\//.test(p)) return ['node', 'native'];
  if (/^(docs|\.claude|\.codex|\.github|scripts|test|src|bin|examples)\//.test(p)) return ['node'];
  if (/^(package\.json|package-lock\.json|LICENSE[^/]*|\.gitignore)$/.test(p)) return ['node'];
  // Anything else (.gitattributes, a new top-level directory, ...): everything.
  return [...ALL_STEPS];
}

// The union over every path, in run order. No change at all still runs the Node tests.
function stepsForPaths(files) {
  const wanted = new Set(['node']);
  for (const file of files) for (const step of stepsForPath(file)) wanted.add(step);
  return ALL_STEPS.filter((step) => wanted.has(step));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

// Paths changed since the merge-base with origin/main (or since `base` itself), with
// staged, unstaged and untracked files. null when git cannot tell.
function changedPaths(base) {
  let from = base;
  if (!from) {
    const mergeBase = git(['merge-base', 'HEAD', 'origin/main']);
    if (!mergeBase) return null;
    from = mergeBase.trim();
  }
  const diff = git(['diff', '--name-only', '--no-renames', from]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (diff === null || untracked === null) return null;
  const lines = `${diff}\n${untracked}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [...new Set(lines)].sort();
}

function selectSteps(options, changed) {
  if (options.only) return [options.only];
  if (options.all) return [...ALL_STEPS];
  const wanted = new Set(options.changed ? (changed ? stepsForPaths(changed) : ALL_STEPS) : ['node', 'native']);
  if (options.desktop) wanted.add('desktop');
  if (options.app) wanted.add('app');
  if (options.gcc) wanted.add('gcc');
  return ALL_STEPS.filter((step) => wanted.has(step));
}

// ---- Caches ----------------------------------------------------------------------

function cacheRoot(env = process.env) {
  if (env.SIANN_CACHE_DIR) return env.SIANN_CACHE_DIR;
  if (isWindows) {
    // A short path on the repository's drive, outside every worktree: Git checkouts of
    // the dependencies stay clear of MAX_PATH.
    const drive = /^([A-Za-z]:)/.exec(ROOT);
    return path.join(drive ? `${drive[1]}\\` : os.homedir(), 'siann-cache');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'siann');
}

// The environment every native step runs with.
function nativeEnv(options, env = process.env) {
  const root = cacheRoot(env);
  const out = { ...env };
  if (!out.SIANN_DEPS_CACHE_DIR) out.SIANN_DEPS_CACHE_DIR = path.join(root, 'fetchcontent');
  // Read when the sccache server starts; a server that is already running keeps its own.
  if (!out.SCCACHE_DIR) out.SCCACHE_DIR = path.join(root, 'sccache');
  if (!out.SCCACHE_CACHE_SIZE) out.SCCACHE_CACHE_SIZE = '20G';
  if (!out.CCACHE_DIR) out.CCACHE_DIR = path.join(root, 'ccache');
  // English cl output where the English language pack is installed: sccache mangles a
  // /showIncludes prefix in another code page (native/cmake/SiannCompilerCache.cmake).
  if (isWindows && !out.VSLANG) out.VSLANG = '1033';
  if (options.jobs) out.CMAKE_BUILD_PARALLEL_LEVEL = String(options.jobs);
  return out;
}

// ---- Running -------------------------------------------------------------------

function run(command, args, cwd, env = process.env) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? String(result.error) : ''}`;
  return { ok: result.status === 0, seconds, output };
}

function runAsync(command, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (error) => resolve({ ok: false, output: `${output}${error}` }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

// cmake / ctest with the Visual Studio environment on Windows.
function native(tool, args, options) {
  const env = nativeEnv(options);
  if (isWindows) {
    return run('cmd.exe', ['/d', '/c', path.join('tools', 'msvc-env.cmd'), tool, ...args], NATIVE, env);
  }
  return run(tool, args, NATIVE, env);
}

function sequence(commands, options) {
  for (const [tool, args] of commands) {
    const step = native(tool, args, options);
    if (!step.ok) return { ...step, failedAt: `${tool} ${args.join(' ')}` };
  }
  return { ok: true, output: '' };
}

function preset(name) {
  return (options) => sequence([
    ['cmake', ['--preset', name]],
    ['cmake', ['--build', '--preset', name]],
    ['ctest', ['--preset', name]],
  ], options);
}

function listSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'build') continue;
        walk(full);
      } else if (entry.name.endsWith('.cpp')) {
        files.push(full);
      }
    }
  };
  walk(path.join(NATIVE, 'libs'));
  walk(path.join(NATIVE, 'apps'));
  return files.filter((f) => !f.includes(`${path.sep}host_desktop${path.sep}`));
}

// What only compiles against JUCE, or differently with it. Each file's platform
// half stays out: g++ here has neither windows.h nor AppKit, so CI alone covers those.
function desktopSources() {
  const lib = path.join(NATIVE, 'libs', 'host_desktop');
  const cpp = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.cpp') && !f.endsWith('_win.cpp'))
    .map((f) => path.join(dir, f));
  return [...cpp(path.join(lib, 'src')), ...cpp(path.join(lib, 'test_plugin')), ...cpp(path.join(lib, 'tests')),
    path.join(NATIVE, 'apps', 'engine', 'src', 'main_thread_desktop.cpp'),
    path.join(NATIVE, 'apps', 'engine', 'tests', 'engine_launch_test.cpp')];
}

// A dependency's source directory in a configured build tree: the shared cache copy
// when the configure used one (SIANN_DEP_SOURCE_DIR_<NAME> in CMakeCache.txt),
// otherwise FetchContent's own <build>/_deps/<name>-src.
function dependencySource(buildDir, name) {
  const cache = path.join(buildDir, 'CMakeCache.txt');
  if (fs.existsSync(cache)) {
    const key = `SIANN_DEP_SOURCE_DIR_${name.toUpperCase()}:INTERNAL=`;
    const line = fs.readFileSync(cache, 'utf8').split(/\r?\n/).find((l) => l.startsWith(key));
    const dir = line ? line.slice(key.length).trim() : '';
    if (dir) return path.normalize(dir);
  }
  return path.join(buildDir, '_deps', `${name.toLowerCase()}-src`);
}

// The configure preset's CMAKE_BUILD_TYPE (following `inherits`), from native/CMakePresets.json.
function presetBuildType(name, presets = JSON.parse(fs.readFileSync(path.join(NATIVE, 'CMakePresets.json'), 'utf8'))) {
  const byName = new Map((presets.configurePresets || []).map((p) => [p.name, p]));
  const seen = new Set();
  const find = (presetName) => {
    const preset = byName.get(presetName);
    if (!preset || seen.has(presetName)) return null;
    seen.add(presetName);
    const own = preset.cacheVariables && preset.cacheVariables.CMAKE_BUILD_TYPE;
    if (own !== undefined) return typeof own === 'object' ? own.value : own;
    for (const parent of [].concat(preset.inherits || [])) {
      const inherited = find(parent);
      if (inherited) return inherited;
    }
    return null;
  };
  return find(name);
}

// JUCE's juce_TargetPlatform.h #warns (an error under -Werror) unless DEBUG or NDEBUG is
// defined; these match what CMake passes for the build type (JUCE adds DEBUG=1 and
// _DEBUG=1 in Debug configurations).
function buildTypeDefines(buildType) {
  return buildType === 'Debug' || !buildType ? ['-DDEBUG=1', '-D_DEBUG=1'] : ['-DNDEBUG'];
}

const toPosix = (p) => {
  if (!isWindows) return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
};

function hasCcache() {
  const probe = isWindows
    ? run('wsl.exe', ['-e', 'sh', '-c', 'command -v ccache'], ROOT)
    : run('sh', ['-c', 'command -v ccache'], ROOT);
  return probe.ok && probe.output.trim() !== '';
}

async function gcc(options) {
  const devBuild = path.join(NATIVE, 'build', 'dev');
  // Only the third-party sources are needed: a configure provides them.
  if (!fs.existsSync(path.join(devBuild, 'CMakeCache.txt'))) {
    const configured = native('cmake', ['--preset', 'dev'], options);
    if (!configured.ok) return { ...configured, failedAt: 'cmake --preset dev' };
  }
  const deps = path.join(devBuild, '_deps');
  const includes = [];
  for (const group of ['libs', 'apps']) {
    for (const entry of fs.readdirSync(path.join(NATIVE, group), { withFileTypes: true })) {
      const inc = path.join(NATIVE, group, entry.name, 'include');
      if (fs.existsSync(inc)) includes.push(`-I${toPosix(inc)}`);
    }
  }
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'media', 'tests'))}`);
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'graph', 'tests'))}`);
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'hash', 'tests'))}`);
  // What the hosting tests share, whichever format carries the plugin.
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'host_common', 'tests'))}`);
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'host_clap', 'src'))}`);
  // The hostile plugin's crash test runs its own executable through the CLI tests' ChildProcess.
  includes.push(`-I${toPosix(path.join(NATIVE, 'apps', 'cli', 'tests', 'support'))}`);
  // The protocol tests reuse the playback tests' live rig (as in their CMake target).
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'playback', 'tests', 'support'))}`);
  // The siann-engine launch tests reuse the protocol tests' loopback clients.
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'protocol', 'tests'))}`);
  const dep = (name) => dependencySource(devBuild, name);
  for (const dir of [dep('dr_libs'), dep('r8brain'), dep('ixwebsocket'), path.join(dep('clap'), 'include'),
    path.join(dep('Catch2'), 'src'), path.join(deps, 'catch2-build', 'generated-includes')]) {
    includes.push('-isystem', toPosix(dir));
  }
  const flags = ['-std=c++20', '-Wall', '-Wextra', '-Wpedantic', '-Wshadow', '-Werror', '-fsyntax-only',
    '-DSIANN_FIXTURES_DIR="x"', '-DSIANN_TEST_PLUGIN_CLAP="x"',
    '-DSIANN_HOSTILE_PLUGIN_CLAP="x"', '-DSIANN_HOST_CLAP_TESTS_EXE="x"', ...includes];

  const jobs = [];
  for (const file of listSources()) jobs.push([file, flags]);
  // JUCE comes from the desktop preset's own configure, and its macros as in host_desktop/CMakeLists.txt.
  const desktopBuild = path.join(NATIVE, 'build', 'desktop');
  const juce = path.join(dependencySource(desktopBuild, 'juce'), 'modules');
  const haveJuce = fs.existsSync(juce);
  if (haveJuce) {
    const desktopFlags = [...flags,
      '-I', toPosix(path.join(NATIVE, 'libs', 'host_desktop', 'tests')),
      '-isystem', toPosix(juce),
      '-isystem', toPosix(path.join(juce, 'juce_audio_processors_headless', 'format_types', 'VST3_SDK')),
      '-DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1', '-DJUCE_STANDALONE_APPLICATION=0', '-DJUCE_PLUGINHOST_VST3=1',
      '-DJUCE_MODAL_LOOPS_PERMITTED=1', '-DSIANN_ENGINE_WITH_JUCE=1', '-DSIANN_TEST_PLUGIN_VST3="x"',
      ...buildTypeDefines(presetBuildType('desktop'))];
    for (const file of desktopSources()) jobs.push([file, desktopFlags]);
  }

  // ccache, when WSL (or this host) has it, in front of g++.
  const ccache = hasCcache();
  const compiler = ccache ? ['ccache', 'g++'] : ['g++'];
  const failures = [];
  let output = '';
  const width = options.jobs || Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [file, fileFlags] = jobs[next];
      next += 1;
      const args = [...compiler.slice(1), ...fileFlags, toPosix(file)];
      // eslint-disable-next-line no-await-in-loop
      const step = isWindows
        ? await runAsync('wsl.exe', ['-e', compiler[0], ...args], ROOT)
        : await runAsync(compiler[0], args, ROOT);
      if (!step.ok) {
        failures.push(path.relative(ROOT, file));
        output += step.output;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  const notes = [];
  if (!haveJuce) notes.push('the JUCE sources were not checked: run --desktop first');
  if (!ccache) notes.push(`no ccache${isWindows ? ' in WSL' : ''}: \`sudo apt install ccache\` there to cache it`);
  return {
    ok: failures.length === 0,
    output: failures.length ? `failed: ${failures.sort().join(', ')}\n${output}` : '',
    note: notes.length ? notes.join('; ') : undefined,
  };
}

// The bridge's tests only: a bare `node --test` would also pick up JavaScript
// under native/build/dev/_deps (IXWebSocket ships test/*.js).
function nodeTests() {
  const dir = path.join(ROOT, 'test');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
}

// ---- npm installs ----------------------------------------------------------------

// Written into node_modules after a successful `npm ci`: the package-lock.json hash it installed.
const LOCK_STAMP = '.siann-lock-hash';

function lockHash(dir) {
  const lock = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lock)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
}

// Whether `npm ci` must run in <dir>: no node_modules yet, or a package-lock.json that
// changed since the last install (a dependency added after the first install would
// otherwise never arrive). Installs from before the stamp existed compare the lockfile's
// mtime with npm's own node_modules/.package-lock.json.
function needsInstall(dir) {
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) return true;
  const hash = lockHash(dir);
  if (hash === null) return false;
  const stamp = path.join(modules, LOCK_STAMP);
  if (fs.existsSync(stamp)) return fs.readFileSync(stamp, 'utf8').trim() !== hash;
  const installed = path.join(modules, '.package-lock.json');
  if (!fs.existsSync(installed)) return true;
  return fs.statSync(path.join(dir, 'package-lock.json')).mtimeMs > fs.statSync(installed).mtimeMs;
}

function recordInstall(dir) {
  const hash = lockHash(dir);
  if (hash !== null) fs.writeFileSync(path.join(dir, 'node_modules', LOCK_STAMP), `${hash}\n`);
}

// The Electron shell: its own npm package with pinned dependencies (the root
// package stays dependency-free), tested against the dev build's siann-engine.
function appStep(options) {
  const APP = path.join(ROOT, 'app');
  const exe = path.join(NATIVE, 'build', 'dev', 'apps', 'engine', isWindows ? 'siann-engine.exe' : 'siann-engine');
  // The timeline e2e prepares its bundles with siann-cli create and import.
  const cli = path.join(NATIVE, 'build', 'dev', 'apps', 'cli', isWindows ? 'siann-cli.exe' : 'siann-cli');
  // The crash-recovery e2e crashes the engine with the hostile plugin; it skips without one.
  // (a file, or the bundle directory on macOS)
  const hostile = path.join(NATIVE, 'build', 'dev', 'libs', 'host_clap', 'hostile_plugin', 'siann_hostile_plugin.clap');
  // Without the native step in this run, build just what the e2e needs (as CI's app job does).
  if (!(options.selected || []).includes('native')) {
    const built = sequence([
      ['cmake', ['--preset', 'dev']],
      ['cmake', ['--build', '--preset', 'dev', '--target', 'siann-engine', 'siann-cli', 'siann_hostile_plugin_CLAP']],
    ], options);
    if (!built.ok) return built;
  }
  if (!fs.existsSync(exe)) {
    return { ok: false, output: `run the native step first: ${exe} is missing` };
  }
  if (!fs.existsSync(cli)) {
    return { ok: false, output: `run the native step first: ${cli} is missing` };
  }
  const env = { ...process.env, SIANN_ENGINE_EXE: exe, SIANN_CLI_EXE: cli };
  if (fs.existsSync(hostile)) env.SIANN_HOSTILE_PLUGIN_CLAP = hostile;
  // The editor-ownership test needs an engine that hosts plugins; it skips without one.
  const desktopBuild = path.join(NATIVE, 'build', 'desktop');
  const desktopExe = path.join(desktopBuild, 'apps', 'engine', isWindows ? 'siann-engine.exe' : 'siann-engine');
  const plugin = path.join(desktopBuild, 'libs', 'host_desktop', 'test_plugin', 'siann_test_plugin_artefacts', 'Debug',
    'VST3', 'siann_test_plugin.vst3');
  if (fs.existsSync(desktopExe) && fs.existsSync(plugin)) {
    env.SIANN_DESKTOP_ENGINE_EXE = desktopExe;
    env.SIANN_TEST_PLUGIN = plugin;
  }
  // The CLAP editor case (m5-clap-editor-window): siann_test_plugin's CLAP from the
  // same build (Ninja puts it beside its CMakeLists, a multi-config generator in Debug).
  const clapDir = path.join(desktopBuild, 'libs', 'host_clap', 'test_plugin');
  const clap = [path.join(clapDir, 'siann_test_plugin.clap'), path.join(clapDir, 'Debug', 'siann_test_plugin.clap')]
    .find((candidate) => fs.existsSync(candidate));
  if (fs.existsSync(desktopExe) && clap) {
    env.SIANN_DESKTOP_ENGINE_EXE = desktopExe;
    env.SIANN_TEST_PLUGIN_CLAP = clap;
  }
  // npm is a .cmd shim on Windows, which spawnSync runs only through cmd.exe.
  const npm = (args) => (isWindows ? run('cmd.exe', ['/d', '/c', 'npm', ...args], APP, env) : run('npm', args, APP, env));
  if (needsInstall(APP)) {
    const step = npm(['ci']);
    if (!step.ok) return { ...step, failedAt: 'npm ci' };
    recordInstall(APP);
  }
  // Some npm versions skip dependency install scripts; Electron's fetches its binary.
  if (!fs.existsSync(path.join(APP, 'node_modules', 'electron', 'path.txt'))) {
    const step = run(process.execPath, [path.join('node_modules', 'electron', 'install.js')], APP, env);
    if (!step.ok) return { ...step, failedAt: 'electron install.js' };
  }
  // The plain-tab e2e (m5-ui-shell) runs in Playwright's own Chromium; the
  // install is a no-op once the pinned revision is there.
  const npx = (args, withEnv = env) => (isWindows ? run('cmd.exe', ['/d', '/c', 'npx', ...args], APP, withEnv) : run('npx', args, APP, withEnv));
  const chromium = npx(['playwright', 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium']);
  if (!chromium.ok) return { ...chromium, failedAt: 'npx playwright install chromium' };
  for (const args of [['run', 'build'], ['test']]) {
    const step = npm(args);
    if (!step.ok) return { ...step, failedAt: `npm ${args.join(' ')}` };
  }
  return fidelityGate(APP, env, npx);
}

// The mockup fidelity gate (docs/harness/agent-rules.md, "UI fidelity"): the window
// against the mockup, geometry, computed styles and pixels, in en and zh-TW. The
// report goes to app/test-results/fidelity. While no gate of the manifest is
// `enforce` the gate only reports: a failed run is noted, not a failed step.
function fidelityEnforced() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'test', 'fidelity', 'manifest.json'), 'utf8'));
  return Object.values(manifest.gates).includes('enforce');
}

function fidelityGate(APP, env, npx) {
  const out = path.join(APP, 'test-results', 'fidelity');
  const step = npx(['playwright', 'test', '--project', 'fidelity'], { ...env, SIANN_FIDELITY: '1', SIANN_FIDELITY_OUT: out });
  const report = path.join(out, 'report.md');
  if (step.ok) return { ok: true, output: '', note: `fidelity report: ${report}` };
  if (fidelityEnforced()) return { ...step, failedAt: `the mockup fidelity gate (${report})` };
  return { ok: true, output: '', note: `the mockup fidelity gate did not pass (report-only until m5-ui-mockup-alignment): ${report}` };
}

// app/'s locked dependencies are installed and current: npm's own record of the
// install (node_modules/.package-lock.json) is not older than package-lock.json.
function appDepsFresh(appDir) {
  const installed = path.join(appDir, 'node_modules', '.package-lock.json');
  const lock = path.join(appDir, 'package-lock.json');
  if (!fs.existsSync(installed) || !fs.existsSync(lock)) return false;
  return fs.statSync(installed).mtimeMs >= fs.statSync(lock).mtimeMs;
}

// The desktop-release engine the installer ships, and its crash tests: with the
// static CRT, a plugin's abort() still ends the engine with exit code 3 and no
// dialog (spec, "Process model", Crash).
const PACKAGE_NATIVE = [
  ['cmake', ['--preset', 'desktop-release']],
  ['cmake', ['--build', '--preset', 'desktop-release', '--target', 'siann-engine', 'siann_engine_host_tests',
    'siann_engine_launch_tests', 'siann_host_clap_tests']],
  ['ctest', ['--preset', 'desktop-release', '-R', 'crash']],
];

// The Windows installer (m5b-package-windows): the desktop-release engine (Release,
// JUCE, static MSVC runtime) and its crash tests, `npm run dist` in app/
// (electron-builder, NSIS, no signing), the package tests over win-unpacked and the
// packaged e2e on its SIANN.exe. electron-builder makes the Windows installer on
// Windows only.
async function packageStep(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return { ok: true, output: '', note: 'skipped: the Windows installer is built on Windows only' };
  }
  const APP = path.join(ROOT, 'app');
  const built = sequence(PACKAGE_NATIVE, options);
  if (!built.ok) return built;
  const engine = path.join(NATIVE, 'build', 'desktop-release', 'apps', 'engine', 'siann-engine.exe');
  if (!fs.existsSync(engine)) return { ok: false, output: `${engine} is missing after the build` };

  // No signing: no certificate is looked up, and none the environment might hold is used.
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'SIANN_ENGINE_EXE']) {
    delete env[key];
  }
  const npm = (args) => run('cmd.exe', ['/d', '/c', 'npm', ...args], APP, env);
  if (!appDepsFresh(APP)) {
    const installed = npm(['ci']);
    if (!installed.ok) return { ...installed, failedAt: 'npm ci' };
  }
  if (!fs.existsSync(path.join(APP, 'node_modules', 'electron', 'path.txt'))) {
    const step = run(process.execPath, [path.join('node_modules', 'electron', 'install.js')], APP, env);
    if (!step.ok) return { ...step, failedAt: 'electron install.js' };
  }
  const dist = npm(['run', 'dist']);
  if (!dist.ok) return { ...dist, failedAt: 'npm run dist' };

  const unpacked = path.join(APP, 'release', 'win-unpacked');
  const packageTests = fs.readdirSync(path.join(ROOT, 'test', 'package')).filter((f) => f.endsWith('.test.js')).sort()
    .map((f) => path.join('test', 'package', f));
  const tests = run(process.execPath, ['--test', ...packageTests], ROOT, { ...env, SIANN_PACKAGE_DIR: unpacked });
  if (!tests.ok) return { ...tests, failedAt: 'node --test test/package' };

  const head = git(['rev-parse', 'HEAD']);
  if (!head) return { ok: false, output: 'git rev-parse HEAD failed' };
  const e2e = run('cmd.exe', ['/d', '/c', 'npx', 'playwright', 'test', '--project', 'packaged'], APP, {
    ...env,
    SIANN_PACKAGED_EXE: path.join(unpacked, 'SIANN.exe'),
    SIANN_EXPECT_COMMIT: head.trim(),
  });
  if (!e2e.ok) return { ...e2e, failedAt: 'playwright test --project packaged' };
  const installer = fs.readdirSync(path.join(APP, 'release')).find((f) => /^SIANN-Setup-.*-x64\.exe$/.test(f));
  return { ok: true, output: '', note: installer ? `app/release/${installer}` : undefined };
}

const STEPS = {
  node: () => run(process.execPath, ['--test', ...nodeTests()], ROOT),
  native: preset('dev'),
  desktop: preset('desktop'),
  app: appStep,
  package: packageStep,
  gcc,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const byChanges = options.changed && !options.only && !options.all;
  const changed = byChanges ? changedPaths(options.base) : null;
  const selected = selectSteps(options, changed);
  options.selected = selected;
  const say = (text) => { if (!options.json) process.stdout.write(text); };
  if (byChanges) {
    say(changed
      ? `[check-all] ${changed.length} changed path(s) since ${options.base || 'the merge-base with origin/main'}: ${selected.join(', ')}\n`
      : '[check-all] could not list the changes (no origin/main?): running every step\n');
  }
  if (options.plan) {
    if (options.json) process.stdout.write(`${JSON.stringify({ steps: selected, changed }, null, 2)}\n`);
    else say(`${selected.join('\n')}\n`);
    return 0;
  }
  const results = [];
  for (const name of selected) {
    say(`[check-all] ${name} ... `);
    const started = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    const result = await STEPS[name](options);
    const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e9);
    const tail = result.ok ? '' : result.output.split(/\r?\n/).slice(-60).join('\n');
    results.push({ step: name, ok: result.ok, seconds, failedAt: result.failedAt, note: result.note, tail });
    const passed = `ok (${seconds} s)${result.note ? ` (${result.note})` : ''}\n`;
    say(result.ok ? passed : `FAILED${result.failedAt ? ` at ${result.failedAt}` : ''}\n${tail}\n`);
  }
  const ok = results.every((r) => r.ok);
  if (options.json) process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  ALL_STEPS, appDepsFresh, buildTypeDefines, cacheRoot, changedPaths, dependencySource, desktopSources, fidelityEnforced,
  listSources, nativeEnv, needsInstall, PACKAGE_NATIVE, packageStep, parseArgs, presetBuildType, recordInstall, selectSteps,
  stepsForPath, stepsForPaths,
};
