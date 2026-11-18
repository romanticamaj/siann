// The shell's power-save blocker while recording (m5b-ui-recording; UI
// redesign 3.5 [E3]: "While recording, the shell holds
// powerSaveBlocker('prevent-app-suspension')"). The main-process handler is
// told by the renderer that a recording started or ended; it starts one
// blocker of that type at the start, stops the same id at the end, and also
// when the window closes or the engine goes away (the recording is over then
// whatever the renderer said). Repeated news changes nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PowerSaveHandler, type PowerSaveBlockerLike } from '../../src/main/power-save';

function fakeBlocker() {
  const calls: string[] = [];
  let next = 7;
  const started = new Set<number>();
  const blocker: PowerSaveBlockerLike = {
    start: (type) => {
      const id = next;
      next += 1;
      started.add(id);
      calls.push(`start(${type}) = ${id}`);
      return id;
    },
    stop: (id) => {
      started.delete(id);
      calls.push(`stop(${id})`);
    },
    isStarted: (id) => started.has(id),
  };
  return { blocker, calls, started };
}

test('starts prevent-app-suspension at the start of a recording and stops the same id at its end', () => {
  const { blocker, calls, started } = fakeBlocker();
  const handler = new PowerSaveHandler(blocker);
  assert.equal(handler.held(), false);
  handler.recording(true);
  assert.equal(handler.held(), true);
  handler.recording(false);
  assert.equal(handler.held(), false);
  assert.deepEqual(calls, ['start(prevent-app-suspension) = 7', 'stop(7)']);
  assert.equal(started.size, 0);
});

test('idempotent: a repeated start holds one blocker, a repeated stop stops nothing more', () => {
  const { blocker, calls } = fakeBlocker();
  const handler = new PowerSaveHandler(blocker);
  handler.recording(true);
  handler.recording(true);
  handler.recording(false);
  handler.recording(false);
  assert.deepEqual(calls, ['start(prevent-app-suspension) = 7', 'stop(7)']);
  // A second recording takes a new blocker.
  handler.recording(true);
  assert.deepEqual(calls.at(-1), 'start(prevent-app-suspension) = 8');
});

test('released when the window closes or the engine goes away', () => {
  for (const end of ['window', 'engine'] as const) {
    const { blocker, calls } = fakeBlocker();
    const handler = new PowerSaveHandler(blocker);
    handler.recording(true);
    handler.release(end);
    assert.equal(handler.held(), false, end);
    assert.deepEqual(calls, ['start(prevent-app-suspension) = 7', 'stop(7)'], end);
    handler.release(end);
    assert.equal(calls.length, 2, `${end}: nothing more`);
  }
});

test('anything but a boolean from the renderer is ignored', () => {
  const { blocker, calls } = fakeBlocker();
  const handler = new PowerSaveHandler(blocker);
  handler.recording('yes' as unknown as boolean);
  handler.recording(undefined as unknown as boolean);
  assert.deepEqual(calls, []);
});
