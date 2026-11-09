#!/usr/bin/env node
// pluginval at strictness 5 (m4-juce-formats; architecture spec, Libraries and
// "Build, test and CI"). pluginval is GPL and runs as its own process, never linked.
//
//   node scripts/pluginval.js [options] <plugin>...   validate plugins by path
//   node scripts/pluginval.js [options] --compat      the compatibility set in
//                                                     scripts/compat-plugins.json
//
// Options:
//   --pluginval <exe>           the pluginval binary (or a pluginval.app); default
//                               $SIANN_PLUGINVAL
//   --strictness-level <1-10>   default 5
//   --timeout-ms <ms>           pluginval's no-output timeout, default 300000
//   --output-dir <dir>          where pluginval writes its logs
//   --disabled-tests <file>     pluginval's list of tests not to run (say why where
//                               it is used)
//   --skip-gui-tests            no editor tests (pluginval's own flag)
//   --json                      a summary {ok, plugins: [{id, path, result}]} on stdout
//
// --compat: each entry names one environment variable holding the plugin's path.
// Unset: SKIP (the plugin is not installed or not authorised here; nothing prompts
// for a login). Set to a path that does not exist: FAIL. Entries with "platforms"
// run on those platforms only (AU on macOS).
//
// Exit code: 0 when nothing failed, 1 when a plugin failed or was missing, 2 when
// there is no pluginval to run or the arguments are wrong.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COMPAT_FILE = path.join(__dirname, 'compat-plugins.json');
const DEFAULT_STRICTNESS = '5';
const DEFAULT_TIMEOUT_MS = '300000';

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    pluginval: null,
    strictness: DEFAULT_STRICTNESS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputDir: null,
    disabledTests: null,
    skipGuiTests: false,
    compat: false,
    json: false,
    plugins: [],
  };
  const value = (i, name) => {
    if (i >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pluginval') options.pluginval = value(++i, arg);
    else if (arg === '--strictness-level') options.strictness = value(++i, arg);
    else if (arg === '--timeout-ms') options.timeoutMs = value(++i, arg);
    else if (arg === '--output-dir') options.outputDir = value(++i, arg);
    else if (arg === '--disabled-tests') options.disabledTests = value(++i, arg);
    else if (arg === '--skip-gui-tests') options.skipGuiTests = true;
    else if (arg === '--compat') options.compat = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else options.plugins.push(arg);
  }
  if (!/^(10|[1-9])$/.test(options.strictness)) throw new UsageError('--strictness-level takes 1 to 10');
  if (!/^\d+$/.test(options.timeoutMs)) throw new UsageError('--timeout-ms takes a number of milliseconds');
  if (options.compat === (options.plugins.length > 0)) {
    throw new UsageError('give plugin paths or --compat, not both and not neither');
  }
  return options;
}

// The binary to run: a pluginval.app (macOS) stands for the executable inside it.
function resolvePluginval(given) {
  const hint =
    'pluginval not found: pass --pluginval <exe> or set SIANN_PLUGINVAL ' +
    '(https://github.com/Tracktion/pluginval/releases/tag/v1.0.4)';
  const candidate = given || process.env.SIANN_PLUGINVAL;
  if (!candidate) return { error: hint };
  const exe = candidate.endsWith('.app') ? path.join(candidate, 'Contents', 'MacOS', 'pluginval') : candidate;
  if (!fs.existsSync(exe)) return { error: `${hint}; ${exe} does not exist` };
  return { exe };
}

function pluginvalArgs(options, plugin) {
  const args = ['--strictness-level', options.strictness, '--timeout-ms', options.timeoutMs];
  if (options.outputDir) args.push('--output-dir', options.outputDir);
  if (options.disabledTests) args.push('--disabled-tests', options.disabledTests);
  if (options.skipGuiTests) args.push('--skip-gui-tests');
  args.push('--validate', plugin);
  return args;
}

// A pluginval given as a .js file runs under this Node: the tests' stand-in. Its
// output goes to stderr when stdout carries the JSON summary.
function runPluginval(exe, args, json) {
  const [command, commandArgs] = exe.endsWith('.js') ? [process.execPath, [exe, ...args]] : [exe, args];
  const result = spawnSync(command, commandArgs, { stdio: ['ignore', json ? 2 : 1, 2] });
  if (result.error) return { ok: false, reason: String(result.error) };
  if (result.status !== 0) return { ok: false, reason: `pluginval exited with ${result.status ?? result.signal}` };
  return { ok: true };
}

// [{id, path | null, env?}] for this run.
function targets(options) {
  if (!options.compat) return options.plugins.map((plugin) => ({ id: plugin, path: plugin }));
  const compat = JSON.parse(fs.readFileSync(COMPAT_FILE, 'utf8'));
  return compat.plugins
    .filter((entry) => !entry.platforms || entry.platforms.includes(process.platform))
    .map((entry) => ({ id: entry.id, env: entry.env, path: process.env[entry.env] || null }));
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`pluginval.js: ${error.message}\n`);
    return 2;
  }
  const pluginval = resolvePluginval(options.pluginval);
  if (pluginval.error) {
    process.stderr.write(`pluginval.js: ${pluginval.error}\n`);
    return 2;
  }
  if (options.outputDir) fs.mkdirSync(options.outputDir, { recursive: true });
  // With --json, stdout carries the summary alone; the lines go to stderr.
  const say = (line) => (options.json ? process.stderr : process.stdout).write(`${line}\n`);

  const results = [];
  for (const target of targets(options)) {
    if (target.path === null) {
      say(`SKIP ${target.id}: ${target.env} is not set`);
      results.push({ id: target.id, path: null, result: 'skip' });
      continue;
    }
    if (!fs.existsSync(target.path)) {
      const from = target.env ? ` (${target.env})` : '';
      say(`FAIL ${target.id}: ${target.path}${from} does not exist`);
      results.push({ id: target.id, path: target.path, result: 'fail' });
      continue;
    }
    say(`---- ${target.id}: pluginval --strictness-level ${options.strictness} ${target.path}`);
    const outcome = runPluginval(pluginval.exe, pluginvalArgs(options, target.path), options.json);
    say(outcome.ok ? `PASS ${target.id}` : `FAIL ${target.id}: ${outcome.reason}`);
    results.push({ id: target.id, path: target.path, result: outcome.ok ? 'pass' : 'fail' });
  }
  const ok = results.every((entry) => entry.result !== 'fail');
  if (options.json) process.stdout.write(`${JSON.stringify({ ok, plugins: results })}\n`);
  return ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { parseArgs, pluginvalArgs, main };
