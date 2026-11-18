// The plugin methods a slot and the picker call (m5b-ui-inserts-master;
// docs/schemas/protocol-plugins-v0.md; UI redesign 3.4): plugin.registry and
// plugin.approve for the picker, plugin.instantiate to insert at the end of a
// track's chain (one revision: the job commits plugin.insert), command.execute
// plugin.set_bypass and plugin.remove (one revision each), and
// plugin.open_editor / plugin.close_editor, which are no revision. The editor
// state of a slot is the editorOpen of the last result for it: the engine has
// no event for a window closed from its title bar (docs/harness/follow-ups.md),
// so e reads what the engine last answered. A refused bypass, Remove or editor
// request raises a toast with the engine's code (editor_failed on the
// headless engine, which has no window to embed a CLAP editor into).
//
// Framework-free: the client, the toasts and the locale are injected.

import { refusalLine } from '../i18n/errors';
import type { Locale } from '../i18n/locale';
import type { ToastStore } from '../shell/toast-store';
import type { Entity } from './document';
import type { Snapshot } from './read-model';

export interface PluginClient {
  readonly model: { getSnapshot(): Snapshot | null; select(ref: string): Entity | undefined };
  request(method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown>;
}

// One install of plugin.registry.
export interface RegistryEntry {
  readonly format: string;
  readonly path: string;
  readonly uid: string | null;
  readonly name: string;
  readonly approved: boolean;
}

// What the engine refused: its code and message.
export interface PluginFailure {
  readonly code: string;
  readonly message: string;
}

export class PluginActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginActionError';
  }
}

export interface PluginActionsOptions {
  readonly client: PluginClient;
  readonly toasts?: ToastStore;
  readonly locale?: () => Locale;
}

function failureOf(error: unknown): PluginFailure {
  const code = (error as { code?: unknown }).code;
  return { code: typeof code === 'string' ? code : 'internal_error', message: error instanceof Error ? error.message : String(error) };
}

function entryOf(value: unknown): RegistryEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.format !== 'string' || typeof v.path !== 'string') return null;
  return Object.freeze({
    format: v.format,
    path: v.path,
    uid: typeof v.uid === 'string' ? v.uid : null,
    name: typeof v.name === 'string' && v.name !== '' ? v.name : v.path,
    approved: v.approved === true,
  });
}

export class PluginActions {
  readonly #options: PluginActionsOptions;
  readonly #editors = new Map<string, boolean>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(options: PluginActionsOptions) {
    this.#options = options;
  }

  // Changes with every editor state, for useSyncExternalStore.
  getVersion = (): number => this.#version;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // The editorOpen of the last open or close result for the slot.
  editorOpen(slotId: string): boolean {
    return this.#editors.get(slotId) === true;
  }

  async registry(): Promise<RegistryEntry[]> {
    const result = (await this.#request('plugin.registry', {})) as { plugins?: unknown } | null;
    const rows = Array.isArray(result?.plugins) ? result.plugins : [];
    return rows.map(entryOf).filter((e): e is RegistryEntry => e !== null);
  }

  // Approves an install (the engine probes it first when its uid is not known).
  async approve(entry: RegistryEntry): Promise<RegistryEntry> {
    const result = await this.#request('plugin.approve', { format: entry.format, path: entry.path, approved: true });
    return entryOf(result) ?? { ...entry, approved: true };
  }

  // Inserts the install at the end of the track's chain: one revision. Resolves
  // with the new slot id; a refused request or a failed job throws its code.
  async instantiate(trackId: string, entry: RegistryEntry): Promise<string> {
    const snapshot = this.#options.client.model.getSnapshot();
    const track = this.#options.client.model.select(`track:${trackId}`) as { inserts?: readonly string[] } | undefined;
    const index = track?.inserts?.length ?? 0;
    const job = (await this.#request('plugin.instantiate', { trackId, index, descriptor: { format: entry.format, path: entry.path } }, snapshot?.revision)) as {
      state?: unknown;
      result?: { slotId?: unknown };
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (job?.state === 'done' && typeof job.result?.slotId === 'string') return job.result.slotId;
    const code = typeof job?.error?.code === 'string' ? job.error.code : 'internal_error';
    const message = typeof job?.error?.message === 'string' ? job.error.message : '';
    throw new PluginActionError(code, message);
  }

  setBypass(slotId: string, bypass: boolean): Promise<void> {
    return this.#command({ op: 'plugin.set_bypass', slotId, bypass });
  }

  remove(slotId: string): Promise<void> {
    return this.#command({ op: 'plugin.remove', slotId });
  }

  // Opens the slot's editor, or closes it when the last result said open.
  async toggleEditor(slotId: string): Promise<void> {
    const method = this.editorOpen(slotId) ? 'plugin.close_editor' : 'plugin.open_editor';
    try {
      const result = (await this.#request(method, { slotId })) as { editorOpen?: unknown } | null;
      this.#setEditor(slotId, result?.editorOpen === true);
    } catch (error) {
      this.#setEditor(slotId, false);
      this.#refused(error);
    }
  }

  async #command(command: Record<string, unknown>): Promise<void> {
    const revision = this.#options.client.model.getSnapshot()?.revision;
    try {
      await this.#request('command.execute', { commands: [command] }, revision);
    } catch (error) {
      this.#refused(error);
    }
  }

  #request(method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    return expectedRevision === undefined ? this.#options.client.request(method, params) : this.#options.client.request(method, params, expectedRevision);
  }

  #refused(error: unknown): void {
    const { toasts, locale } = this.#options;
    if (!toasts) return;
    const { code, message } = failureOf(error);
    toasts.push(refusalLine(code, message, locale?.() ?? 'en'), (next) => refusalLine(code, message, next));
  }

  #setEditor(slotId: string, open: boolean): void {
    if (this.editorOpen(slotId) === open && this.#editors.has(slotId)) return;
    this.#editors.set(slotId, open);
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}

export { failureOf };
