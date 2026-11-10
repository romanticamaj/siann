// A finished timeline gesture as the one command.execute it ends in (spec,
// "Frontend"): a placement is clip.place with a client-chosen clp_<hex> id, a
// drop clip.move (with trackId only when the track changed), the right trim
// handle clip.trim, the left one clip.trim and clip.move together (the audio
// stays put), delete clip.remove. Every command list carries the snapshot's
// revision as expectedRevision, so a commit by anyone else in between is a
// revision_mismatch and nothing changes. A gesture that changes nothing, or
// names an entity the snapshot does not hold, issues nothing (null).
// Framework-free.

import type { ClipEntity, MediaEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { snapMove, snapTrim, type TrimEdge } from './geometry';

export type TimelineGesture =
  | { readonly kind: 'place'; readonly mediaId: string; readonly trackId: string; readonly position: bigint }
  | { readonly kind: 'move'; readonly clipId: string; readonly deltaFrames: bigint; readonly trackId: string }
  | { readonly kind: 'trim'; readonly clipId: string; readonly edge: TrimEdge; readonly deltaFrames: bigint }
  | { readonly kind: 'delete'; readonly clipId: string };

export interface TimelineCommand {
  readonly expectedRevision: string;
  readonly commands: ReadonlyArray<Record<string, unknown>>;
}

// clp_ and 16 random lowercase hex digits (ids are client-chosen for pure commands).
export function newClipId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `clp_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function audio(value: string): { domain: 'audio'; value: string } {
  return { domain: 'audio', value };
}

export function gestureCommand(
  snapshot: Snapshot,
  gesture: TimelineGesture,
  clipId: () => string = newClipId,
): TimelineCommand | null {
  const issue = (commands: Array<Record<string, unknown>>): TimelineCommand => ({ expectedRevision: snapshot.revision, commands });
  if (gesture.kind === 'place') {
    const media = snapshot.entities[`media:${gesture.mediaId}`] as MediaEntity | undefined;
    if (!media || !snapshot.entities[`track:${gesture.trackId}`]) return null;
    return issue([
      {
        op: 'clip.place',
        clipId: clipId(),
        trackId: gesture.trackId,
        mediaId: gesture.mediaId,
        position: audio(snapMove('0', gesture.position)),
        sourceStart: '0',
        length: media.frames,
      },
    ]);
  }
  const clip = snapshot.entities[`clip:${gesture.clipId}`] as ClipEntity | undefined;
  if (!clip || clip.position.domain !== 'audio') return null;
  if (gesture.kind === 'delete') return issue([{ op: 'clip.remove', clipId: clip.id }]);
  if (gesture.kind === 'move') {
    if (!snapshot.entities[`track:${gesture.trackId}`]) return null;
    const position = snapMove(clip.position.value, gesture.deltaFrames);
    const trackChanged = gesture.trackId !== clip.trackId;
    if (!trackChanged && position === clip.position.value) return null;
    const move: Record<string, unknown> = { op: 'clip.move', clipId: clip.id, position: audio(position) };
    if (trackChanged) move.trackId = gesture.trackId;
    return issue([move]);
  }
  const media = snapshot.entities[`media:${clip.mediaId}`] as MediaEntity | undefined;
  if (!media) return null;
  const trimmed = snapTrim(clip, media.frames, gesture.edge, gesture.deltaFrames);
  if (trimmed.length === clip.length && trimmed.sourceStart === clip.sourceStart) return null;
  const trim = { op: 'clip.trim', clipId: clip.id, sourceStart: trimmed.sourceStart, length: trimmed.length };
  if (gesture.edge === 'right') return issue([trim]);
  return issue([trim, { op: 'clip.move', clipId: clip.id, position: audio(trimmed.position) }]);
}
