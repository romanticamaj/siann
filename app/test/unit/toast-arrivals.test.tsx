// The toast surface (m5-ui-plan-panel; UI redesign 4.4: "a new plan raises a
// toast and the count on the Plans button; nothing steals focus"). The store
// is generic (push(message)), so m5-ui-connection's reconnect toast uses it
// too: toasts expire by an injected timer, can be dismissed, and only the
// newest few are visible. A plan arrival from the PlanStore pushes the
// catalog's planArrived message in the current locale. The region is a
// polite status region and the component never moves the focus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale } from '../../src/renderer/i18n/locale';
import { planArrivedMessage } from '../../src/renderer/i18n/messages';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { announceArrivals } from '../../src/renderer/plans/arrivals';
import { ToastStore, TOAST_MS, MAX_TOASTS } from '../../src/renderer/shell/toast-store';
import { Toasts } from '../../src/renderer/shell/Toasts';
import { FakeScheduler } from './support/fakes';

const RENDERER = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');

test('push, expiry by the injected timer, dismiss, and a cap on the visible toasts', () => {
  const scheduler = new FakeScheduler();
  const toasts = new ToastStore({ schedule: scheduler.schedule });
  let notified = 0;
  toasts.subscribe(() => (notified += 1));
  const first = toasts.push('one');
  assert.deepEqual(toasts.getSnapshot().map((t) => t.text), ['one']);
  assert.equal(notified, 1);
  const snapshot = toasts.getSnapshot();
  assert.equal(toasts.getSnapshot(), snapshot, 'stable identity');

  scheduler.fire(TOAST_MS);
  assert.deepEqual(toasts.getSnapshot(), [], 'expired');
  toasts.dismiss(first);

  const second = toasts.push('two');
  toasts.push('three');
  toasts.dismiss(second);
  assert.deepEqual(toasts.getSnapshot().map((t) => t.text), ['three']);
  assert.ok(scheduler.timers.find((t) => t.cancelled), 'a dismissed toast cancels its timer');

  for (let i = 0; i < MAX_TOASTS + 2; i += 1) toasts.push(`n${i}`);
  const shown = toasts.getSnapshot().map((t) => t.text);
  assert.equal(shown.length, MAX_TOASTS);
  assert.equal(shown[shown.length - 1], `n${MAX_TOASTS + 1}`, 'the newest stays');
});

function planObject(hash: string, state: string, extra: Record<string, unknown> = {}) {
  return { schema: 'siann.plan.v1', hash, state, baseRevision: 'r1', steps: [{}, {}, {}], readSet: [], writeSet: [], stale: [], ...extra };
}

test('a plan arrival pushes the planArrived message in the current locale', () => {
  const scheduler = new FakeScheduler();
  const toasts = new ToastStore({ schedule: scheduler.schedule });
  const plans = new PlanStore({ now: () => 0 });
  let locale: Locale = 'en';
  const off = announceArrivals(plans, toasts, () => locale);
  const hash = 'sha256:' + '1'.repeat(64);
  plans.applyChanged({ schema: 'siann.event.v1', seq: '1', type: 'plan.changed', plan: hash, state: 'validated' });
  plans.setStatus(planObject(hash, 'validated'));
  assert.deepEqual(toasts.getSnapshot().map((t) => t.text), [planArrivedMessage('en', { steps: 3 })]);
  // A language switch re-words a toast already shown.
  assert.equal(toasts.getSnapshot()[0]!.reword?.('zh-Hans'), planArrivedMessage('zh-Hans', { steps: 3 }));

  locale = 'zh-Hant';
  const other = 'sha256:' + '2'.repeat(64);
  plans.applyChanged({ schema: 'siann.event.v1', seq: '2', type: 'plan.changed', plan: other, state: 'validated' });
  plans.setStatus(planObject(other, 'validated'));
  assert.equal(toasts.getSnapshot()[1]!.text, planArrivedMessage('zh-Hant', { steps: 3 }));

  off();
  const third = 'sha256:' + '3'.repeat(64);
  plans.applyChanged({ schema: 'siann.event.v1', seq: '3', type: 'plan.changed', plan: third, state: 'validated' });
  plans.setStatus(planObject(third, 'validated'));
  assert.equal(toasts.getSnapshot().length, 2, 'unsubscribed');
});

test('the toast region is a polite status region that never takes the focus', () => {
  const toasts = new ToastStore({ schedule: () => () => undefined });
  toasts.push('A plan with 3 steps arrived');
  const markup = renderToStaticMarkup(<Toasts store={toasts} />);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /data-testid="toast"/);
  assert.ok(markup.includes('A plan with 3 steps arrived'));
  assert.ok(!/autofocus/i.test(markup), markup);
  const source = fs.readFileSync(path.join(RENDERER, 'shell', 'Toasts.tsx'), 'utf8');
  assert.ok(!/\.focus\(/.test(source), 'Toasts.tsx never calls focus()');
  assert.ok(!/autoFocus/.test(source), 'Toasts.tsx never auto-focuses');
  assert.equal(renderToStaticMarkup(<Toasts store={new ToastStore({ schedule: () => () => undefined })} />).includes('data-testid="toast"'), false);
});
