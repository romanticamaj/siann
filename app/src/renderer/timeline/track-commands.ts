// The track list's commands (UI redesign spec 3.3): adding a track (the T key
// or the + button above the list) is track.add with a client-chosen trk_ id of
// 16 lowercase hex digits, as clip ids are chosen, two channels and the
// catalog's default name with the next free number; renaming is
// track.rename, and nothing when the new name is empty or unchanged. Each
// carries the snapshot's revision as expectedRevision. Framework-free.

import type { TrackEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { TimelineCommand } from './commands';

export const NEW_TRACK_CHANNELS = 2;

export function newTrackId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `trk_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// The default name with the lowest number no track of the snapshot carries.
export function nextTrackName(snapshot: Snapshot, name: (n: number) => string): string {
  const taken = new Set(snapshot.tracks.map((track) => track.name));
  for (let n = 1; ; n += 1) {
    const candidate = name(n);
    if (!taken.has(candidate)) return candidate;
  }
}

export function addTrackCommand(snapshot: Snapshot, name: string, trackId: () => string = newTrackId): TimelineCommand {
  return {
    expectedRevision: snapshot.revision,
    commands: [{ op: 'track.add', trackId: trackId(), name, channels: NEW_TRACK_CHANNELS }],
  };
}

export function renameTrackCommand(snapshot: Snapshot, trackId: string, name: string): TimelineCommand | null {
  const track = snapshot.entities[`track:${trackId}`] as TrackEntity | undefined;
  const next = name.trim();
  if (!track || track.schema !== 'siann.entity.track.v1' || next === '' || next === track.name) return null;
  return { expectedRevision: snapshot.revision, commands: [{ op: 'track.rename', trackId, name: next }] };
}
