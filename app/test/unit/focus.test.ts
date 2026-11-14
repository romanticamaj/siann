// The second-instance handler (architecture spec, "Process model", Single
// instance): a second launch brings the first window forward, and on macOS the
// app steals activation, because focus() alone does not activate a background app.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { focusFirstWindow, type FocusApp, type FocusWindow } from '../../src/main/focus';

function fakes(state: { minimized?: boolean; destroyed?: boolean } = {}): {
  app: FocusApp;
  win: FocusWindow;
  calls: string[];
} {
  const calls: string[] = [];
  const app: FocusApp = {
    focus: (options) => calls.push(`app.focus(${JSON.stringify(options)})`),
  };
  const win: FocusWindow = {
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  return { app, win, calls };
}

test('macOS steals activation and shows the window before focusing it', () => {
  const { app, win, calls } = fakes();
  focusFirstWindow(app, win, 'darwin');
  assert.deepEqual(calls, ['app.focus({"steal":true})', 'show', 'focus']);
});

test('macOS restores a minimized window first', () => {
  const { app, win, calls } = fakes({ minimized: true });
  focusFirstWindow(app, win, 'darwin');
  assert.deepEqual(calls, ['restore', 'app.focus({"steal":true})', 'show', 'focus']);
});

for (const platform of ['win32', 'linux'] as const) {
  test(`${platform} restores and focuses the window, and leaves the app alone`, () => {
    const plain = fakes();
    focusFirstWindow(plain.app, plain.win, platform);
    assert.deepEqual(plain.calls, ['focus']);
    const minimized = fakes({ minimized: true });
    focusFirstWindow(minimized.app, minimized.win, platform);
    assert.deepEqual(minimized.calls, ['restore', 'focus']);
  });
}

test('no window, or a destroyed one, is left alone', () => {
  const none = fakes();
  focusFirstWindow(none.app, null, 'darwin');
  assert.deepEqual(none.calls, []);
  const destroyed = fakes({ destroyed: true });
  focusFirstWindow(destroyed.app, destroyed.win, 'darwin');
  assert.deepEqual(destroyed.calls, []);
});
