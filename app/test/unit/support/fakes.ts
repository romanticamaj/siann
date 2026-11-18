// Test doubles shared by the renderer's protocol tests (the pattern of
// session-client.test.ts): a socket the test plays the engine's side of, a
// scheduler whose timers fire only when the test says so, and a bounded
// condition wait across event-loop turns. No network, no timers, no wall clock
// as synchronization.

import assert from 'node:assert/strict';

import type { ClipEntity, Entity, MediaEntity, TrackEntity } from '../../../src/renderer/model/document';
import type { Snapshot } from '../../../src/renderer/model/read-model';
import type { SocketLike } from '../../../src/renderer/model/session-client';

export type Message = Record<string, unknown> & {
  requestId?: string;
  method?: string;
  params?: Record<string, unknown>;
};

export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  binaryType = 'blob';
  readonly sent: Message[] = [];
  closedByClient = false;
  handler: ((message: Message) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    const message = JSON.parse(data) as Message;
    this.sent.push(message);
    this.handler?.(message);
  }
  close(): void {
    this.closedByClient = true;
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  deliverBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
  serverClose(): void {
    this.onclose?.();
  }
  requests(method: string): Message[] {
    return this.sent.filter((m) => m.method === method);
  }
}

export interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

export class FakeScheduler {
  readonly timers: Timer[] = [];
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer: Timer = { fn, ms, cancelled: false, fired: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  pending(): Timer[] {
    return this.timers.filter((t) => !t.cancelled && !t.fired);
  }
  fire(ms: number): void {
    const matching = this.pending().filter((t) => t.ms === ms);
    assert.equal(matching.length, 1, `one pending ${ms} ms timer`);
    matching[0]!.fired = true;
    matching[0]!.fn();
  }
}

// Polls a condition across event-loop turns (WebCrypto digests finish on the
// thread pool): gives up only after 2000 turns and 10 s.
export async function until(condition: () => boolean, what: string): Promise<void> {
  const start = performance.now();
  for (let i = 0; i < 2000 || performance.now() - start < 10_000; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---- a session client for the media import (m5b-ui-media): the engine's side
// of media.import, job.status and command.execute, scripted by the test, over
// a snapshot the test commits to (the read model follows session.changed).

export interface FakeJob {
  readonly jobId: string;
  readonly path: string;
  readonly clientImportId: string;
  // What the next job.status answers; the test sets it.
  status: Record<string, unknown>;
}

export class FakeSessionClient {
  readonly sent: Array<{ method: string; params: Record<string, unknown>; expectedRevision?: string }> = [];
  readonly jobs: FakeJob[] = [];
  readonly #listeners = new Set<() => void>();
  #snapshot: Snapshot;
  // command.execute's answer: by default it commits the commands as the next revision.
  executeAnswer: ((commands: readonly Record<string, unknown>[]) => unknown) | null = null;
  readonly model = {
    getSnapshot: (): Snapshot => this.#snapshot,
    subscribe: (listener: () => void): (() => void) => {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    },
  };

  constructor(snapshot: Snapshot) {
    this.#snapshot = snapshot;
  }

  requests(method: string) {
    return this.sent.filter((m) => m.method === method);
  }

  // The read model reaches a new revision: `change` gives the next snapshot.
  commit(change: (snapshot: Snapshot) => Snapshot): void {
    this.#snapshot = change(this.#snapshot);
    for (const listener of [...this.#listeners]) listener();
  }

  request(method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    this.sent.push({ method, params, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
    if (method === 'media.import') {
      const job: FakeJob = { jobId: `job_${this.jobs.length + 1}`, path: String(params.path), clientImportId: String(params.clientImportId), status: { state: 'queued' } };
      this.jobs.push(job);
      return Promise.resolve({ jobId: job.jobId, kind: 'media.import', state: 'queued' });
    }
    if (method === 'job.status') {
      const job = this.jobs.find((j) => j.jobId === params.jobId);
      if (!job) return Promise.reject(new Error('not_found'));
      return Promise.resolve({ jobId: job.jobId, kind: 'media.import', ...job.status });
    }
    if (method === 'command.execute') {
      const commands = params.commands as Record<string, unknown>[];
      if (this.executeAnswer) {
        const answer = this.executeAnswer(commands);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }
      const revision = `r${Number(this.#snapshot.revision.slice(1)) + 1}`;
      queueMicrotask(() => this.commit((s) => applyCommands(s, commands, revision)));
      return Promise.resolve({ revision: { id: revision } });
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  }

  execute(commands: readonly unknown[], expectedRevision?: string): Promise<unknown> {
    return this.request('command.execute', { commands }, expectedRevision);
  }
}

// track.add and clip.place applied to a snapshot as the engine commits them.
export function applyCommands(snapshot: Snapshot, commands: readonly Record<string, unknown>[], revision: string): Snapshot {
  const entities: Record<string, Entity> = { ...snapshot.entities };
  const tracks: TrackEntity[] = [...snapshot.tracks];
  const clips: ClipEntity[] = [...snapshot.clips];
  let trackOrder = [...snapshot.trackOrder];
  for (const c of commands) {
    if (c.op === 'track.add') {
      const t = { schema: 'siann.entity.track.v1', id: c.trackId, name: c.name, kind: 'audio', channels: c.channels, gainMilliDb: 0, pan: 0, mute: false, solo: false } as unknown as TrackEntity;
      entities[`track:${t.id}`] = t;
      tracks.push(t);
      trackOrder = [...trackOrder, t.id];
    }
    if (c.op === 'clip.place') {
      const clip = { schema: 'siann.entity.clip.v1', id: c.clipId, trackId: c.trackId, mediaId: c.mediaId, position: c.position, sourceStart: c.sourceStart, length: c.length, gainMilliDb: 0 } as unknown as ClipEntity;
      entities[`clip:${clip.id}`] = clip;
      clips.push(clip);
    }
  }
  return Object.freeze({ ...snapshot, revision, entities, tracks, clips, trackOrder });
}

// media.add as an import job commits it.
export function addMedia(snapshot: Snapshot, media: MediaEntity, revision: string): Snapshot {
  return Object.freeze({ ...snapshot, revision, entities: { ...snapshot.entities, [`media:${media.id}`]: media }, media: [...snapshot.media, media] });
}
