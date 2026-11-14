// The selection (UI redesign spec 3.1, 3.2 "Editing" and 3.3; P1-8), pure.
//
// Clips: a click replaces the selection with the clip under the pointer (an
// empty click clears it), Shift-click toggles a clip in or out, Ctrl+A takes
// every audio clip the timeline draws, and ids the snapshot no longer holds
// are pruned. L locates the selection's start, N and B the next and previous
// clip start on the selected tracks (every track when none is selected), and
// Alt+S fits the selection in the view.
//
// Tracks: a primary track (the Inspector's, the last clicked) and the set of
// selected tracks; click selects one, Ctrl-click toggles one, Shift-click
// selects the range from the primary in track order.

import type { ClipEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { Viewport } from './geometry';
import { zoomToRange } from './zoom';

export function clickSelection(current: readonly string[], clipId: string | null, add: boolean): string[] {
  if (clipId === null) return add ? [...current] : [];
  if (!add) return [clipId];
  return current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId];
}

function drawn(snapshot: Snapshot): ClipEntity[] {
  const lanes = new Set(snapshot.trackOrder);
  return snapshot.clips.filter((clip) => clip.position.domain === 'audio' && lanes.has(clip.trackId));
}

// Ctrl+A: every audio clip on a lane.
export function selectAllClips(snapshot: Snapshot): string[] {
  return drawn(snapshot).map((clip) => clip.id);
}

// The ids the snapshot still holds; the same array when it holds them all.
export function pruneSelection(ids: readonly string[], snapshot: Snapshot | null): readonly string[] {
  const kept = ids.filter((id) => snapshot?.entities[`clip:${id}`] !== undefined);
  return kept.length === ids.length ? ids : kept;
}

function selectedClips(snapshot: Snapshot, ids: readonly string[]): ClipEntity[] {
  const wanted = new Set(ids);
  return drawn(snapshot).filter((clip) => wanted.has(clip.id));
}

export function selectionSpan(snapshot: Snapshot, ids: readonly string[]): { start: bigint; end: bigint } | null {
  let range: { start: bigint; end: bigint } | null = null;
  for (const clip of selectedClips(snapshot, ids)) {
    const start = BigInt(clip.position.value);
    const end = start + BigInt(clip.length);
    range = range ? { start: start < range.start ? start : range.start, end: end > range.end ? end : range.end } : { start, end };
  }
  return range;
}

// L: the selection's start.
export function selectionStart(snapshot: Snapshot, ids: readonly string[]): bigint | null {
  return selectionSpan(snapshot, ids)?.start ?? null;
}

function starts(snapshot: Snapshot, trackIds: readonly string[]): bigint[] {
  const tracks = trackIds.length > 0 ? new Set(trackIds) : null;
  return drawn(snapshot)
    .filter((clip) => !tracks || tracks.has(clip.trackId))
    .map((clip) => BigInt(clip.position.value));
}

// N: the first clip start after the cursor on the tracks (all when none named).
export function nextClipFrame(snapshot: Snapshot, cursor: bigint, trackIds: readonly string[]): bigint | null {
  let found: bigint | null = null;
  for (const start of starts(snapshot, trackIds)) if (start > cursor && (found === null || start < found)) found = start;
  return found;
}

// B: the last clip start before the cursor on the tracks (all when none named).
export function previousClipFrame(snapshot: Snapshot, cursor: bigint, trackIds: readonly string[]): bigint | null {
  let found: bigint | null = null;
  for (const start of starts(snapshot, trackIds)) if (start < cursor && (found === null || start > found)) found = start;
  return found;
}

// Alt+S: the view that fits the selection's span, with a margin; unchanged without one.
export function zoomToSelection(view: Viewport, snapshot: Snapshot, ids: readonly string[]): Viewport {
  const range = selectionSpan(snapshot, ids);
  return range ? zoomToRange(view, range.start, range.end) : view;
}

export interface TrackSelection {
  // The Inspector's track and the anchor of a range; null with nothing selected.
  readonly primary: string | null;
  // Every selected track, in the order they were selected (a range: track order).
  readonly ids: readonly string[];
}

export const NO_TRACKS: TrackSelection = Object.freeze({ primary: null, ids: Object.freeze([]) as readonly string[] });

export type TrackSelectMode = 'replace' | 'toggle' | 'range';

export function selectTrack(current: TrackSelection, trackId: string, mode: TrackSelectMode, order: readonly string[]): TrackSelection {
  if (mode === 'toggle') {
    if (current.ids.includes(trackId)) {
      const ids = current.ids.filter((id) => id !== trackId);
      const primary = current.primary === trackId ? (ids[ids.length - 1] ?? null) : current.primary;
      return { primary, ids };
    }
    return { primary: trackId, ids: [...current.ids, trackId] };
  }
  if (mode === 'range' && current.primary !== null) {
    const from = order.indexOf(current.primary);
    const to = order.indexOf(trackId);
    if (from >= 0 && to >= 0) {
      return { primary: current.primary, ids: order.slice(Math.min(from, to), Math.max(from, to) + 1) };
    }
  }
  return { primary: trackId, ids: [trackId] };
}

// The tracks that still exist; the same object when they all do.
export function pruneTracks(current: TrackSelection, order: readonly string[]): TrackSelection {
  const ids = current.ids.filter((id) => order.includes(id));
  const primaryKept = current.primary === null || order.includes(current.primary);
  if (ids.length === current.ids.length && primaryKept) return current;
  const primary = primaryKept ? current.primary : (ids[ids.length - 1] ?? null);
  return { primary, ids };
}
