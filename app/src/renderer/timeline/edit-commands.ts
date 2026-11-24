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
// - fades (m5b-engine-clip-fades): clip.place takes none, so split, duplicate
//   and copy append clip.set_fade to the same list: split keeps the fade in on
//   the left piece and moves the fade out to the right one, a copy keeps both;
// - a selection move: clip.move per clip, trackId only where the lane changed;
// - the clip volume control: clip.set_gain;
// - M, S and Shift+Delete: track.set_mute, track.set_solo, track.remove per
//   selected track;
// - m5b-ui-edit-more: glue (clip.remove of the following pieces and
//   clip.trim of the first, clip.set_fade for the last piece's fade out, or a
//   refusal), cut (clip.remove), paste and repeat (clip.place and
//   clip.set_fade), and the nudges (clip.move; clip.trim with clip.move for
//   the start; clip.trim for the end).
//
// Music-domain clips (which need the tempo map) are left alone, as the
// timeline does not draw them yet. Framework-free.

import type { ClipEntity, MediaEntity, TrackEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { recheck, sameList, type Recheck } from '../model/recheck';
import { newClipId, type TimelineCommand } from './commands';
import { snapTrim } from './geometry';
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

// What a placed copy takes of a clip (a clip entity or a clipboard item).
type ClipContent = Pick<ClipEntity, 'mediaId' | 'sourceStart' | 'length' | 'gainMilliDb' | 'fadeIn' | 'fadeOut'>;

// A copy of the clip under a new id, with its fades.
function placeCopy(clip: ClipContent, clipId: string, trackId: string, position: bigint): Command[] {
  const place: Command = {
    op: 'clip.place',
    clipId,
    trackId,
    mediaId: clip.mediaId,
    position: audio(position),
    sourceStart: clip.sourceStart,
    length: clip.length,
    gainMilliDb: clip.gainMilliDb,
  };
  if (!clip.fadeIn && !clip.fadeOut) return [place];
  const fade: Command = { op: 'clip.set_fade', clipId };
  if (clip.fadeIn) fade.fadeIn = { ...clip.fadeIn };
  if (clip.fadeOut) fade.fadeOut = { ...clip.fadeOut };
  return [place, fade];
}

// The trim and place that split one clip at `frame`, or nothing when the
// frame is not strictly inside it. The left piece keeps its fade in (the
// trim shortens it to fit) and loses its fade out; the right piece gets the
// fade out, shortened to its length, and no fade in.
function splitOne(clip: ClipEntity, frame: bigint, clipId: () => string): Command[] {
  const start = BigInt(clip.position.value);
  const length = BigInt(clip.length);
  if (frame <= start || frame >= start + length) return [];
  const left = frame - start;
  const right = length - left;
  const rightId = clipId();
  const out = clip.fadeOut;
  const outLength = out ? BigInt(out.length) : 0n;
  return [
    { op: 'clip.trim', clipId: clip.id, sourceStart: clip.sourceStart, length: left.toString() },
    ...(out ? [{ op: 'clip.set_fade', clipId: clip.id, fadeOut: { length: '0', curve: out.curve } }] : []),
    {
      op: 'clip.place',
      clipId: rightId,
      trackId: clip.trackId,
      mediaId: clip.mediaId,
      position: audio(frame),
      sourceStart: (BigInt(clip.sourceStart) + left).toString(),
      length: right.toString(),
      gainMilliDb: clip.gainMilliDb,
    },
    ...(out
      ? [{ op: 'clip.set_fade', clipId: rightId, fadeOut: { length: (outLength < right ? outLength : right).toString(), curve: out.curve } }]
      : []),
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
    clips.flatMap((clip) => placeCopy(clip, clipId(), clip.trackId, BigInt(clip.position.value) + by)),
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
    clips.flatMap((clip) => placeCopy(clip, clipId(), shiftedTrack(snapshot, clip.trackId, lanes), BigInt(clip.position.value) + delta)),
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

// What Shift+Delete's confirmation shows: the tracks it removes (those the
// snapshot holds, once each) and the revision they were read at; null when
// none is left.
export interface TrackRemoval {
  readonly trackIds: readonly string[];
  readonly revision: string;
}

export function trackRemoval(snapshot: Snapshot, trackIds: readonly string[]): TrackRemoval | null {
  const found = tracksOf(snapshot, trackIds).map((track) => track.id);
  return found.length === 0 ? null : { trackIds: found, revision: snapshot.revision };
}

// The confirmation confirmed (model/recheck.ts): `allowed` is the capability
// and the edit guard read now.
export function recheckTrackRemoval(shown: TrackRemoval, snapshot: Snapshot | null, allowed: boolean): Recheck<TrackRemoval> {
  const current = snapshot ? trackRemoval(snapshot, shown.trackIds) : null;
  return recheck(shown, current, allowed, (a, b) => sameList(a.trackIds, b.trackIds), () => (snapshot ? removeTracksCommand(snapshot, shown.trackIds) : null));
}

// ---- m5b-ui-edit-more (UI redesign spec 3.2 "Tools", "Clip handles" and
// "Editing"): glue, cut, copy, paste, repeat and nudge.

// Why two clips do not glue: the next clip is on another track, it does not
// start where the first ends (a gap or an overlap), it plays other media, or
// its source position does not continue the first's. no_next: nothing follows
// on the track.
export type GlueRefusal = 'no_next' | 'gap' | 'other_media' | 'source_not_continuous' | 'other_track';

export interface GlueRefused {
  readonly refused: GlueRefusal;
}

export function isGlueRefused(value: unknown): value is GlueRefused {
  return typeof value === 'object' && value !== null && 'refused' in value;
}

// Whether `next` continues `first`: the same track, adjacent on the timeline,
// the same media, the source running on. Null when they glue.
export function glueCheck(first: ClipEntity, next: ClipEntity): GlueRefusal | null {
  if (first.trackId !== next.trackId) return 'other_track';
  const end = BigInt(first.position.value) + BigInt(first.length);
  if (BigInt(next.position.value) !== end) return 'gap';
  if (next.mediaId !== first.mediaId) return 'other_media';
  if (BigInt(next.sourceStart) !== BigInt(first.sourceStart) + BigInt(first.length)) return 'source_not_continuous';
  return null;
}

// The audio clips of each track, by start (then id).
function lanesOf(snapshot: Snapshot): Map<string, ClipEntity[]> {
  const lanes = new Map<string, ClipEntity[]>();
  for (const clip of snapshot.clips) {
    if (clip.schema !== 'siann.entity.clip.v1' || clip.position.domain !== 'audio') continue;
    const lane = lanes.get(clip.trackId) ?? [];
    lane.push(clip);
    lanes.set(clip.trackId, lane);
  }
  for (const lane of lanes.values()) {
    lane.sort((a, b) => {
      const d = BigInt(a.position.value) - BigInt(b.position.value);
      return d < 0n ? -1 : d > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  return lanes;
}

// The clip after `clip` on its track: the nearest later start.
function nextOnTrack(lane: readonly ClipEntity[], clip: ClipEntity): ClipEntity | null {
  const index = lane.findIndex((c) => c.id === clip.id);
  return index >= 0 ? (lane[index + 1] ?? null) : null;
}

// The commands that join a run of pieces into its first: clip.remove of each
// following piece, clip.trim of the first to the run's length, and
// clip.set_fade when the fade out changes (the last piece's, "0" when it has
// none and the first had one). The first piece keeps its fade in and volume.
function joinRun(run: readonly ClipEntity[]): Command[] {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  let length = 0n;
  for (const piece of run) length += BigInt(piece.length);
  const commands: Command[] = run.slice(1).map((piece) => ({ op: 'clip.remove', clipId: piece.id }));
  commands.push({ op: 'clip.trim', clipId: first.id, sourceStart: first.sourceStart, length: length.toString() });
  if (last.fadeOut) commands.push({ op: 'clip.set_fade', clipId: first.id, fadeOut: { ...last.fadeOut } });
  else if (first.fadeOut) commands.push({ op: 'clip.set_fade', clipId: first.id, fadeOut: { length: '0', curve: first.fadeOut.curve } });
  return commands;
}

// The Glue tool: the clip and the next clip of its track, or with `all`
// (Alt-click) every following piece that continues the run; a refusal when
// the next clip does not continue this one; null for an unknown clip.
export function glueCommand(snapshot: Snapshot, clipId: string, options: { readonly all?: boolean } = {}): TimelineCommand | GlueRefused | null {
  const clip = audioClip(snapshot, clipId);
  if (!clip) return null;
  const lane = lanesOf(snapshot).get(clip.trackId) ?? [];
  const run = [clip];
  for (;;) {
    const last = run[run.length - 1]!;
    const next = nextOnTrack(lane, last);
    const refusal = next ? glueCheck(last, next) : 'no_next';
    if (refusal || !next) {
      if (run.length === 1) return { refused: refusal ?? 'no_next' };
      break;
    }
    run.push(next);
    if (!options.all) break;
  }
  return issue(snapshot, joinRun(run));
}

// edit.glue: each run of consecutive selected pieces that glue, per track in
// track order; a selected clip with no selected neighbour to join is left alone.
export function glueSelectionCommand(snapshot: Snapshot, clipIds: readonly string[]): TimelineCommand | null {
  const wanted = new Set(audioClips(snapshot, clipIds).map((c) => c.id));
  const lanes = lanesOf(snapshot);
  const commands: Command[] = [];
  for (const trackId of snapshot.trackOrder) {
    let run: ClipEntity[] = [];
    const flush = () => {
      if (run.length > 1) commands.push(...joinRun(run));
      run = [];
    };
    for (const clip of lanes.get(trackId) ?? []) {
      if (!wanted.has(clip.id)) {
        flush();
        continue;
      }
      const last = run[run.length - 1];
      if (last && glueCheck(last, clip) !== null) flush();
      run.push(clip);
    }
    flush();
  }
  return issue(snapshot, commands);
}

// One clip of the clipboard: what a paste places, its track, and its offset
// from the earliest copied clip's start.
export interface ClipboardItem extends ClipContent {
  readonly trackId: string;
  readonly offset: bigint;
}

// Copied clips (Ctrl+C, Ctrl+X): where the earliest one started and each clip.
export interface ClipboardContent {
  readonly origin: bigint;
  readonly items: readonly ClipboardItem[];
}

// Ctrl+C: the selected audio clips as a clipboard value; null when none is known.
export function copyClips(snapshot: Snapshot, clipIds: readonly string[]): ClipboardContent | null {
  const clips = audioClips(snapshot, clipIds);
  const range = span(clips);
  if (!range) return null;
  const items = clips.map(
    (clip): ClipboardItem => ({
      trackId: clip.trackId,
      mediaId: clip.mediaId,
      sourceStart: clip.sourceStart,
      length: clip.length,
      gainMilliDb: clip.gainMilliDb,
      ...(clip.fadeIn ? { fadeIn: { ...clip.fadeIn } } : {}),
      ...(clip.fadeOut ? { fadeOut: { ...clip.fadeOut } } : {}),
      offset: BigInt(clip.position.value) - range.start,
    }),
  );
  return Object.freeze({ origin: range.start, items: Object.freeze(items) });
}

// Ctrl+X once copied: clip.remove of every selected clip.
export function cutCommand(snapshot: Snapshot, clipIds: readonly string[]): TimelineCommand | null {
  return issue(
    snapshot,
    audioClips(snapshot, clipIds).map((clip) => ({ op: 'clip.remove', clipId: clip.id })),
  );
}

// Ctrl+V at the cursor, Alt+V at the origin: the clipboard placed with its
// relative positions and tracks; a clip whose track or media is gone is left out.
export function pasteCommand(snapshot: Snapshot, clipboard: ClipboardContent, at: bigint | 'origin', clipId: () => string = newClipId): TimelineCommand | null {
  const base = at === 'origin' ? clipboard.origin : at < 0n ? 0n : at;
  const lanes = new Set(snapshot.trackOrder);
  const commands: Command[] = [];
  for (const item of clipboard.items) {
    if (!lanes.has(item.trackId) || !snapshot.entities[`track:${item.trackId}`]) continue;
    if (!snapshot.entities[`media:${item.mediaId}`]) continue;
    commands.push(...placeCopy(item, clipId(), item.trackId, base + item.offset));
  }
  return issue(snapshot, commands);
}

// The most copies one repeat makes (the Ctrl+K dialog's range is 1 to it).
export const MAX_REPEAT = 99;

// Ctrl+K and the repeat handle: `count` copies of the selection, copy k
// shifted by k times the selection's span, keeping tracks and offsets.
export function repeatCommand(snapshot: Snapshot, clipIds: readonly string[], count: number, clipId: () => string = newClipId): TimelineCommand | null {
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT) return null;
  const clips = audioClips(snapshot, clipIds);
  const range = span(clips);
  if (!range) return null;
  const by = range.end - range.start;
  const commands: Command[] = [];
  for (let k = 1; k <= count; k += 1) {
    for (const clip of clips) commands.push(...placeCopy(clip, clipId(), clip.trackId, BigInt(clip.position.value) + BigInt(k) * by));
  }
  return issue(snapshot, commands);
}

// The selection's span in frames (the start of its earliest clip to the end of its latest), or 0n.
export function selectionLength(snapshot: Snapshot, clipIds: readonly string[]): bigint {
  const range = span(audioClips(snapshot, clipIds));
  return range ? range.end - range.start : 0n;
}

// The copies a drag of the repeat handle by `dx` frames makes: the drag in
// selection spans, rounded (half a span is one copy), 0 to MAX_REPEAT.
export function repeatCountFromDrag(dx: bigint, selectionSpan: bigint): number {
  if (dx <= 0n || selectionSpan <= 0n) return 0;
  const count = (2n * dx + selectionSpan) / (2n * selectionSpan);
  return count > BigInt(MAX_REPEAT) ? MAX_REPEAT : Number(count);
}

export type NudgeMode = 'position' | 'startLeft' | 'startRight' | 'endLeft' | 'endRight';

// Ctrl+Left/Right ('position', by the signed step: clip.move, the whole
// selection stopping at 0) and the Alt arrows (the step's magnitude): the
// start moved with clip.trim and clip.move (the audio stays where it is,
// within the media, the timeline's start and one frame), the end with
// clip.trim (within the media and one frame). One list for the selection.
export function nudgeCommand(snapshot: Snapshot, clipIds: readonly string[], stepFrames: bigint, mode: NudgeMode): TimelineCommand | null {
  if (stepFrames === 0n) return null;
  if (mode === 'position') return moveSelectionCommand(snapshot, clipIds, stepFrames, 0);
  const step = stepFrames < 0n ? -stepFrames : stepFrames;
  const edge = mode === 'startLeft' || mode === 'startRight' ? 'left' : 'right';
  const delta = mode === 'startLeft' || mode === 'endLeft' ? -step : step;
  const commands: Command[] = [];
  for (const clip of audioClips(snapshot, clipIds)) {
    const media = snapshot.entities[`media:${clip.mediaId}`] as MediaEntity | undefined;
    if (!media || media.schema !== 'siann.entity.media.v1') continue;
    const trimmed = snapTrim(clip, media.frames, edge, delta);
    if (trimmed.length === clip.length && trimmed.sourceStart === clip.sourceStart) continue;
    commands.push({ op: 'clip.trim', clipId: clip.id, sourceStart: trimmed.sourceStart, length: trimmed.length });
    if (edge === 'left') commands.push({ op: 'clip.move', clipId: clip.id, position: audio(BigInt(trimmed.position)) });
  }
  return issue(snapshot, commands);
}
