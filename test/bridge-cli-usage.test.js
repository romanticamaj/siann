'use strict';

// bin/siann.js usage errors (m5b-bridge-cli-coverage, acceptance item 5): every
// subcommand's missing arguments, an unknown command or workflow, an option a
// subcommand does not take or one without its value exit 1 with the usage on
// stderr and nothing on stdout; --help, anywhere, exits 0 with the usage on stdout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'siann.js');

function siann(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function usageError(args, message) {
  const result = siann(args);
  assert.equal(result.status, 1, `siann ${args.join(' ')}`);
  assert.match(result.stderr, /Usage:\n {2}siann run /, `siann ${args.join(' ')}`);
  assert.equal(result.stdout, '', `siann ${args.join(' ')}`);
  if (message) assert.match(result.stderr, message, `siann ${args.join(' ')}`);
}

test('no command is a usage error', () => {
  usageError([]);
});

test('an unknown command or workflow is a usage error naming it', () => {
  usageError(['nope'], /unknown command: siann nope/);
  usageError(['workflow', 'nope', 'x.json'], /unknown command: siann workflow nope/);
  usageError(['workflow'], /unknown command: siann workflow/);
  usageError(['plan', 'outtake', 'dir', '--out', 'x.json'], /unknown command: siann plan outtake/);
  usageError(['live', 'export-pack', 'm.json'], /unknown command/);
  usageError(['export', 'aaf', 'm.json', '--out', 'x'], /unknown command/);
});

test('every subcommand without its arguments is a usage error', () => {
  for (const args of [
    ['run'],
    ['validate-journal'],
    ['plan', 'intake'],
    ['plan', 'intake', 'dir'],
    ['live', 'import-pack'],
    ['export', 'dawproject'],
    ['export', 'dawproject', 'm.json'],
    ['rollback'],
    ['workflow', 'import-pack'],
    ['workflow', 'import-pack', 'm.json'],
    ['workflow', 'validate-plan'],
    ['workflow', 'approve-plan', 'plan.json'],
    ['workflow', 'reject-plan', 'plan.json'],
    ['workflow', 'apply-plan', 'plan.json'],
  ]) {
    usageError(args, /missing arguments/);
  }
});

test('an option the subcommand does not take, an unknown option and a missing value are usage errors', () => {
  usageError(['run', 'cmd.json', '--out', 'x.json'], /siann run does not take --out/);
  usageError(['plan', 'intake', 'dir', '--out', 'x.json', '--copy-media'], /does not take --copy-media/);
  usageError(['export', 'dawproject', 'm.json', '--out', 'x', '--device', 'fake'], /does not take --device/);
  usageError(['workflow', 'validate-plan', 'p.json', '--plan', 'q.json'], /does not take --plan/);
  usageError(['rollback', 'j.json', '--context', 'c.json'], /does not take --context/);
  usageError(['run', 'cmd.json', '--bogus'], /unknown option --bogus/);
  usageError(['run', 'cmd.json', '--device'], /option --device needs a value/);
});

test('--help, alone or after a command, prints the usage on stdout and exits 0', () => {
  for (const args of [['--help'], ['-h'], ['run', '--help'], ['workflow', 'apply-plan', '-h'], ['rollback', '--help']]) {
    const result = siann(args);
    assert.equal(result.status, 0, args.join(' '));
    assert.match(result.stdout, /^Usage:\n {2}siann run /, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
  }
});
