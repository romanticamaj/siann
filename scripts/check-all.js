#!/usr/bin/env node
// One command for every local check the milestone harness relies on.
//
//   node scripts/check-all.js                 Node tests + native dev build and tests
//   node scripts/check-all.js --desktop       also the JUCE desktop preset
//   node scripts/check-all.js --gcc           also a g++ -Werror syntax check (WSL on Windows),
//                                             of the JUCE sources too once the desktop preset
//                                             has fetched JUCE (run --desktop first)
//   node scripts/check-all.js --app           also the Electron shell (app/): npm ci on first
//                                             use, build, unit and Playwright tests against
//                                             native/build/dev's siann-engine (after native)
//   node scripts/check-all.js --only native   one step: node | native | desktop | app | gcc
//   node scripts/check-all.js --json          machine-readable summary
//
// Exit code 0 when every selected step passes, 1 otherwise.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const isWindows = process.platform === 'win32';

function parseArgs(argv) {
  const options = { desktop: false, gcc: false, app: false, json: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--desktop') options.desktop = true;
    else if (arg === '--gcc') options.gcc = true;
    else if (arg === '--app') options.app = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--only') options.only = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

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

// cmake / ctest with the Visual Studio environment on Windows.
function native(tool, args) {
  if (isWindows) {
    return run('cmd.exe', ['/d', '/c', path.join('tools', 'msvc-env.cmd'), tool, ...args], NATIVE);
  }
  return run(tool, args, NATIVE);
}

function preset(name) {
  return () => {
    for (const [tool, args] of [
      ['cmake', ['--preset', name]],
      ['cmake', ['--build', '--preset', name]],
      ['ctest', ['--preset', name]],
    ]) {
      const step = native(tool, args);
      if (!step.ok) return { ...step, failedAt: `${tool} ${args.join(' ')}` };
    }
    return { ok: true, output: '' };
  };
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

function gcc() {
  const deps = path.join(NATIVE, 'build', 'dev', '_deps');
  if (!fs.existsSync(deps)) {
    return { ok: false, output: 'run the native step first: third-party sources come from native/build/dev/_deps' };
  }
  const toPosix = (p) => {
    if (!isWindows) return p;
    const m = /^([A-Za-z]):\\(.*)$/.exec(p);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
  };
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
  // The protocol tests reuse the playback tests' live rig (as in their CMake target).
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'playback', 'tests', 'support'))}`);
  // The siann-engine launch tests reuse the protocol tests' loopback clients.
  includes.push(`-I${toPosix(path.join(NATIVE, 'libs', 'protocol', 'tests'))}`);
  for (const d of ['dr_libs-src', 'r8brain-src', 'ixwebsocket-src', path.join('catch2-src', 'src'), path.join('catch2-build', 'generated-includes')]) {
    includes.push('-isystem', toPosix(path.join(deps, d)));
  }
  const flags = ['-std=c++20', '-Wall', '-Wextra', '-Wpedantic', '-Wshadow', '-Werror', '-fsyntax-only',
    '-DSIANN_FIXTURES_DIR="x"', ...includes];
  const failures = [];
  let output = '';
  const check = (file, fileFlags) => {
    const args = [...fileFlags, toPosix(file)];
    const step = isWindows ? run('wsl.exe', ['-e', 'g++', ...args], ROOT) : run('g++', args, ROOT);
    if (!step.ok) {
      failures.push(path.relative(ROOT, file));
      output += step.output;
    }
  };
  for (const file of listSources()) check(file, flags);
  // JUCE comes from the desktop preset's own fetch, and its macros as in host_desktop/CMakeLists.txt.
  const juce = path.join(NATIVE, 'build', 'desktop', '_deps', 'juce-src', 'modules');
  const haveJuce = fs.existsSync(juce);
  if (haveJuce) {
    const desktopFlags = [...flags,
      '-I', toPosix(path.join(NATIVE, 'libs', 'host_desktop', 'tests')),
      '-isystem', toPosix(juce),
      '-isystem', toPosix(path.join(juce, 'juce_audio_processors_headless', 'format_types', 'VST3_SDK')),
      '-DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1', '-DJUCE_STANDALONE_APPLICATION=0', '-DJUCE_PLUGINHOST_VST3=1',
      '-DJUCE_MODAL_LOOPS_PERMITTED=1', '-DSIANN_ENGINE_WITH_JUCE=1', '-DSIANN_TEST_PLUGIN_VST3="x"'];
    for (const file of desktopSources()) check(file, desktopFlags);
  }
  return {
    ok: failures.length === 0,
    output: failures.length ? `failed: ${failures.join(', ')}\n${output}` : '',
    note: haveJuce ? undefined : 'the JUCE sources were not checked: run --desktop first',
  };
}

// The bridge's tests only: a bare `node --test` would also pick up JavaScript
// under native/build/dev/_deps (IXWebSocket ships test/*.js).
function nodeTests() {
  const dir = path.join(ROOT, 'test');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
}

// The Electron shell: its own npm package with pinned dependencies (the root
// package stays dependency-free), tested against the dev build's siann-engine.
function appStep() {
  const APP = path.join(ROOT, 'app');
  const exe = path.join(NATIVE, 'build', 'dev', 'apps', 'engine', isWindows ? 'siann-engine.exe' : 'siann-engine');
  if (!fs.existsSync(exe)) {
    return { ok: false, output: `run the native step first: ${exe} is missing` };
  }
  const env = { ...process.env, SIANN_ENGINE_EXE: exe };
  // The editor-ownership test needs an engine that hosts plugins; it skips without one.
  const desktopBuild = path.join(NATIVE, 'build', 'desktop');
  const desktopExe = path.join(desktopBuild, 'apps', 'engine', isWindows ? 'siann-engine.exe' : 'siann-engine');
  const plugin = path.join(desktopBuild, 'libs', 'host_desktop', 'test_plugin', 'siann_test_plugin_artefacts', 'Debug',
    'VST3', 'siann_test_plugin.vst3');
  if (fs.existsSync(desktopExe) && fs.existsSync(plugin)) {
    env.SIANN_DESKTOP_ENGINE_EXE = desktopExe;
    env.SIANN_TEST_PLUGIN = plugin;
  }
  // npm is a .cmd shim on Windows, which spawnSync runs only through cmd.exe.
  const npm = (args) => (isWindows ? run('cmd.exe', ['/d', '/c', 'npm', ...args], APP, env) : run('npm', args, APP, env));
  const steps = [];
  if (!fs.existsSync(path.join(APP, 'node_modules'))) steps.push(['ci']);
  for (const args of steps) {
    const step = npm(args);
    if (!step.ok) return { ...step, failedAt: `npm ${args.join(' ')}` };
  }
  // Some npm versions skip dependency install scripts; Electron's fetches its binary.
  if (!fs.existsSync(path.join(APP, 'node_modules', 'electron', 'path.txt'))) {
    const step = run(process.execPath, [path.join('node_modules', 'electron', 'install.js')], APP, env);
    if (!step.ok) return { ...step, failedAt: 'electron install.js' };
  }
  for (const args of [['run', 'build'], ['test']]) {
    const step = npm(args);
    if (!step.ok) return { ...step, failedAt: `npm ${args.join(' ')}` };
  }
  return { ok: true, output: '' };
}

const STEPS = {
  node: () => run(process.execPath, ['--test', ...nodeTests()], ROOT),
  native: preset('dev'),
  desktop: preset('desktop'),
  app: appStep,
  gcc,
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.only
    ? [options.only]
    : ['node', 'native', ...(options.desktop ? ['desktop'] : []), ...(options.app ? ['app'] : []),
      ...(options.gcc ? ['gcc'] : [])];
  const results = [];
  for (const name of selected) {
    if (!STEPS[name]) throw new Error(`unknown step ${name}`);
    if (!options.json) process.stdout.write(`[check-all] ${name} ... `);
    const result = STEPS[name]();
    const tail = result.ok ? '' : result.output.split(/\r?\n/).slice(-60).join('\n');
    results.push({ step: name, ok: result.ok, seconds: Math.round(result.seconds || 0), failedAt: result.failedAt, note: result.note, tail });
    if (!options.json) {
      const passed = `ok${result.note ? ` (${result.note})` : ''}\n`;
      process.stdout.write(result.ok ? passed : `FAILED${result.failedAt ? ` at ${result.failedAt}` : ''}\n${tail}\n`);
    }
  }
  const ok = results.every((r) => r.ok);
  if (options.json) process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { desktopSources, listSources, parseArgs };
