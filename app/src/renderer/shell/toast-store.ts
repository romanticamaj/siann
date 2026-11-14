// The toasts of the window (UI redesign spec 1.6, 4.4 and 4.5 C8; Toasts.tsx
// draws them). Framework-free: a toast is pushed with its text (already worded
// in the UI locale) and dismisses itself after durationMs on the injected
// scheduler, or earlier by its close button; at most MAX_TOASTS are visible
// (the oldest goes). The reconnect toast comes from announceReconnects; the
// new-plan toast of m5-ui-plan-panel (plans/arrivals.ts) pushes here too and
// passes a reword so a language switch re-words a toast already shown.

import type { Locale } from '../i18n/locale';
import type { PhaseState } from '../model/connection-phase';

export interface Toast {
  readonly id: number;
  // The line as worded when it was raised.
  readonly text: string;
  // The same line in another locale, so a language switch re-words it.
  readonly reword?: (locale: Locale) => string;
}

export interface ToastStoreOptions {
  // Runs fn after ms; returns a cancel function (setTimeout by default).
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly durationMs?: number;
}

// Long enough to read a revision id and move the eyes to it.
export const TOAST_MS = 8000;
export const MAX_TOASTS = 3;

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export class ToastStore {
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #durationMs: number;
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Map<number, () => void>();
  #toasts: readonly Toast[] = Object.freeze([]);
  #nextId = 0;

  constructor(options: ToastStoreOptions = {}) {
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#durationMs = options.durationMs ?? TOAST_MS;
  }

  getSnapshot = (): readonly Toast[] => this.#toasts;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  push(text: string, reword?: (locale: Locale) => string): number {
    this.#nextId += 1;
    const id = this.#nextId;
    const toasts: Toast[] = [...this.#toasts, Object.freeze({ id, text, ...(reword ? { reword } : {}) })];
    for (const dropped of toasts.splice(0, Math.max(0, toasts.length - MAX_TOASTS))) this.#cancel(dropped.id);
    this.#set(toasts);
    this.#timers.set(
      id,
      this.#schedule(() => {
        this.#timers.delete(id);
        this.dismiss(id);
      }, this.#durationMs),
    );
    return id;
  }

  dismiss(id: number): void {
    this.#cancel(id);
    if (!this.#toasts.some((toast) => toast.id === id)) return;
    this.#set(this.#toasts.filter((toast) => toast.id !== id));
  }

  #cancel(id: number): void {
    const cancel = this.#timers.get(id);
    if (!cancel) return;
    this.#timers.delete(id);
    cancel();
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
