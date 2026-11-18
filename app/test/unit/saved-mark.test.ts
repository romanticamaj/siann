// The saved mark (m5b-ui-project; UI redesign UR-4): the renderer's. Its
// baseline is the head revision at the window's first sync, at every session
// epoch (session.opened, model/session-client.ts) and the revision
// session.save answers; the mark shows while the head differs from it. A
// session reopened with journaled, unsaved revisions therefore starts
// unmarked (docs/harness/follow-ups.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SavedMark, type SavedMarkClient } from '../../src/renderer/model/project';

function fakeClient() {
  const listeners = new Set<() => void>();
  let state = { epoch: 0, syncCount: 0 };
  let revision: string | null = null;
  const client: SavedMarkClient = {
    getState: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    model: {
      getSnapshot: () => (revision === null ? null : { revision }),
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
  };
  const emit = () => [...listeners].forEach((l) => l());
  return {
    client,
    // A sync lands at `head`.
    sync(head: string) {
      revision = head;
      state = { ...state, syncCount: state.syncCount + 1 };
      emit();
    },
    // A delta moves the head.
    head(next: string) {
      revision = next;
      emit();
    },
    epoch() {
      state = { ...state, epoch: state.epoch + 1 };
      emit();
    },
  };
}

test('the first sync is the baseline; an edit marks; Save\'s revision clears', () => {
  const engine = fakeClient();
  const mark = new SavedMark(engine.client);
  assert.equal(mark.getSnapshot(), false, 'nothing synced: no mark');
  engine.sync('r9');
  assert.equal(mark.getSnapshot(), false, 'a session reopened at r9 with unsaved revisions starts unmarked');
  let told = 0;
  mark.subscribe(() => (told += 1));
  engine.head('r10');
  assert.equal(mark.getSnapshot(), true);
  assert.equal(told, 1);
  mark.saved('r10');
  assert.equal(mark.getSnapshot(), false);
  engine.head('r11');
  assert.equal(mark.getSnapshot(), true);
  // Back to the saved revision (an undo): no mark.
  engine.head('r10');
  assert.equal(mark.getSnapshot(), false);
});

test('a resync of the same session keeps the baseline (an engine restart)', () => {
  const engine = fakeClient();
  const mark = new SavedMark(engine.client);
  engine.sync('r3');
  engine.head('r4');
  engine.sync('r4');
  assert.equal(mark.getSnapshot(), true, 'the restart re-synced at the unsaved head: still marked');
});

test('each epoch takes the opened session\'s first sync as its baseline', () => {
  const engine = fakeClient();
  const mark = new SavedMark(engine.client);
  engine.sync('r3');
  engine.head('r4');
  assert.equal(mark.getSnapshot(), true);
  // Open: the epoch comes before the new session's sync.
  engine.epoch();
  assert.equal(mark.getSnapshot(), false, 'between the epoch and its sync nothing is marked');
  engine.sync('r12');
  assert.equal(mark.getSnapshot(), false, 'the opened session starts unmarked');
  engine.head('r13');
  assert.equal(mark.getSnapshot(), true);
  mark.destroy();
});

test('the saved revision is the baseline: the status bar names it, never an unsaved head', () => {
  const engine = fakeClient();
  const mark = new SavedMark(engine.client);
  assert.equal(mark.savedRevision(), null, 'nothing synced: no saved revision');
  engine.sync('r3');
  assert.equal(mark.savedRevision(), 'r3');
  engine.head('r4');
  assert.equal(mark.getSnapshot(), true);
  assert.equal(mark.savedRevision(), 'r3', 'marked: the saved revision stays the baseline');
  let told = 0;
  mark.subscribe(() => (told += 1));
  // The head moved on while Save ran: still marked, but the baseline moved, and the listeners hear it.
  mark.saved('r2');
  assert.equal(mark.getSnapshot(), true);
  assert.equal(mark.savedRevision(), 'r2');
  assert.equal(told, 1);
  mark.saved('r2');
  assert.equal(told, 1, 'the same baseline again: nothing changed');
  mark.saved('r4');
  assert.equal(mark.savedRevision(), 'r4');
  assert.equal(mark.getSnapshot(), false);
  engine.epoch();
  assert.equal(mark.savedRevision(), null, 'between the epoch and its sync there is no saved revision');
  engine.sync('r12');
  assert.equal(mark.savedRevision(), 'r12');
  mark.destroy();
});
