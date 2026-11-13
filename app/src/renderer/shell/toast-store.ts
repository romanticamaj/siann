// The toast surface's store (m5-ui-plan-panel adds it, m5-ui-connection uses
// it too; UI redesign 4.4 and P1-0). Generic: push(message) shows a finished,
// already-worded line; it expires after TOAST_MS by the injected scheduler,
// can be dismissed, and at most MAX_TOASTS are visible (the oldest goes).
// Framework-free: shell/Toasts.tsx reads it through useSyncExternalStore.

import type { Locale } from '../i18n/locale';

export const TOAST_MS = 8000;
export const MAX_TOASTS = 3;

export interface Toast {
  readonly id: number;
  // The line as worded when it was raised.
  readonly message: string;
  // The same line in another locale, so a language switch re-words it.
  readonly reword?: (locale: Locale) => string;
}

export interface ToastStoreOptions {
  // Runs fn after ms; returns a cancel function (setTimeout by default).
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export class ToastStore {
  #toasts: readonly Toast[] = Object.freeze([]);
  #nextId = 1;
  readonly #cancels = new Map<number, () => void>();
  readonly #listeners = new Set<() => void>();
  readonly #schedule: (fn: () => void, ms: number) => () => void;

  constructor(options: ToastStoreOptions = {}) {
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  getSnapshot(): readonly Toast[] {
    return this.#toasts;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  push(message: string, reword?: (locale: Locale) => string): number {
    const id = this.#nextId++;
    const toasts: Toast[] = [...this.#toasts, { id, message, ...(reword ? { reword } : {}) }];
    for (const dropped of toasts.splice(0, Math.max(0, toasts.length - MAX_TOASTS))) this.#cancel(dropped.id);
    this.#cancels.set(
      id,
      this.#schedule(() => {
        this.#cancels.delete(id);
        this.#remove(id);
      }, TOAST_MS),
    );
    this.#set(toasts);
    return id;
  }

  dismiss(id: number): void {
    this.#cancel(id);
    this.#remove(id);
  }

  #cancel(id: number): void {
    this.#cancels.get(id)?.();
    this.#cancels.delete(id);
  }

  #remove(id: number): void {
    if (!this.#toasts.some((t) => t.id === id)) return;
    this.#set(this.#toasts.filter((t) => t.id !== id));
  }

  #set(toasts: Toast[]): void {
    this.#toasts = Object.freeze(toasts);
    for (const listener of [...this.#listeners]) listener();
  }
}
