// What undo and redo can do now, as far as the client knows (m5-ui-alignment-
// chrome; UI redesign 3.2: the top bar's redo is dim with nothing to redo, as
// the mockup draws it). The engine publishes no undo stack, so this reads the
// cause of each session.changed (protocol-events-v1.md): an undo leaves
// something to redo, a redo something to undo, and any other commit
// something to undo and nothing to redo. A refused undo or redo
// (nothing_to_undo, nothing_to_redo) says that side is empty. A new
// connection forgets everything: 'unknown' draws the button lit, so nothing
// is dimmed that might work. Framework-free.

import type { EventMessage, SessionClient } from './session-client';

export type Side = 'yes' | 'no' | 'unknown';

export interface UndoAvailability {
  readonly undo: Side;
  readonly redo: Side;
}

const UNKNOWN: UndoAvailability = Object.freeze({ undo: 'unknown', redo: 'unknown' });

type HistoryClient = Pick<SessionClient, 'onEvent' | 'subscribe'> & { getState(): { readonly connections: number } };

export class UndoHistory {
  readonly #listeners = new Set<() => void>();
  readonly #offs: Array<() => void>;
  #snapshot: UndoAvailability = UNKNOWN;
  #connection: number;

  constructor(client: HistoryClient) {
    this.#connection = client.getState().connections;
    this.#offs = [
      client.onEvent('session.changed', (event: EventMessage) => this.#changed(event)),
      client.subscribe(() => {
        const connection = client.getState().connections;
        if (connection === this.#connection) return;
        this.#connection = connection;
        this.#set(UNKNOWN);
      }),
    ];
  }

  getSnapshot(): UndoAvailability {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // session.undo or session.redo answered that nothing is left on its side.
  refused(method: 'session.undo' | 'session.redo'): void {
    this.#set(method === 'session.undo' ? { ...this.#snapshot, undo: 'no' } : { ...this.#snapshot, redo: 'no' });
  }

  destroy(): void {
    for (const off of this.#offs) off();
    this.#listeners.clear();
  }

  #changed(event: EventMessage): void {
    const cause = typeof event.cause === 'string' ? event.cause : '';
    if (cause === 'undo') this.#set({ undo: 'unknown', redo: 'yes' });
    else if (cause === 'redo') this.#set({ undo: 'yes', redo: 'unknown' });
    else this.#set({ undo: 'yes', redo: 'no' });
  }

  #set(next: UndoAvailability): void {
    if (next.undo === this.#snapshot.undo && next.redo === this.#snapshot.redo) return;
    this.#snapshot = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
  }
}
