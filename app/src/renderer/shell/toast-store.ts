// The toasts of the window (UI redesign spec 1.6 and 4.5 C8; Toasts.tsx
// draws them). Framework-free: a toast is pushed with its text (already worded
// in the UI locale) and dismisses itself after durationMs on the injected
// scheduler, or earlier by its close button. The reconnect toast comes from
// announceReconnects; the new-plan toast of m5-ui-plan-panel pushes here too.

import type { PhaseState } from '../model/connection-phase';

export interface Toast {
  readonly id: number;
  readonly text: string;
}

export interface ToastStoreOptions {
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly durationMs?: number;
}

// Long enough to read a revision id and move the eyes to it.
export const TOAST_MS = 8000;

export class ToastStore {
  readonly #options: ToastStoreOptions;
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Map<number, () => void>();
  #toasts: readonly Toast[] = Object.freeze([]);
  #nextId = 0;

  constructor(options: ToastStoreOptions) {
    this.#options = options;
  }

  getSnapshot = (): readonly Toast[] => this.#toasts;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  push(text: string): number {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#set([...this.#toasts, Object.freeze({ id, text })]);
    this.#timers.set(
      id,
      this.#options.schedule(() => {
        this.#timers.delete(id);
        this.dismiss(id);
      }, this.#options.durationMs ?? TOAST_MS),
    );
    return id;
  }

  dismiss(id: number): void {
    const cancel = this.#timers.get(id);
    if (cancel) {
      this.#timers.delete(id);
      cancel();
    }
    if (!this.#toasts.some((toast) => toast.id === id)) return;
    this.#set(this.#toasts.filter((toast) => toast.id !== id));
  }

  #set(toasts: readonly Toast[]): void {
    this.#toasts = Object.freeze(toasts);
    for (const listener of [...this.#listeners]) listener();
  }
}

// What announceReconnects reads of the connection phase.
export interface PhaseSource {
  getSnapshot(): PhaseState;
  subscribe(listener: () => void): () => void;
}

// Pushes one toast per reconnect, worded by `message` with the recovered
// revision (spec 4.5 C8). The first connection announces nothing.
export function announceReconnects(phases: PhaseSource, toasts: ToastStore, message: (revision: string) => string): () => void {
  let announced = phases.getSnapshot().reconnect?.count ?? 0;
  return phases.subscribe(() => {
    const reconnect = phases.getSnapshot().reconnect;
    if (!reconnect || reconnect.count === announced) return;
    announced = reconnect.count;
    toasts.push(message(reconnect.revision));
  });
}
