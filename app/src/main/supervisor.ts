// Spawns and supervises siann-engine (architecture spec, "Process model":
// crash-loop backoff; Protocol v0 item 17: the launcher handshake).
//
// The engine writes exactly one line to stdout once it is listening, the
// ready line. The supervisor parses it strictly and emits `ready`; anything
// else on stdout (a malformed first line, a second line) is a failed launch:
// the child is killed and restarted, so a half-parsed token never reaches the
// renderer. Every exit not asked for by stop() schedules a restart after a
// delay that doubles from initialMs up to maxMs; the count resets once an
// engine has stayed up resetAfterMs after its ready line; after maxRestarts
// consecutive restarts the next failure emits `gave-up`. stop() closes the
// child's stdin (the engine exits on EOF), kills it when a grace timer
// expires, and never restarts.
//
// Process creation and timers are injected (spawn, schedule), so the unit
// tests drive every path without real processes or wall-clock waits.

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

// What the supervisor needs of a child process (node:child_process's
// ChildProcess satisfies it).
export interface EngineChild extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: { end(): unknown } | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnEngine = (exe: string, args: readonly string[]) => EngineChild;
// Runs fn after ms; the returned function cancels it.
export type Schedule = (fn: () => void, ms: number) => () => void;

export interface Backoff {
  initialMs: number;
  maxMs: number;
  resetAfterMs: number;
  maxRestarts: number;
}

// The shell constants (spec, "Process model").
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
  // How long stop() waits after closing stdin before it kills the child.
  stopGraceMs?: number;
  // stderr lines kept for `gave-up`.
  stderrLines?: number;
}

export interface EngineExit {
  code: number | null;
  signal: string | null;
  // The delay before the next launch; null when there is none (stop() or
  // gave-up).
  restartInMs: number | null;
}

export interface EngineGaveUp {
  code: number | null;
  signal: string | null;
  stderr: string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const SESSION_ID = /^ses_[0-9a-f]+$/;

// The ready line, strictly: null unless every field has its documented shape.
export function parseReadyLine(line: string): EngineReady | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const { port, token, mcpToken, sessionId, pid, about } = v;
  if (v.schema !== READY_SCHEMA) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (typeof token !== 'string' || !HEX64.test(token)) return null;
  if (typeof mcpToken !== 'string' || !HEX64.test(mcpToken) || mcpToken === token) return null;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof about !== 'object' || about === null) return null;
  return { port, token, mcpToken, sessionId, pid, about };
}

interface Launch {
  child: EngineChild;
  stdout: string;
  ready: EngineReady | null;
  failed: boolean;
  exited: boolean;
  stderr: string[];
  stderrPartial: string;
}

export class EngineSupervisor extends EventEmitter {
  private readonly options: SupervisorOptions;
  private readonly backoff: Backoff;
  private launch: Launch | null = null;
  private failures = 0;
  private stopping = false;
  private started = false;
  private cancelRestart: (() => void) | null = null;
  private cancelReset: (() => void) | null = null;
  private cancelGrace: (() => void) | null = null;
  private stopWaiters: Array<() => void> = [];

  constructor(options: SupervisorOptions) {
    super();
    this.options = options;
    this.backoff = { ...DEFAULT_BACKOFF, ...(options.backoff ?? {}) };
  }

  // The running engine's ready line, or null between launches.
  current(): EngineReady | null {
    return this.launch?.ready ?? null;
  }

  // The running engine's pid once it is ready.
  pid(): number | null {
    return this.current()?.pid ?? null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.spawnEngine();
  }

  // Ends the engine: closes its stdin, kills it after the grace period, and
  // resolves once it has exited. Never restarts afterwards.
  stop(): Promise<void> {
    this.stopping = true;
    this.cancel('restart');
    this.cancel('reset');
    const launch = this.launch;
    if (launch === null || launch.exited) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    if (this.cancelGrace === null) {
      try {
        launch.child.stdin?.end();
      } catch {
        // A closed pipe: the child is on its way out anyway.
      }
      this.cancelGrace = this.options.schedule(() => {
        this.cancelGrace = null;
        if (!launch.exited) launch.child.kill();
      }, this.options.stopGraceMs ?? 5_000);
    }
    return done;
  }

  private cancel(which: 'restart' | 'reset' | 'grace'): void {
    const key = which === 'restart' ? 'cancelRestart' : which === 'reset' ? 'cancelReset' : 'cancelGrace';
    const fn = this[key];
    this[key] = null;
    if (fn) fn();
  }

  private spawnEngine(): void {
    this.cancelRestart = null;
    let child: EngineChild;
    try {
      child = this.options.spawn(this.options.exe, this.options.args);
    } catch (error) {
      // Treated like a launch that exited at once.
      const launch: Launch = this.newLaunch(new EventEmitter() as unknown as EngineChild);
      launch.stderr.push(String(error));
      this.launch = launch;
      this.onExit(launch, null, null);
      return;
    }
    const launch = this.newLaunch(child);
    this.launch = launch;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(launch, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.onStderr(launch, chunk));
    child.on('exit', (code: number | null, signal: string | null) => this.onExit(launch, code, signal));
    // A spawn failure (ENOENT): no 'exit' follows.
    child.on('error', (error: unknown) => {
      launch.stderr.push(String(error));
      this.onExit(launch, null, null);
    });
  }

  private newLaunch(child: EngineChild): Launch {
    return { child, stdout: '', ready: null, failed: false, exited: false, stderr: [], stderrPartial: '' };
  }

  private failLaunch(launch: Launch, reason: string): void {
    if (launch.failed || launch.exited) return;
    launch.failed = true;
    launch.ready = null;
    launch.stderr.push(`siann-shell: ${reason}`);
    this.emit('protocol-error', reason);
    launch.child.kill();
  }

  private onStdout(launch: Launch, chunk: string): void {
    if (launch.failed || launch.exited) return;
    if (launch.ready !== null) {
      // Nothing may follow the ready line on stdout.
      if (chunk.length > 0) this.failLaunch(launch, 'unexpected output after the ready line');
      return;
    }
    launch.stdout += chunk;
    const end = launch.stdout.indexOf('\n');
    if (end < 0) return;
    const line = launch.stdout.slice(0, end).replace(/\r$/, '');
    const rest = launch.stdout.slice(end + 1);
    launch.stdout = '';
    const ready = parseReadyLine(line);
    if (ready === null) {
      this.failLaunch(launch, 'malformed ready line');
      return;
    }
    if (rest.length > 0) {
      this.failLaunch(launch, 'unexpected output after the ready line');
      return;
    }
    launch.ready = ready;
    if (this.stopping) return;
    this.cancel('reset');
    this.cancelReset = this.options.schedule(() => {
      this.cancelReset = null;
      this.failures = 0;
    }, this.backoff.resetAfterMs);
    this.emit('ready', ready);
  }

  private onStderr(launch: Launch, chunk: string): void {
    const text = launch.stderrPartial + chunk;
    const lines = text.split(/\r?\n/);
    launch.stderrPartial = lines.pop() ?? '';
    launch.stderr.push(...lines.filter((l) => l.length > 0));
    const keep = this.options.stderrLines ?? 20;
    if (launch.stderr.length > keep) launch.stderr.splice(0, launch.stderr.length - keep);
  }

  private onExit(launch: Launch, code: number | null, signal: string | null): void {
    if (launch.exited) return;
    launch.exited = true;
    launch.ready = null;
    if (launch.stderrPartial.length > 0) {
      launch.stderr.push(launch.stderrPartial);
      launch.stderrPartial = '';
    }
    if (this.launch !== launch) return;
    this.cancel('reset');
    if (this.stopping) {
      this.cancel('grace');
      this.emit('exit', { code, signal, restartInMs: null } satisfies EngineExit);
      const waiters = this.stopWaiters;
      this.stopWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.failures += 1;
    if (this.failures > this.backoff.maxRestarts) {
      this.emit('exit', { code, signal, restartInMs: null } satisfies EngineExit);
      this.emit('gave-up', { code, signal, stderr: [...launch.stderr] } satisfies EngineGaveUp);
      return;
    }
    const delay = Math.min(this.backoff.initialMs * 2 ** (this.failures - 1), this.backoff.maxMs);
    this.emit('exit', { code, signal, restartInMs: delay } satisfies EngineExit);
    this.cancelRestart = this.options.schedule(() => this.spawnEngine(), delay);
  }
}
