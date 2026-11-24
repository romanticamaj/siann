// The selected bus (m5b-ui-sends-buses; UI redesign 3.4; 10.11, 25): app
// state beside the track selection, which it does not change. A press on a
// bus strip outside its controls selects the bus; selecting a track, Escape
// with the lower zone focused, or the bus's removal clears it.
// mixer.bus.remove acts on it, and the application menu's Remove Bus is
// disabled while none is selected, so index.tsx (the menu) and App (the
// strips, the commands) share one store. Framework-free.

export class BusSelection {
  #busId: string | null = null;
  readonly #listeners = new Set<() => void>();

  getSnapshot = (): string | null => this.#busId;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(busId: string | null): void {
    if (busId === this.#busId) return;
    this.#busId = busId;
    for (const listener of [...this.#listeners]) listener();
  }

  // Clears a selection whose bus is gone.
  prune(busOrder: readonly string[]): void {
    if (this.#busId !== null && !busOrder.includes(this.#busId)) this.set(null);
  }
}
