// The plugin picker's state (m5b-ui-inserts-master; UI redesign 3.4): opened
// from an empty slot of a track, it lists the installs of plugin.registry by
// name and format, filtered by a search field. An approved install is chosen
// with its row and inserted at the end of the track's chain (one revision);
// an unapproved one is approved (plugin.approve) after a confirmation that
// names its file, and then reads approved from a fresh registry. What the
// engine refuses (the registry, an approval: invalid_params for a library
// that holds several plugins, plugin_load_failed, plugin_not_found; a failed
// instantiate job) is shown with its code and message, and an install whose
// approval was refused stays unapproved. Choosing among the plugins of one
// library is in docs/harness/follow-ups.md.
//
// Framework-free; PluginPicker.tsx renders it.

import { failureOf, type InsertOwner, type PluginActions, type PluginFailure, type RegistryEntry } from '../model/plugin-actions';

export type { InsertOwner } from '../model/plugin-actions';

export interface PickerState {
  readonly open: boolean;
  // The track the picker inserts on, or null (no picker, or a bus's).
  readonly trackId: string | null;
  // The track or bus the picker inserts on (m5b-ui-sends-buses: a bus strip's rack).
  readonly owner: InsertOwner | null;
  // null while plugin.registry is asked.
  readonly installs: readonly RegistryEntry[] | null;
  readonly query: string;
  // The install whose approval waits for its confirmation.
  readonly confirm: RegistryEntry | null;
  readonly error: PluginFailure | null;
  readonly busy: boolean;
}

const CLOSED: PickerState = Object.freeze({ open: false, trackId: null, owner: null, installs: null, query: '', confirm: null, error: null, busy: false });

// The last segment of an install's path, whatever its separators.
export const fileName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file;

const byName = (a: RegistryEntry, b: RegistryEntry) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.path.localeCompare(b.path);

export class PickerController {
  readonly #actions: PluginActions;
  readonly #listeners = new Set<() => void>();
  #state: PickerState = CLOSED;
  // Each open is a session of its own: a late answer of an earlier one is dropped.
  #opened = 0;

  constructor(options: { actions: PluginActions }) {
    this.#actions = options.actions;
  }

  getSnapshot = (): PickerState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // The installs the search keeps, by name. The search reads the name and the
  // file name: an install not probed yet is named after its file, and keeps
  // matching once its approval names the plugin.
  visible(): RegistryEntry[] {
    const query = this.#state.query.trim().toLowerCase();
    const all = [...(this.#state.installs ?? [])].sort(byName);
    return query === '' ? all : all.filter((e) => e.name.toLowerCase().includes(query) || fileName(e.path).toLowerCase().includes(query));
  }

  // A track id, or the track or bus the empty slot belongs to.
  async open(target: string | InsertOwner): Promise<void> {
    const owner: InsertOwner = typeof target === 'string' ? { trackId: target } : target;
    const session = ++this.#opened;
    this.#set({ ...CLOSED, open: true, owner, trackId: 'trackId' in owner ? owner.trackId : null });
    await this.#load(session);
  }

  close(): void {
    this.#opened += 1;
    this.#set(CLOSED);
  }

  search(query: string): void {
    if (!this.#state.open) return;
    this.#set({ ...this.#state, query });
  }

  askApprove(entry: RegistryEntry): void {
    if (!this.#state.open) return;
    this.#set({ ...this.#state, confirm: entry, error: null });
  }

  cancelApprove(): void {
    if (this.#state.confirm === null) return;
    this.#set({ ...this.#state, confirm: null });
  }

  async confirmApprove(): Promise<void> {
    const entry = this.#state.confirm;
    if (!entry) return;
    const session = this.#opened;
    this.#set({ ...this.#state, confirm: null, busy: true, error: null });
    try {
      await this.#actions.approve(entry);
    } catch (error) {
      if (session === this.#opened) this.#set({ ...this.#state, busy: false, error: failureOf(error) });
      return;
    }
    if (session === this.#opened) await this.#load(session);
  }

  // Inserts the install at the end of the track's or the bus's chain; closes on success.
  async choose(entry: RegistryEntry): Promise<boolean> {
    const owner = this.#state.owner;
    if (!this.#state.open || owner === null || !entry.approved) return false;
    const session = this.#opened;
    this.#set({ ...this.#state, busy: true, error: null });
    try {
      await this.#actions.instantiate(owner, entry);
    } catch (error) {
      if (session === this.#opened) this.#set({ ...this.#state, busy: false, error: failureOf(error) });
      return false;
    }
    if (session === this.#opened) this.close();
    return true;
  }

  async #load(session: number): Promise<void> {
    try {
      const installs = await this.#actions.registry();
      if (session === this.#opened) this.#set({ ...this.#state, installs, busy: false });
    } catch (error) {
      if (session === this.#opened) this.#set({ ...this.#state, installs: this.#state.installs ?? [], busy: false, error: failureOf(error) });
    }
  }

  #set(state: PickerState): void {
    this.#state = Object.freeze(state);
    for (const listener of [...this.#listeners]) listener();
  }
}
