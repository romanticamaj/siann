// Transient notices (UX pass, B3/A11): errors and events shown as toasts that
// dismiss themselves, with the last error kept for the status bar. React reads
// it through useSyncExternalStore. Framework-free; the scheduler is injected.

export type ToastKind = 'error' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

export interface ToastSnapshot {
  readonly toasts: readonly Toast[];
  // The newest error, kept after its toast is gone ('' for none).
  readonly lastError: string;
}

export const TOAST_MS = 6000;
export const MAX_TOASTS = 4;

export class ToastStore {
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Map<number, () => void>();
  #snapshot: ToastSnapshot = Object.freeze({ toasts: Object.freeze([]), lastError: '' });
  #next = 1;

  constructor(schedule: (fn: () => void, ms: number) => () => void) {
    this.#schedule = schedule;
  }

  getSnapshot(): ToastSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Shows a toast; an identical one already shown is not repeated. Returns its id.
  push(kind: ToastKind, text: string, ms = TOAST_MS): number {
    const same = this.#snapshot.toasts.find((t) => t.kind === kind && t.text === text);
    const lastError = kind === 'error' ? text : this.#snapshot.lastError;
    if (same) {
      this.#restart(same.id, ms);
      this.#set({ toasts: this.#snapshot.toasts, lastError });
      return same.id;
    }
    const toast: Toast = Object.freeze({ id: this.#next++, kind, text });
    let toasts = [...this.#snapshot.toasts, toast];
    while (toasts.length > MAX_TOASTS) {
      const dropped = toasts.shift()!;
      this.#timers.get(dropped.id)?.();
      this.#timers.delete(dropped.id);
    }
    this.#restart(toast.id, ms);
    this.#set({ toasts, lastError });
    return toast.id;
  }

  error(text: string): number {
    return this.push('error', text);
  }

  info(text: string): number {
    return this.push('info', text);
  }

  dismiss(id: number): void {
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    if (!this.#snapshot.toasts.some((t) => t.id === id)) return;
    this.#set({ toasts: this.#snapshot.toasts.filter((t) => t.id !== id), lastError: this.#snapshot.lastError });
  }

  // Forgets the last error (a later success of the same surface).
  clearLastError(): void {
    if (this.#snapshot.lastError === '') return;
    this.#set({ toasts: this.#snapshot.toasts, lastError: '' });
  }

  #restart(id: number, ms: number): void {
    this.#timers.get(id)?.();
    this.#timers.set(
      id,
      this.#schedule(() => {
        this.#timers.delete(id);
        this.dismiss(id);
      }, ms),
    );
  }

  #set(next: { toasts: readonly Toast[]; lastError: string }): void {
    this.#snapshot = Object.freeze({ toasts: Object.freeze([...next.toasts]), lastError: next.lastError });
    for (const listener of [...this.#listeners]) listener();
  }
}
