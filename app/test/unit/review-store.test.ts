// The plan review's state, lifted out of the Plans tab (m5b-ui-ghosts; UI
// redesign 4.2, 5.2): model/review-store.ts holds the selected plan, its
// ticked steps, its plan.preview, the hovered and the pinned step and the
// ghosts toggle, framework-free (React reads it through useSyncExternalStore),
// so the ghosts exist with the right zone closed. It asks plan.preview (and,
// for a stale plan, session.fetch at the base revision) as the tab did, and
// nothing else. Ghosts are drawn for a reviewable plan only (validated or
// approved, and not stale), and a reconnect clears the selection, the ticks
// and the pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlanStore } from '../../src/renderer/model/plan-store';
import type { Snapshot } from '../../src/renderer/model/read-model';
import { ReviewStore, reviewable, type ReviewClient } from '../../src/renderer/model/review-store';
import { ghostsOf } from '../../src/renderer/plans/ghosts';
import { mockupPlans, mockupPreview, mockupSnapshot, MOCKUP_STEPS, PENDING, APPLIED, REJECTED, STALE } from './support/mockup-plan';

function fakeClient(snapshot: Snapshot = mockupSnapshot()) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<() => void>();
  let current = snapshot;
  const client: ReviewClient = {
    model: {
      getSnapshot: () => current,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
    },
    request: async (method, params) => {
      sent.push({ method, params });
      if (method === 'plan.preview') return mockupPreview();
      return { entities: [] };
    },
  };
  return {
    client,
    sent,
    set(next: Snapshot) {
      current = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function make() {
  const plans = new PlanStore({ now: () => 0 });
  plans.fromList({ plans: mockupPlans().map((p) => p.raw) });
  const fake = fakeClient();
  const store = new ReviewStore({ client: fake.client, plans });
  await settle();
  return { plans, store, ...fake };
}

test('reviewable: validated or approved, and not stale', () => {
  const [stale, rejected, applied, pending] = mockupPlans();
  assert.equal(reviewable(pending), true);
  assert.equal(reviewable({ ...pending!, state: 'approved' }), true);
  for (const plan of [stale, rejected, applied, { ...pending!, state: 'draft' as const }, { ...pending!, state: 'rolled_back' as const }]) assert.equal(reviewable(plan), false, plan!.state);
  assert.equal(reviewable(undefined), false);
});

test('the default selection is the card\'s plan; its preview is asked once, and the ghosts are ghostsOf of it', async () => {
  const { store, sent } = await make();
  assert.equal(store.plan()?.hash, PENDING);
  assert.deepEqual(sent.map((s) => s.method), ['plan.preview']);
  assert.deepEqual(sent[0]!.params, { plan: PENDING });
  assert.ok(store.getSnapshot().preview?.preview);
  assert.deepEqual(store.ghosts(), ghostsOf(MOCKUP_STEPS, mockupPreview(), mockupSnapshot(), null));
  assert.ok(store.ghosts().length >= 6);
  // The same array while nothing it is made of changed.
  assert.equal(store.ghosts(), store.ghosts());
});

test('ticks, hover, pin and the toggle: ghosts follow the ticks and the toggle, the hover leaves them alone', async () => {
  const { store } = await make();
  let changes = 0;
  store.subscribe(() => (changes += 1));
  const before = store.ghosts();
  store.setHot(2);
  assert.equal(store.getSnapshot().hotStep, 2);
  assert.equal(store.outlineStep(), 3);
  assert.equal(store.ghosts(), before, 'a hover does not make new ghosts');
  store.setTicked(new Set([0, 1, 3, 4, 5]));
  assert.ok(!store.ghosts().some((g) => g.step === 3));
  assert.deepEqual(store.ghosts(), ghostsOf(MOCKUP_STEPS, mockupPreview(), mockupSnapshot(), new Set([0, 1, 3, 4, 5])));
  store.toggleGhosts();
  assert.equal(store.getSnapshot().ghostsOn, false);
  assert.deepEqual(store.ghosts(), []);
  store.toggleGhosts();
  assert.ok(store.ghosts().length > 0);
  assert.ok(changes >= 4);
});

test('locate pins the step until another step is located or hovered; a click on a ghost pins its step and asks for the Plans tab', async () => {
  const { store, sent } = await make();
  const reveals: unknown[] = [];
  store.onReveal((request) => reveals.push(request));
  store.locate(2);
  assert.equal(store.getSnapshot().pinnedStep, 2);
  assert.equal(store.outlineStep(), 3);
  // Step 3 of the mockup's plan is a gain: it has a strip ghost, so the MixConsole is asked for.
  assert.deepEqual(reveals.at(-1), { step: 3, mixer: true, plans: false });
  store.locate(0);
  assert.equal(store.getSnapshot().pinnedStep, 0);
  store.setHot(0);
  assert.equal(store.getSnapshot().pinnedStep, 0, 'the pointer on the pinned row keeps the pin');
  store.setHot(4);
  assert.equal(store.getSnapshot().pinnedStep, null, 'the pointer entering another row ends the pin');
  store.setHot(null);
  store.pinGhost(6);
  assert.equal(store.getSnapshot().pinnedStep, 5);
  assert.deepEqual(reveals.at(-1), { step: 6, mixer: false, plans: true });
  assert.deepEqual(sent.map((s) => s.method), ['plan.preview'], 'locating sends no request');
});

test('a hover asks to reveal its step\'s ghosts without opening a zone', async () => {
  const { store } = await make();
  const reveals: unknown[] = [];
  store.onReveal((request) => reveals.push(request));
  store.setHot(3);
  assert.deepEqual(reveals, [{ step: 4, mixer: false, plans: false }]);
});

test('no ghosts for an applied, a rejected or a stale plan', async () => {
  const { store } = await make();
  for (const hash of [APPLIED, REJECTED, STALE]) {
    store.select(hash);
    await settle();
    assert.equal(store.plan()?.hash, hash);
    assert.equal(store.reviewable(), false, hash);
    assert.deepEqual(store.ghosts(), [], hash);
  }
  store.select(PENDING);
  await settle();
  assert.ok(store.ghosts().length > 0);
});

test('another plan on the card, or a reconnect, clears the ticks, the hover and the pin; a reconnect the selection too', async () => {
  const { store } = await make();
  store.select(PENDING);
  store.setTicked(new Set([0]));
  store.locate(1);
  store.select(APPLIED);
  assert.equal(store.getSnapshot().ticked, null);
  assert.equal(store.getSnapshot().pinnedStep, null);
  store.select(PENDING);
  store.setTicked(new Set([0]));
  store.locate(1);
  store.reset();
  assert.deepEqual(
    { selected: store.getSnapshot().selected, ticked: store.getSnapshot().ticked, pinned: store.getSnapshot().pinnedStep, hot: store.getSnapshot().hotStep },
    { selected: null, ticked: null, pinned: null, hot: null },
  );
});

test('a new head revision asks plan.preview again, and the ghosts follow the snapshot', async () => {
  const { store, sent, set } = await make();
  const before = store.ghosts();
  set({ ...mockupSnapshot(), revision: 'r40' });
  await settle();
  assert.deepEqual(sent.map((s) => s.method), ['plan.preview', 'plan.preview']);
  assert.notEqual(store.ghosts(), before);
});
