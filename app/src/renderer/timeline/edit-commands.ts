// Cubase's editing as command lists (UI redesign spec 3.2 "Editing", 3.3 and
// P1-8). Each builder is a pure function of a Snapshot and returns one
// TimelineCommand, one command.execute and so one revision, carrying the
// snapshot's revision as expectedRevision; null when there is nothing to do
// or every entity named is unknown. The engine applies a command list
// atomically and has no overlap rule, so:
//
// - split: clip.trim of the left piece and clip.place of the right one, which
//   starts in the media where the left one ends (the audio is continuous);
// - duplicate and copy: clip.place of new clp_ ids, the originals untouched;
// - a selection move: clip.move per clip, trackId only where the lane changed;
// - the clip volume control: clip.set_gain;
// - M, S and Shift+Delete: track.set_mute, track.set_solo, track.remove per
//   selected track.
//
// Music-domain clips (which need the tempo map) are left alone, as the
// timeline does not draw them yet. Framework-free.

import type { ClipEntity, TrackEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { newClipId, type TimelineCommand } from './commands';
import type { TrackSelection } from './selection';

type Command = Record<string, unknown>;

// The clip volume control's range and steps (milli-dB per pixel).
export const GAIN_MIN_MILLI_DB = -60_000;
export const GAIN_MAX_MILLI_DB = 6_000;
export const GAIN_STEP_PER_PX = 100;
export const GAIN_FINE_STEP_PER_PX = 10;
// The pointer distance after which a constrained drag picks its axis.
export const CONSTRAIN_PX = 4;

function issue(snapshot: Snapshot, commands: Command[]): TimelineCommand | null {
  return commands.length === 0 ? null : { expectedRevision: snapshot.revision, commands };
}

function audioClip(snapshot: Snapshot, clipId: string): ClipEntity | null {
  const clip = snapshot.entities[`clip:${clipId}`] as ClipEntity | undefined;
  return clip && clip.schema === 'siann.entity.clip.v1' && clip.position.domain === 'audio' ? clip : null;
}

function audioClips(snapshot: Snapshot, clipIds: readonly string[]): ClipEntity[] {
  const seen = new Set<string>();
  const found: ClipEntity[] = [];
  for (const id of clipIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const clip = audioClip(snapshot, id);
    if (clip) found.push(clip);
  }
  return found;
}

function audio(value: bigint): { domain: 'audio'; value: string } {
  return { domain: 'audio', value: value.toString() };
}

function placeCopy(clip: ClipEntity, clipId: string, trackId: string, position: bigint): Command {
  return {
    op: 'clip.place',
    clipId,
    trackId,
    mediaId: clip.mediaId,
    position: audio(position),
    sourceStart: clip.sourceStart,
    length: clip.length,
    gainMilliDb: clip.gainMilliDb,
  };
}

// The trim and place that split one clip at `frame`, or nothing when the
// frame is not strictly inside it.
function splitOne(clip: ClipEntity, frame: bigint, clipId: () => string): Command[] {
  const start = BigInt(clip.position.value);
  const length = BigInt(clip.length);
  if (frame <= start || frame >= start + length) return [];
  const left = frame - start;
  return [
    { op: 'clip.trim', clipId: clip.id, sourceStart: clip.sourceStart, length: left.toString() },
    {
      op: 'clip.place',
      clipId: clipId(),
      trackId: clip.trackId,
      mediaId: clip.mediaId,
      position: audio(frame),
      sourceStart: (BigInt(clip.sourceStart) + left).toString(),
      length: (length - left).toString(),
      gainMilliDb: clip.gainMilliDb,
    },
  ];
}

// Splits each named clip that strictly contains `frame` (the Split tool,
// Alt-click), in one list.
export function splitCommand(snapshot: Snapshot, clipIds: readonly string[], frame: bigint, clipId: () => string = newClipId): TimelineCommand | null {
  return issue(snapshot, audioClips(snapshot, clipIds).flatMap((clip) => splitOne(clip, frame, clipId)));
}

// Alt+X: the selected clips at the cursor, or every audio clip under the
// cursor on every track when nothing is selected.
export function splitAtCursor(snapshot: Snapshot, selection: readonly string[], cursorFrame: bigint, clipId: () => string = newClipId): TimelineCommand | null {
  const order = new Map(snapshot.trackOrder.map((id, index) => [id, index]));
  const ids =
    selection.length > 0
      ? selection
      : [...snapshot.clips]
          .filter((c) => order.has(c.trackId))
          .sort((a, b) => order.get(a.trackId)! - order.get(b.trackId)! || Number(BigInt(a.position.value) - BigInt(b.position.value)))
          .map((c) => c.id);
  return splitCommand(snapshot, ids, cursorFrame, clipId);
}

// The start of the earliest and the end of the latest clip.
function span(clips: readonly ClipEntity[]): { start: bigint; end: bigint } | null {
  if (clips.length === 0) return null;
  let start = BigInt(clips[0]!.position.value);
  let end = start;
  for (const clip of clips) {
    const s = BigInt(clip.position.value);
    const e = s + BigInt(clip.length);
    if (s < start) start = s;
    if (e > end) end = e;
  }
  return { start, end };
}

// Ctrl+D: a copy of the selection directly after it, as one unit (each clip
// moves by the selection's span, keeping its track and offsets).
export function duplicateCommand(snapshot: Snapshot, clipIds: readonly string[], clipId: () => string = newClipId): TimelineCommand | null {
  const clips = audioClips(snapshot, clipIds);
  const range = span(clips);
  if (!range) return null;
  const by = range.end - range.start;
  return issue(
    snapshot,
    clips.map((clip) => placeCopy(clip, clipId(), clip.trackId, BigInt(clip.position.value) + by)),
  );
}

// The lane change the whole selection can make: held so no clip leaves the lanes.
function laneShift(snapshot: Snapshot, clips: readonly ClipEntity[], laneDelta: number): number {
  let low = -Infinity;
  let high = Infinity;
  for (const clip of clips) {
    const lane = snapshot.trackOrder.indexOf(clip.trackId);
    if (lane < 0) continue;
    low = Math.max(low, -lane);
    high = Math.min(high, snapshot.trackOrder.length - 1 - lane);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 0;
  return Math.max(low, Math.min(high, Math.trunc(laneDelta)));
}

function shiftedTrack(snapshot: Snapshot, trackId: string, lanes: number): string {
  if (lanes === 0) return trackId;
  const lane = snapshot.trackOrder.indexOf(trackId);
  return lane < 0 ? trackId : (snapshot.trackOrder[lane + lanes] ?? trackId);
}

// The frame delta the whole selection can make: none starts before 0.
function frameShift(clips: readonly ClipEntity[], delta: bigint): bigint {
  const range = span(clips);
  if (!range) return delta;
  return delta < -range.start ? -range.start : delta;
}

// Alt-drag: a copy of each clip moved by `deltaFrames` and `laneDelta` lanes;
// the originals stay. Whether the pointer moved far enough to be a drag at
// all is the canvas's decision.
export function copyCommand(
  snapshot: Snapshot,
  clipIds: readonly string[],
  deltaFrames: bigint,
  laneDelta = 0,
  clipId: () => string = newClipId,
): TimelineCommand | null {
  const clips = audioClips(snapshot, clipIds);
  const lanes = laneShift(snapshot, clips, laneDelta);
  const delta = frameShift(clips, deltaFrames);
  return issue(
    snapshot,
    clips.map((clip) => placeCopy(clip, clipId(), shiftedTrack(snapshot, clip.trackId, lanes), BigInt(clip.position.value) + delta)),
  );
}

// A drag of the selection: clip.move per clip that changes, with trackId
// only where its lane changed.
export function moveSelectionCommand(snapshot: Snapshot, clipIds: readonly string[], deltaFrames: bigint, laneDelta = 0): TimelineCommand | null {
  const clips = audioClips(snapshot, clipIds);
  const lanes = laneShift(snapshot, clips, laneDelta);
  const delta = frameShift(clips, deltaFrames);
  const commands: Command[] = [];
  for (const clip of clips) {
    const trackId = shiftedTrack(snapshot, clip.trackId, lanes);
    const position = BigInt(clip.position.value) + delta;
    if (trackId === clip.trackId && delta === 0n) continue;
    const move: Command = { op: 'clip.move', clipId: clip.id, position: audio(position) };
    if (trackId !== clip.trackId) move.trackId = trackId;
    commands.push(move);
  }
  return issue(snapshot, commands);
}

// Ctrl-drag: the axis the move keeps to, by the dominant direction once the
// pointer is CONSTRAIN_PX away ('x' keeps the lane, 'y' the position); null before.
export function constrainAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.abs(dx) < CONSTRAIN_PX && Math.abs(dy) < CONSTRAIN_PX) return null;
  return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
}

// The clip volume control: one clip.set_gain, nothing when unchanged.
export function clipGainCommand(snapshot: Snapshot, clipId: string, gainMilliDb: number): TimelineCommand | null {
  const clip = snapshot.entities[`clip:${clipId}`] as ClipEntity | undefined;
  if (!clip || clip.schema !== 'siann.entity.clip.v1') return null;
  const gain = Math.round(gainMilliDb);
  if (gain === clip.gainMilliDb) return null;
  return issue(snapshot, [{ op: 'clip.set_gain', clipId, gainMilliDb: gain }]);
}

// The gain a vertical drag of the volume control reaches: up is louder, 100
// mdB per pixel (10 with Shift), within -60 to +6 dB. A start below the
// range (minus infinity) counts from -60 dB.
export function gainFromDrag(startMilliDb: number, dyPx: number, fine: boolean): number {
  const start = Math.min(GAIN_MAX_MILLI_DB, Math.max(GAIN_MIN_MILLI_DB, startMilliDb));
  const next = start - Math.round(dyPx) * (fine ? GAIN_FINE_STEP_PER_PX : GAIN_STEP_PER_PX);
  return Math.min(GAIN_MAX_MILLI_DB, Math.max(GAIN_MIN_MILLI_DB, next));
}

function tracksOf(snapshot: Snapshot, trackIds: readonly string[]): TrackEntity[] {
  const seen = new Set<string>();
  const found: TrackEntity[] = [];
  for (const id of trackIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const track = snapshot.entities[`track:${id}`] as TrackEntity | undefined;
    if (track && track.schema === 'siann.entity.track.v1') found.push(track);
  }
  return found;
}

// M and S over the selected tracks: each one set to the opposite of the
// primary's (the last clicked track's) state; tracks already there are left
// alone. The primary need not be the first of the ids (a Ctrl-click appends
// it, a range is in track order); a primary that is gone or not among the ids
// gives way to the first selected track still in the snapshot.
function toggleTracks(snapshot: Snapshot, selection: TrackSelection, field: 'mute' | 'solo'): TimelineCommand | null {
  const tracks = tracksOf(snapshot, selection.ids);
  if (tracks.length === 0) return null;
  const primary = tracks.find((track) => track.id === selection.primary) ?? tracks[0]!;
  const target = !primary[field];
  const op = field === 'mute' ? 'track.set_mute' : 'track.set_solo';
  return issue(
    snapshot,
    tracks.filter((track) => track[field] !== target).map((track) => ({ op, trackId: track.id, [field]: target })),
  );
}

export function trackMuteCommand(snapshot: Snapshot, selection: TrackSelection): TimelineCommand | null {
  return toggleTracks(snapshot, selection, 'mute');
}

export function trackSoloCommand(snapshot: Snapshot, selection: TrackSelection): TimelineCommand | null {
  return toggleTracks(snapshot, selection, 'solo');
}

// Shift+Delete, once confirmed: track.remove per selected track (the engine
// removes each track's clips and plugin slots with it).
export function removeTracksCommand(snapshot: Snapshot, trackIds: readonly string[]): TimelineCommand | null {
  return issue(
    snapshot,
    tracksOf(snapshot, trackIds).map((track) => ({ op: 'track.remove', trackId: track.id })),
  );
}
