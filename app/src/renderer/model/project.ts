// Projects (m5b-ui-project; UI redesign UR-4, 3.0; architecture spec,
// "Process model"): New, Open, the recent list and Save, and the saved mark.
//
// The shell owns the folder dialogs and the record of bundles; the renderer
// reaches them only through a ShellPort, which index.tsx adapts from the
// preload bridge and which is null in a plain browser tab. New asks the
// shell's save dialog for a folder and sends session.create {path}; Open asks
// its open dialog (or takes a recent entry) and sends session.open {path}. The
// protocol never names a bundle's path to a client, so once the engine has
// answered the renderer tells the shell (ShellPort.opened), which records it,
// keeps it for an engine restart and rebuilds the menu. The window follows
// session.opened through the session client's epoch. A refusal (the bundle
// another engine holds: session_locked; an existing folder: already_exists;
// no folder: not_found) is shown with the bundle's path, and the old session
// stays. Save sends session.save and hands its revision to the saved mark.
//
// The saved mark is the renderer's: its baseline is the head revision at the
// window's first sync, at every epoch (the first sync after it) and the
// revision session.save answers; it shows while the head differs from it.
// The status bar's "Saved · rN" names that baseline (savedRevision), never
// the head.
// Framework-free: React reads both through useSyncExternalStore.

import type { Locale } from '../i18n/locale';
import { refusalLine } from '../i18n/errors';
import { translator } from '../i18n/t';
import type { CommandId, CommandRegistry } from '../keys/commands';
import type { CapabilitySelector } from './capabilities';
import { ProtocolError } from './session-client';

export interface RecentProject {
  readonly path: string;
  // The bundle's folder name without .siann.
  readonly name: string;
}

export interface ShellProjectState {
  // The bundle the engine serves as the shell knows it; null on the scratch bundle.
  readonly current: string | null;
  // The shell started on the scratch bundle: the start view shows.
  readonly startView: boolean;
  // Newest first, at most ten.
  readonly recent: readonly RecentProject[];
}

// The shell's half of projects: its dialogs and its record.
export interface ShellPort {
  state(): Promise<ShellProjectState>;
  // An absolute folder for a new bundle, or null when the dialog was cancelled.
  chooseNew(): Promise<string | null>;
  // An existing bundle's folder, or null.
  chooseOpen(): Promise<string | null>;
  // The engine created or opened `path`.
  opened(path: string): void;
  onChange(listener: (state: ShellProjectState) => void): void;
}

export interface ProjectView {
  // A shell port exists (the commands that need it are rendered).
  readonly shell: boolean;
  readonly startView: boolean;
  readonly current: string | null;
  readonly recent: readonly RecentProject[];
  // The last refusal, worded; null after a success.
  readonly error: string | null;
  // A New or Open is under way.
  readonly busy: boolean;
}

export interface ProjectControllerOptions {
  readonly client: { request(method: string, params: Record<string, unknown>): Promise<unknown> };
  readonly shell: ShellPort | null;
  readonly locale: () => Locale;
  readonly toasts?: { push(text: string): unknown };
  readonly saved?: { saved(revision: string): void };
}

export const RECENT_COMMANDS: readonly CommandId[] = [
  'project.openRecent.1',
  'project.openRecent.2',
  'project.openRecent.3',
  'project.openRecent.4',
  'project.openRecent.5',
  'project.openRecent.6',
  'project.openRecent.7',
  'project.openRecent.8',
  'project.openRecent.9',
  'project.openRecent.10',
];

const PATH_KEYS = {
  session_locked: 'project.locked',
  already_exists: 'project.exists',
  not_found: 'project.notFound',
} as const;

// "<code>: <text>", the catalog's text with the bundle's path for the refusals
// of New and Open, the engine's message (refusalLine) for any other code.
export function projectRefusal(error: unknown, path: string | null, locale: Locale): string {
  const code = error instanceof ProtocolError ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  if (path !== null && Object.prototype.hasOwnProperty.call(PATH_KEYS, code)) {
    return `${code}: ${translator(locale)(PATH_KEYS[code as keyof typeof PATH_KEYS], { path })}`;
  }
  return refusalLine(code, message, locale);
}

export class ProjectController {
  readonly #options: ProjectControllerOptions;
  readonly #listeners = new Set<() => void>();
  #view: ProjectView;

  constructor(options: ProjectControllerOptions) {
    this.#options = options;
    this.#view = Object.freeze({ shell: options.shell !== null, startView: false, current: null, recent: [], error: null, busy: false });
  }

  getSnapshot = (): ProjectView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // Reads the shell's record once and follows its changes.
  async start(): Promise<void> {
    const shell = this.#options.shell;
    if (!shell) return;
    shell.onChange((state) => this.#shellState(state, false));
    this.#shellState(await shell.state(), true);
  }

  async newProject(): Promise<boolean> {
    const shell = this.#options.shell;
    if (!shell || this.#view.busy) return false;
    const path = await shell.chooseNew();
    if (path === null) return false;
    return this.#serve('session.create', path);
  }

  async open(): Promise<boolean> {
    const shell = this.#options.shell;
    if (!shell || this.#view.busy) return false;
    const path = await shell.chooseOpen();
    if (path === null) return false;
    return this.#serve('session.open', path);
  }

  async openPath(path: string): Promise<boolean> {
    if (!this.#options.shell || this.#view.busy) return false;
    return this.#serve('session.open', path);
  }

  // The n-th recent bundle, from 1.
  async openRecent(n: number): Promise<boolean> {
    const entry = this.#view.recent[n - 1];
    return entry ? this.openPath(entry.path) : false;
  }

  async save(): Promise<boolean> {
    try {
      const result = (await this.#options.client.request('session.save', {})) as { revision?: unknown } | null;
      if (result && typeof result.revision === 'string') this.#options.saved?.saved(result.revision);
      return true;
    } catch (error) {
      this.#options.toasts?.push(projectRefusal(error, null, this.#options.locale()));
      return false;
    }
  }

  // The key commands and menu items: Save always (with session.save); New,
  // Open and the recent entries only with a shell port, each declining when
  // the engine does not list its method.
  bind(commands: CommandRegistry, can: () => CapabilitySelector): () => void {
    const offs = [
      commands.register('window', 'project.save', () => {
        if (!can().has('session.save')) return false;
        void this.save();
        return true;
      }),
    ];
    if (this.#options.shell) {
      offs.push(
        commands.register('window', 'project.new', () => {
          if (!can().has('session.create') || this.#view.busy) return false;
          void this.newProject();
          return true;
        }),
        commands.register('window', 'project.open', () => {
          if (!can().has('session.open') || this.#view.busy) return false;
          void this.open();
          return true;
        }),
        ...RECENT_COMMANDS.map((id, i) =>
          commands.register('window', id, () => {
            if (!can().has('session.open') || this.#view.busy || this.#view.recent[i] === undefined) return false;
            void this.openRecent(i + 1);
            return true;
          }),
        ),
      );
    }
    return () => offs.forEach((off) => off());
  }

  async #serve(method: 'session.create' | 'session.open', path: string): Promise<boolean> {
    this.#set({ busy: true });
    try {
      await this.#options.client.request(method, { path });
    } catch (error) {
      const line = projectRefusal(error, path, this.#options.locale());
      this.#set({ busy: false, error: line });
      this.#options.toasts?.push(line);
      return false;
    }
    this.#set({ busy: false, error: null, startView: false, current: path });
    this.#options.shell?.opened(path);
    return true;
  }

  // The shell's record. After the first read the start view only goes: a
  // later change never brings it back.
  #shellState(state: ShellProjectState, first: boolean): void {
    this.#set({
      startView: first ? state.startView : this.#view.startView && state.startView,
      current: state.current ?? this.#view.current,
      recent: state.recent,
    });
  }

  #set(patch: Partial<ProjectView>): void {
    this.#view = Object.freeze({ ...this.#view, ...patch });
    for (const listener of [...this.#listeners]) listener();
  }
}

// What the saved mark reads of the session client.
export interface SavedMarkClient {
  getState(): { readonly epoch: number; readonly syncCount: number };
  subscribe(listener: () => void): () => void;
  readonly model: {
    getSnapshot(): { readonly revision: string } | null;
    subscribe(listener: () => void): () => void;
  };
}

export class SavedMark {
  readonly #client: SavedMarkClient;
  readonly #listeners = new Set<() => void>();
  readonly #offs: Array<() => void>;
  #epoch: number;
  // The sync count when the baseline was last dropped: the next sync sets it.
  #afterSync = 0;
  #baseline: string | null = null;
  // The baseline the listeners last heard.
  #told: string | null = null;
  #marked = false;

  constructor(client: SavedMarkClient) {
    this.#client = client;
    this.#epoch = client.getState().epoch;
    this.#offs = [client.subscribe(() => this.#check()), client.model.subscribe(() => this.#check())];
    this.#check();
  }

  getSnapshot = (): boolean => this.#marked;

  // The baseline: the revision the status bar calls saved; null before the first sync of an epoch.
  savedRevision = (): string | null => this.#baseline;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // session.save answered `revision`.
  saved(revision: string): void {
    this.#baseline = revision;
    this.#check();
  }

  destroy(): void {
    for (const off of this.#offs) off();
    this.#listeners.clear();
  }

  #check(): void {
    const state = this.#client.getState();
    if (state.epoch !== this.#epoch) {
      this.#epoch = state.epoch;
      this.#baseline = null;
      this.#afterSync = state.syncCount;
    }
    const head = this.#client.model.getSnapshot()?.revision ?? null;
    if (this.#baseline === null && head !== null && state.syncCount > this.#afterSync) this.#baseline = head;
    const marked = this.#baseline !== null && head !== null && head !== this.#baseline;
    if (marked === this.#marked && this.#baseline === this.#told) return;
    this.#marked = marked;
    this.#told = this.#baseline;
    for (const listener of [...this.#listeners]) listener();
  }
}
