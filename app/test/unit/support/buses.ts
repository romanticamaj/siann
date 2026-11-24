// Buses and sends in a test snapshot (m5b-ui-sends-buses): the entities as
// docs/schemas/protocol-engine-v0.md, "Buses and sends", writes them, and a
// snapshot that holds them with root.busOrder in the given buses' order.

import type { BusEntity, Entity, RootEntity, SendEntity, TrackEntity } from '../../../src/renderer/model/document';
import type { Snapshot } from '../../../src/renderer/model/read-model';
import { snapshotOf } from './timeline';

export function bus(id: string, name: string): BusEntity {
  return { schema: 'siann.entity.bus.v1', id, name, channels: 2, gainMilliDb: 0, pan: 0, mute: false, solo: false };
}

export function send(id: string, trackId: string, busId: string, levelMilliDb = 0, pre = false, enabled = true): SendEntity {
  return { schema: 'siann.entity.send.v1', id, trackId, busId, levelMilliDb, pre, enabled };
}

// The tracks in their given order, the buses in theirs (busOrder), the sends.
export function busSnapshot(buses: readonly BusEntity[], sends: readonly SendEntity[], tracks: readonly TrackEntity[] = [], revision = 'r7'): Snapshot {
  const base = snapshotOf(tracks.map((t) => t.id), tracks, [], [], revision);
  const root: RootEntity = { ...base.root!, ...(buses.length > 0 ? { busOrder: buses.map((b) => b.id) } : {}) };
  const entities: Record<string, Entity> = { ...base.entities, 'root:root': root };
  for (const b of buses) entities[`bus:${b.id}`] = b;
  for (const s of sends) entities[`send:${s.id}`] = s;
  const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  return Object.freeze({ ...base, root, entities, buses: byId(buses), sends: byId(sends), busOrder: root.busOrder ?? [] });
}
