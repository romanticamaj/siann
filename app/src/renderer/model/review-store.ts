// The plan review's state (m5b-ui-ghosts; UI redesign 4.2, 5.2), lifted out of
// the Plans tab so the ghosts exist with the right zone closed: the selected
// plan (null: the default selection, plans/selection.ts), its ticked steps,
// its plan.preview answer, the step under the pointer, the step pinned by its
// target button or a click on a ghost, and the ghosts toggle (the pill,
// Ctrl+Alt+G). Framework-free: React reads it through useSyncExternalStore,
// the event display through subscribe().
//
// It asks what the Plans tab asked before, and nothing else: plan.preview of
// the card's plan when its hash, state, staleness, base revision or the head
// revision changes (none for a plan that has landed), and for a stale plan
// session.fetch of its stale refs at its base revision (the stale reasons).
//
// Ghosts are drawn for a reviewable plan only (validated or approved, and not
// stale): ghosts() is plans/ghosts.ts's ghostsOf of its steps, its preview,
// the snapshot and the ticked steps, the same array while none of those
// changed, and empty for any other plan or with the toggle off. Another plan
// on the card clears the ticks, the hover and the pin; a reconnect clears the
// selection too (UI redesign 4.5 C8). A hover asks to bring the step's ghosts
// into view; locating (the target button) pins the step and also asks for the
// MixConsole when a ghost is on a strip; a click on a ghost pins its step and
// asks for the Plans tab. The pin lasts until another step is located or the
// pointer enters another row.

import { landedLabel } from '../plans/actions';
import type { PlanPreview } from '../plans/diff';
import { ghostsOf, hasStripGhost, type Ghost } from '../plans/ghosts';
import { cardPlan } from '../plans/selection';
import type { PlanEntry, PlanSnapshot } from './plan-store';
import type { Snapshot } from './read-model';

type Entity = Readonly<Record<string, unknown>>;

export interface ReviewClient {
  readonly model: { getSnapshot(): Snapshot | null; subscribe(listener: () => void): () => void };
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface ReviewPlans {
  getSnapshot(): PlanSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface PreviewState {
  readonly plan: string;
  readonly preview?: PlanPreview;
  // The refusal of plan.preview (plans/RefusalLine's refusalOf words it).
  readonly error?: unknown;
  // The stale refs at the plan's base revision; null when that read was refused.
  readonly base?: ReadonlyMap<string, Entity | null> | null;
}

export interface ReviewState {
  readonly selected: string | null;
  // null: every step ticked (the default).
  readonly ticked: ReadonlySet<number> | null;
  // 0-based step indexes, as the card's rows count them.
  readonly hotStep: number | null;
  readonly pinnedStep: number | null;
  readonly ghostsOn: boolean;
  readonly preview: PreviewState | null;
}

// A request to bring a step's ghosts into view (1-based step), and to show
// the MixConsole or the Plans tab for it.
export interface RevealRequest {
  readonly step: number;
  readonly mixer: boolean;
  readonly plans: boolean;
}

export function reviewable(plan: PlanEntry | undefined): plan is PlanEntry {
  return plan !== undefined && (plan.state === 'validated' || plan.state === 'approved') && plan.stale.length === 0;
}

const NONE: readonly Ghost[] = Object.freeze([]);
const INITIAL: ReviewState = Object.freeze({ selected: null, ticked: null, hotStep: null, pinnedStep: null, ghostsOn: true, preview: null });

export class ReviewStore {
  readonly #client: ReviewClient;
  readonly #plans: ReviewPlans;
  #state: ReviewState = INITIAL;
  readonly #listeners = new Set<() => void>();
  readonly #reveals = new Set<(request: RevealRequest) => void>();
  readonly #off: Array<() => void> = [];
  #shown: string | null = null;
  #previewKey: string | null = null;
  #token = 0;
  #memo: { plan: PlanEntry; preview: PlanPreview; snapshot: Snapshot | null; ticked: ReadonlySet<number> | null; ghosts: readonly Ghost[] } | null = null;

  constructor(options: { client: ReviewClient; plans: ReviewPlans }) {
    this.#client = options.client;
    this.#plans = options.plans;
    this.#off.push(this.#plans.subscribe(() => this.#refresh()));
    this.#off.push(this.#client.model.subscribe(() => this.#refresh()));
    this.#refresh(false);
  }

  destroy(): void {
    for (const off of this.#off.splice(0)) off();
    this.#listeners.clear();
    this.#reveals.clear();
  }

  getSnapshot(): ReviewState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onReveal(listener: (request: RevealRequest) => void): () => void {
    this.#reveals.add(listener);
    return () => {
      this.#reveals.delete(listener);
    };
  }

  // The plan on the card.
  plan(): PlanEntry | undefined {
    return cardPlan(this.#plans.getSnapshot().plans, this.#state.selected);
  }

  reviewable(): boolean {
    return reviewable(this.plan());
  }

  ghosts(): readonly Ghost[] {
    const plan = this.plan();
    const preview = this.#state.preview?.preview;
    if (!this.#state.ghostsOn || !reviewable(plan) || !preview || this.#state.preview?.plan !== plan.hash) return NONE;
    const snapshot = this.#client.model.getSnapshot();
    const ticked = this.#state.ticked;
    const memo = this.#memo;
    if (memo && memo.plan === plan && memo.preview === preview && memo.snapshot === snapshot && memo.ticked === ticked) return memo.ghosts;
    const ghosts = Object.freeze(ghostsOf(plan.steps, preview, snapshot, ticked));
    this.#memo = { plan, preview, snapshot, ticked, ghosts };
    return ghosts;
  }

  // The step whose ghosts are outlined (1-based): the hovered one, else the pinned one.
  outlineStep(): number | null {
    const index = this.#state.hotStep ?? this.#state.pinnedStep;
    return index === null ? null : index + 1;
  }

  select(hash: string): void {
    this.#set({ selected: hash, ticked: null });
    this.#refresh();
  }

  setTicked(ticked: ReadonlySet<number> | null): void {
    this.#set({ ticked });
    this.#emit();
  }

  // The pointer entered a row (or left every row: null).
  setHot(index: number | null): void {
    const pinned = this.#state.pinnedStep;
    this.#set({ hotStep: index, pinnedStep: index !== null && pinned !== null && pinned !== index ? null : pinned });
    this.#emit();
    if (index !== null) this.#reveal({ step: index + 1, mixer: false, plans: false });
  }

  // The target button of a row: pins it and brings its ghosts into view.
  locate(index: number): void {
    this.#set({ pinnedStep: index });
    this.#emit();
    this.#reveal({ step: index + 1, mixer: hasStripGhost(this.ghosts(), index + 1), plans: false });
  }

  // A click on a ghost of `step` (1-based).
  pinGhost(step: number): void {
    this.#set({ pinnedStep: step - 1 });
    this.#emit();
    this.#reveal({ step, mixer: false, plans: true });
  }

  toggleGhosts(): void {
    this.#set({ ghostsOn: !this.#state.ghostsOn });
    this.#emit();
  }

  // A reconnect: the selection, its ticks, the hover and the pin go.
  reset(): void {
    this.#set({ selected: null, ticked: null, hotStep: null, pinnedStep: null });
    this.#refresh();
  }

  #set(patch: Partial<ReviewState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #reveal(request: RevealRequest): void {
    for (const listener of [...this.#reveals]) listener(request);
  }

  // The card's plan and the head revision: a new plan clears what belonged to
  // the old one; a new key asks plan.preview again.
  #refresh(emit = true): void {
    const plan = this.plan();
    const shown = plan?.hash ?? null;
    if (shown !== this.#shown) {
      this.#shown = shown;
      this.#set({ ticked: null, hotStep: null, pinnedStep: null });
    }
    const hash = plan && landedLabel(plan) === null ? plan.hash : null;
    const revision = this.#client.model.getSnapshot()?.revision ?? null;
    const baseRevision = typeof plan?.raw.baseRevision === 'string' ? plan.raw.baseRevision : null;
    const staleKey = plan ? plan.stale.map((s) => `${s.ref}:${s.change}`).join(',') : '';
    const key = hash === null ? null : JSON.stringify([hash, plan!.state, staleKey, revision, baseRevision]);
    if (key !== this.#previewKey) {
      this.#previewKey = key;
      if (hash === null) this.#set({ preview: null });
      else {
        if (this.#state.preview?.plan !== hash) this.#set({ preview: null });
        this.#ask(hash, plan!.stale.map((s) => s.ref), baseRevision);
      }
    }
    if (emit) this.#emit();
  }

  #ask(hash: string, staleRefs: readonly string[], baseRevision: string | null): void {
    const token = (this.#token += 1);
    const base = async (): Promise<ReadonlyMap<string, Entity | null> | null> => {
      if (staleRefs.length === 0 || baseRevision === null) return new Map();
      try {
        const fetched = (await this.#client.request('session.fetch', { refs: [...staleRefs], revision: baseRevision })) as {
          entities?: Array<{ ref?: unknown; entity?: unknown }>;
        };
        const map = new Map<string, Entity | null>();
        for (const item of fetched.entities ?? []) {
          if (typeof item.ref === 'string') map.set(item.ref, (item.entity as Entity | undefined) ?? null);
        }
        return map;
      } catch {
        return null;
      }
    };
    void this.#client.request('plan.preview', { plan: hash }).then(
      async (result) => {
        const atBase = await base();
        if (token !== this.#token) return;
        this.#set({ preview: { plan: hash, preview: result as PlanPreview, base: atBase } });
        this.#emit();
      },
      (error: unknown) => {
        if (token !== this.#token) return;
        this.#set({ preview: { plan: hash, error } });
        this.#emit();
      },
    );
  }
}
