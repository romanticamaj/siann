// Spawns and supervises siann-engine (architecture spec, "Process model";
// Protocol v0 item 17). Stub: the tests in test/unit/supervisor.test.ts
// describe the behaviour.

import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

export const READY_SCHEMA = 'siann.engine.ready.v0';

export interface EngineReady {
  port: number;
  token: string;
  mcpToken: string;
  sessionId: string;
  pid: number;
  about: unknown;
}

export interface EngineChild extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: { end(): unknown } | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnEngine = (exe: string, args: readonly string[]) => EngineChild;
export type Schedule = (fn: () => void, ms: number) => () => void;

export interface Backoff {
  initialMs: number;
  maxMs: number;
  resetAfterMs: number;
  maxRestarts: number;
}

export const DEFAULT_BACKOFF: Backoff = Object.freeze({
  initialMs: 250,
  maxMs: 10_000,
  resetAfterMs: 30_000,
  maxRestarts: 5,
});

export interface SupervisorOptions {
  exe: string;
  args: readonly string[];
  spawn: SpawnEngine;
  schedule: Schedule;
  backoff?: Partial<Backoff>;
  stopGraceMs?: number;
  stderrLines?: number;
}

export interface EngineExit {
  code: number | null;
  signal: string | null;
  restartInMs: number | null;
}

export interface EngineGaveUp {
  code: number | null;
  signal: string | null;
  stderr: string[];
}

export function parseReadyLine(_line: string): EngineReady | null {
  return null;
}

export class EngineSupervisor extends EventEmitter {
  constructor(readonly options: SupervisorOptions) {
    super();
  }

  current(): EngineReady | null {
    return null;
  }

  pid(): number | null {
    return null;
  }

  start(): void {}

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
