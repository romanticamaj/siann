// The engine command line (architecture spec, "Process model"): the Windows window
// handle reaches the engine as a decimal number, and nothing else does.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { engineArgs, pluginRegistryFile } from '../../src/main/engine-args';

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
