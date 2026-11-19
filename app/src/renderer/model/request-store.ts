// The requests the "ask the agent" box shows (m5b-ui-composer; UI redesign
// 4.4; protocol-engine-v0.md "Agent requests", protocol-events-v1.md
// agent.request_changed). Framework-free: React reads the store through
// useSyncExternalStore.
//
// attach() reads agent.requests once per connection when engine.capabilities
// lists the method and features.agentRequests, then follows
// agent.request_changed, which replaces a request by its id. The shown set is
// every open request (pending or taken), in the order the engine lists them
// (oldest first) and then the order they arrived, and under them the most
// recently closed one, until the next send (sent()) or a dismissal
// (dismiss()); what a send or a dismissal hid stays hidden when the list is
// read again on the same engine. Nothing is kept while the engine is away; a
// restarted engine holds no requests.
//
// A request seen open that closes as answered with a plan signals once that
// the plan is to be selected (onSelectPlan); one already closed when the list
// is loaded, or a repeated event of a closed one, signals nothing.

import type { MessageKey } from '../i18n/en';
import type { AgentRequest, AgentRequestState, ClientState } from './session-client';

export interface RequestSnapshot {
  readonly open: readonly AgentRequest[];
  readonly closed: AgentRequest | null;
  // open, then closed.
  readonly shown: readonly AgentRequest[];
}

export function isOpen(state: AgentRequestState): boolean {
  return state === 'pending' || state === 'taken';
}

// The state as the row reads it: the protocol's pending reads "sent".
export function requestStateKey(state: AgentRequestState): MessageKey {
  switch (state) {
    case 'pending':
      return 'composer.state.pending';
    case 'taken':
      return 'composer.state.taken';
    case 'answered':
      return 'composer.state.answered';
    case 'declined':
      return 'composer.state.declined';
    case 'cancelled':
      return 'composer.state.cancelled';
    case 'expired':
      return 'composer.state.expired';
  }
}

const STATES: ReadonlySet<string> = new Set(['pending', 'taken', 'answered', 'declined', 'cancelled', 'expired']);

// An agent.request_changed's request, or null.
export function parseRequest(value: unknown): AgentRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.text !== 'string' || typeof raw.state !== 'string' || !STATES.has(raw.state)) return null;
  return raw as unknown as AgentRequest;
}

// What attach() needs of the session client.
export interface RequestClient {
  getState(): ClientState;
  subscribe(listener: () => void): () => void;
  onEvent(type: string, listener: (event: Readonly<Record<string, unknown>>) => void): () => void;
  agentRequests(): Promise<readonly AgentRequest[]>;
}

function listed(state: ClientState): boolean {
  const capabilities = state.capabilities;
  const features = (capabilities?.features ?? {}) as Record<string, unknown>;
  const methods = Array.isArray(capabilities?.methods) ? capabilities.methods : [];
  const value = Object.prototype.hasOwnProperty.call(features, 'agentRequests') ? features.agentRequests : undefined;
  return state.status === 'connected' && value !== undefined && value !== null && value !== false && methods.includes('agent.requests');
}

const EMPTY: RequestSnapshot = Object.freeze({ open: Object.freeze([]), closed: null, shown: Object.freeze([]) });
// The hidden ids kept (a send or a dismissal adds one).
const HIDDEN_KEPT = 64;

export class RequestStore {
  #snapshot: RequestSnapshot = EMPTY;
  readonly #listeners = new Set<() => void>();
  readonly #select = new Set<(plan: string) => void>();
  // Closed requests a send or a dismissal took off the list.
  readonly #hidden = new Set<string>();
  // Requests seen closed (no select signal for them).
  readonly #closedSeen = new Set<string>();

  getSnapshot(): RequestSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // The plan an answered request led to, once per request.
  onSelectPlan(listener: (plan: string) => void): () => void {
    this.#select.add(listener);
    return () => {
      this.#select.delete(listener);
    };
  }

  // agent.requests' answer: the open ones and the last closed one replace what is held.
  load(requests: readonly AgentRequest[]): void {
    const open = requests.filter((r) => isOpen(r.state));
    const closed = requests.filter((r) => !isOpen(r.state));
    for (const r of closed) this.#closedSeen.add(r.id);
    const last = closed.length > 0 ? closed[closed.length - 1]! : null;
    this.#set(open, last !== null && !this.#hidden.has(last.id) ? last : null);
  }

  // A request's new state (agent.request_changed, or the answer of a call).
  change(request: AgentRequest): void {
    const { open, closed } = this.#snapshot;
    const at = open.findIndex((r) => r.id === request.id);
    if (isOpen(request.state)) {
      if (this.#closedSeen.has(request.id)) return;
      const next = [...open];
      if (at >= 0) next[at] = request;
      else next.push(request);
      this.#set(next, closed);
      return;
    }
    const seen = this.#closedSeen.has(request.id);
    this.#closedSeen.add(request.id);
    const rest = at >= 0 ? open.filter((r) => r.id !== request.id) : open;
    if (this.#hidden.has(request.id)) {
      this.#set(rest, closed);
      return;
    }
    // The most recently closed one replaces the earlier; a repeat of the shown one refreshes it.
    const shownClosed = !seen || closed?.id === request.id ? request : closed;
    this.#set(rest, shownClosed);
    if (!seen && request.state === 'answered' && typeof request.plan === 'string') {
      for (const listener of [...this.#select]) listener(request.plan);
    }
  }

  // The user sent a request: the closed one leaves the list.
  sent(request: AgentRequest): void {
    this.dismiss();
    this.change(request);
  }

  // The closed one leaves the list.
  dismiss(): void {
    const { open, closed } = this.#snapshot;
    if (closed === null) return;
    this.#hidden.add(closed.id);
    if (this.#hidden.size > HIDDEN_KEPT) this.#hidden.delete(this.#hidden.values().next().value!);
    this.#set(open, null);
  }

  clear(): void {
    if (this.#snapshot !== EMPTY) {
      this.#snapshot = EMPTY;
      this.#notify();
    }
  }

  // Follows a session client until the returned function is called.
  attach(client: RequestClient): () => void {
    let detached = false;
    // The connection read (the client's connection count), or null.
    let reading: number | null = null;
    // Requests agent.request_changed reported while agent.requests was in flight: newer than its answer.
    let during: Map<string, AgentRequest> | null = null;
    const onState = () => {
      if (detached) return;
      const state = client.getState();
      if (!listed(state)) {
        reading = null;
        during = null;
        this.clear();
        return;
      }
      if (reading === state.connections) return;
      const connection = state.connections;
      reading = connection;
      during = new Map();
      client.agentRequests().then(
        (requests) => {
          if (detached || reading !== connection) return;
          const newer = during ?? new Map<string, AgentRequest>();
          during = null;
          this.load(requests);
          for (const request of newer.values()) this.change(request);
        },
        () => {
          if (reading === connection) during = null;
        },
      );
    };
    const offs = [
      client.subscribe(onState),
      client.onEvent('agent.request_changed', (event) => {
        if (detached || !listed(client.getState())) return;
        const request = parseRequest(event.request);
        if (!request) return;
        if (during) {
          during.set(request.id, request);
          return;
        }
        this.change(request);
      }),
    ];
    onState();
    return () => {
      detached = true;
      for (const off of offs) off();
    };
  }

  #set(open: readonly AgentRequest[], closed: AgentRequest | null): void {
    const next: RequestSnapshot = Object.freeze({
      open: Object.freeze([...open]),
      closed,
      shown: Object.freeze(closed ? [...open, closed] : [...open]),
    });
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
