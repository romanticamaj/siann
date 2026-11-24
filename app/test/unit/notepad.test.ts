// The Notepad's drafts (m5b-ui-notepad; UI redesign 3.4, 10.11 item 23): a
// pure per-track reducer and its store, no React. The expectations come from
// the spec's 3.4 paragraph, not from the code under test:
//
// - the area shows the document's notes with CR LF and a lone CR as LF;
// - a draft is dirty only when typing left the text different from what the
//   area showed: a focus and a blur, or a text typed and reverted, send
//   nothing;
// - a leave or a commit of a dirty draft sends one track.set_notes for the
//   track the draft belongs to ("" for an emptied text), and no second one
//   while it is in flight (Mod+Enter, then the blur it causes);
// - Escape discards; a refusal keeps the draft and its Refusal until the next
//   commit or a discard;
// - a change that arrives while the draft is dirty keeps the draft and says
//   so (changedElsewhere); a clean area follows the document;
// - the edit guard sends nothing and keeps the draft;
// - drafts are per track id while the window lives, and go with the track.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TrackEntity } from '../../src/renderer/model/document';
import type { Refusal } from '../../src/renderer/plans/RefusalLine';
import {
  EMPTY_NOTEPAD,
  commit,
  createNotepadStore,
  discard,
  draftOf,
  settled,
  shownNotes,
  syncTracks,
  textOf,
  typed,
  type NotepadState,
} from '../../src/renderer/shell/notepad';
import { track } from './support/timeline';

const withNotes = (id: string, notes?: string): TrackEntity => ({ ...track(id), ...(notes === undefined ? {} : { notes }) });
const REFUSED: Refusal = { code: 'invalid_notes', message: 'track notes are at most 16384 bytes', changedEntities: [] };

function synced(...tracks: TrackEntity[]): NotepadState {
  return syncTracks(EMPTY_NOTEPAD, tracks);
}

test('the shown text is the document\'s notes with CR LF and a lone CR as LF, as a textarea shows them', () => {
  assert.equal(shownNotes(undefined), '');
  assert.equal(shownNotes(''), '');
  assert.equal(shownNotes('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(shownNotes('\ttab\r\n'), '\ttab\n');
  const state = synced(withNotes('trk_a', 'one\r\ntwo'), withNotes('trk_b'));
  assert.equal(textOf(state, 'trk_a'), 'one\ntwo');
  assert.equal(textOf(state, 'trk_b'), '');
  assert.equal(textOf(state, 'trk_missing'), '');
});

test('dirty only when typing changed the shown text: no command for a focus then a blur, or for a text typed and reverted', () => {
  // Stored CR LF: the area shows LF, and leaving it untouched sends nothing.
  const state = synced(withNotes('trk_a', 'line 1\r\nline 2'));
  assert.equal(commit(state, 'trk_a', false).command, null, 'a blur with no typing');
  const typedBack = typed(typed(state, 'trk_a', 'line 1\nline 2!'), 'trk_a', 'line 1\nline 2');
  assert.equal(draftOf(typedBack, 'trk_a')?.draft, null, 'reverted: clean');
  assert.equal(commit(typedBack, 'trk_a', false).command, null, 'typed then reverted');
});

test('a leave or a commit of a dirty draft gives one track.set_notes for the draft\'s track, and "" for an emptied text', () => {
  let state = synced(withNotes('trk_a', 'old'), withNotes('trk_b', 'other'));
  state = typed(state, 'trk_a', 'new\ntext');
  // The selection moved to trk_b meanwhile: the command is still trk_a's.
  const first = commit(state, 'trk_a', false);
  assert.deepEqual(first.command, { op: 'track.set_notes', trackId: 'trk_a', notes: 'new\ntext' });
  assert.equal(commit(state, 'trk_b', false).command, null, 'trk_b has no draft');
  const emptied = commit(typed(synced(withNotes('trk_a', 'gone')), 'trk_a', ''), 'trk_a', false);
  assert.deepEqual(emptied.command, { op: 'track.set_notes', trackId: 'trk_a', notes: '' });
});

test('no second command while one is in flight (Mod+Enter, then the blur it causes)', () => {
  const state = typed(synced(withNotes('trk_a', 'a')), 'trk_a', 'ab');
  const sent = commit(state, 'trk_a', false);
  assert.ok(sent.command);
  assert.equal(commit(sent.state, 'trk_a', false).command, null, 'the blur after Mod+Enter');
  // Settled: clean, the text is what was sent.
  const done = settled(sent.state, 'trk_a', 'ab', null);
  assert.equal(draftOf(done, 'trk_a')?.draft, null);
  assert.equal(textOf(done, 'trk_a'), 'ab');
  assert.equal(commit(done, 'trk_a', false).command, null);
});

test('discard drops the draft and shows the document\'s text', () => {
  const state = typed(synced(withNotes('trk_a', 'kept\r\n')), 'trk_a', 'typed');
  assert.equal(textOf(state, 'trk_a'), 'typed');
  const dropped = discard(state, 'trk_a');
  assert.equal(textOf(dropped, 'trk_a'), 'kept\n');
  assert.equal(draftOf(dropped, 'trk_a')?.draft, null);
  assert.equal(commit(dropped, 'trk_a', false).command, null);
});

test('a refusal keeps the draft and carries the Refusal; the next successful commit or a discard clears it', () => {
  const state = typed(synced(withNotes('trk_a', 'a')), 'trk_a', 'bad‮');
  const sent = commit(state, 'trk_a', false);
  const refused = settled(sent.state, 'trk_a', 'bad‮', REFUSED);
  assert.equal(textOf(refused, 'trk_a'), 'bad‮', 'the draft is kept');
  assert.deepEqual(draftOf(refused, 'trk_a')?.refusal, REFUSED);
  // It can be committed again once fixed.
  const fixed = typed(refused, 'trk_a', 'good');
  assert.deepEqual(draftOf(fixed, 'trk_a')?.refusal, REFUSED, 'typing keeps the line until the next commit');
  const again = commit(fixed, 'trk_a', false);
  assert.deepEqual(again.command, { op: 'track.set_notes', trackId: 'trk_a', notes: 'good' });
  assert.equal(draftOf(settled(again.state, 'trk_a', 'good', null), 'trk_a')?.refusal, null, 'a success clears it');
  assert.equal(draftOf(discard(refused, 'trk_a'), 'trk_a')?.refusal, null, 'a discard clears it');
});

test('a document change while dirty keeps the draft and sets changedElsewhere; while clean it replaces the text; commit and discard clear the flag', () => {
  const clean = synced(withNotes('trk_a', 'v1'));
  const followed = syncTracks(clean, [withNotes('trk_a', 'v2\r\nx')]);
  assert.equal(textOf(followed, 'trk_a'), 'v2\nx');
  assert.equal(draftOf(followed, 'trk_a')?.changedElsewhere, false);

  const dirty = typed(clean, 'trk_a', 'mine');
  const arrived = syncTracks(dirty, [withNotes('trk_a', 'theirs')]);
  assert.equal(textOf(arrived, 'trk_a'), 'mine', 'the draft stays');
  assert.equal(draftOf(arrived, 'trk_a')?.changedElsewhere, true);
  // Escape then shows the arrived text.
  const shown = discard(arrived, 'trk_a');
  assert.equal(textOf(shown, 'trk_a'), 'theirs');
  assert.equal(draftOf(shown, 'trk_a')?.changedElsewhere, false);
  // Committing overwrites the change as one command.
  const sent = commit(arrived, 'trk_a', false);
  assert.deepEqual(sent.command, { op: 'track.set_notes', trackId: 'trk_a', notes: 'mine' });
  const done = settled(sent.state, 'trk_a', 'mine', null);
  assert.equal(draftOf(done, 'trk_a')?.changedElsewhere, false);
  // The echo of the window's own commit is no change elsewhere.
  const echoed = syncTracks(sent.state, [withNotes('trk_a', 'mine')]);
  assert.equal(draftOf(echoed, 'trk_a')?.changedElsewhere, false);
});

test('the edit guard: blocked gives no command and keeps the draft', () => {
  const state = typed(synced(withNotes('trk_a', 'a')), 'trk_a', 'held');
  const blocked = commit(state, 'trk_a', true);
  assert.equal(blocked.command, null);
  assert.equal(textOf(blocked.state, 'trk_a'), 'held');
  // Once main is heard it commits.
  assert.deepEqual(commit(blocked.state, 'trk_a', false).command, { op: 'track.set_notes', trackId: 'trk_a', notes: 'held' });
});

test('drafts are kept per track id, and dropped when the track leaves the document', () => {
  let state = synced(withNotes('trk_a', 'a'), withNotes('trk_b', 'b'));
  state = typed(state, 'trk_a', 'a draft');
  state = typed(state, 'trk_b', 'b draft');
  assert.equal(textOf(state, 'trk_a'), 'a draft');
  assert.equal(textOf(state, 'trk_b'), 'b draft');
  const removed = syncTracks(state, [withNotes('trk_a', 'a')]);
  assert.equal(textOf(removed, 'trk_a'), 'a draft');
  assert.equal(draftOf(removed, 'trk_b'), undefined);
  // An unchanged document gives the same state object (useSyncExternalStore).
  assert.equal(syncTracks(removed, [withNotes('trk_a', 'a')]), removed);
});

test('the store sends one command.execute per commit, with the head revision, and settles from its answer', async () => {
  let snapshot = { revision: 'r7', tracks: [withNotes('trk_a', 'a'), withNotes('trk_b')] } as { revision: string; tracks: TrackEntity[] };
  const listeners = new Set<() => void>();
  const model = { getSnapshot: () => snapshot, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
  const sent: Array<{ commands: readonly unknown[]; revision?: string }> = [];
  let answer: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  let blocked = false;
  const store = createNotepadStore({
    model,
    execute: (commands, revision) => {
      sent.push({ commands, revision });
      return new Promise<unknown>((resolve, reject) => (answer = { resolve: () => resolve(undefined), reject }));
    },
    blocked: () => blocked,
    refusal: () => REFUSED,
  });
  store.typed('trk_a', 'notes');
  store.commit('trk_a');
  store.commit('trk_a');
  assert.deepEqual(sent, [{ commands: [{ op: 'track.set_notes', trackId: 'trk_a', notes: 'notes' }], revision: 'r7' }]);
  answer!.reject(new Error('refused'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(draftOf(store.getSnapshot(), 'trk_a')?.refusal, REFUSED);
  assert.equal(textOf(store.getSnapshot(), 'trk_a'), 'notes');
  // Blocked: nothing goes.
  blocked = true;
  store.commit('trk_a');
  assert.equal(sent.length, 1);
  blocked = false;
  store.commit('trk_a');
  assert.equal(sent.length, 2);
  answer!.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(draftOf(store.getSnapshot(), 'trk_a')?.draft, null);
  // The document follows through the model.
  snapshot = { revision: 'r9', tracks: [withNotes('trk_a', 'from elsewhere')] };
  for (const l of [...listeners]) l();
  assert.equal(textOf(store.getSnapshot(), 'trk_a'), 'from elsewhere');
  assert.equal(draftOf(store.getSnapshot(), 'trk_b'), undefined);
  store.dispose();
  assert.equal(listeners.size, 0);
});
