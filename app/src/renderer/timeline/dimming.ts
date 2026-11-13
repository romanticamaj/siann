// Dimming (UI redesign spec 1.2): a muted track, and every track muted by
// another track's solo (any solo on, this one not soloed), has its lane and
// header drawn at 45 %. Framework-free.

import type { TrackEntity } from '../model/document';

export const DIMMED_ALPHA = 0.45;

export function dimmedTracks(tracks: readonly TrackEntity[]): Set<string> {
  const soloing = tracks.some((track) => track.solo);
  const dimmed = new Set<string>();
  for (const track of tracks) if (track.mute || (soloing && !track.solo)) dimmed.add(track.id);
  return dimmed;
}
