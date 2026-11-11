// The renderer's view of the engine's plans (m5-plan-review; spec "Frontend",
// plan review; Protocol v0 item 25). Framework-free: React reads it through
// useSyncExternalStore. The engine owns every plan; this store only mirrors
// what plan.list, plan.status and plan.changed report, never an optimistic
// state. attach() wires it to a session client: plan.list once connected and
// after every sync (events a gap swallowed are re-read), again after each
// session.changed (a commit can make a plan stale), plan.status for a
// plan.changed that names a plan the store does not hold, and the heard side
// from session.inspect and audition.changed.

import type { ClientState, EventMessage } from './session-client';

export type PlanState = 'draft' | 'validated' | 'approved' | 'rejected' | 'applied' | 'rolled_back';

export interface StaleRef {
  readonly ref: string;
  readonly change: 'added' | 'removed' | 'modified';
}

export interface PlanEntry {
  readonly hash: string;
  readonly state: PlanState;
  readonly steps: readonly Record<string, unknown>[];
  readonly stale: readonly StaleRef[];
  readonly proposalBranch?: string;
  readonly parentPlan?: string;
  readonly rejectionNote?: string;
  // The plan object as the engine answered it (plan.status / plan.list).
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PlanSnapshot {
  // Submission order (plan.list), then plans learnt later in arrival order.
  readonly plans: readonly PlanEntry[];
  readonly byHash: ReadonlyMap<string, PlanEntry>;
  // Hashes a plan.changed named that the store does not hold yet.
  readonly needsStatus: readonly string[];
  // The side heard ("main" or a branch id), or null when unknown (no engine,
  // no auditioner).
  readonly heard: string | null;
}

export type PlanEvent = EventMessage;

// What attach() needs of the session client.
export interface PlanClient {
  getState(): ClientState;
  subscribe(listener: () => void): () => void;
  onEvent(type: string, listener: (event: PlanEvent) => void): () => void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

const STATES: readonly PlanState[] = ['draft', 'validated', 'approved', 'rejected', 'applied', 'rolled_back'];

function isState(value: unknown): value is PlanState {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

function staleOf(value: unknown): StaleRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is StaleRef => !!s && typeof s === 'object' && typeof (s as StaleRef).ref === 'string' && typeof (s as StaleRef).change === 'string',
  );
}

// A plan object of plan.status or plan.list, or null when it is not one.
export function planEntry(raw: unknown): PlanEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const plan = raw as Record<string, unknown>;
  if (typeof plan.hash !== 'string' || !isState(plan.state)) return null;
  const steps = Array.isArray(plan.steps) ? (plan.steps as Record<string, unknown>[]) : [];
  const entry: PlanEntry = {
    hash: plan.hash,
    state: plan.state,
    steps: Object.freeze([...steps]),
    stale: Object.freeze(staleOf(plan.stale)),
    ...(typeof plan.proposalBranch === 'string' ? { proposalBranch: plan.proposalBranch } : {}),
    ...(typeof plan.parentPlan === 'string' ? { parentPlan: plan.parentPlan } : {}),
    ...(typeof plan.rejectionNote === 'string' ? { rejectionNote: plan.rejectionNote } : {}),
    raw: Object.freeze({ ...plan }),
  };
  return Object.freeze(entry);
}

function freezeSnapshot(plans: PlanEntry[], needsStatus: string[], heard: string | null): PlanSnapshot {
  const byHash = new Map(plans.map((p) => [p.hash, p] as const));
  return Object.freeze({ plans: Object.freeze(plans), byHash, needsStatus: Object.freeze(needsStatus), heard });
}

export class PlanStore {
  #snapshot: PlanSnapshot = freezeSnapshot([], [], null);
  readonly #listeners = new Set<() => void>();

  getSnapshot(): PlanSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Replaces every plan with a plan.list answer.
  fromList(result: unknown): void {
    const list = (result as { plans?: unknown } | null)?.plans;
    if (!Array.isArray(list)) return;
    const plans = list.map(planEntry).filter((p): p is PlanEntry => p !== null);
    const held = new Set(plans.map((p) => p.hash));
    this.#set(freezeSnapshot(plans, this.#snapshot.needsStatus.filter((h) => !held.has(h)), this.#snapshot.heard));
  }

  // One plan as plan.status answered it: replaced in place, or added at the end.
  setStatus(raw: unknown): void {
    const entry = planEntry(raw);
    if (!entry) return;
    const plans = [...this.#snapshot.plans];
    const index = plans.findIndex((p) => p.hash === entry.hash);
    if (index >= 0) plans[index] = entry;
    else plans.push(entry);
    this.#set(freezeSnapshot(plans, this.#snapshot.needsStatus.filter((h) => h !== entry.hash), this.#snapshot.heard));
  }

  // A plan.changed event: the plan's state and proposal link. A plan the
  // store does not hold is marked as needing plan.status (returns true then).
  applyChanged(event: PlanEvent): boolean {
    const hash = event.plan;
    if (typeof hash !== 'string' || !isState(event.state)) return false;
    const current = this.#snapshot.byHash.get(hash);
    if (!current) {
      if (!this.#snapshot.needsStatus.includes(hash)) {
        this.#set(freezeSnapshot([...this.#snapshot.plans], [...this.#snapshot.needsStatus, hash], this.#snapshot.heard));
      }
      return true;
    }
    const branch = typeof event.proposalBranch === 'string' ? event.proposalBranch : undefined;
    if (current.state === event.state && current.proposalBranch === branch) return false;
    const raw: Record<string, unknown> = { ...current.raw, state: event.state };
    if (branch === undefined) delete raw.proposalBranch;
    else raw.proposalBranch = branch;
    const next = planEntry(raw)!;
    const plans = this.#snapshot.plans.map((p) => (p.hash === hash ? next : p));
    this.#set(freezeSnapshot(plans, [...this.#snapshot.needsStatus], this.#snapshot.heard));
    return false;
  }

  setHeard(heard: string | null): void {
    if (heard === this.#snapshot.heard) return;
    this.#set(freezeSnapshot([...this.#snapshot.plans], [...this.#snapshot.needsStatus], heard));
  }

  // Follows a session client until the returned function is called.
  attach(client: PlanClient): () => void {
    let detached = false;
    let lastSync = -1;
    let lastStatus: ClientState['status'] | null = null;
    // Answers that arrive after a newer request started are dropped.
    let listGeneration = 0;
    let inspectGeneration = 0;

    const list = () => {
      const generation = ++listGeneration;
      client.request('plan.list', {}).then(
        (result) => {
          if (!detached && generation === listGeneration) this.fromList(result);
        },
        () => undefined,
      );
    };
    const inspect = () => {
      const generation = ++inspectGeneration;
      client.request('session.inspect', {}).then(
        (result) => {
          if (detached || generation !== inspectGeneration) return;
          const heard = (result as { heard?: unknown } | null)?.heard;
          this.setHeard(typeof heard === 'string' ? heard : null);
        },
        () => undefined,
      );
    };
    const status = (hash: string) => {
      client.request('plan.status', { plan: hash }).then(
        (result) => {
          if (!detached) this.setStatus(result);
        },
        () => undefined,
      );
    };
    const onState = () => {
      if (detached) return;
      const state = client.getState();
      const becameConnected = state.status === 'connected' && lastStatus !== 'connected';
      const synced = state.status === 'connected' && state.syncCount !== lastSync;
      lastStatus = state.status;
      if (state.status !== 'connected') {
        this.setHeard(null);
        return;
      }
      if (becameConnected || synced) {
        lastSync = state.syncCount;
        list();
        inspect();
      }
    };
    const offs = [
      client.subscribe(onState),
      client.onEvent('plan.changed', (event) => {
        if (detached) return;
        if (this.applyChanged(event) && typeof event.plan === 'string') status(event.plan);
      }),
      client.onEvent('audition.changed', (event) => {
        if (!detached && typeof event.heard === 'string') this.setHeard(event.heard);
      }),
      client.onEvent('session.changed', () => {
        if (!detached) list();
      }),
    ];
    onState();
    return () => {
      detached = true;
      for (const off of offs) off();
    };
  }

  #set(next: PlanSnapshot): void {
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
