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
        inputLatencyFrames: finite(d.inputLatencyFrames) ?? 0,
        outputLatencyFrames: finite(d.outputLatencyFrames) ?? 0,
      });
    }
  }
  const error = raw.deviceError as { code?: unknown } | null | undefined;
  const deviceError = error && typeof error.code === 'string' ? Object.freeze({ code: error.code }) : null;
  return Object.freeze({ device, deviceError, xruns: typeof raw.xruns === 'string' ? raw.xruns : null });
}

export interface StatusFields {
  readonly device: string;
  readonly latency: string;
  readonly xruns: string;
}

const ms = (frames: number, sampleRate: number) => ((frames * 1000) / sampleRate).toFixed(1);

// The bar's words for an answer: the device id (or the device error's code,
// or none), input and output latency in ms, and the xruns as reported.
export function statusFields(status: EngineStatus | null, t: T): StatusFields {
  const device = status?.device ?? null;
  return {
    device: device ? device.id : (status?.deviceError?.code ?? t('status.noDevice')),
    latency: device
      ? t('status.latencyValue', {
          input: ms(device.inputLatencyFrames, device.sampleRate),
          output: ms(device.outputLatencyFrames, device.sampleRate),
        })
      : '',
    xruns: status?.xruns ?? '',
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

  #set(snapshot: EngineStatus | null): void {
    if (snapshot === this.#snapshot) return;
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener();
  }
}
