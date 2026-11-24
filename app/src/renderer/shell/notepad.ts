// The Notepad's drafts (m5b-ui-notepad, UR-17; UI redesign 3.4, 10.11 item
// 23): a pure reducer per track, framework-free, and the small store the
// Inspector's Notepad section reads through useSyncExternalStore.
//
// Each track the document holds has an entry: `base`, the document's notes as
// the text area shows them (CR LF and a lone CR as LF); `draft`, the typed
// text while it differs from what the area showed (null: clean); `sending`,
// the text of the track.set_notes in flight; the refusal of the last commit;
// and whether the notes changed elsewhere while the draft was dirty.
//
// - A commit (leaving the area, Mod+Enter) of a dirty draft gives one
//   track.set_notes for the track the draft belongs to, and nothing while one
//   is in flight or while the edit guard holds (4.5 C5); the draft stays.
// - A discard (Escape) drops the draft, the refusal and the flag.
// - A document change while clean replaces the text; while dirty it keeps the
//   draft and sets changedElsewhere, unless it is the window's own commit
//   arriving (the text in flight) or the very text of the draft.
// - Entries live as long as the store (the window), and go with their track.

import type { TrackEntity } from '../model/document';
import type { Refusal } from '../plans/RefusalLine';

export interface SetNotes {
  readonly op: 'track.set_notes';
  readonly trackId: string;
  readonly notes: string;
}

export interface NoteDraft {
  readonly base: string;
  readonly draft: string | null;
  readonly sending: string | null;
  readonly refusal: Refusal | null;
  readonly changedElsewhere: boolean;
}

export type NotepadState = Readonly<Record<string, NoteDraft>>;

export const EMPTY_NOTEPAD: NotepadState = Object.freeze({});

const clean = (base: string): NoteDraft => ({ base, draft: null, sending: null, refusal: null, changedElsewhere: false });

// The notes as a textarea shows them: its value normalises CR LF and CR to LF.
export function shownNotes(notes: string | undefined): string {
  return (notes ?? '').replace(/\r\n?/g, '\n');
}

export function draftOf(state: NotepadState, trackId: string): NoteDraft | undefined {
  return Object.prototype.hasOwnProperty.call(state, trackId) ? state[trackId] : undefined;
}

// What the area shows for the track: the draft, else the document's notes.
export function textOf(state: NotepadState, trackId: string): string {
  const entry = draftOf(state, trackId);
  return entry ? (entry.draft ?? entry.base) : '';
}

function put(state: NotepadState, trackId: string, entry: NoteDraft): NotepadState {
  return { ...state, [trackId]: entry };
}

// The document's tracks: new ones start clean, gone ones are dropped.
export function syncTracks(state: NotepadState, tracks: ReadonlyArray<Pick<TrackEntity, 'id' | 'notes'>>): NotepadState {
  let changed = false;
  const next: Record<string, NoteDraft> = {};
  for (const track of tracks) {
    const doc = shownNotes(track.notes);
    const prev = draftOf(state, track.id);
    let entry: NoteDraft;
    if (!prev) entry = clean(doc);
    else if (prev.base === doc) entry = prev;
    else if (prev.draft === null) entry = { ...prev, base: doc, changedElsewhere: false };
    else if (prev.draft === doc) entry = { ...prev, base: doc, draft: null, refusal: null, changedElsewhere: false };
    else if (prev.sending === doc) entry = { ...prev, base: doc };
    else entry = { ...prev, base: doc, changedElsewhere: true };
    if (entry !== prev) changed = true;
    next[track.id] = entry;
  }
  if (!changed && Object.keys(state).length === tracks.length) return state;
  return next;
}

// The area's value after an input.
export function typed(state: NotepadState, trackId: string, text: string): NotepadState {
  const prev = draftOf(state, trackId) ?? clean('');
  if (text === prev.base) {
    if (prev.draft === null && !prev.changedElsewhere && prev.refusal === null) return state;
    return put(state, trackId, { ...prev, draft: null, refusal: null, changedElsewhere: false });
  }
  if (prev.draft === text) return state;
  return put(state, trackId, { ...prev, draft: text });
}

// A leave or Mod+Enter: the command to send, if any.
export function commit(state: NotepadState, trackId: string, blocked: boolean): { readonly state: NotepadState; readonly command: SetNotes | null } {
  const prev = draftOf(state, trackId);
  if (!prev || prev.draft === null || prev.sending !== null || blocked) return { state, command: null };
  return {
    state: put(state, trackId, { ...prev, sending: prev.draft }),
    command: { op: 'track.set_notes', trackId, notes: prev.draft },
  };
}

// The answer to the command that sent `sent`: null for a success.
export function settled(state: NotepadState, trackId: string, sent: string, refusal: Refusal | null): NotepadState {
  const prev = draftOf(state, trackId);
  if (!prev) return state;
  if (refusal) return put(state, trackId, { ...prev, sending: null, refusal });
  if (prev.draft === null || prev.draft === sent) return put(state, trackId, { ...prev, base: prev.draft === null ? prev.base : sent, draft: null, sending: null, refusal: null, changedElsewhere: false });
  // Typed on while it was in flight: the rest stays a draft.
  return put(state, trackId, { ...prev, base: sent, sending: null, refusal: null, changedElsewhere: false });
}

// Escape: the document's text again.
export function discard(state: NotepadState, trackId: string): NotepadState {
  const prev = draftOf(state, trackId);
  if (!prev || (prev.draft === null && prev.refusal === null && !prev.changedElsewhere)) return state;
  return put(state, trackId, { ...prev, draft: null, refusal: null, changedElsewhere: false });
}

// ---- the store

export interface NotepadModel {
  getSnapshot(): { readonly revision?: string; readonly tracks?: ReadonlyArray<Pick<TrackEntity, 'id' | 'notes'>> } | null;
  subscribe(listener: () => void): () => void;
}

export interface NotepadStoreOptions {
  readonly model: NotepadModel;
  // command.execute (SessionClient.execute).
  execute(commands: readonly unknown[], expectedRevision?: string): Promise<unknown>;
  // The edit guard (model/edit-guard.ts): true while a proposal is heard.
  blocked(): boolean;
  // The refusal line's Refusal of a rejection (plans/RefusalLine.tsx refusalOf).
  refusal(error: unknown): Refusal;
}

export interface NotepadStore {
  getSnapshot(): NotepadState;
  subscribe(listener: () => void): () => void;
  typed(trackId: string, text: string): void;
  commit(trackId: string): void;
  discard(trackId: string): void;
  dispose(): void;
}

export function createNotepadStore(options: NotepadStoreOptions): NotepadStore {
  const { model } = options;
  let state = syncTracks(EMPTY_NOTEPAD, model.getSnapshot()?.tracks ?? []);
  const listeners = new Set<() => void>();
  const set = (next: NotepadState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const unsubscribe = model.subscribe(() => {
    const snapshot = model.getSnapshot();
    // Before the first snapshot (or after a reset) there is no document to follow.
    if (snapshot) set(syncTracks(state, snapshot.tracks ?? []));
  });
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    typed: (trackId, text) => set(typed(state, trackId, text)),
    commit(trackId) {
      const result = commit(state, trackId, options.blocked());
      if (!result.command) return;
      const notes = result.command.notes;
      set(result.state);
      options.execute([result.command], model.getSnapshot()?.revision).then(
        () => set(settled(state, trackId, notes, null)),
        (error: unknown) => set(settled(state, trackId, notes, options.refusal(error))),
      );
    },
    discard: (trackId) => set(discard(state, trackId)),
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}
