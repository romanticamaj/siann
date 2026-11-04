'use strict';

// The long native tests ([long], M2's 10-minute recording and kill) run only in
// a scheduled or manually triggered workflow, never on pull requests or pushes,
// and the default CI never selects them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const LONG = path.join(WORKFLOWS, 'long-tests.yml');
const CI = path.join(WORKFLOWS, 'ci.yml');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// The lines of a top-level YAML key's block (without the key line).
function topLevelBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  assert.ok(start >= 0, `top-level "${key}:" in the workflow`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block;
}

// Keys directly under a block, at its first indentation level.
function childKeys(block) {
  const indents = block.filter((l) => /^\s+\S/.test(l) && !/^\s*#/.test(l)).map((l) => l.match(/^\s*/)[0].length);
  if (indents.length === 0) return [];
  const level = Math.min(...indents);
  return block
    .filter((l) => l.match(/^\s*/)[0].length === level && /^\s*[A-Za-z_][\w-]*:/.test(l))
    .map((l) => l.trim().split(':')[0]);
}

test('the long-tests workflow runs on a schedule and on demand only', () => {
  assert.ok(fs.existsSync(LONG), '.github/workflows/long-tests.yml exists');
  const text = read(LONG);
  const triggers = childKeys(topLevelBlock(text, 'on'));
  assert.ok(triggers.includes('schedule'), `schedule trigger (got ${triggers.join(', ')})`);
  assert.ok(triggers.includes('workflow_dispatch'), 'workflow_dispatch trigger');
  assert.ok(!triggers.includes('pull_request'), 'no pull_request trigger');
  assert.ok(!triggers.includes('pull_request_target'), 'no pull_request_target trigger');
  assert.ok(!triggers.includes('push'), 'no push trigger');
  assert.match(text, /-\s*cron:\s*['"][^'"]+['"]/, 'a cron schedule');
});

test('the long-tests workflow builds the native core and runs siann_cli_tests "[long]"', () => {
  const text = read(LONG);
  assert.match(text, /cmake -S native -B (\S+)[^\n]*-DSIANN_WERROR=ON/, 'configures the native core with SIANN_WERROR');
  assert.doesNotMatch(text, /SIANN_WITH_JUCE=ON/, 'core build, no JUCE');
  assert.match(text, /cmake --build /, 'builds');
  assert.match(text, /siann_cli_tests[^\n]*"\[long\]"/, 'runs siann_cli_tests "[long]"');
  assert.match(text, /timeout-minutes:\s*\d+/, 'has a timeout');
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    assert.ok(text.includes(os), `runs on ${os}`);
  }
});

test('the default CI does not select the long tests', () => {
  const text = read(CI);
  assert.ok(!text.includes('[long]'), 'ci.yml never mentions [long]');
  const triggers = childKeys(topLevelBlock(text, 'on'));
  assert.ok(triggers.includes('pull_request'), 'ci.yml still runs on pull requests');
});
