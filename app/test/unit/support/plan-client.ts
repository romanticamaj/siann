// A session client stand-in for the stores that attach to one (PlanStore,
// BranchSnapshotStore): its connection state, its events and its requests,
// each answered by a function the test sets, or held until the test settles
// it. No socket, no timers.

import type { ClientState } from '../../../src/renderer/model/session-client';
import type { PlanClient, PlanEvent } from '../../../src/renderer/model/plan-store';

export interface Held {
  readonly method: string;
  readonly params: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class FakeAttachClient implements PlanClient {
  state: ClientState = {
    status: 'connecting',
    sessionId: null,
    epoch: 0,
    revision: null,
    about: null,
    lastSeq: null,
    syncCount: 0,
    connections: 0,
    error: null,
    legend: null,
    capabilities: null,
  };
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  // Requests of a method in `hold` wait in `held` until the test settles them.
  readonly hold = new Set<string>();
  readonly held: Held[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #events = new Map<string, Set<(event: PlanEvent) => void>>();
  getState(): ClientState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onEvent(type: string, fn: (event: PlanEvent) => void): () => void {
    let set = this.#events.get(type);
    if (!set) this.#events.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.hold.has(method)) {
      return new Promise((resolve, reject) => this.held.push({ method, params, resolve, reject }));
    }
    const answer = this.answers.get(method);
    return answer ? Promise.resolve(answer(params)) : Promise.reject(new Error(`no answer for ${method}`));
  }
  setState(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
  emit(event: { readonly type: string; readonly [field: string]: unknown }): void {
    const full = { schema: 'siann.event.v1', seq: '1', ...event } as PlanEvent;
    for (const fn of [...(this.#events.get(full.type) ?? [])]) fn(full);
  }
  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
