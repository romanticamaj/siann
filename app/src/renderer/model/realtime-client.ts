// The renderer's realtime channel client (docs/schemas/protocol-events-v1.md,
// "Realtime channel"): meters and the playhead on their own WebSocket,
// /v1/realtime, so they never queue behind commands or events. It opens beside
// the SessionClient's command socket (same port and token), authenticates with
// the first text frame, decodes each binary frame with the legend the
// SessionClient holds, and keeps the newest frame and the newest reading per
// entity (latest wins; nothing is queued). A frame of an epoch other than the
// legend's is ignored. It closes when the command socket closes and opens
// again when the command socket has reconnected.
//
// Framework-free: the meter surfaces read latest() and meter() from their own
// animation frame (ADR-0019 point 3: no meter value passes through React state);
// subscribe() is for plain listeners.

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
  readonly #unsubscribe: () => void;
  #channel: Channel | null = null;
  #legend: MeterLegend | null = null;
  #latest: MeterFrame | null = null;
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
    const frame = decodeMeterFrame(data);
    if (!frame || !this.#legend || frame.epoch !== this.#legend.epoch) return;
    this.#latest = frame;
    for (const entry of frame.entries) this.#readings.set(entry.entityIndex, entry);
    this.#frames += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  #drop(): void {
    const channel = this.#channel;
    this.#channel = null;
    this.#latest = null;
    this.#readings = new Map();
    if (channel && !channel.closed) {
      channel.closed = true;
      channel.socket.close();
    }
  }
}
