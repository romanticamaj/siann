// The red clip of a recording (m5b-ui-recording; UI redesign 3.5, 5.2): one
// growing clip per take while recording, from the take's startFrame (null
// until its first captured frame, so nothing is drawn during a count-in) to
// the playhead, until the document holds the committed clip clp_<takeId>.
// Its live waveform is the track's input meter (input:<trackId> in the meter
// legend) gathered from the realtime frames into columns of WAVE_FRAMES
// frames from the take's start, the loudest peak per column. The event
// display's overlay draws both at display rate, outside React.
// Framework-free.

import type { MeterFrame, MeterLegend } from './meter-frames';
import type { RecordState, RecordStateSource } from './record';

// One waveform column: 25 ms at 48 kHz.
export const WAVE_FRAMES = 1200;

export interface RecordingClip {
  readonly takeId: string;
  readonly trackId: string;
  readonly start: bigint;
  readonly end: bigint;
}

export function recordingClips(state: RecordState | null, playhead: bigint | null, committed: (clipId: string) => boolean): RecordingClip[] {
  if (!state?.recording || playhead === null) return [];
  const out: RecordingClip[] = [];
  for (const take of state.takes) {
    if (take.endedBy !== null || take.startFrame === null || !/^\d+$/.test(take.startFrame)) continue;
    if (committed(`clp_${take.takeId}`)) continue;
    const start = BigInt(take.startFrame);
    out.push({ takeId: take.takeId, trackId: take.trackId, start, end: playhead > start ? playhead : start });
  }
  return out;
}

export class LiveWaveform {
  readonly #columns = new Map<string, number[]>();

  // A realtime frame's reading of the track's input meter into the take's column.
  add(takeId: string, trackId: string, start: bigint, frame: MeterFrame, legend: MeterLegend | null): void {
    if (!legend || frame.epoch !== legend.epoch || !/^\d+$/.test(frame.playheadSamples)) return;
    const index = legend.entities.indexOf(`input:${trackId}`);
    if (index < 0) return;
    const entry = frame.entries.find((e) => e.entityIndex === index);
    if (!entry) return;
    const at = BigInt(frame.playheadSamples);
    if (at < start) return;
    const column = Number((at - start) / BigInt(WAVE_FRAMES));
    let peak = 0;
    for (const value of entry.peak) if (value > peak) peak = value;
    let columns = this.#columns.get(takeId);
    if (!columns) {
      columns = [];
      this.#columns.set(takeId, columns);
    }
    while (columns.length <= column) columns.push(0);
    if (peak > columns[column]!) columns[column] = peak;
  }

  columns(takeId: string): readonly number[] {
    return this.#columns.get(takeId) ?? [];
  }

  // Forgets every take but these.
  retain(takeIds: ReadonlySet<string>): void {
    for (const id of [...this.#columns.keys()]) if (!takeIds.has(id)) this.#columns.delete(id);
  }
}

// The read model as the feed reads it: the document's entities, and a change.
export interface RecordingModel {
  getSnapshot(): { readonly entities: Readonly<Record<string, unknown>> } | null;
  subscribe(listener: () => void): () => void;
}

export interface RecordingRealtime {
  latest(): MeterFrame | null;
  legend(): MeterLegend | null;
  subscribe(listener: () => void): () => void;
}

// What the event display's overlay draws while recording: the red clips of
// the record store at a playhead, each take's waveform fed by the realtime
// frames as they arrive (no React), and a change of the record state or of
// the document (the committed clip replaces the red one).
export class RecordingFeed {
  readonly #store: RecordStateSource;
  readonly #model: RecordingModel;
  readonly #wave = new LiveWaveform();
  readonly #offs: Array<() => void> = [];
  readonly #listeners = new Set<() => void>();
  #frame: MeterFrame | null = null;

  constructor(store: RecordStateSource, realtime: RecordingRealtime | null, model: RecordingModel) {
    this.#store = store;
    this.#model = model;
    this.#offs.push(store.subscribe(() => this.#stateChanged()));
    this.#offs.push(model.subscribe(() => this.#emit()));
    if (realtime) this.#offs.push(realtime.subscribe(() => this.#frameArrived(realtime)));
  }

  clips(playhead: bigint | null): RecordingClip[] {
    const entities = this.#model.getSnapshot()?.entities;
    return recordingClips(this.#store.getSnapshot(), playhead, (clipId) => entities?.[`clip:${clipId}`] !== undefined);
  }

  columns(takeId: string): readonly number[] {
    return this.#wave.columns(takeId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  destroy(): void {
    for (const off of this.#offs.splice(0)) off();
    this.#listeners.clear();
  }

  #stateChanged(): void {
    const takes = this.#store.getSnapshot()?.takes ?? [];
    this.#wave.retain(new Set(takes.filter((t) => t.endedBy === null).map((t) => t.takeId)));
    this.#emit();
  }

  #frameArrived(realtime: RecordingRealtime): void {
    const frame = realtime.latest();
    if (!frame || frame === this.#frame) return;
    this.#frame = frame;
    const state = this.#store.getSnapshot();
    if (!state?.recording) return;
    const legend = realtime.legend();
    for (const take of state.takes) {
      if (take.endedBy !== null || take.startFrame === null || !/^\d+$/.test(take.startFrame)) continue;
      this.#wave.add(take.takeId, take.trackId, BigInt(take.startFrame), frame, legend);
    }
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
