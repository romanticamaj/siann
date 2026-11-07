// The engine command line (architecture spec, "Process model"): the Windows window
// handle reaches the engine as a decimal number, and nothing else does.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { engineArgs } from '../../src/main/engine-args';

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

test('the plugin to open is passed on every platform', () => {
  assert.deepEqual(engineArgs({ session, platform: 'darwin', windowHandle: null, openEditor: '/x/Nova.component' }), [
    '--session',
    session,
    '--open-editor',
    '/x/Nova.component',
  ]);
  assert.deepEqual(engineArgs({ session, platform: 'darwin', windowHandle: null, openEditor: '' }), ['--session', session]);
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

test('the e2e tests can add engine arguments, last', () => {
  assert.deepEqual(engineArgs({ session, platform: 'linux', windowHandle: null, testArgs: ['--device', 'fake'] }), [
    '--session',
    session,
    '--device',
    'fake',
  ]);
});
