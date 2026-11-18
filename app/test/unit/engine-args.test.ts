// The engine command line (architecture spec, "Process model"): the Windows window
// handle reaches the engine as a decimal number, and nothing else does.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  TEST_CAPABILITIES_ARG,
  TEST_ENVIRONMENT_ARG,
  engineArgs,
  engineTestArgs,
  fidelityEnvironmentArgs,
  pluginRegistryFile,
  testCapabilitiesArgs,
} from '../../src/main/engine-args';

const session = '/tmp/Untitled.siann';

function handle64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

test('a session alone', () => {
  assert.deepEqual(engineArgs({ session, platform: 'win32', windowHandle: null }), ['--session', session]);
});

test('on Windows the window handle is the owner, in decimal', () => {
  assert.deepEqual(engineArgs({ session, platform: 'win32', windowHandle: handle64(0x1a0b2cn) }), [
    '--session',
    session,
    '--owner-window',
    '1706796',
  ]);
});

test('a handle above 2^53 keeps every digit', () => {
  const args = engineArgs({ session, platform: 'win32', windowHandle: handle64(0xffff_ffff_ffff_fff1n) });
  assert.equal(args.at(-1), '18446744073709551601');
});

test('a 32-bit handle', () => {
  const windowHandle = Buffer.alloc(4);
  windowHandle.writeUInt32LE(4242);
  assert.equal(engineArgs({ session, platform: 'win32', windowHandle }).at(-1), '4242');
});

test('macOS and Linux pass no owner: their handles are not windows the engine can own by', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(engineArgs({ session, platform, windowHandle: handle64(7n) }), ['--session', session]);
  }
});

test('no plugin is opened at launch: editors open through plugin.open_editor (M4)', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const args = engineArgs({ session, platform, windowHandle: null });
    assert.ok(!args.includes('--open-editor'), platform);
  }
  const launch: Record<string, unknown> = { session, platform: 'darwin', windowHandle: null };
  launch.openEditor = '/x/Nova.component';  // a field the launch no longer has
  assert.deepEqual(engineArgs(launch as unknown as Parameters<typeof engineArgs>[0]), ['--session', session]);
});

test('the shell hands the engine its backoff, for the device retry', () => {
  assert.deepEqual(
    engineArgs({
      session,
      platform: 'linux',
      windowHandle: null,
      backoff: { initialMs: 250, maxMs: 10_000, resetAfterMs: 30_000 },
    }),
    ['--session', session, '--device-backoff', '250:10000:30000'],
  );
});

// m5-plugin-registry (Protocol v0 items 17 and 21): the engine keeps plugin
// approvals in the user's data directory, never in a session.
test('the plugin approvals live in <userData>/plugin-registry.json', () => {
  const userData = path.join(os.tmpdir(), 'SIANN user data');
  const file = pluginRegistryFile(userData);
  assert.equal(file, path.join(userData, 'plugin-registry.json'));
  assert.deepEqual(engineArgs({ session, platform: 'linux', windowHandle: null, pluginRegistry: file }), [
    '--session',
    session,
    '--plugin-registry',
    file,
  ]);
  // Before the e2e tests' own arguments.
  assert.deepEqual(
    engineArgs({ session, platform: 'linux', windowHandle: null, pluginRegistry: file, testArgs: ['--device', 'fake'] }),
    ['--session', session, '--plugin-registry', file, '--device', 'fake'],
  );
});

test('the e2e tests can add engine arguments, last', () => {
  assert.deepEqual(engineArgs({ session, platform: 'linux', windowHandle: null, testArgs: ['--device', 'fake'] }), [
    '--session',
    session,
    '--device',
    'fake',
  ]);
});

// The follow-up of PR #70: SIANN_ENGINE_TEST_ARGS split at spaces could not carry a
// plugin path with a space in it. A JSON array of strings carries any argument.
test('SIANN_ENGINE_TEST_ARGS as a JSON array keeps an argument with spaces whole', () => {
  const dir = path.join(os.tmpdir(), 'SIANN build', 'plugins');
  assert.deepEqual(engineTestArgs(JSON.stringify(['--device', 'fake', '--plugin-dir', dir])), [
    '--device',
    'fake',
    '--plugin-dir',
    dir,
  ]);
  assert.deepEqual(engineTestArgs('  ["--device", "fake"] '), ['--device', 'fake']);
});

test('SIANN_ENGINE_TEST_ARGS as plain words is split at spaces', () => {
  assert.deepEqual(engineTestArgs('--device fake  --test-wedge'), ['--device', 'fake', '--test-wedge']);
  assert.equal(engineTestArgs(undefined), undefined);
  assert.deepEqual(engineTestArgs(''), []);
});

test('SIANN_ENGINE_TEST_ARGS that starts as JSON but is not an array of strings is refused', () => {
  for (const text of ['[--device fake]', '["--device", 7]', '[', '["a"] trailing']) {
    assert.throws(() => engineTestArgs(text), /SIANN_ENGINE_TEST_ARGS/, text);
  }
});

// m5-ui-loop-click: SIANN_TEST_CAPABILITIES reaches the renderer only under
// SIANN_SHELL_TEST=1, as one argument carrying the file's JSON.
test('SIANN_TEST_CAPABILITIES: one renderer argument under SIANN_SHELL_TEST=1, nothing otherwise', () => {
  const answer = { methods: ['engine.capabilities'], commands: [], features: { plans: true } };
  const read = (file: string) => {
    assert.equal(file, '/tmp/caps.json');
    return JSON.stringify(answer);
  };
  const args = testCapabilitiesArgs({ SIANN_SHELL_TEST: '1', SIANN_TEST_CAPABILITIES: '/tmp/caps.json' }, read);
  assert.equal(args.length, 1);
  assert.ok(args[0]!.startsWith(TEST_CAPABILITIES_ARG));
  assert.deepEqual(JSON.parse(decodeURIComponent(args[0]!.slice(TEST_CAPABILITIES_ARG.length))), answer);
  // Not under test, or no file: nothing, and the file is not read.
  const never = () => assert.fail('read');
  assert.deepEqual(testCapabilitiesArgs({ SIANN_TEST_CAPABILITIES: '/tmp/caps.json' }, never), []);
  assert.deepEqual(testCapabilitiesArgs({ SIANN_SHELL_TEST: '0', SIANN_TEST_CAPABILITIES: '/tmp/caps.json' }, never), []);
  assert.deepEqual(testCapabilitiesArgs({ SIANN_SHELL_TEST: '1' }, never), []);
  // Not an engine.capabilities answer: refused.
  assert.throws(() => testCapabilitiesArgs({ SIANN_SHELL_TEST: '1', SIANN_TEST_CAPABILITIES: '/tmp/caps.json' }, () => '{"commands": []}'), /SIANN_TEST_CAPABILITIES/);
});

// m5-ui-alignment-chrome (UI redesign 10.2): SIANN_FIDELITY_ENVIRONMENT, the
// manifest's environment object as JSON, reaches the renderer only under
// SIANN_SHELL_TEST=1, as one argument, the same shape as the capabilities'.
test('SIANN_FIDELITY_ENVIRONMENT: one renderer argument under SIANN_SHELL_TEST=1, nothing otherwise', () => {
  const environment = {
    device: { id: 'ASIO/Scarlett 4i4', sampleRate: 48000, bufferFrames: 128, inputLatencyFrames: 128, outputLatencyFrames: 128 },
    engineAbout: { name: 'siann-engine', version: '0.1.0', license: 'X', source: { commit: 'a'.repeat(40), dirty: false } },
  };
  const text = JSON.stringify(environment);
  const args = fidelityEnvironmentArgs({ SIANN_SHELL_TEST: '1', SIANN_FIDELITY_ENVIRONMENT: text });
  assert.equal(args.length, 1);
  assert.ok(args[0]!.startsWith(TEST_ENVIRONMENT_ARG));
  assert.deepEqual(JSON.parse(decodeURIComponent(args[0]!.slice(TEST_ENVIRONMENT_ARG.length))), environment);
  // The variable does nothing without SIANN_SHELL_TEST=1.
  assert.deepEqual(fidelityEnvironmentArgs({ SIANN_FIDELITY_ENVIRONMENT: text }), []);
  assert.deepEqual(fidelityEnvironmentArgs({ SIANN_SHELL_TEST: '0', SIANN_FIDELITY_ENVIRONMENT: text }), []);
  assert.deepEqual(fidelityEnvironmentArgs({ SIANN_SHELL_TEST: '1' }), []);
  // Not an object: refused, so a run never draws what it did not mean.
  assert.throws(() => fidelityEnvironmentArgs({ SIANN_SHELL_TEST: '1', SIANN_FIDELITY_ENVIRONMENT: '[1]' }), /SIANN_FIDELITY_ENVIRONMENT/);
  assert.throws(() => fidelityEnvironmentArgs({ SIANN_SHELL_TEST: '1', SIANN_FIDELITY_ENVIRONMENT: 'nonsense' }), /SIANN_FIDELITY_ENVIRONMENT/);
});
