// Stub: the peaks cache lands with the implementation.

import type { PeakPyramid } from './peaks';
import type { EngineEndpoint } from './session-client';

export interface FetchResponseLike {
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponseLike>;

export interface PeaksCacheOptions {
  fetch: FetchLike;
  endpoint: () => EngineEndpoint | null;
  schedule: (fn: () => void, ms: number) => () => void;
}

export type PeaksState = 'absent' | 'pending' | 'ready' | 'failed';

export class PeaksCache {
  constructor(_options: PeaksCacheOptions) {}
  get(_hash: string): PeakPyramid | null {
    return null;
  }
  state(_hash: string): PeaksState {
    return 'absent';
  }
  error(_hash: string): string | null {
    return null;
  }
  endpointChanged(): void {}
  subscribe(_listener: () => void): () => void {
    return () => {};
  }
}
