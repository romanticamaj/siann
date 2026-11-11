// The renderer's protocol client (docs/schemas/protocol-events-v1.md, "Client
// read model"). It authenticates on the engine's command socket with
// events: true, fills the ReadModel with session.sync, advances it with
// session.changed deltas fetched at each event's revision, and resyncs on a
// gap, on revision_unavailable, on a delta that does not hash to the event's
// documentHash, on session.opened, and on a reconnect that missed events or
// reached another engine. Every event envelope names the current session, so
// an event of another session (its session.opened lost in a gap) is adopted
// before the sync; a session_mismatch that no queued event explains
// re-authenticates, since the auth reply is what names the current session.
// Structural changes are never optimistic: execute() resolves with the
// engine's answer and leaves the model to session.changed.
//
// Framework-free: the socket factory, the endpoint source (the preload's
// window.siann.engine.current) and the reconnect scheduler are injected.

import type { FetchedEntity, SessionChanged, SyncChunk } from './document';
import { isMeterLegend, type MeterLegend } from './meter-frames';
import { ReadModel, ReadModelError } from './read-model';

export interface EngineEndpoint {
  readonly port: number;
  readonly token: string;
}

// The part of the browser WebSocket the client uses.
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface AboutInfo {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly source?: { readonly url?: string; readonly commit?: string; readonly dirty?: boolean };
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ClientState {
  readonly status: ConnectionStatus;
  readonly sessionId: string | null;
  // The auth reply's head revision (the snapshot's is the model's).
  readonly revision: string | null;
  readonly about: AboutInfo | null;
  // The seq of the last event the model reflects (decimal string).
  readonly lastSeq: string | null;
  // Completed session.sync replacements of the model.
  readonly syncCount: number;
  // WebSocket opens since this client was made: a page reload starts it again at 0.
  readonly connections: number;
  // The last failure that left the model behind, for people; not stable.
  readonly error: string | null;
  // The meter legend of the realtime channel (protocol-events-v1.md,
  // "meters.legend"): from the auth reply, replaced by each sync's `meters` and
  // each meters.legend event applied in order; null before the engine has one.
  readonly legend: MeterLegend | null;
}

export interface SessionClientOptions {
  createSocket: (url: string) => SocketLike;
  currentEndpoint: () => Promise<EngineEndpoint | null>;
  schedule: (fn: () => void, ms: number) => () => void;
  model?: ReadModel;
  reconnectMs?: number;
  // The first delay before a failed session.sync is tried again; each further
  // failure doubles it, up to SYNC_RETRY_MAX_MS.
  syncRetryMs?: number;
  // The status before the first connect (the renderer shows connecting).
  initialStatus?: ConnectionStatus;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly step?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export const RECONNECT_MS = 250;
export const SYNC_RETRY_MS = 250;
export const SYNC_RETRY_MAX_MS = 8000;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  // The session the request named.
  sessionId: string | null;
}

export interface EventMessage {
  readonly schema: string;
  readonly seq: string;
  readonly sessionId?: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

type Work = { kind: 'sync' } | { kind: 'event'; event: EventMessage };

// One authenticated socket: its pending requests and its ordered work queue.
interface Connection {
  readonly socket: SocketLike;
  readonly endpoint: EngineEndpoint;
  readonly pending: Map<string, Pending>;
  readonly queue: Work[];
  sessionId: string | null;
  authenticated: boolean;
  draining: boolean;
  closed: boolean;
  // A scheduled retry of a failed session.sync (its cancel), and the failures
  // since the last sync that succeeded.
  syncRetry: (() => void) | null;
  syncFailures: number;
}

function randomPrefix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isEvent(message: Record<string, unknown>): message is EventMessage {
  return message.schema === 'siann.event.v1' && typeof message.seq === 'string' && typeof message.type === 'string';
}

function seqOf(text: string): bigint | null {
  return /^\d{1,20}$/.test(text) ? BigInt(text) : null;
}

export class SessionClient {
  readonly model: ReadModel;
  readonly #options: SessionClientOptions;
  readonly #prefix = randomPrefix();
  readonly #listeners = new Set<() => void>();
  readonly #eventListeners = new Map<string, Set<(event: EventMessage) => void>>();
  #nextId = 0;
  #connection: Connection | null = null;
  #retry: (() => void) | null = null;
  #state: ClientState = {
    status: 'disconnected',
    sessionId: null,
    revision: null,
    about: null,
    lastSeq: null,
    syncCount: 0,
    connections: 0,
    error: null,
    legend: null,
  };
  #lastSeq: bigint | null = null;
  // The session the model's snapshot belongs to.
  #modelSessionId: string | null = null;

  constructor(options: SessionClientOptions) {
    this.#options = options;
    this.model = options.model ?? new ReadModel();
    if (options.initialStatus) this.#state = Object.freeze({ ...this.#state, status: options.initialStatus });
  }

  getState(): ClientState {
    return this.#state;
  }

  // The engine the authenticated command socket is on (the realtime channel
  // opens beside it), or null.
  endpoint(): EngineEndpoint | null {
    const connection = this.#connection;
    return connection && !connection.closed && connection.authenticated ? connection.endpoint : null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Listens to events of one type once the client has taken them in, in seq
  // order: a session.changed after the model applied it, any other type as
  // it advances lastSeq (plan.changed, audition.changed, ...). An event a
  // gap's sync covered is never handed over; a listener that keeps state
  // from events re-reads it after each sync (syncCount).
  onEvent(type: string, listener: (event: EventMessage) => void): () => void {
    let listeners = this.#eventListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  // Connects to the endpoint the shell announces (window.siann.engine.current
  // and onChange). The same endpoint again leaves a live socket alone unless
  // forced; null disconnects.
  connect(next: EngineEndpoint | null, force = false): void {
    const current = this.#connection;
    if (!force && current && !current.closed && next && next.port === current.endpoint.port && next.token === current.endpoint.token) {
      return;
    }
    if (this.#retry) {
      this.#retry();
      this.#retry = null;
    }
    if (current) {
      this.#drop(current);
      current.socket.close();
    }
    if (!next) {
      this.#update({ status: 'disconnected' });
      return;
    }
    const socket = this.#options.createSocket(`ws://127.0.0.1:${next.port}/`);
    const connection: Connection = {
      socket,
      endpoint: next,
      pending: new Map(),
      queue: [],
      sessionId: null,
      authenticated: false,
      draining: false,
      closed: false,
      syncRetry: null,
      syncFailures: 0,
    };
    this.#connection = connection;
    this.#update({ status: 'connecting' });
    socket.onopen = () => {
      if (this.#connection !== connection) return;
      this.#update({ connections: this.#state.connections + 1 });
      socket.send(JSON.stringify({ type: 'auth', token: next.token, events: true }));
    };
    socket.onmessage = (event) => {
      if (this.#connection !== connection || typeof event.data !== 'string') return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message && typeof message === 'object') this.#receive(connection, message as Record<string, unknown>);
    };
    socket.onclose = () => {
      if (this.#connection !== connection) return;
      this.#drop(connection);
      this.#connection = null;
      this.#update({ status: 'disconnected' });
      this.#scheduleReconnect();
    };
  }

  close(): void {
    if (this.#retry) {
      this.#retry();
      this.#retry = null;
    }
    const connection = this.#connection;
    this.#connection = null;
    if (connection) {
      this.#drop(connection);
      connection.socket.close();
    }
    this.#update({ status: 'disconnected' });
  }

  // One protocol request on the command socket; settles once with its result
  // or a ProtocolError carrying the error code.
  request(method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    const connection = this.#connection;
    if (!connection || connection.closed || !connection.authenticated || connection.sessionId === null) {
      return Promise.reject(new ProtocolError('disconnected', 'not connected to an engine'));
    }
    return this.#send(connection, method, params, expectedRevision);
  }

  // command.execute. The model changes only when the session.changed of the
  // commit arrives.
  execute(commands: readonly unknown[], expectedRevision?: string): Promise<unknown> {
    return this.request('command.execute', { commands }, expectedRevision);
  }

  #send(connection: Connection, method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    if (connection.closed) return Promise.reject(new ProtocolError('disconnected', 'the connection closed'));
    this.#nextId += 1;
    const requestId = `req_${this.#prefix}_${this.#nextId}`;
    const envelope: Record<string, unknown> = { requestId, sessionId: connection.sessionId, method, params };
    if (expectedRevision !== undefined) envelope.expectedRevision = expectedRevision;
    return new Promise((resolve, reject) => {
      connection.pending.set(requestId, { resolve, reject, sessionId: connection.sessionId });
      connection.socket.send(JSON.stringify(envelope));
    });
  }

  #receive(connection: Connection, message: Record<string, unknown>): void {
    if (message.type === 'auth' && !connection.authenticated) {
      this.#authenticated(connection, message);
      return;
    }
    if (typeof message.requestId === 'string') {
      const pending = connection.pending.get(message.requestId);
      if (!pending) return;
      connection.pending.delete(message.requestId);
      if (message.ok === true) {
        pending.resolve(message.result);
      } else {
        const error = (message.error ?? {}) as { code?: string; message?: string; step?: number; data?: unknown };
        pending.reject(new ProtocolError(error.code ?? 'internal_error', error.message ?? '', error.step, error.data));
        if (error.code === 'session_mismatch') this.#sessionStale(connection, pending.sessionId);
      }
      return;
    }
    if (connection.authenticated && isEvent(message)) {
      connection.queue.push({ kind: 'event', event: message });
      void this.#drain(connection);
    }
  }

  #authenticated(connection: Connection, reply: Record<string, unknown>): void {
    if (reply.ok !== true || typeof reply.sessionId !== 'string') {
      this.#update({ status: 'disconnected' });
      return;
    }
    connection.authenticated = true;
    connection.sessionId = reply.sessionId;
    // Another session (an engine restart starts its seq again): the old seq
    // means nothing here and must not filter this engine's events, so until a
    // sync of this session lands the model is behind and every event syncs.
    if (this.#modelSessionId !== reply.sessionId) this.#behind();
    this.#update({
      status: 'connected',
      sessionId: reply.sessionId,
      revision: typeof reply.revision === 'string' ? reply.revision : null,
      about: (reply.about as AboutInfo | undefined) ?? null,
      legend: isMeterLegend(reply.meters) ? reply.meters : null,
    });
    // Protocol v0 item 11: a client that missed events, or reached another
    // engine (a restart has a new session id and starts its seq again), syncs.
    const authSeq = typeof reply.seq === 'string' ? seqOf(reply.seq) : null;
    const upToDate =
      this.model.getSnapshot() !== null &&
      this.#modelSessionId === reply.sessionId &&
      authSeq !== null &&
      this.#lastSeq === authSeq;
    if (!upToDate) {
      connection.queue.push({ kind: 'sync' });
      void this.#drain(connection);
    }
  }

  // Runs the connection's work in arrival order, one item at a time, so events
  // that arrive during a sync wait for it and are then filtered by its seq.
  async #drain(connection: Connection): Promise<void> {
    if (connection.draining) return;
    connection.draining = true;
    try {
      while (!connection.closed && connection.queue.length > 0) {
        const work = connection.queue.shift()!;
        if (work.kind === 'sync') await this.#sync(connection);
        else await this.#event(connection, work.event);
      }
    } finally {
      connection.draining = false;
    }
  }

  async #event(connection: Connection, event: EventMessage): Promise<void> {
    const at = seqOf(event.seq);
    if (at === null) return;
    if (this.#lastSeq !== null && at <= this.#lastSeq) return;
    if (typeof event.sessionId === 'string' && event.sessionId !== connection.sessionId) {
      // Every envelope names the current session: a session.opened lost in a
      // gap leaves the client naming the old one, which the engine refuses
      // (session_mismatch). Adopt the new id; the model is of another session,
      // so it is behind and the sync below replaces it.
      connection.sessionId = event.sessionId;
      this.#update({ sessionId: event.sessionId });
      this.#behind();
    }
    if (event.type === 'session.opened') {
      await this.#sync(connection);
      return;
    }
    if (this.#lastSeq === null || at > this.#lastSeq + 1n) {
      // A gap (or no model yet): replace the model, then look at this event
      // again against the sync's seq.
      await this.#sync(connection);
      if (!connection.closed && this.#lastSeq !== null && at === this.#lastSeq + 1n) await this.#event(connection, event);
      return;
    }
    if (event.type !== 'session.changed') {
      if (event.type === 'meters.legend' && isMeterLegend(event)) {
        this.#update({ legend: { epoch: event.epoch, entities: event.entities } });
      }
      this.#advance(at);
      this.#emit(event);
      return;
    }
    const changed = event as unknown as SessionChanged;
    const refs = changed.changedIds.filter((c) => c.change !== 'removed').map((c) => c.ref);
    let fetched: readonly FetchedEntity[] = [];
    try {
      if (refs.length > 0) {
        const result = (await this.#send(connection, 'session.fetch', { refs, revision: changed.revision })) as {
          entities: FetchedEntity[];
        };
        fetched = result.entities;
      }
      if (connection.closed) return;
      await this.model.applyChanged(changed, fetched);
      this.#advance(at);
      this.#emit(event);
    } catch (error) {
      if (connection.closed) return;
      if (error instanceof ProtocolError && error.code === 'disconnected') return;
      // revision_unavailable, a divergent hash, or any delta the model refuses:
      // never trust a model that left the engine's; replace it.
      const known = error instanceof ReadModelError || error instanceof ProtocolError;
      this.#update({ error: known ? `${(error as { code: string }).code}: ${(error as Error).message}` : String(error) });
      await this.#sync(connection);
    }
  }

  async #sync(connection: Connection): Promise<void> {
    const sessionId = connection.sessionId;
    try {
      const chunks: SyncChunk[] = [];
      let cursor: string | null = null;
      for (;;) {
        const chunk = (await this.#send(connection, 'session.sync', cursor === null ? {} : { cursor })) as SyncChunk;
        chunks.push(chunk);
        if (chunk.next === null || chunk.next === undefined) break;
        cursor = chunk.next;
      }
      if (connection.closed) return;
      const snapshot = await this.model.fromSync(chunks, sessionId);
      if (connection.closed) return;
      this.#modelSessionId = sessionId;
      this.#lastSeq = seqOf(snapshot.seq);
      connection.syncFailures = 0;
      if (connection.syncRetry) {
        connection.syncRetry();
        connection.syncRetry = null;
      }
      const meters = chunks[0]?.meters;
      this.#update({
        lastSeq: snapshot.seq,
        syncCount: this.#state.syncCount + 1,
        error: null,
        legend: isMeterLegend(meters) ? meters : null,
      });
    } catch (error) {
      if (connection.closed) return;
      // The model is not known to be in step: the next event syncs instead of
      // being filtered by a stale seq, and a retry runs without waiting for one.
      this.#behind();
      this.#update({ error: error instanceof Error ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}` : String(error) });
      this.#scheduleSyncRetry(connection);
    }
  }

  // A request naming `sentId` was session_mismatch: the server serves another
  // session. If the client has adopted it since, or a queued event names it
  // (that event adopts it in order), nothing more is needed; otherwise only a
  // new auth reply names the current session, so re-authenticate (the sync of
  // the new connection replaces the model). Never resend the stale id.
  #sessionStale(connection: Connection, sentId: string | null): void {
    if (connection.closed || this.#connection !== connection || connection.sessionId !== sentId) return;
    const explained = connection.queue.some(
      (work) => work.kind === 'event' && typeof work.event.sessionId === 'string' && work.event.sessionId !== sentId,
    );
    if (!explained) this.connect(connection.endpoint, true);
  }

  #behind(): void {
    this.#lastSeq = null;
    this.#update({ lastSeq: null });
  }

  #scheduleSyncRetry(connection: Connection): void {
    if (connection.syncRetry || connection.closed) return;
    const first = this.#options.syncRetryMs ?? SYNC_RETRY_MS;
    const delay = Math.min(first * 2 ** connection.syncFailures, SYNC_RETRY_MAX_MS);
    connection.syncFailures += 1;
    connection.syncRetry = this.#options.schedule(() => {
      connection.syncRetry = null;
      if (connection.closed || this.#connection !== connection || this.#lastSeq !== null) return;
      connection.queue.push({ kind: 'sync' });
      void this.#drain(connection);
    }, delay);
  }

  #advance(at: bigint): void {
    this.#lastSeq = at;
    this.#update({ lastSeq: at.toString() });
  }

  #emit(event: EventMessage): void {
    const listeners = this.#eventListeners.get(event.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A listener's failure must not stop the client's queue.
        this.#update({ error: `listener: ${String(error)}` });
      }
    }
  }

  #drop(connection: Connection): void {
    connection.closed = true;
    connection.queue.length = 0;
    if (connection.syncRetry) {
      connection.syncRetry();
      connection.syncRetry = null;
    }
    const pending = [...connection.pending.values()];
    connection.pending.clear();
    for (const p of pending) p.reject(new ProtocolError('disconnected', 'the connection closed'));
  }

  #scheduleReconnect(): void {
    if (this.#retry) return;
    this.#retry = this.#options.schedule(() => {
      this.#retry = null;
      void this.#options.currentEndpoint().then((next) => this.connect(next, true));
    }, this.#options.reconnectMs ?? RECONNECT_MS);
  }

  #update(patch: Partial<ClientState>): void {
    const next = { ...this.#state, ...patch };
    const changed = (Object.keys(patch) as Array<keyof ClientState>).some((key) => this.#state[key] !== next[key]);
    if (!changed) return;
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
  }
}
