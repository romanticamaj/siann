// Studio Setup's model (m5b-ui-project; UI redesign UR-4, criterion F;
// docs/schemas/protocol-engine-v0.md, engine.devices, engine.select_device,
// engine.status). The devices come from engine.devices, each with its input
// and output channel counts (null where the engine does not know them); a
// selection is one engine.select_device {id, inputId?}. A refused selection
// keeps the engine's code for the dialog, and then, when a device was running
// before it, selects that device again: the engine.devices entry marked
// current (engine.status may name it `default`, which engine.select_device
// answers not_found) with the input engine.status names, both read before the
// selection. Nothing is sent back when no device ran. The figures the dialog
// shows (rate, buffer, latencies and whether device-side SRC is active, which
// it is when the device's rate differs from the session's) are engine.status',
// as the status bar polls it.

import type { Locale } from '../i18n/locale';
import type { T } from '../i18n/t';
import type { CapabilitySelector } from './capabilities';
import type { EngineStatus, EngineStatusSource } from './engine-status';
import { projectRefusal } from './project';

export interface AudioDevice {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly current: boolean;
  readonly inputChannels: number | null;
  readonly outputChannels: number | null;
}

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

export function parseDevices(value: unknown): AudioDevice[] {
  const list = value !== null && typeof value === 'object' ? (value as { devices?: unknown }).devices : null;
  if (!Array.isArray(list)) return [];
  const out: AudioDevice[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== 'string') continue;
    out.push(
      Object.freeze({
        id: d.id,
        type: typeof d.type === 'string' ? d.type : '',
        name: typeof d.name === 'string' ? d.name : d.id,
        isDefault: d.isDefault === true,
        current: d.current === true,
        inputChannels: count(d.inputChannels),
        outputChannels: count(d.outputChannels),
      }),
    );
  }
  return out;
}

// Studio Setup exists only where the engine lists both methods (UI redesign 3.0).
export function studioSetupAvailable(can: CapabilitySelector): boolean {
  return can.has('engine.devices') && can.has('engine.select_device');
}

export interface SetupFields {
  readonly sampleRate: string;
  readonly buffer: string;
  readonly inputLatency: string;
  readonly outputLatency: string;
  // Device-side SRC: true when the device runs at another rate than the
  // session; null when the session's rate is not known.
  readonly src: boolean | null;
}

function latency(frames: number, rate: number, t: T): string {
  return t('setup.latencyValue', { frames: String(frames), ms: ((frames * 1000) / rate).toFixed(1) });
}

// The running device's figures, or null when no device runs.
export function setupFields(status: EngineStatus | null, sessionRate: number | null, t: T): SetupFields | null {
  const device = status?.device ?? null;
  if (!device) return null;
  return {
    sampleRate: t('setup.rateValue', { hz: String(Math.round(device.sampleRate)) }),
    buffer: t('setup.bufferValue', { frames: String(device.bufferFrames) }),
    inputLatency: latency(device.inputLatencyFrames, device.sampleRate, t),
    outputLatency: latency(device.outputLatencyFrames, device.sampleRate, t),
    src: sessionRate === null ? null : device.sampleRate !== sessionRate,
  };
}

export interface StudioSetupView {
  readonly devices: readonly AudioDevice[];
  // The last refusal, "<code>: <text>"; null after a success.
  readonly error: string | null;
  readonly busy: boolean;
}

export interface StudioSetupOptions {
  readonly client: { request(method: string, params: Record<string, unknown>): Promise<unknown> };
  readonly status: EngineStatusSource;
  readonly locale: () => Locale;
}

export class StudioSetupController {
  readonly #options: StudioSetupOptions;
  readonly #listeners = new Set<() => void>();
  #view: StudioSetupView = Object.freeze({ devices: [], error: null, busy: false });

  constructor(options: StudioSetupOptions) {
    this.#options = options;
  }

  getSnapshot = (): StudioSetupView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  async load(): Promise<void> {
    try {
      this.#set({ devices: parseDevices(await this.#options.client.request('engine.devices', {})) });
    } catch (error) {
      this.#set({ error: projectRefusal(error, null, this.#options.locale()) });
    }
  }

  // Selects the output `id` and the input `inputId` (none when null).
  async select(id: string, inputId: string | null): Promise<boolean> {
    if (this.#view.busy) return false;
    const status = this.#options.status.getSnapshot();
    const ran = status?.device ?? null;
    const previous = this.#view.devices.find((device) => device.current)?.id ?? null;
    const previousInput = ran?.input?.id ?? null;
    this.#set({ busy: true });
    const request = (output: string, input: string | null) =>
      this.#options.client.request('engine.select_device', { id: output, ...(input !== null ? { inputId: input } : {}) });
    let ok = true;
    try {
      await request(id, inputId);
      this.#set({ error: null });
    } catch (error) {
      ok = false;
      this.#set({ error: projectRefusal(error, null, this.#options.locale()) });
      if (ran !== null && previous !== null) await request(previous, previousInput).catch(() => undefined);
    }
    this.#set({ busy: false });
    await this.load();
    return ok;
  }

  #set(patch: Partial<StudioSetupView>): void {
    this.#view = Object.freeze({ ...this.#view, ...patch });
    for (const listener of [...this.#listeners]) listener();
  }
}
