// The toast store (m5-ui-connection; UI redesign spec 1.6 and 4.5 C8):
// framework-free, with the auto-dismiss on an injected scheduler (no timers,
// no wall clock). A reconnect of the connection phase pushes the catalog's
// "reconnected" message with the recovered revision, in the UI locale.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconnectedMessage } from '../../src/renderer/i18n/messages';
import type { Locale } from '../../src/renderer/i18n/locale';
import type { PhaseState } from '../../src/renderer/model/connection-phase';
import { announceReconnects, TOAST_MS, ToastStore } from '../../src/renderer/shell/toast-store';

class FakeScheduler {
  readonly timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { fn, ms, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  live() {
    return this.timers.filter((t) => !t.cancelled);
  }
  fireAll(): void {
    for (const timer of this.live()) {
      timer.cancelled = true;
      timer.fn();
    }
  }
}

test('push shows a toast, dismiss removes it and cancels its timer', () => {
  const scheduler = new FakeScheduler();
  const store = new ToastStore({ schedule: scheduler.schedule });
  let notified = 0;
  store.subscribe(() => (notified += 1));
  const a = store.push('first');
  const b = store.push('second');
  assert.notEqual(a, b);
  assert.deepEqual(
    store.getSnapshot().map((t) => t.text),
    ['first', 'second'],
  );
  assert.equal(scheduler.live().length, 2);
  assert.ok(scheduler.live().every((t) => t.ms === TOAST_MS));
  store.dismiss(a);
  assert.deepEqual(
    store.getSnapshot().map((t) => t.text),
    ['second'],
  );
  assert.equal(scheduler.live().length, 1, "the dismissed toast's timer is cancelled");
  // Dismissing twice is harmless.
  store.dismiss(a);
  assert.equal(notified, 3);
});

test('a toast dismisses itself when its time is up', () => {
  const scheduler = new FakeScheduler();
  const store = new ToastStore({ schedule: scheduler.schedule, durationMs: 1234 });
  store.push('gone soon');
  assert.equal(scheduler.live()[0]!.ms, 1234);
  const snapshot = store.getSnapshot();
  assert.equal(store.getSnapshot(), snapshot, 'the snapshot is stable between changes');
  scheduler.fireAll();
  assert.deepEqual(store.getSnapshot(), []);
});

class FakePhases {
  state: PhaseState = { phase: 'starting', connectedBefore: false, pending: null, reconnect: null };
  readonly listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  set(state: PhaseState): void {
    this.state = state;
    for (const l of [...this.listeners]) l();
  }
}

for (const [locale, expected] of [
  ['en', 'Reconnected at r42'],
  ['zh-Hant', '已在 r42 重新連線'],
  ['zh-Hans', '已在 r42 重新连接'],
] as const) {
  test(`a reconnect pushes the reconnected message with the recovered revision (${locale})`, () => {
    const scheduler = new FakeScheduler();
    const store = new ToastStore({ schedule: scheduler.schedule });
    const phases = new FakePhases();
    const off = announceReconnects(phases, store, (revision) => reconnectedMessage(locale as Locale, { revision }));
    // The first connection announces nothing.
    phases.set({ phase: 'online', connectedBefore: true, pending: null, reconnect: null });
    assert.deepEqual(store.getSnapshot(), []);
    phases.set({ phase: 'offline', connectedBefore: true, pending: null, reconnect: null });
    phases.set({ phase: 'online', connectedBefore: true, pending: null, reconnect: { revision: 'r42', count: 1 } });
    assert.deepEqual(
      store.getSnapshot().map((t) => t.text),
      [expected],
    );
    // The same reconnect seen again (another phase notification) is not repeated.
    phases.set({ ...phases.state });
    assert.equal(store.getSnapshot().length, 1);
    off();
    assert.equal(phases.listeners.size, 0);
  });
}
