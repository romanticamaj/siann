// Recording over the session client (m5b-ui-recording; UI redesign 3.1, 3.3,
// 3.5; 10.11, 16 to 21; docs/schemas/protocol-engine-v0.md, "Recording" and
// "Monitoring"; protocol-events-v1.md, "record.changed").
//
// - RecordStore holds the record state the engine says: `recording`, the
//   armed track ids and the takes of the current (or last) recording. It is
//   read from engine.status after each auth and each session.sync (a gap's
//   sync covers events the client never hands over), then kept by
//   record.changed (published to every connection, whoever armed) and by the
//   result of each transport and record method. An engine.status asked
//   before a newer event or result is dropped; a result without takes keeps
//   the takes. Null while the engine is away. An early end of a take (endedBy
//   overflow, disk or device) is reported once (onEarlyEnd).
// - RecordController sends what a button or a key asks: one record.arm per
//   toggle, one transport.record per Record (on while stopped, off while
//   recording), one command.execute of track.set_input or track.set_monitor
//   per choice, record.recover_take for Keep and Discard. Nothing is
//   optimistic. It says why a control is disabled (armBlock, recordBlock,
//   inputBlock) and sends nothing then; a refusal becomes one toast.
// - bindRecordCommands registers R (the selected track, project zone) and Num *
//   / Ctrl+Shift+R (window); each declines when it would send nothing.
// Framework-free.

import { refusalLine } from '../i18n/errors';
import type { Locale } from '../i18n/locale';
import type { T } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { CapabilitySelector } from './capabilities';
import type { TrackEntity } from './document';
import type { EngineStatusSource } from './engine-status';
import { inputAvailable, inputCommand, sameInput, type InputPort } from './input-ports';
import type { PendingTake } from './pending-takes';
import type { Snapshot } from './read-model';
import type { EventMessage, SessionClient } from './session-client';

export interface Take {
  readonly takeId: string;
  readonly trackId: string;
  // The timeline frame it lands on (a decimal string), null until its first captured frame.
  readonly startFrame: string | null;
  readonly durableFrames: string;
  // Present once the recording ended: stop, overflow, disk or device.
  readonly endedBy: string | null;
  readonly overflows: string | null;
}

export interface RecordState {
  readonly recording: boolean;
  readonly armed: readonly string[];
  readonly takes: readonly Take[];
}

export const EARLY_ENDS: readonly string[] = ['overflow', 'disk', 'device'];

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parseTakes(value: unknown): Take[] | null {
  if (!Array.isArray(value)) return null;
  const out: Take[] = [];
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.takeId !== 'string' || typeof r.trackId !== 'string') continue;
    out.push(
      Object.freeze({
        takeId: r.takeId,
        trackId: r.trackId,
        startFrame: text(r.startFrame),
        durableFrames: text(r.durableFrames) ?? '0',
        endedBy: text(r.endedBy),
        overflows: text(r.overflows),
      }),
    );
  }
  return out;
}

// {recording, armed, takes} out of record.arm's result, record.changed, a
// transport method's result or engine.status; takes is null where the
// answer has none (a transport result, engine.status). Null without both
// `recording` and `armed`.
export function parseRecordState(value: unknown): { readonly recording: boolean; readonly armed: readonly string[]; readonly takes: readonly Take[] | null } | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.recording !== 'boolean' || !Array.isArray(raw.armed) || !raw.armed.every((id) => typeof id === 'string')) return null;
  return { recording: raw.recording, armed: [...(raw.armed as string[])], takes: parseTakes(raw.takes) };
}

export interface RecordStateSource {
  getSnapshot(): RecordState | null;
  subscribe(listener: () => void): () => void;
}

type StoreClient = Pick<SessionClient, 'request' | 'subscribe' | 'getState' | 'onEvent'>;

export interface RecordStoreOptions {
  // A take ended early (endedBy overflow, disk or device), once per take.
  readonly onEarlyEnd?: (take: Take) => void;
}

const sameState = (a: RecordState, b: RecordState) => JSON.stringify(a) === JSON.stringify(b);

export class RecordStore implements RecordStateSource {
  readonly #client: StoreClient;
  readonly #options: RecordStoreOptions;
  readonly #listeners = new Set<() => void>();
  readonly #offs: Array<() => void> = [];
  readonly #reported = new Set<string>();
  #snapshot: RecordState | null = null;
  #version = 0;
  #read: string | null = null;

  constructor(client: StoreClient, options: RecordStoreOptions = {}) {
    this.#client = client;
    this.#options = options;
    this.#offs.push(client.subscribe(() => this.#check()));
    this.#offs.push(client.onEvent('record.changed', (event: EventMessage) => this.apply(event)));
    this.#check();
  }

  getSnapshot(): RecordState | null {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // A method's result or an event: the engine's record state now.
  apply(value: unknown): void {
    const next = parseRecordState(value);
    if (!next) return;
    this.#version += 1;
    this.#set(next);
  }

  destroy(): void {
    for (const off of this.#offs.splice(0)) off();
    this.#listeners.clear();
  }

  #check(): void {
    const state = this.#client.getState();
    if (state.status !== 'connected') {
      this.#read = null;
      this.#set(null);
      return;
    }
    const methods = state.capabilities?.methods;
    if (!Array.isArray(methods) || !methods.includes('engine.status')) return;
    const key = `${state.connections}:${state.syncCount}`;
    if (key === this.#read) return;
    const connection = this.#read === null || this.#read.split(':')[0] !== String(state.connections);
    this.#read = key;
    if (connection) this.#set(null);
    const asked = this.#version;
    this.#client.request('engine.status', {}).then(
      (result) => {
        if (this.#read === key && this.#version === asked) this.#set(parseRecordState(result));
      },
      () => undefined,
    );
  }

  #set(next: ReturnType<typeof parseRecordState>): void {
    const merged: RecordState | null = next ? Object.freeze({ recording: next.recording, armed: Object.freeze([...next.armed]), takes: Object.freeze(next.takes ?? this.#snapshot?.takes ?? []) }) : null;
    if (merged === this.#snapshot || (merged && this.#snapshot && sameState(merged, this.#snapshot))) return;
    this.#snapshot = merged;
    if (merged) {
      for (const take of merged.takes) {
        if (take.endedBy === null || !EARLY_ENDS.includes(take.endedBy) || this.#reported.has(take.takeId)) continue;
        this.#reported.add(take.takeId);
        this.#options.onEarlyEnd?.(take);
      }
    }
    for (const listener of [...this.#listeners]) listener();
  }
}

// The toast of an early end: the track and the reason.
export function earlyEndLine(take: Take, trackName: string, t: T): string {
  const key = take.endedBy === 'overflow' ? 'record.ended.overflow' : take.endedBy === 'disk' ? 'record.ended.disk' : 'record.ended.device';
  return t(key, { track: trackName, frames: take.overflows ?? '0' });
}

// The meter a slot of `ref` reads: an armed track's input while the legend has it.
export function armedMeterRef(ref: string, armed: readonly string[], has: (ref: string) => boolean): string {
  if (!ref.startsWith('track:')) return ref;
  const id = ref.slice('track:'.length);
  return armed.includes(id) && has(`input:${id}`) ? `input:${id}` : ref;
}

export type MonitorMode = 'off' | 'auto' | 'input';

export function monitorOf(track: Pick<TrackEntity, 'monitor'> | null | undefined): MonitorMode {
  return track?.monitor === 'auto' || track?.monitor === 'input' ? track.monitor : 'off';
}

// A click on the monitor button: off to input, input or auto to off (10.11, 16).
export function nextMonitor(mode: MonitorMode): MonitorMode {
  return mode === 'off' ? 'input' : 'off';
}

export interface RecordGates {
  // Record enable and Record.
  readonly record: boolean;
  readonly monitor: boolean;
  readonly input: boolean;
}

// What the controls need of engine.capabilities (UI redesign 3.0).
export function recordGates(can: CapabilitySelector): RecordGates {
  const recording = can.feature('recording');
  return {
    record: recording && can.has('record.arm') && can.has('transport.record'),
    monitor: can.feature('monitoring') && can.command('track.set_monitor'),
    input: recording && can.command('track.set_input'),
  };
}

export type ArmBlock = 'disconnected' | 'noDevice' | 'noInput' | 'noTrackInput' | 'inputUnavailable' | 'recording';
export type RecordBlock = 'disconnected' | 'noDevice' | 'noInput' | 'nothingArmed';
export type InputBlock = 'recording';

export interface RecordToasts {
  push(text: string, reword?: (locale: Locale) => string): number;
}

export interface RecordControllerOptions {
  readonly client: Pick<SessionClient, 'request' | 'execute' | 'getState' | 'subscribe'>;
  readonly model: { getSnapshot(): Snapshot | null };
  readonly store: RecordStore;
  readonly status: EngineStatusSource;
  readonly capabilities: () => CapabilitySelector;
  readonly toasts: RecordToasts;
  readonly locale: () => Locale;
  // A transport method's result, for the transport state (cycle, click, punch ...).
  readonly onTransportResult?: (result: unknown) => void;
}

export class RecordController {
  readonly #options: RecordControllerOptions;
  readonly #decided = new Set<string>();
  readonly #pendingListeners = new Set<() => void>();

  constructor(options: RecordControllerOptions) {
    this.#options = options;
  }

  get store(): RecordStore {
    return this.#options.store;
  }

  get status(): EngineStatusSource {
    return this.#options.status;
  }

  gates(): RecordGates {
    return recordGates(this.#options.capabilities());
  }

  // Anything the blocks read changed: the record state, engine.status or the connection.
  subscribe(listener: () => void): () => void {
    const offs = [this.store.subscribe(listener), this.status.subscribe(listener), this.#options.client.subscribe(listener)];
    return () => offs.forEach((off) => off());
  }

  recording(): boolean {
    return this.store.getSnapshot()?.recording === true;
  }

  isArmed(trackId: string): boolean {
    return this.store.getSnapshot()?.armed.includes(trackId) === true;
  }

  // The open input's channels, or null without an input (or a device).
  openChannels(): number | null {
    const input = this.status.getSnapshot()?.device?.input ?? null;
    return input ? input.channels : null;
  }

  #track(trackId: string): TrackEntity | null {
    const entity = this.#options.model.getSnapshot()?.entities[`track:${trackId}`] as TrackEntity | undefined;
    return entity?.schema === 'siann.entity.track.v1' ? entity : null;
  }

  #deviceBlock(): 'disconnected' | 'noDevice' | 'noInput' | null {
    if (this.#options.client.getState().status !== 'connected') return 'disconnected';
    const status = this.status.getSnapshot();
    if (status && !status.device) return 'noDevice';
    if (status && !status.device?.input) return 'noInput';
    return null;
  }

  // Why record enable cannot toggle now, or null.
  armBlock(trackId: string): ArmBlock | null {
    const device = this.#deviceBlock();
    if (device) return device;
    if (this.recording()) return 'recording';
    if (this.isArmed(trackId)) return null;
    const track = this.#track(trackId);
    if (!track?.input) return 'noTrackInput';
    const open = this.openChannels();
    if (open !== null && !inputAvailable(track.input, open)) return 'inputUnavailable';
    return null;
  }

  // Why Record cannot start now, or null (stopping is never blocked while connected).
  recordBlock(): RecordBlock | null {
    if (this.#options.client.getState().status !== 'connected') return 'disconnected';
    if (this.recording()) return null;
    const device = this.#deviceBlock();
    if (device) return device;
    if ((this.store.getSnapshot()?.armed.length ?? 0) === 0) return 'nothingArmed';
    return null;
  }

  // Why the input cannot change now (a track being recorded keeps it: track_recording).
  inputBlock(trackId: string): InputBlock | null {
    const state = this.store.getSnapshot();
    if (state?.recording && (state.armed.includes(trackId) || state.takes.some((t) => t.trackId === trackId && t.endedBy === null))) return 'recording';
    return null;
  }

  toggleArm(trackId: string): boolean {
    if (!this.gates().record || this.armBlock(trackId) !== null) return false;
    void this.#request('record.arm', { trackId, armed: !this.isArmed(trackId) }, (result) => this.store.apply(result));
    return true;
  }

  toggleRecord(): boolean {
    if (!this.gates().record || this.recordBlock() !== null) return false;
    void this.#request('transport.record', { enabled: !this.recording() }, (result) => {
      this.store.apply(result);
      this.#options.onTransportResult?.(result);
    });
    return true;
  }

  setInput(trackId: string, input: InputPort | null): boolean {
    if (!this.gates().input || this.inputBlock(trackId) !== null) return false;
    const track = this.#track(trackId);
    if (!track || sameInput(track.input, input)) return false;
    void this.#execute([inputCommand(trackId, input)]);
    return true;
  }

  toggleMonitor(trackId: string): boolean {
    if (!this.gates().monitor) return false;
    const track = this.#track(trackId);
    if (!track) return false;
    void this.#execute([{ op: 'track.set_monitor', trackId, monitor: nextMonitor(monitorOf(track)) }]);
    return true;
  }

  // The pending takes not yet decided here and not being recorded.
  pendingTakes(): readonly PendingTake[] {
    const live = new Set((this.store.getSnapshot()?.takes ?? []).filter((t) => t.endedBy === null).map((t) => t.takeId));
    return (this.#options.client.getState().pendingTakes ?? []).filter((take) => !this.#decided.has(take.takeId) && !live.has(take.takeId));
  }

  subscribePending(listener: () => void): () => void {
    this.#pendingListeners.add(listener);
    const offs = [this.#options.client.subscribe(listener), this.store.subscribe(listener)];
    return () => {
      this.#pendingListeners.delete(listener);
      for (const off of offs) off();
    };
  }

  // Keep (accept) or Discard a pending take; resolves true when the engine took it.
  async recoverTake(takeId: string, accept: boolean): Promise<boolean> {
    const ok = await this.#request('record.recover_take', { takeId, accept });
    if (ok) {
      this.#decided.add(takeId);
      for (const listener of [...this.#pendingListeners]) listener();
    }
    return ok;
  }

  async #request(method: string, params: Record<string, unknown>, onResult?: (result: unknown) => void): Promise<boolean> {
    try {
      const result = await this.#options.client.request(method, params);
      onResult?.(result);
      return true;
    } catch (error) {
      this.#refused(error);
      return false;
    }
  }

  async #execute(commands: readonly unknown[]): Promise<boolean> {
    try {
      await this.#options.client.execute(commands);
      return true;
    } catch (error) {
      this.#refused(error);
      return false;
    }
  }

  #refused(error: unknown): void {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    const known = typeof code === 'string' ? code : null;
    this.#options.toasts.push(refusalLine(known, message, this.#options.locale()), (locale) => refusalLine(known, message, locale));
  }
}

export interface RecordBindings {
  // The primary selected track, or null.
  readonly selectedTrack: () => string | null;
}

export function bindRecordCommands(commands: CommandRegistry, controller: RecordController, bindings: RecordBindings): () => void {
  const offs = [
    commands.register('project', 'track.recordEnable', () => {
      const id = bindings.selectedTrack();
      return id !== null && controller.toggleArm(id);
    }),
    commands.register('window', 'transport.record', () => controller.toggleRecord()),
  ];
  return () => offs.forEach((off) => off());
}
