// The renderer's realtime channel client (docs/schemas/protocol-events-v1.md,
// "Realtime channel"): meters and the playhead on their own WebSocket,
// /v1/realtime, so they never queue behind commands or events. It opens beside
// the SessionClient's command socket (same port and token), authenticates with
// the first text frame, decodes each binary frame with the legend the
// SessionClient holds, and keeps the newest frame and the newest reading per
// entity (latest wins; nothing is queued). A frame of an epoch other than the
// legend's is not metered. Its playhead is the transport's, not the graph's:
// playhead() is the newest frame of any epoch and outlives a new legend, so
// the project cursor stays known through the graph publication every edit
// brings (the legend event and the first frame of its epoch arrive on two
// sockets, in either order); only a disconnect drops it. It closes when the
// command socket closes and opens again when the command socket has
// reconnected.
//
// The same socket carries the master's loudness (m5b-ui-meter; "Loudness
// frame"): a SLUD frame follows each SMTR frame, and the client tells them
// apart by the magic. A loudness frame goes to the client's LoudnessStore and
// its loudness listeners, and is no meter frame; the store reads minus
// infinity again when the channel closes.
//
// Framework-free: the meter surfaces read latest() and meter() from their own
// animation frame (ADR-0019 point 3: no meter value passes through React state),
// the project cursor and the transport read playhead(); subscribe() is for
// plain listeners.

import { decodeLoudnessFrame, frameKind } from './loudness-frames';
import { LoudnessStore } from './loudness-store';
import { decodeMeterFrame, type MeterEntry, type MeterFrame, type MeterLegend } from './meter-frames';
import type { SessionClient, SocketLike } from './session-client';

export const REALTIME_PATH = '/v1/realtime';

// The browser WebSocket's binaryType: frames arrive as ArrayBuffers.
export type RealtimeSocket = SocketLike & { binaryType?: string };

export interface RealtimeClientOptions {
  session: Pick<SessionClient, 'getState' | 'subscribe' | 'endpoint'>;
  createSocket: (url: string) => RealtimeSocket;
}

interface Channel {
  readonly socket: RealtimeSocket;
  // The command socket opens counted when this channel was opened.
  readonly connection: number;
  closed: boolean;
}

export class RealtimeClient {
  readonly #options: RealtimeClientOptions;
  readonly #listeners = new Set<() => void>();
  readonly #loudnessListeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  // The master's loudness, from the SLUD frames (read by the meter surfaces).
  readonly loudness = new LoudnessStore();
  #channel: Channel | null = null;
  #legend: MeterLegend | null = null;
  #latest: MeterFrame | null = null;
  #playhead: MeterFrame | null = null;
  #readings = new Map<number, MeterEntry>();
  #frames = 0;
  #closed = false;

  constructor(options: RealtimeClientOptions) {
    this.#options = options;
    this.#unsubscribe = options.session.subscribe(() => this.#follow());
    this.#follow();
  }

  // The legend frames are decoded with (the SessionClient's).
  legend(): MeterLegend | null {
    return this.#legend;
  }

  // The newest frame of the legend's epoch, or null.
  latest(): MeterFrame | null {
    return this.#latest;
  }

  // The newest frame of any epoch, for its playheadSamples and playing; null
  // only before the first frame of a connection.
  playhead(): MeterFrame | null {
    return this.#playhead;
  }

  // Frames accepted since this client was made.
  frameCount(): number {
    return this.#frames;
  }

  // The newest reading of an entity ("master", "track:<id>"), or null.
  meter(ref: string): MeterEntry | null {
    const index = this.#legend ? this.#legend.entities.indexOf(ref) : -1;
    return index < 0 ? null : (this.#readings.get(index) ?? null);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // A loudness frame arrived, or the loudness was cleared (plain listeners, no React).
  subscribeLoudness(listener: () => void): () => void {
    this.#loudnessListeners.add(listener);
    return () => {
      this.#loudnessListeners.delete(listener);
    };
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    this.#drop();
  }

  // Opens, keeps or closes the channel as the command socket goes.
  #follow(): void {
    if (this.#closed) return;
    const state = this.#options.session.getState();
    const legend = state.legend;
    if (legend?.epoch !== this.#legend?.epoch) {
      this.#readings = new Map();
      this.#latest = null;
    }
    this.#legend = legend;
    const endpoint = this.#options.session.endpoint();
    if (state.status !== 'connected' || !endpoint) {
      this.#drop();
      return;
    }
    const current = this.#channel;
    if (current && !current.closed && current.connection === state.connections) return;
    this.#drop();
    const socket = this.#options.createSocket(`ws://127.0.0.1:${endpoint.port}${REALTIME_PATH}`);
    socket.binaryType = 'arraybuffer';
    const channel: Channel = { socket, connection: state.connections, closed: false };
    this.#channel = channel;
    socket.onopen = () => {
      if (this.#channel !== channel) return;
      socket.send(JSON.stringify({ type: 'auth', token: endpoint.token }));
    };
    socket.onmessage = (event) => {
      if (this.#channel !== channel) return;
      const data = event.data;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) this.#receive(data);
    };
    socket.onclose = () => {
      if (this.#channel !== channel) return;
      channel.closed = true;
      this.#channel = null;
    };
  }

  #receive(data: ArrayBuffer | ArrayBufferView): void {
    if (frameKind(data) === 'loudness') {
      const loudness = decodeLoudnessFrame(data);
      if (!loudness) return;
      this.loudness.set(loudness);
      this.#tellLoudness();
      return;
    }
    const frame = decodeMeterFrame(data);
    if (!frame) return;
    this.#playhead = frame;
    if (this.#legend && frame.epoch === this.#legend.epoch) {
      this.#latest = frame;
      for (const entry of frame.entries) this.#readings.set(entry.entityIndex, entry);
      this.#frames += 1;
    }
    for (const listener of [...this.#listeners]) listener();
  }

  #tellLoudness(): void {
    for (const listener of [...this.#loudnessListeners]) listener();
  }

  #drop(): void {
    const channel = this.#channel;
    this.#channel = null;
    this.#latest = null;
    this.#playhead = null;
    this.#readings = new Map();
    if (this.loudness.momentary !== -Infinity || this.loudness.shortTerm !== -Infinity || this.loudness.integrated !== -Infinity) {
      this.loudness.clear();
      this.#tellLoudness();
    }
    if (channel && !channel.closed) {
      channel.closed = true;
      channel.socket.close();
    }
  }
}
