// The session document as the protocol carries it (docs/schemas/
// protocol-events-v1.md): entity JSON in its hashed form, matching
// native/libs/model/include/siann/model/entities.hpp and the model's toJson.
// 64-bit fields (ticks, frames, sample positions, seq) stay decimal strings,
// because JSON numbers lose precision above 2^53. Framework-free.

export type EntityType = 'root' | 'media' | 'track' | 'clip' | 'plugin_slot';

export const ENTITY_TYPES: readonly EntityType[] = ['root', 'media', 'track', 'clip', 'plugin_slot'];

export interface TempoPoint {
  readonly ticks: string;
  readonly milliBpm: number;
}

export interface RootEntity {
  readonly schema: 'siann.entity.root.v1';
  readonly id: 'root';
  readonly name: string;
  readonly sampleRate: number;
  readonly tempo: readonly TempoPoint[];
  readonly trackOrder: readonly string[];
}

export interface MediaEntity {
  readonly schema: 'siann.entity.media.v1';
  readonly id: string;
  readonly contentHash: string;
  readonly originalHash?: string;
  readonly format: 'wav' | 'flac';
  readonly channels: number;
  readonly sampleRate: number;
  readonly frames: string;
}

export interface TrackEntity {
  readonly schema: 'siann.entity.track.v1';
  readonly id: string;
  readonly name: string;
  readonly kind: 'audio';
  readonly channels: number;
  // Integer milli-dB; -2147483648 is minus infinity (the fader minimum).
  readonly gainMilliDb: number;
  // -10000 (hard left) to 10000 (hard right).
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  // Plugin slot ids in signal order; absent when the track has no inserts.
  readonly inserts?: readonly string[];
}

export interface ClipPosition {
  readonly domain: 'audio' | 'music';
  readonly value: string;
}

export interface ClipEntity {
  readonly schema: 'siann.entity.clip.v1';
  readonly id: string;
  readonly trackId: string;
  readonly mediaId: string;
  readonly position: ClipPosition;
  readonly sourceStart: string;
  readonly length: string;
  readonly gainMilliDb: number;
}

export interface PluginSlotEntity {
  readonly schema: 'siann.entity.plugin_slot.v1';
  readonly id: string;
  readonly trackId: string;
  readonly format: string;
  readonly uid: string;
  readonly name: string;
  readonly path: string;
  readonly stateBlob?: string;
  readonly bypass: boolean;
}

export type Entity = RootEntity | MediaEntity | TrackEntity | ClipEntity | PluginSlotEntity;

export interface EntityRef {
  readonly type: EntityType;
  readonly id: string;
}

const REF_RE = /^(root|media|track|clip|plugin_slot):([A-Za-z0-9_-]{1,64})$/;

// "<type>:<id>" as session.fetch and changedIds name an entity; null for
// anything else.
export function parseRef(text: string): EntityRef | null {
  const match = REF_RE.exec(text);
  if (!match) return null;
  return { type: match[1] as EntityType, id: match[2]! };
}

// The tables of a sync chunk and of Document::toJson(), in sync order.
export const TABLES = [
  ['media', 'media'],
  ['tracks', 'track'],
  ['clips', 'clip'],
  ['pluginSlots', 'plugin_slot'],
] as const;

export interface SyncChunk {
  readonly revision: string;
  readonly seq: string;
  readonly documentHash: string;
  readonly entities: number;
  readonly meters: unknown;
  readonly chunk: {
    readonly root?: RootEntity;
    readonly media?: readonly MediaEntity[];
    readonly tracks?: readonly TrackEntity[];
    readonly clips?: readonly ClipEntity[];
    // Present only in a chunk that holds slots.
    readonly pluginSlots?: readonly PluginSlotEntity[];
  };
  readonly next: string | null;
}

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface SessionChanged {
  readonly schema?: string;
  readonly seq: string;
  readonly sessionId?: string;
  readonly revision: string;
  readonly type: 'session.changed';
  readonly parents?: readonly string[];
  readonly cause?: string;
  readonly actor?: string;
  readonly time?: string;
  readonly documentHash: string;
  readonly changedIds: ReadonlyArray<{ readonly ref: string; readonly change: ChangeKind }>;
}

export interface FetchedEntity {
  readonly ref: string;
  readonly entity?: unknown;
  readonly missing?: true;
}
