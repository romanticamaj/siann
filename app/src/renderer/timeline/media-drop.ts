// Where a drop on the event display lands (m5b-ui-media; UI redesign UR-5,
// 3.2): the drop point's frame snapped as a drag snaps it (snap.ts, the
// canvas's snapper at the view's zoom and scroll), the same for every file
// of the drop, and one lane per file: on track k the files go to k, k+1, ...,
// and past the last track, or for a drop below it, each further file gets a
// new track. A drop on the ruler or the marker row lands nowhere. Each file
// then ends as one command list: track.add (a client-chosen trk_ id, named
// after the media, which the engine already stripped of unsafe characters)
// when its lane is new or its track went away, and clip.place at the
// position with the media's frames as its length, at the snapshot's
// revision. Framework-free.

import type { Snapshot } from '../model/read-model';
import { newClipId, type TimelineCommand } from './commands';
import { lanesTopOf, trackAt, xToFrame, type Viewport } from './geometry';
import { snapperFor, type SnapSettings } from './snap';
import { NEW_TRACK_CHANNELS, newTrackId } from './track-commands';

// A file's lane: an existing track, or null for a new one.
export interface DropLane {
  readonly trackId: string | null;
}

export interface DropPlan {
  readonly position: bigint;
  readonly lanes: readonly DropLane[];
}

export interface DropInput {
  readonly snapshot: Snapshot;
  readonly view: Viewport;
  readonly snap: SnapSettings;
  // The drop point in canvas pixels.
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export function planDrop({ snapshot, view, snap, x, y, count }: DropInput): DropPlan | null {
  if (count <= 0 || y < lanesTopOf(view)) return null;
  const rate = snapshot.root?.sampleRate ?? 48000;
  const frame = xToFrame(x, view);
  const snapped = snapperFor(snap, view.framesPerPixel, snapshot.root?.tempo ?? [], rate, false, BigInt(view.scrollFrames))(frame < 0n ? 0n : frame);
  const position = snapped < 0n ? 0n : snapped;
  const target = trackAt(snapshot, y, view);
  const order = snapshot.trackOrder;
  const first = target === null ? order.length : order.indexOf(target);
  const lanes: DropLane[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = first + i;
    lanes.push({ trackId: at < order.length ? order[at]! : null });
  }
  return { position, lanes };
}

// The media a placement plays: its id, name and frames.
export interface PlacedMedia {
  readonly mediaId: string;
  readonly name?: string;
  readonly frames: string;
}

export interface PlacementIds {
  readonly trackId?: () => string;
  readonly clipId?: () => string;
}

export function placementCommand(snapshot: Snapshot, lane: DropLane, media: PlacedMedia, position: bigint, ids: PlacementIds = {}): TimelineCommand {
  const commands: Array<Record<string, unknown>> = [];
  let trackId = lane.trackId;
  if (trackId === null || !snapshot.entities[`track:${trackId}`]) {
    trackId = (ids.trackId ?? newTrackId)();
    commands.push({ op: 'track.add', trackId, name: media.name && media.name !== '' ? media.name : media.mediaId, channels: NEW_TRACK_CHANNELS });
  }
  commands.push({
    op: 'clip.place',
    clipId: (ids.clipId ?? newClipId)(),
    trackId,
    mediaId: media.mediaId,
    position: { domain: 'audio', value: (position < 0n ? 0n : position).toString() },
    sourceStart: '0',
    length: media.frames,
  });
  return { expectedRevision: snapshot.revision, commands };
}
