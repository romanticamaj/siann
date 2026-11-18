// The ghosts the DOM zones draw (m5b-ui-ghosts). Stub.

import { createContext, useContext } from 'react';

import type { PlanEntry } from '../model/plan-store';
import type { Ghost } from './ghosts';

export interface GhostView {
  readonly ghosts: readonly Ghost[];
  readonly outline: number | null;
  pin(step: number): void;
  readonly plan?: PlanEntry;
}

export const NO_GHOSTS: GhostView = Object.freeze({ ghosts: Object.freeze([]) as readonly Ghost[], outline: null, pin: () => undefined });

export const GhostContext = createContext<GhostView>(NO_GHOSTS);

export function useGhostView(): GhostView {
  return useContext(GhostContext);
}
