'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { scriptInvocation } = require('../src/bridge/script-invocation');
const { desktopSources, listSources, parseArgs } = require('../scripts/check-all');

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

test('the g++ check reaches the JUCE sources too', () => {
  const relative = (files) => files.map((f) => path.relative(path.join(__dirname, '..', 'native'), f).replace(/\\/g, '/'));
  const desktop = relative(desktopSources());
  for (const file of ['libs/host_desktop/src/juce_plugin_host.cpp', 'libs/host_desktop/test_plugin/processor.cpp',
    'libs/host_desktop/test_plugin/vst3_restarter.cpp', 'libs/host_desktop/tests/juce_plugin_host_test.cpp',
    'apps/engine/tests/engine_launch_test.cpp', 'apps/engine/src/main_thread_desktop.cpp']) {
    assert.ok(desktop.includes(file), file);
  }
  // Needs windows.h, which WSL's g++ does not have.
  assert.ok(!desktop.includes('libs/host_desktop/src/juce_plugin_host_win.cpp'));
  assert.ok(!relative(listSources()).some((f) => f.startsWith('libs/host_desktop/')));
});

test('check-all parses its flags', () => {
  const none = { desktop: false, gcc: false, app: false, json: false, only: null,
    changed: false, all: false, base: null, plan: false, jobs: null };
  assert.deepEqual(parseArgs([]), none);
  assert.deepEqual(parseArgs(['--gcc', '--desktop', '--json', '--only', 'native']),
    { ...none, desktop: true, gcc: true, json: true, only: 'native' });
  assert.deepEqual(parseArgs(['--app', '--gcc']), { ...none, gcc: true, app: true });
  assert.deepEqual(parseArgs(['--changed', '--base', 'HEAD^1', '--plan', '-j', '4']),
    { ...none, changed: true, base: 'HEAD^1', plan: true, jobs: 4 });
  assert.deepEqual(parseArgs(['--all', '--jobs', '2']), { ...none, all: true, jobs: 2 });
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['-j', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--only', 'nope']), /unknown step/);
});
