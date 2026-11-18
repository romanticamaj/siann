// The branch snapshot (m5b-ui-audition; UI redesign 4.3, P2-3): what the
// renderer knows of an open proposal's entities, so the ghosts of the plan
// heard can be drawn solid from what is playing. Framework-free: React and
// the review store read it through subscribe().
//
// It is built from proposal.changed only (protocol-events-v1.md): the event
// names the branch revision and the refs that revision changed; the store
// keeps, per branch, every ref the branch changed since the snapshot was
// first held, and asks session.fetch {refs, revision} for all of them at the
// event's revision (a gesture committed onto the branch publishes another
// proposal.changed, and the union is fetched again at the new revision). An
// answer of a request older than the newest for its branch is dropped
// (generations), and so is an answer that arrives after a drop.
//
// A renderer that connects, reloads or resyncs cannot learn a branch's head
// revision (session.inspect returns branch ids only and proposal.changed is
// not replayed), so the snapshot is dropped on proposal.closed of its branch,
// on any status but connected and on every syncCount change, and is held
// again only from the next proposal.changed of that branch. session.inspect
// never creates one.

import type { PlanClient } from './plan-store';

type Entity = Readonly<Record<string, unknown>>;

export interface BranchSnapshot {
  readonly branch: string;
  // The branch revision the entities were fetched at.
  readonly revision: string;
  // Each ref the branch changed: its entity at that revision, or null when the
  // branch removed it.
  readonly entities: ReadonlyMap<string, Entity | null>;
}

interface Pending {
  readonly refs: Set<string>;
  generation: number;
}

export class BranchSnapshotStore {
  #held = new Map<string, BranchSnapshot>();
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<() => void>();
  // Bumped on every drop: an answer of an earlier epoch is never held.
  #epoch = 0;

  get(branch: string): BranchSnapshot | null {
    return this.#held.get(branch) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Drops every snapshot and every ref collected (a reconnect, a resync).
  dropAll(): void {
    this.#epoch += 1;
    this.#pending.clear();
    if (this.#held.size === 0) return;
    this.#held = new Map();
    this.#emit();
  }

  // Drops one branch's (proposal.closed); a fetch of it on its way is dropped
  // with it (its pending entry is gone).
  drop(branch: string): void {
    this.#pending.delete(branch);
    if (!this.#held.has(branch)) return;
    const next = new Map(this.#held);
    next.delete(branch);
    this.#held = next;
    this.#emit();
  }

  attach(client: PlanClient): () => void {
    let detached = false;
    let lastStatus: string | null = null;
    let lastSync = -1;
    const onState = () => {
      if (detached) return;
      const state = client.getState();
      if (state.status !== 'connected') {
        if (lastStatus === 'connected' || this.#held.size > 0 || this.#pending.size > 0) this.dropAll();
      } else if (lastSync !== -1 && state.syncCount !== lastSync) {
        this.dropAll();
      }
      lastStatus = state.status;
      if (state.status === 'connected') lastSync = state.syncCount;
    };
    const onChanged = (event: Record<string, unknown>) => {
      if (detached) return;
      const branch = event.branch;
      const revision = event.revision;
      if (typeof branch !== 'string' || typeof revision !== 'string') return;
      const changed = Array.isArray(event.changedIds) ? event.changedIds : [];
      let pending = this.#pending.get(branch);
      if (!pending) this.#pending.set(branch, (pending = { refs: new Set(), generation: 0 }));
      for (const item of changed) {
        const ref = (item as { ref?: unknown } | null)?.ref;
        if (typeof ref === 'string') pending.refs.add(ref);
      }
      if (pending.refs.size === 0) return;
      const generation = (pending.generation += 1);
      const epoch = this.#epoch;
      const refs = [...pending.refs];
      client.request('session.fetch', { refs, revision }).then(
        (result) => {
          if (detached || epoch !== this.#epoch || this.#pending.get(branch) !== pending || generation !== pending.generation) return;
          const entities = new Map<string, Entity | null>();
          const list = (result as { entities?: unknown } | null)?.entities;
          for (const item of Array.isArray(list) ? list : []) {
            const entry = item as { ref?: unknown; entity?: unknown };
            if (typeof entry.ref === 'string') entities.set(entry.ref, entry.entity && typeof entry.entity === 'object' ? (entry.entity as Entity) : null);
          }
          const next = new Map(this.#held);
          next.set(branch, Object.freeze({ branch, revision, entities }));
          this.#held = next;
          this.#emit();
        },
        () => undefined,
      );
    };
    const offs = [
      client.subscribe(onState),
      client.onEvent('proposal.changed', (event) => onChanged(event as unknown as Record<string, unknown>)),
      client.onEvent('proposal.closed', (event) => {
        if (!detached && typeof event.branch === 'string') this.drop(event.branch);
      }),
    ];
    onState();
    return () => {
      detached = true;
      for (const off of offs) off();
    };
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
