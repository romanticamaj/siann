'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scriptInvocation } = require('../src/bridge/script-invocation');
const { parseArgs } = require('../scripts/check-all');

test('JavaScript runners start with the current Node executable', () => {
  for (const file of ['/x/runner.js', '/x/runner.cjs', '/x/runner.mjs', 'C:\\x\\RUNNER.JS']) {
    assert.deepEqual(scriptInvocation(file, ['cmd.json'], '/work'), {
      command: process.execPath,
      args: [file, 'cmd.json'],
      cwd: '/work',
    });
  }
});

test('other runners are spawned directly', () => {
  assert.deepEqual(scriptInvocation('/x/siann-command-runner', ['cmd.json'], '/work'), {
    command: '/x/siann-command-runner',
    args: ['cmd.json'],
    cwd: '/work',
  });
});

test('check-all parses its flags', () => {
  assert.deepEqual(parseArgs([]), { desktop: false, gcc: false, app: false, json: false, only: null });
  assert.deepEqual(parseArgs(['--gcc', '--desktop', '--json', '--only', 'native']),
    { desktop: true, gcc: true, app: false, json: true, only: 'native' });
  assert.deepEqual(parseArgs(['--app', '--gcc']), { desktop: false, gcc: true, app: true, json: false, only: null });
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});
