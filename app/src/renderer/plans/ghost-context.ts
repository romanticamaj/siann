// The ghosts the DOM zones draw (m5b-ui-ghosts; UI redesign 4.2): the track
// headers, the MixConsole strips and the Inspector read the plan under
// review's ghosts, the outlined step and where a click on a ghost goes from
// this context, which App fills from the review store (model/review-store.ts).
// Without a provider (a zone rendered alone) there are no ghosts.

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

import type { PlanEntry } from '../model/plan-store';
import type { ReviewStore } from '../model/review-store';
import type { Ghost } from './ghosts';

export interface GhostView {
  readonly ghosts: readonly Ghost[];
  // The step whose ghosts are outlined (1-based), or null.
  readonly outline: number | null;
  // A click on a ghost of `step`.
  pin(step: number): void;
  // The plan under review while it is reviewable, with the ghosts shown or
  // toggled off (the Inspector's Agent changes lists what is pending on a
  // track from it), and its ticked steps (0-based; null: every step).
  readonly plan?: PlanEntry;
  readonly ticked?: ReadonlySet<number> | null;
}

export const NO_GHOSTS: GhostView = Object.freeze({ ghosts: Object.freeze([]) as readonly Ghost[], outline: null, pin: () => undefined });

export const GhostContext = createContext<GhostView>(NO_GHOSTS);

// The review store itself, for the zones that act on its requests (the
// MixConsole and the Plans tab scroll a revealed step into view).
export const ReviewContext = createContext<ReviewStore | null>(null);

export function useGhostView(): GhostView {
  return useContext(GhostContext);
}

// The review store's ghosts as a GhostView, for the provider.
export function useReviewGhosts(store: ReviewStore | null): GhostView {
  const subscribe = (listener: () => void) => (store ? store.subscribe(listener) : () => undefined);
  const ghosts = useSyncExternalStore(subscribe, () => (store ? store.ghosts() : NO_GHOSTS.ghosts), () => NO_GHOSTS.ghosts);
  const outline = useSyncExternalStore(subscribe, () => (store ? store.outlineStep() : null), () => null);
  const plan = useSyncExternalStore(subscribe, () => (store?.reviewable() ? store.plan() : undefined), () => undefined);
  const ticked = useSyncExternalStore(subscribe, () => (store ? store.getSnapshot().ticked : null), () => null);
  return useMemo<GhostView>(
    () => (store ? { ghosts, outline, plan, ticked, pin: (step) => store.pinGhost(step) } : NO_GHOSTS),
    [store, ghosts, outline, plan, ticked],
  );
}

// The attributes a DOM ghost takes besides the mockup's classes: data-ghost
// (the 150 ms fade in of shell.css, which prefers-reduced-motion removes) and
// data-ghost-hot on the ghosts of the hovered or pinned step (their outline).
export function ghostAttrs(view: GhostView, steps: readonly number[]): { readonly 'data-ghost': string; readonly 'data-ghost-hot'?: string } {
  return view.outline !== null && steps.includes(view.outline) ? { 'data-ghost': steps.join(' '), 'data-ghost-hot': 'true' } : { 'data-ghost': steps.join(' ') };
}
