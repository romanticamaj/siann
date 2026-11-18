// The plan review's state (m5b-ui-ghosts). Stub.

import type { Ghost } from '../plans/ghosts';
import type { PlanPreview } from '../plans/diff';
import type { PlanEntry, PlanSnapshot } from './plan-store';
import type { Snapshot } from './read-model';

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
  readonly error?: { readonly code: string | null; readonly message: string };
  readonly base?: ReadonlyMap<string, Readonly<Record<string, unknown>> | null> | null;
}

export interface ReviewState {
  readonly selected: string | null;
  readonly ticked: ReadonlySet<number> | null;
  readonly hotStep: number | null;
  readonly pinnedStep: number | null;
  readonly ghostsOn: boolean;
  readonly preview: PreviewState | null;
}

export interface RevealRequest {
  readonly step: number;
  readonly mixer: boolean;
  readonly plans: boolean;
}

export function reviewable(_plan: PlanEntry | undefined): boolean {
  return false;
}

const INITIAL: ReviewState = { selected: null, ticked: null, hotStep: null, pinnedStep: null, ghostsOn: true, preview: null };

export class ReviewStore {
  constructor(_options: { client: ReviewClient; plans: ReviewPlans }) {}
  getSnapshot(): ReviewState {
    return INITIAL;
  }
  subscribe(_listener: () => void): () => void {
    return () => undefined;
  }
  onReveal(_listener: (request: RevealRequest) => void): () => void {
    return () => undefined;
  }
  plan(): PlanEntry | undefined {
    return undefined;
  }
  reviewable(): boolean {
    return false;
  }
  ghosts(): readonly Ghost[] {
    return [];
  }
  outlineStep(): number | null {
    return null;
  }
  select(_hash: string): void {}
  setTicked(_ticked: ReadonlySet<number> | null): void {}
  setHot(_index: number | null): void {}
  locate(_index: number): void {}
  pinGhost(_step: number): void {}
  toggleGhosts(): void {}
  reset(): void {}
  destroy(): void {}
}
