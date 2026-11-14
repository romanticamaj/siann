// The window's connection phase (m5-ui-connection; UI redesign spec 7 P1-6,
// 4.5 C8 and 3.0 "engine disconnected"), pure over the previous phase and what
// the session client and its read model report:
//
// - 'starting': the shell's engine has not been reached yet (the first launch;
//   a null endpoint before the engine is up counts too). No banner, nothing
//   dimmed. Bounded: it ends offline when the shell reports a failed launch
//   (its onChange with no endpoint: an exit, a protocol error, giving up), when
//   a first connection fails after its socket opened, or when the start
//   outlasts STARTING_MS (a report the shell sent before the page listened).
// - 'online': connected.
// - 'offline': disconnected after a connection was lost, through the reconnect
//   loop's disconnected / connecting alternation (the banner must not
//   flicker), from the start when there is no shell (a plain tab), or when the
//   start failed as above. The first connection after that is no reconnect.
//
// A reconnect is offline -> online after an earlier connection. It names the
// recovered revision: the read model's once the sync of that connection
// landed (syncCount advanced), or the auth reply's when it equals the model's
// already (nothing was missed). Each reconnect has its own count, which the
// toast and the selection reset key on.
//
// Framework-free; ConnectionPhaseStore follows a SessionClient for React.

import type { ClientState, ConnectionStatus } from './session-client';

// How long the window may wait for its first connection without the banner.
export const STARTING_MS = 10_000;

// Runs fn after ms; the returned function cancels it.
export type Schedule = (fn: () => void, ms: number) => () => void;

export type Phase = 'starting' | 'online' | 'offline';

export interface Reconnect {
  readonly revision: string;
  // 1 for the first reconnect, then 2, ...
  readonly count: number;
}

export interface PhaseState {
  readonly phase: Phase;
  // A connection was made at some point.
  readonly connectedBefore: boolean;
  // Reconnected, waiting for the sync that counts past this syncCount.
  readonly pending: { readonly syncCount: number } | null;
  // The last reconnect, or null before the first.
  readonly reconnect: Reconnect | null;
}

export interface PhaseInput {
  readonly status: ConnectionStatus;
  // The auth reply's head revision.
  readonly revision: string | null;
  readonly syncCount: number;
  // The read model's snapshot revision, or null before a snapshot.
  readonly snapshotRevision: string | null;
  // Sockets that opened (the client's connections).
  readonly connections: number;
  // The shell reported no engine, or the start outlasted STARTING_MS.
  readonly startFailed: boolean;
}

// The phase before any report: 'starting' while the client is connecting to
// the shell's engine, 'offline' when it starts disconnected (no shell).
export function initialPhase(status: ConnectionStatus): PhaseState {
  return Object.freeze({ phase: status === 'connecting' ? 'starting' : 'offline', connectedBefore: false, pending: null, reconnect: null });
}

function nextReconnect(prev: PhaseState, revision: string): Reconnect {
  return Object.freeze({ revision, count: (prev.reconnect?.count ?? 0) + 1 });
}

function same(a: PhaseState, b: PhaseState): boolean {
  return (
    a.phase === b.phase &&
    a.connectedBefore === b.connectedBefore &&
    a.reconnect === b.reconnect &&
    (a.pending === b.pending || (a.pending !== null && b.pending !== null && a.pending.syncCount === b.pending.syncCount))
  );
}

function make(prev: PhaseState, next: PhaseState): PhaseState {
  return same(prev, next) ? prev : Object.freeze(next);
}

export function reducePhase(prev: PhaseState, input: PhaseInput): PhaseState {
  if (input.status !== 'connected') {
    // Before the first connection the shell may report no engine yet; that is
    // still the start, unless there never was a shell to wait for, or the
    // start failed: a failed launch, or a socket that opened and closed again.
    const failed = input.startFailed || (input.status === 'disconnected' && input.connections > 0);
    const phase: Phase = prev.phase === 'starting' && !failed ? 'starting' : 'offline';
    return make(prev, { ...prev, phase, pending: null });
  }
  if (prev.phase === 'online') {
    if (prev.pending === null) return prev;
    if (input.syncCount > prev.pending.syncCount && input.snapshotRevision !== null) {
      return make(prev, { ...prev, pending: null, reconnect: nextReconnect(prev, input.snapshotRevision) });
    }
    return prev;
  }
  if (!prev.connectedBefore) {
    // The first connection: no reconnect.
    return make(prev, { ...prev, phase: 'online', connectedBefore: true, pending: null });
  }
  // offline -> online after an earlier connection.
  if (input.revision !== null && input.revision === input.snapshotRevision) {
    return make(prev, { ...prev, phase: 'online', pending: null, reconnect: nextReconnect(prev, input.revision) });
  }
  return make(prev, { ...prev, phase: 'online', pending: { syncCount: input.syncCount } });
}

// What the store reads of a SessionClient.
export interface PhaseClient {
  getState(): ClientState;
  subscribe(listener: () => void): () => void;
  readonly model: {
    getSnapshot(): { readonly revision: string } | null;
    subscribe(listener: () => void): () => void;
  };
}

export class ConnectionPhaseStore {
  readonly #client: PhaseClient;
  readonly #listeners = new Set<() => void>();
  readonly #offs: Array<() => void>;
  #state: PhaseState;
  #startFailed = false;
  #cancelStart: (() => void) | null = null;

  // schedule bounds the start by STARTING_MS (index.tsx passes the window's
  // timers; without it only the shell's reports end the start).
  constructor(client: PhaseClient, options: { schedule?: Schedule } = {}) {
    this.#client = client;
    this.#state = reducePhase(initialPhase(client.getState().status), this.#input());
    const update = () => this.#update();
    this.#offs = [client.subscribe(update), client.model.subscribe(update)];
    if (options.schedule && this.#state.phase === 'starting') {
      this.#cancelStart = options.schedule(() => {
        this.#cancelStart = null;
        this.engineDown();
      }, STARTING_MS);
    }
  }

  // The shell reported no engine (its onChange with no endpoint: a failed
  // launch, a crash, giving up). Ends the start; nothing after it.
  engineDown(): void {
    if (this.#startFailed) return;
    this.#startFailed = true;
    this.#update();
  }

  getSnapshot = (): PhaseState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  destroy(): void {
    this.#stopStartTimer();
    for (const off of this.#offs.splice(0)) off();
    this.#listeners.clear();
  }

  #input(): PhaseInput {
    const state = this.#client.getState();
    return {
      status: state.status,
      revision: state.revision,
      syncCount: state.syncCount,
      snapshotRevision: this.#client.model.getSnapshot()?.revision ?? null,
      connections: state.connections,
      startFailed: this.#startFailed,
    };
  }

  #stopStartTimer(): void {
    if (this.#cancelStart) this.#cancelStart();
    this.#cancelStart = null;
  }

  #update(): void {
    const next = reducePhase(this.#state, this.#input());
    if (next.phase !== 'starting') this.#stopStartTimer();
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
