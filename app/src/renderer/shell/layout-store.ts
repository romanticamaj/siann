// The layout store (UI redesign spec 2.3, "Remembered per user, not per
// session"): the shell state of layout.ts, read from and written to one
// localStorage key (siann.layout.v1). Storage is injected and every access is
// guarded: a private window, blocked site data or a full quota leave the shell
// working with the defaults, unsaved. React reads it through
// useSyncExternalStore (useShellState). Nothing here reaches the engine.

import { useSyncExternalStore } from 'react';

import { initialShellState, LAYOUT_KEY, parseLayout, reduce, serializeLayout, type ShellAction, type ShellState } from './layout';

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LayoutStore {
  getSnapshot(): ShellState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ShellAction): void;
}

export function createLayoutStore(options: { storage: LayoutStorage | null }): LayoutStore {
  const { storage } = options;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(LAYOUT_KEY) ?? null;
  } catch {
    stored = null;
  }
  let state = initialShellState(parseLayout(stored));
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      const layoutChanged = next.layout !== state.layout;
      state = next;
      if (layoutChanged && storage) {
        try {
          storage.setItem(LAYOUT_KEY, serializeLayout(next.layout));
        } catch {
          // Unsaved: the layout still applies to this window.
        }
      }
      for (const listener of [...listeners]) listener();
    },
  };
}

export function useShellState(store: LayoutStore): ShellState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
