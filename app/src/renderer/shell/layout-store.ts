// The layout store. Placeholder: arrives with the feature commit.

import type { ShellAction, ShellState } from './layout';

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LayoutStore {
  getSnapshot(): ShellState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ShellAction): void;
}

export function createLayoutStore(_options: { storage: LayoutStorage | null }): LayoutStore {
  throw new Error('not implemented');
}
