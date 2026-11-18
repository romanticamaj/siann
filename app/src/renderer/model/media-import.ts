// Importing audio files (m5b-ui-media; UI redesign UR-5; architecture spec,
// "Frontend", and Jobs v0, import): one media.import {path, clientImportId}
// per file, its job polled with job.status on the injected scheduler (one
// timer for every running job), and a placeholder per file with the file's
// name and the job's progress until the file is placed or fails.
//
// A drop on the event display (drop()) places its files once every import of
// the drop has ended, done or failed, in drop order: each file one
// command.execute (media-drop.ts: track.add when its lane is new, and
// clip.place), sent once the read model reached the job's revision, with the
// head as expectedRevision; the next waits for the read model to reach the
// revision the previous one committed. So N files are N revisions and N
// undos remove the N clips, while the media stay until further undos. Content
// the session already holds ends done with existing: true and no revision,
// and its clip is placed with the mediaId the job returns. A failed import
// removes its placeholder and raises a toast with the engine's code and the
// file name; the other files keep the lanes the drop gave them. The Media
// tab's Import (importFiles()) imports and places nothing. While `blocked`
// says a proposal is heard (the edit guard, UI redesign 4.5 C5), a drop and
// Import send nothing and a toast gives the guard's reason, and a drop whose
// imports end once heard places no clip and says so. Framework-free.

import type { Locale } from '../i18n/locale';
import { translator } from '../i18n/t';
import { GUARD_REASON } from './edit-guard';
import type { MediaEntity } from './document';
import type { Snapshot } from './read-model';
import { baseName, type DroppedFile } from './media-bridge';
import { placementCommand, type DropLane, type DropPlan } from '../timeline/media-drop';

// How often running jobs are polled.
export const POLL_MS = 100;

// What media-import needs of the session client.
export interface ImportClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  execute(commands: readonly unknown[], expectedRevision?: string): Promise<unknown>;
  readonly model: { getSnapshot(): Snapshot | null; subscribe(listener: () => void): () => void };
}

export interface ImportToasts {
  push(text: string, reword?: (locale: Locale) => string): number;
}

// A file being imported: its name, the job's progress (0 to 1, null before
// the job reports any), and, for a drop, its lane (newIndex: which of the
// drop's new tracks) and position.
export interface Placeholder {
  readonly key: string;
  readonly name: string;
  readonly progress: number | null;
  readonly lane: (DropLane & { readonly newIndex: number | null }) | null;
  readonly position: bigint | null;
}

// job.status's result of a done import.
export interface ImportResult {
  readonly mediaId: string;
  readonly revision?: string;
  readonly name?: string;
  readonly frames?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly converted?: boolean;
  readonly existing?: boolean;
  readonly [field: string]: unknown;
}

export interface MediaImporterOptions {
  readonly client: ImportClient;
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly toasts: ImportToasts;
  readonly locale: () => Locale;
  // True while the edit guard holds structural edits (a proposal is heard).
  readonly blocked?: () => boolean;
  readonly ids?: { readonly importId?: () => string; readonly trackId?: () => string; readonly clipId?: () => string };
}

interface Entry {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly lane: Placeholder['lane'];
  readonly position: bigint | null;
  progress: number | null;
  jobId: string | null;
  state: 'importing' | 'done' | 'failed';
  result: ImportResult | null;
  ended: Promise<void>;
  end: () => void;
}

const revisionNumber = (revision: string | undefined | null): number | null => {
  const match = /^r(\d+)$/.exec(revision ?? '');
  return match ? Number(match[1]) : null;
};

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'error';
};

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class MediaImporter {
  readonly #options: MediaImporterOptions;
  readonly #listeners = new Set<() => void>();
  readonly #entries: Entry[] = [];
  readonly #seen = new Map<string, { name: string; progress: number | null }>();
  readonly #results: ImportResult[] = [];
  #snapshot: readonly Placeholder[] = Object.freeze([]);
  #cancelPoll: (() => void) | null = null;
  #polling = false;

  constructor(options: MediaImporterOptions) {
    this.#options = options;
  }

  getSnapshot = (): readonly Placeholder[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // Test hooks: every placeholder shown so far (its highest progress) and every done job's result.
  seen(): ReadonlyArray<{ readonly name: string; readonly progress: number | null }> {
    return [...this.#seen.values()].map((entry) => ({ ...entry }));
  }

  results(): readonly ImportResult[] {
    return [...this.#results];
  }

  // A drop of accepted files: import each, then place them as the plan says.
  async drop(files: readonly DroppedFile[], plan: DropPlan): Promise<void> {
    if (this.#guarded()) return;
    let fresh = 0;
    const entries = files.map((file, index) => {
      const lane = plan.lanes[index] ?? { trackId: null };
      const newIndex = lane.trackId === null ? fresh++ : null;
      return this.#start(file.name, file.path, { trackId: lane.trackId, newIndex }, plan.position);
    });
    await Promise.all(entries.map((entry) => entry.ended));
    // A proposal heard by now: the media stay imported, no clip is placed.
    const placing = !this.#guarded();
    for (const entry of entries) {
      if (placing && entry.state === 'done' && entry.result) await this.#place(entry, entry.result);
      this.#remove(entry);
    }
  }

  // The Media tab's Import: each file imported, nothing placed.
  async importFiles(paths: readonly string[]): Promise<void> {
    if (this.#guarded()) return;
    const entries = paths.map((file) => this.#start(baseName(file), file, null, null));
    await Promise.all(entries.map((entry) => entry.ended));
    for (const entry of entries) this.#remove(entry);
  }

  // True, with a toast giving the edit guard's reason, while a proposal is heard.
  #guarded(): boolean {
    if (!this.#options.blocked?.()) return false;
    const text = (locale: Locale) => translator(locale)(GUARD_REASON);
    this.#options.toasts.push(text(this.#options.locale()), text);
    return true;
  }

  #start(name: string, path: string, lane: Placeholder['lane'], position: bigint | null): Entry {
    let end = () => {};
    const ended = new Promise<void>((resolve) => (end = resolve));
    const key = (this.#options.ids?.importId ?? (() => randomId('imp')))();
    const entry: Entry = { key, name, path, lane, position, progress: null, jobId: null, state: 'importing', result: null, ended, end };
    this.#entries.push(entry);
    this.#seen.set(key, { name, progress: null });
    this.#publish();
    this.#options.client.request('media.import', { path, clientImportId: key }).then(
      (answer) => {
        const jobId = (answer as { jobId?: unknown } | null)?.jobId;
        if (typeof jobId !== 'string') return this.#fail(entry, 'invalid_response');
        entry.jobId = jobId;
        this.#schedulePoll();
      },
      (error: unknown) => this.#fail(entry, codeOf(error)),
    );
    return entry;
  }

  #schedulePoll(): void {
    if (this.#cancelPoll || this.#polling) return;
    this.#cancelPoll = this.#options.schedule(() => {
      this.#cancelPoll = null;
      void this.#poll();
    }, POLL_MS);
  }

  async #poll(): Promise<void> {
    this.#polling = true;
    const running = this.#entries.filter((entry) => entry.state === 'importing' && entry.jobId !== null);
    await Promise.all(
      running.map((entry) =>
        this.#options.client.request('job.status', { jobId: entry.jobId }).then(
          (status) => this.#status(entry, status as Record<string, unknown> | null),
          (error: unknown) => this.#fail(entry, codeOf(error)),
        ),
      ),
    );
    this.#polling = false;
    if (this.#entries.some((entry) => entry.state === 'importing' && entry.jobId !== null)) this.#schedulePoll();
  }

  #status(entry: Entry, status: Record<string, unknown> | null): void {
    if (entry.state !== 'importing') return;
    const state = status?.state;
    if (state === 'done') {
      const result = status?.result as ImportResult | undefined;
      if (!result || typeof result.mediaId !== 'string') return this.#fail(entry, 'invalid_response');
      entry.state = 'done';
      entry.progress = 1;
      entry.result = result;
      this.#results.push({ ...result });
      this.#publish();
      // A dropped file counts as ended once its media.add revision reached the
      // read model (its placement reads the media there); an imported one at once.
      if (entry.lane === null) entry.end();
      else void this.#reach(result.revision).then(() => entry.end());
      return;
    }
    if (state === 'failed') {
      const error = status?.error as { code?: unknown } | undefined;
      return this.#fail(entry, typeof error?.code === 'string' ? error.code : 'error');
    }
    const progress = status?.progress as { framesDone?: unknown; framesTotal?: unknown } | undefined;
    if (progress && typeof progress.framesDone === 'string' && typeof progress.framesTotal === 'string') {
      const total = Number(progress.framesTotal);
      const done = Number(progress.framesDone);
      entry.progress = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      this.#publish();
    }
  }

  #fail(entry: Entry, code: string): void {
    if (entry.state !== 'importing') return;
    entry.state = 'failed';
    this.#toast('media.importFailed', { name: entry.name, code });
    this.#remove(entry);
    entry.end();
  }

  async #place(entry: Entry, result: ImportResult): Promise<void> {
    const { client } = this.#options;
    await this.#reach(result.revision);
    const snapshot = client.model.getSnapshot();
    if (!snapshot || entry.lane === null || entry.position === null) return;
    const media = snapshot.entities[`media:${result.mediaId}`] as MediaEntity | undefined;
    const frames = media?.frames ?? result.frames;
    if (typeof frames !== 'string') return;
    const command = placementCommand(snapshot, entry.lane, { mediaId: result.mediaId, name: media?.name ?? result.name, frames }, entry.position, {
      ...(this.#options.ids?.trackId ? { trackId: this.#options.ids.trackId } : {}),
      ...(this.#options.ids?.clipId ? { clipId: this.#options.ids.clipId } : {}),
    });
    try {
      // command.execute answers {revision: {id, ...}}: the next placement waits for that head.
      const answer = (await client.execute(command.commands, command.expectedRevision)) as { revision?: unknown } | null;
      const committed = typeof answer?.revision === 'string' ? answer.revision : (answer?.revision as { id?: unknown } | undefined)?.id;
      if (typeof committed === 'string') await this.#reach(committed);
    } catch (error) {
      this.#toast('media.placeFailed', { name: entry.name, code: codeOf(error) });
    }
  }

  // Resolves once the read model's head is at `revision` or later.
  #reach(revision: string | undefined): Promise<void> {
    const want = revisionNumber(revision);
    const model = this.#options.client.model;
    const reached = () => {
      const have = revisionNumber(model.getSnapshot()?.revision);
      return want === null || (have !== null && have >= want);
    };
    if (reached()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const off = model.subscribe(() => {
        if (!reached()) return;
        off();
        resolve();
      });
    });
  }

  #toast(key: 'media.importFailed' | 'media.placeFailed', values: { name: string; code: string }): void {
    const text = (locale: Locale) => translator(locale)(key, values);
    this.#options.toasts.push(text(this.#options.locale()), text);
  }

  #remove(entry: Entry): void {
    const at = this.#entries.indexOf(entry);
    if (at < 0) return;
    this.#entries.splice(at, 1);
    this.#publish();
  }

  #publish(): void {
    for (const entry of this.#entries) {
      const seen = this.#seen.get(entry.key);
      if (seen && entry.progress !== null && (seen.progress === null || entry.progress > seen.progress)) seen.progress = entry.progress;
    }
    this.#snapshot = Object.freeze(
      this.#entries.map((entry) => Object.freeze({ key: entry.key, name: entry.name, progress: entry.progress, lane: entry.lane, position: entry.position })),
    );
    for (const listener of [...this.#listeners]) listener();
  }
}
