// The renderer's read model (spec, "Frontend"): immutable snapshots keyed by
// revision, built from a session.sync and advanced only by session.changed
// deltas with their session.fetch answers. It never owns session truth: every
// committed entity came from the engine, and every snapshot's recomputed
// document hash equals the hash the engine published for that revision.
//
// The one optimistic value is a continuous gesture's overlay (a fader or pan
// knob held under a gesture, spec "Gestures"): it changes the derived view,
// never a snapshot, and stays after gesture.end until the session.changed that
// commits the entity arrives, so a recompile never snaps a held fader back.
//
// React reads it through useSyncExternalStore(subscribe, getSnapshot) or
// (subscribe, getView): each identity is stable until the next change.
// Framework-free and DOM-free.

import {
  TABLES,
  parseRef,
  type ClipEntity,
  type Entity,
  type FetchedEntity,
  type MediaEntity,
  type PluginSlotEntity,
  type RootEntity,
  type SessionChanged,
  type SyncChunk,
  type TrackEntity,
} from './document';
import { documentHash, entityHash, entityRef } from './hash';

export class ReadModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReadModelError';
  }
}

export interface Snapshot {
  readonly revision: string;
  readonly seq: string;
  readonly documentHash: string;
  // Every entity by "<type>:<id>".
  readonly entities: Readonly<Record<string, Entity>>;
  readonly entityHashes: Readonly<Record<string, string>>;
  readonly root: RootEntity | null;
  // Each table in id order, as Document::toJson() and session.sync list them.
  readonly media: readonly MediaEntity[];
  readonly tracks: readonly TrackEntity[];
  readonly clips: readonly ClipEntity[];
  readonly pluginSlots: readonly PluginSlotEntity[];
  // The user-visible track order (root.trackOrder).
  readonly trackOrder: readonly string[];
}

// Parameters a continuous gesture may hold (spec, "Two channels into the
// audio thread": the parameter channel). Mute, solo and every structural
// field change only through a commit.
export type GestureField = 'gainMilliDb' | 'pan';

const CONTINUOUS: Readonly<Record<string, readonly GestureField[]>> = {
  track: ['gainMilliDb', 'pan'],
  clip: ['gainMilliDb'],
};

export interface Gesture {
  readonly ref: string;
  readonly field: GestureField;
  // null until the first setGesture.
  readonly value: number | null;
  // After endGesture: no more values; the overlay waits for its commit.
  readonly ended: boolean;
}

export interface View {
  readonly snapshot: Snapshot | null;
  readonly gesture: Gesture | null;
  // The gestured entity with the overlay applied, when it has a value.
  readonly overlaid: Entity | null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function compareIds(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function asEntity(ref: string, value: unknown): Entity {
  const parsed = parseRef(ref);
  if (!parsed) throw new ReadModelError('invalid_ref', `not an entity ref: ${ref}`);
  if (!value || typeof value !== 'object' || (value as { id?: unknown }).id !== parsed.id) {
    throw new ReadModelError('invalid_entity', `the entity for ${ref} does not carry id ${parsed.id}`);
  }
  return deepFreeze(structuredClone(value)) as Entity;
}

async function verifiedHash(entities: Record<string, Entity>, hashes: Record<string, string>): Promise<string> {
  const leaves = Object.keys(entities).map((ref) => {
    const parsed = parseRef(ref)!;
    return { type: parsed.type, id: parsed.id, entityHash: hashes[ref]! };
  });
  return documentHash(leaves);
}

function buildSnapshot(
  revision: string,
  seq: string,
  hash: string,
  entities: Record<string, Entity>,
  hashes: Record<string, string>,
): Snapshot {
  const tables: Record<string, Entity[]> = { media: [], track: [], clip: [], plugin_slot: [] };
  let root: RootEntity | null = null;
  for (const [ref, entity] of Object.entries(entities)) {
    const type = parseRef(ref)!.type;
    if (type === 'root') root = entity as RootEntity;
    else tables[type]!.push(entity);
  }
  for (const rows of Object.values(tables)) rows.sort(compareIds);
  return Object.freeze({
    revision,
    seq,
    documentHash: hash,
    entities: Object.freeze(entities),
    entityHashes: Object.freeze(hashes),
    root,
    media: Object.freeze(tables.media as MediaEntity[]),
    tracks: Object.freeze(tables.track as TrackEntity[]),
    clips: Object.freeze(tables.clip as ClipEntity[]),
    pluginSlots: Object.freeze(tables.plugin_slot as PluginSlotEntity[]),
    trackOrder: root ? root.trackOrder : Object.freeze([]),
  });
}

export class ReadModel {
  #snapshot: Snapshot | null = null;
  #gesture: Gesture | null = null;
  #view: View | null = null;
  readonly #listeners = new Set<() => void>();

  getSnapshot(): Snapshot | null {
    return this.#snapshot;
  }

  getView(): View {
    if (!this.#view) {
      const snapshot = this.#snapshot;
      const gesture = this.#gesture;
      let overlaid: Entity | null = null;
      const base = gesture && snapshot ? snapshot.entities[gesture.ref] : undefined;
      if (gesture && gesture.value !== null && base) {
        overlaid = Object.freeze({ ...base, [gesture.field]: gesture.value }) as Entity;
      }
      this.#view = Object.freeze({ snapshot, gesture, overlaid });
    }
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // An entity as the UI shows it: the committed one, or the gestured one with
  // its overlay.
  select(ref: string): Entity | undefined {
    const view = this.getView();
    if (view.overlaid && view.gesture?.ref === ref) return view.overlaid;
    return view.snapshot?.entities[ref];
  }

  // Replaces the model with a full session.sync (every chunk of one pinned
  // revision). Refused, replacing nothing, when the chunks do not belong to one
  // sync or do not hash to its documentHash.
  async fromSync(chunks: readonly SyncChunk[]): Promise<Snapshot> {
    const first = chunks[0];
    if (!first) throw new ReadModelError('sync_inconsistent', 'a sync has at least one chunk');
    const entities: Record<string, Entity> = {};
    chunks.forEach((chunk, i) => {
      if (chunk.revision !== first.revision || chunk.seq !== first.seq || chunk.documentHash !== first.documentHash) {
        throw new ReadModelError('sync_inconsistent', `chunk ${i} is not at the sync's pinned revision`);
      }
      if ((chunk.next === null) !== (i === chunks.length - 1)) {
        throw new ReadModelError('sync_inconsistent', `chunk ${i} ${chunk.next === null ? 'ends' : 'does not end'} the sync`);
      }
      const add = (ref: string, value: unknown) => {
        if (ref in entities) throw new ReadModelError('sync_inconsistent', `${ref} appears twice`);
        entities[ref] = asEntity(ref, value);
      };
      if (chunk.chunk.root) add('root:root', chunk.chunk.root);
      for (const [table, type] of TABLES) {
        for (const row of chunk.chunk[table] ?? []) add(entityRef(type, (row as { id: string }).id), row);
      }
    });
    if (Object.keys(entities).length !== first.entities) {
      throw new ReadModelError('sync_inconsistent', `the sync lists ${first.entities} entities, the chunks hold ${Object.keys(entities).length}`);
    }
    const hashes: Record<string, string> = {};
    for (const [ref, entity] of Object.entries(entities)) hashes[ref] = await entityHash(entity);
    const computed = await verifiedHash(entities, hashes);
    if (computed !== first.documentHash) {
      throw new ReadModelError('hash_mismatch', `the sync hashes to ${computed}, not ${first.documentHash}`);
    }
    const snapshot = buildSnapshot(first.revision, first.seq, first.documentHash, entities, hashes);
    if (this.#gesture && !snapshot.entities[this.#gesture.ref]) this.#gesture = null;
    this.#commit(snapshot);
    return snapshot;
  }

  // Applies one session.changed with the session.fetch answer at its revision:
  // added and modified entities from the fetch (dropped when fetched missing),
  // removed ones dropped. Refused, changing nothing, when the result does not
  // hash to the event's documentHash.
  async applyChanged(event: SessionChanged, fetched: readonly FetchedEntity[]): Promise<Snapshot> {
    const base = this.#snapshot;
    if (!base) throw new ReadModelError('no_snapshot', 'a delta needs a synced snapshot');
    if (event.type !== 'session.changed') throw new ReadModelError('invalid_event', `not a session.changed: ${event.type}`);
    const answers = new Map(fetched.map((f) => [f.ref, f]));
    const entities: Record<string, Entity> = { ...base.entities };
    const hashes: Record<string, string> = { ...base.entityHashes };
    for (const { ref, change } of event.changedIds) {
      if (!parseRef(ref)) throw new ReadModelError('invalid_ref', `not an entity ref: ${ref}`);
      const answer = change === 'removed' ? undefined : answers.get(ref);
      if (change !== 'removed' && !answer) throw new ReadModelError('incomplete_fetch', `the fetch has no answer for ${ref}`);
      if (!answer || answer.missing) {
        delete entities[ref];
        delete hashes[ref];
        continue;
      }
      entities[ref] = asEntity(ref, answer.entity);
      hashes[ref] = await entityHash(entities[ref]);
    }
    const computed = await verifiedHash(entities, hashes);
    if (computed !== event.documentHash) {
      throw new ReadModelError('hash_mismatch', `revision ${event.revision} hashes to ${computed}, not ${event.documentHash}`);
    }
    if (this.#snapshot !== base) throw new ReadModelError('stale', 'the model changed while the delta was applied');
    const snapshot = buildSnapshot(event.revision, event.seq, event.documentHash, entities, hashes);
    const gesture = this.#gesture;
    if (gesture) {
      const touched = event.changedIds.some((c) => c.ref === gesture.ref);
      if (!snapshot.entities[gesture.ref] || (touched && gesture.ended)) this.#gesture = null;
    }
    this.#commit(snapshot);
    return snapshot;
  }

  beginGesture(ref: string, field: GestureField): void {
    if (this.#gesture && !this.#gesture.ended) throw new ReadModelError('gesture_open', `a gesture on ${this.#gesture.ref} is open`);
    const parsed = parseRef(ref);
    if (!parsed || !(CONTINUOUS[parsed.type] ?? []).includes(field)) {
      throw new ReadModelError('not_continuous', `${ref} ${field} is not a continuous parameter`);
    }
    if (!this.#snapshot?.entities[ref]) throw new ReadModelError('not_found', `${ref} is not in the model`);
    this.#setGesture({ ref, field, value: null, ended: false });
  }

  setGesture(value: number): void {
    const gesture = this.#gesture;
    if (!gesture || gesture.ended) throw new ReadModelError('no_gesture', 'no gesture is open');
    if (!Number.isFinite(value)) throw new ReadModelError('invalid_value', `not a finite value: ${value}`);
    this.#setGesture({ ...gesture, value });
  }

  // Ends the open gesture and returns its last value (the value gesture.end
  // commits). The overlay stays until that commit's session.changed applies.
  endGesture(): number | null {
    const gesture = this.#gesture;
    if (!gesture || gesture.ended) throw new ReadModelError('no_gesture', 'no gesture is open');
    if (gesture.value === null) {
      this.#setGesture(null);
      return null;
    }
    this.#setGesture({ ...gesture, ended: true });
    return gesture.value;
  }

  cancelGesture(): void {
    if (this.#gesture) this.#setGesture(null);
  }

  #setGesture(gesture: Gesture | null): void {
    this.#gesture = gesture ? Object.freeze(gesture) : null;
    this.#view = null;
    this.#notify();
  }

  #commit(snapshot: Snapshot): void {
    this.#snapshot = snapshot;
    this.#view = null;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
