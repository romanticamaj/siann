#!/usr/bin/env node
// `npm run app`: start SIANN from a source checkout (m5b-package-windows,
// acceptance 1). Node built-ins only; the root package stays dependency-free.
//
//   npm run app              install, build and start what is missing, then the app
//   npm run app -- --plan    print the steps and run nothing
//
// The steps, in order:
//   1. `npm ci` in app/ when app/node_modules is missing or older than
//      app/package-lock.json (npm's own app/node_modules/.package-lock.json is
//      compared with it);
//   2. `npm run build` in app/, always: it is quick, and there is no stamp to
//      tell whether the build is current;
//   3. when the engine of the Debug `desktop` preset (JUCE) is missing:
//      `cmake --preset desktop` and `cmake --build --preset desktop --target
//      siann-engine` in native/, as scripts/check-all.js runs the native steps
//      (through native/tools/msvc-env.cmd on Windows, with its shared caches);
//   4. Electron in app/, with SIANN_ENGINE_EXE pointing at that engine.
//
// The installer's engine is a different build (the desktop-release preset);
// see app/electron-builder.json.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { appDepsFresh, nativeEnv } = require('./check-all.js');

const ROOT = path.resolve(__dirname, '..');

function engineExe(root, platform) {
  return path.join(root, 'native', 'build', 'desktop', 'apps', 'engine',
    platform === 'win32' ? 'siann-engine.exe' : 'siann-engine');
}

// What is there already: app/'s dependencies installed and current, and the engine built.
function detectState({ root = ROOT, platform = process.platform } = {}) {
  return {
    depsFresh: appDepsFresh(path.join(root, 'app')),
    engineBuilt: fs.existsSync(engineExe(root, platform)),
  };
}

// The steps for a state, each { name, command, args, cwd, env? }.
function planRun({ platform = process.platform, root = ROOT, depsFresh, engineBuilt, env = process.env }) {
  const app = path.join(root, 'app');
  const native = path.join(root, 'native');
  const windows = platform === 'win32';
  // npm is a .cmd shim on Windows, which only cmd.exe runs.
  const npm = (args) => ({
    name: `npm ${args.join(' ')}`,
    command: windows ? 'cmd.exe' : 'npm',
    args: windows ? ['/d', '/c', 'npm', ...args] : args,
    cwd: app,
  });
  const cmake = (args) => ({
    name: `cmake ${args.join(' ')}`,
    command: windows ? 'cmd.exe' : 'cmake',
    args: windows ? ['/d', '/c', path.join('tools', 'msvc-env.cmd'), 'cmake', ...args] : args,
    cwd: native,
    env: nativeEnv({}, env),
  });
  const steps = [];
  if (!depsFresh) steps.push(npm(['ci']));
  steps.push(npm(['run', 'build']));
  if (!engineBuilt) {
    steps.push(cmake(['--preset', 'desktop']));
    steps.push(cmake(['--build', '--preset', 'desktop', '--target', 'siann-engine']));
  }
  steps.push({
    name: 'electron',
    command: process.execPath,
    args: [path.join(app, 'node_modules', 'electron', 'cli.js'), '.'],
    cwd: app,
    env: { ...env, SIANN_ENGINE_EXE: engineExe(root, platform) },
  });
  return steps;
}

function describe(step) {
  const engine = step.name === 'electron' ? `  (SIANN_ENGINE_EXE=${step.env.SIANN_ENGINE_EXE})` : '';
  return `${step.name}\n    in ${step.cwd}: ${[step.command, ...step.args].join(' ')}${engine}\n`;
}

// Runs one step with the terminal attached; its exit code.
function runStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: step.env || process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error) {
    process.stderr.write(`[run-app] ${step.name}: ${result.error.message}\n`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

async function main(argv, {
  platform = process.platform,
  root = ROOT,
  state,
  write = (text) => process.stdout.write(text),
  run = runStep,
} = {}) {
  let plan = false;
  for (const arg of argv) {
    if (arg === '--plan') plan = true;
    else {
      process.stderr.write(`[run-app] unknown argument ${arg} (only --plan)\n`);
      return 2;
    }
  }
  const steps = planRun({ platform, root, ...(state || detectState({ root, platform })) });
  if (plan) {
    for (const step of steps) write(describe(step));
    return 0;
  }
  for (const step of steps) {
    write(`[run-app] ${step.name}\n`);
    // eslint-disable-next-line no-await-in-loop
    const code = await run(step);
    if (code !== 0) {
      write(`[run-app] ${step.name} failed (exit ${code})\n`);
      return code;
    }
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = { detectState, engineExe, main, planRun };
