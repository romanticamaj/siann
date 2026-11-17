// What the status bar shows of engine.status (UI redesign spec 2.1, "Status
// bar": device and latency, xruns; 3.0: "the status bar shows xruns, which
// engine.status has"; docs/schemas/protocol-engine-v0.md). engine.status has
// no event, so the store asks it once the client is connected and
// engine.capabilities lists the method, then every ENGINE_STATUS_POLL_MS on
// the injected scheduler. The answer is forgotten when the engine goes away
// (null: unknown), and an answer from an earlier connection is dropped.

import type { T } from '../i18n/t';
import type { SessionClient } from './session-client';

export const ENGINE_STATUS_POLL_MS = 1000;

export interface EngineDevice {
  readonly id: string;
  readonly sampleRate: number;
  readonly bufferFrames: number;
  readonly inputLatencyFrames: number;
  readonly outputLatencyFrames: number;
}

export interface EngineStatus {
  // null when no device runs; deviceError then says why.
  readonly device: EngineDevice | null;
  readonly deviceError: { readonly code: string } | null;
  // The deadline-miss count, a decimal string as the engine reports it.
  readonly xruns: string | null;
}

export interface EngineStatusSource {
  getSnapshot(): EngineStatus | null;
  subscribe(listener: () => void): () => void;
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function parseEngineStatus(value: unknown): EngineStatus | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  let device: EngineDevice | null = null;
  if (raw.device !== null && typeof raw.device === 'object') {
    const d = raw.device as Record<string, unknown>;
    const sampleRate = finite(d.sampleRate);
    if (typeof d.id === 'string' && sampleRate !== null && sampleRate > 0) {
      device = Object.freeze({
        id: d.id,
        sampleRate,
        bufferFrames: finite(d.bufferFrames) ?? 0,
        inputLatencyFrames: finite(d.inputLatencyFrames) ?? 0,
        outputLatencyFrames: finite(d.outputLatencyFrames) ?? 0,
      });
    }
  }
  const error = raw.deviceError as { code?: unknown } | null | undefined;
  const deviceError = error && typeof error.code === 'string' ? Object.freeze({ code: error.code }) : null;
  return Object.freeze({ device, deviceError, xruns: typeof raw.xruns === 'string' ? raw.xruns : null });
}

// The status bar's device segment, the mockup's "type · name · kHz / buffer
// · latency ms" (UI redesign 2.1; 10.7, 1): type and name from the device id
// <type>/<name> (the name alone, shown once, for an id without a slash), the
// sample rate in kHz, the buffer in frames, and one latency, the round trip
// (input plus output) in ms with one decimal. Without a device: the device
// error's code, or the catalog's "no device", as the name, and nothing else.
export interface StatusFields {
  readonly type: string | null;
  readonly name: string;
  readonly rate: string;
  readonly buffer: string;
  readonly latency: string;
  readonly xruns: string;
}

// 48000 -> 48, 44100 -> 44.1, 22050 -> 22.05.
const khz = (sampleRate: number) => String(Math.round(sampleRate) / 1000);

export function statusFields(status: EngineStatus | null, t: T): StatusFields {
  const device = status?.device ?? null;
  const xruns = status?.xruns ?? '';
  if (!device) return { type: null, name: status?.deviceError?.code ?? t('status.noDevice'), rate: '', buffer: '', latency: '', xruns };
  const slash = device.id.indexOf('/');
  const roundTrip = ((device.inputLatencyFrames + device.outputLatencyFrames) * 1000) / device.sampleRate;
  return {
    type: slash > 0 ? device.id.slice(0, slash) : null,
    name: slash > 0 ? device.id.slice(slash + 1) : device.id,
    rate: t('status.sampleRate', { khz: khz(device.sampleRate) }),
    buffer: String(device.bufferFrames),
    latency: t('status.latencyValue', { ms: roundTrip.toFixed(1) }),
    xruns,
  };
}

export interface EngineStatusStoreOptions {
  readonly client: SessionClient;
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly intervalMs?: number;
}

export class EngineStatusStore implements EngineStatusSource {
  readonly #client: SessionClient;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #interval: number;
  readonly #listeners = new Set<() => void>();
  readonly #off: () => void;
  #snapshot: EngineStatus | null = null;
  // The connection being polled (the client's connection count), or null.
  #polling: number | null = null;
  #timer: (() => void) | null = null;

  constructor(options: EngineStatusStoreOptions) {
    this.#client = options.client;
    this.#schedule = options.schedule;
    this.#interval = options.intervalMs ?? ENGINE_STATUS_POLL_MS;
    this.#off = this.#client.subscribe(() => this.#check());
    this.#check();
  }

  getSnapshot(): EngineStatus | null {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  destroy(): void {
    this.#off();
    this.#stop();
    this.#listeners.clear();
  }

  #pollable(): boolean {
    const state = this.#client.getState();
    const methods = state.capabilities?.methods;
    return state.status === 'connected' && Array.isArray(methods) && methods.includes('engine.status');
  }

  #check(): void {
    const state = this.#client.getState();
    if (!this.#pollable()) {
      this.#stop();
      if (state.status !== 'connected') this.#set(null);
      return;
    }
    if (this.#polling === state.connections) return;
    this.#stop();
    this.#polling = state.connections;
    this.#poll(state.connections);
  }

  #stop(): void {
    this.#polling = null;
    this.#timer?.();
    this.#timer = null;
  }

  #poll(connection: number): void {
    const current = () => this.#polling === connection;
    this.#client.request('engine.status', {}).then(
      (result) => {
        if (current()) this.#set(parseEngineStatus(result));
      },
      () => undefined,
    ).finally(() => {
      if (!current()) return;
      this.#timer = this.#schedule(() => {
        this.#timer = null;
        if (current()) this.#poll(connection);
      }, this.#interval);
    });
  }

  // An answer that reads the same keeps the snapshot and tells nobody, so a
  // poll causes no React commit (UI redesign spec 5.6).
  #set(snapshot: EngineStatus | null): void {
    if (snapshot === this.#snapshot) return;
    if (snapshot && this.#snapshot && JSON.stringify(snapshot) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener();
  }
}
