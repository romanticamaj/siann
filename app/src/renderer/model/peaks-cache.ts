// The renderer's peak pyramids, keyed by media contentHash
// (docs/schemas/protocol-peaks-v0.md, spec Protocol v0 item 23). get() starts
// one GET /v0/peaks/<hex> per hash with the UI token and answers null until
// the pyramid is decoded; a 202 peaks_pending or a network failure (an engine
// restarting) is retried under the session client's sync backoff
// (SYNC_RETRY_MS doubling up to SYNC_RETRY_MAX_MS); any other answer is a
// failure with its code and is not retried. Pyramids are content-addressed,
// so a decoded one stays across engines.
//
// Framework-free: fetch, the endpoint source and the scheduler are injected.

import { PeaksError, decodePeaks, type PeakPyramid } from './peaks';
import { SYNC_RETRY_MAX_MS, SYNC_RETRY_MS, type EngineEndpoint } from './session-client';

export interface FetchResponseLike {
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponseLike>;

export interface PeaksCacheOptions {
  fetch: FetchLike;
  endpoint: () => EngineEndpoint | null;
  schedule: (fn: () => void, ms: number) => () => void;
  retryMs?: number;
}

export type PeaksState = 'absent' | 'pending' | 'ready' | 'failed';

interface Entry {
  state: PeaksState;
  pyramid: PeakPyramid | null;
  error: string | null;
  // Failures (202 or network) since the last request that settled otherwise.
  attempts: number;
  inFlight: boolean;
  retry: (() => void) | null;
}

const HASH_RE = /^sha256:([0-9a-f]{64})$/;

export class PeaksCache {
  readonly #options: PeaksCacheOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();

  constructor(options: PeaksCacheOptions) {
    this.#options = options;
  }

  // The decoded pyramid, or null while it is fetched (or failed).
  get(contentHash: string): PeakPyramid | null {
    let entry = this.#entries.get(contentHash);
    if (!entry) {
      entry = { state: 'pending', pyramid: null, error: null, attempts: 0, inFlight: false, retry: null };
      this.#entries.set(contentHash, entry);
      if (!HASH_RE.test(contentHash)) {
        entry.state = 'failed';
        entry.error = 'invalid_hash';
      } else {
        this.#request(contentHash, entry);
      }
    }
    return entry.pyramid;
  }

  state(contentHash: string): PeaksState {
    return this.#entries.get(contentHash)?.state ?? 'absent';
  }

  error(contentHash: string): string | null {
    return this.#entries.get(contentHash)?.error ?? null;
  }

  // The shell announced another engine (or one at all): what is still
  // pending asks it now, from the first backoff step.
  endpointChanged(): void {
    for (const [hash, entry] of this.#entries) {
      if (entry.state !== 'pending' || entry.inFlight) continue;
      if (entry.retry) {
        entry.retry();
        entry.retry = null;
      }
      entry.attempts = 0;
      this.#request(hash, entry);
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #request(contentHash: string, entry: Entry): void {
    const endpoint = this.#options.endpoint();
    if (!endpoint) return; // asked again on endpointChanged()
    const hex = HASH_RE.exec(contentHash)![1]!;
    entry.inFlight = true;
    this.#options
      .fetch(`http://127.0.0.1:${endpoint.port}/v0/peaks/${hex}`, { headers: { Authorization: `Bearer ${endpoint.token}` } })
      .then(async (response) => {
        if (response.status === 200) {
          const pyramid = decodePeaks(await response.arrayBuffer());
          this.#settle(entry, { state: 'ready', pyramid, error: null });
          return;
        }
        if (response.status === 202) {
          this.#retryLater(contentHash, entry);
          return;
        }
        let code = `http_${response.status}`;
        try {
          const body = (await response.json()) as { error?: { code?: unknown } };
          if (typeof body?.error?.code === 'string') code = body.error.code;
        } catch {
          // keep the status as the code
        }
        this.#settle(entry, { state: 'failed', pyramid: null, error: code });
      })
      .catch((error: unknown) => {
        if (error instanceof PeaksError) {
          this.#settle(entry, { state: 'failed', pyramid: null, error: error.code });
        } else {
          this.#retryLater(contentHash, entry);
        }
      });
  }

  #retryLater(contentHash: string, entry: Entry): void {
    entry.inFlight = false;
    const first = this.#options.retryMs ?? SYNC_RETRY_MS;
    const delay = Math.min(first * 2 ** entry.attempts, SYNC_RETRY_MAX_MS);
    entry.attempts += 1;
    entry.retry = this.#options.schedule(() => {
      entry.retry = null;
      if (entry.state === 'pending') this.#request(contentHash, entry);
    }, delay);
  }

  #settle(entry: Entry, outcome: Pick<Entry, 'state' | 'pyramid' | 'error'>): void {
    entry.inFlight = false;
    entry.attempts = 0;
    entry.state = outcome.state;
    entry.pyramid = outcome.pyramid;
    entry.error = outcome.error;
    for (const listener of [...this.#listeners]) listener();
  }
}
