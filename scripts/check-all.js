#!/usr/bin/env node
// One command for every local check the milestone harness relies on.
//
//   node scripts/check-all.js                 Node tests + native dev build and tests
//   node scripts/check-all.js --desktop       also the JUCE desktop preset
//   node scripts/check-all.js --gcc           also a g++ -Werror syntax check (WSL on Windows)
//   node scripts/check-all.js --only native   one step: node | native | desktop | gcc
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
  const options = { desktop: false, gcc: false, json: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--desktop') options.desktop = true;
    else if (arg === '--gcc') options.gcc = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--only') options.only = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function run(command, args, cwd) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
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
  for (const d of ['dr_libs-src', 'r8brain-src', 'ixwebsocket-src', path.join('catch2-src', 'src'), path.join('catch2-build', 'generated-includes')]) {
    includes.push('-isystem', toPosix(path.join(deps, d)));
  }
  const flags = ['-std=c++20', '-Wall', '-Wextra', '-Wpedantic', '-Wshadow', '-Werror', '-fsyntax-only',
    '-DSIANN_FIXTURES_DIR="x"', ...includes];
  const failures = [];
  let output = '';
  for (const file of listSources()) {
    const args = [...flags, toPosix(file)];
    const step = isWindows ? run('wsl.exe', ['-e', 'g++', ...args], ROOT) : run('g++', args, ROOT);
    if (!step.ok) {
      failures.push(path.relative(ROOT, file));
      output += step.output;
    }
  }
  return { ok: failures.length === 0, output: failures.length ? `failed: ${failures.join(', ')}\n${output}` : '' };
}

// The bridge's tests only: a bare `node --test` would also pick up JavaScript
// under native/build/dev/_deps (IXWebSocket ships test/*.js).
function nodeTests() {
  const dir = path.join(ROOT, 'test');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
}

const STEPS = {
  node: () => run(process.execPath, ['--test', ...nodeTests()], ROOT),
  native: preset('dev'),
  desktop: preset('desktop'),
  gcc,
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.only
    ? [options.only]
    : ['node', 'native', ...(options.desktop ? ['desktop'] : []), ...(options.gcc ? ['gcc'] : [])];
  const results = [];
  for (const name of selected) {
    if (!STEPS[name]) throw new Error(`unknown step ${name}`);
    if (!options.json) process.stdout.write(`[check-all] ${name} ... `);
    const result = STEPS[name]();
    const tail = result.ok ? '' : result.output.split(/\r?\n/).slice(-60).join('\n');
    results.push({ step: name, ok: result.ok, seconds: Math.round(result.seconds || 0), failedAt: result.failedAt, tail });
    if (!options.json) {
      process.stdout.write(result.ok ? 'ok\n' : `FAILED${result.failedAt ? ` at ${result.failedAt}` : ''}\n${tail}\n`);
    }
  }
  const ok = results.every((r) => r.ok);
  if (options.json) process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
