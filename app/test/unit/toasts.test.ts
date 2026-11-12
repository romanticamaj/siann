// Toasts (UX pass, B3/A11): shown, dismissed after their time or by hand,
// not repeated, capped, and the last error kept after its toast is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_TOASTS, ToastStore } from '../../src/renderer/model/toasts';

function manualClock() {
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  let now = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, at: now + ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => !t.cancelled && t.at <= now)) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

test('a toast dismisses itself after its time; the last error stays', () => {
  const clock = manualClock();
  const store = new ToastStore(clock.schedule);
  let notified = 0;
  store.subscribe(() => (notified += 1));
  store.error('revision_mismatch: the head moved');
  assert.equal(store.getSnapshot().toasts.length, 1);
  assert.equal(store.getSnapshot().lastError, 'revision_mismatch: the head moved');
  clock.advance(5999);
  assert.equal(store.getSnapshot().toasts.length, 1);
  clock.advance(1);
  assert.equal(store.getSnapshot().toasts.length, 0);
  assert.equal(store.getSnapshot().lastError, 'revision_mismatch: the head moved');
  assert.ok(notified >= 2);
  store.clearLastError();
  assert.equal(store.getSnapshot().lastError, '');
});

test('an info toast leaves the last error alone; a repeat restarts its time instead of stacking', () => {
  const clock = manualClock();
  const store = new ToastStore(clock.schedule);
  store.error('a');
  store.info('Engine restarted');
  assert.equal(store.getSnapshot().lastError, 'a');
  clock.advance(4000);
  store.error('a');
  assert.equal(store.getSnapshot().toasts.length, 2);
  clock.advance(3000);
  assert.deepEqual(
    store.getSnapshot().toasts.map((t) => t.text),
    ['a'],
    'the info toast went, the repeated error was restarted',
  );
});

test('dismissing by hand, and the oldest goes beyond the cap', () => {
  const clock = manualClock();
  const store = new ToastStore(clock.schedule);
  const first = store.info('one');
  store.dismiss(first);
  assert.equal(store.getSnapshot().toasts.length, 0);
  for (let i = 0; i < MAX_TOASTS + 2; i += 1) store.info(`n${i}`);
  const texts = store.getSnapshot().toasts.map((t) => t.text);
  assert.equal(texts.length, MAX_TOASTS);
  assert.equal(texts[0], 'n2');
  clock.advance(10_000);
  assert.equal(store.getSnapshot().toasts.length, 0);
});
