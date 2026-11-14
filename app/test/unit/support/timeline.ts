// A small session snapshot for the timeline tests: two tracks in a trackOrder
// that is not their id order, two media entities and three audio-domain clips.
// Built as a plain frozen object (the read model's Snapshot shape); the
// geometry and command modules read only these fields.

import type { ClipEntity, Entity, MediaEntity, RootEntity, TrackEntity } from '../../../src/renderer/model/document';
import type { Snapshot } from '../../../src/renderer/model/read-model';

export function track(id: string): TrackEntity {
  return { schema: 'siann.entity.track.v1', id, name: id, kind: 'audio', channels: 2, gainMilliDb: 0, pan: 0, mute: false, solo: false };
}

export function media(id: string, frames: string, contentHash = `sha256:${'0'.repeat(63)}1`): MediaEntity {
  return { schema: 'siann.entity.media.v1', id, contentHash, format: 'wav', channels: 1, sampleRate: 48000, frames };
}

export function clip(id: string, trackId: string, mediaId: string, position: string, sourceStart: string, length: string): ClipEntity {
  return {
    schema: 'siann.entity.clip.v1',
    id,
    trackId,
    mediaId,
    position: { domain: 'audio', value: position },
    sourceStart,
    length,
    gainMilliDb: 0,
  };
}

export function snapshotOf(
  trackOrder: readonly string[],
  tracks: readonly TrackEntity[],
  mediaRows: readonly MediaEntity[],
  clips: readonly ClipEntity[],
  revision = 'r7',
): Snapshot {
  const root: RootEntity = { schema: 'siann.entity.root.v1', id: 'root', name: 'Song', sampleRate: 48000, tempo: [], trackOrder };
  const entities: Record<string, Entity> = { 'root:root': root };
  for (const t of tracks) entities[`track:${t.id}`] = t;
  for (const m of mediaRows) entities[`media:${m.id}`] = m;
  for (const c of clips) entities[`clip:${c.id}`] = c;
  const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  return Object.freeze({
    revision,
    seq: '1',
    documentHash: `sha256:${'a'.repeat(64)}`,
    entities,
    entityHashes: {},
    root,
    media: byId(mediaRows),
    tracks: byId(tracks),
    clips: byId(clips),
    pluginSlots: [],
    locators: null,
    trackOrder,
  });
}

// trk_b is drawn first (trackOrder), then trk_a.
export function sampleSnapshot(): Snapshot {
  return snapshotOf(
    ['trk_b', 'trk_a'],
    [track('trk_a'), track('trk_b')],
    [media('med_sq', '48000'), media('med_si', '96000', `sha256:${'0'.repeat(63)}2`)],
    [
      clip('clp_1', 'trk_b', 'med_sq', '4800', '0', '24000'),
      clip('clp_2', 'trk_a', 'med_si', '0', '1000', '9600'),
      clip('clp_3', 'trk_a', 'med_sq', '48000', '24000', '24000'),
    ],
  );
}
