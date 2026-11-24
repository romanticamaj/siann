// The sample editor's model (m5b-ui-editor-channel; UI redesign 2.1, 5.2,
// UR-18), pure: which clip the lower zone's Editor tab shows, where the clip's
// range lies over its whole source at the editor's own zoom, what a point
// hits, and the one command a release sends.
//
// - The clip is the app's selectedClipId, the primary one the info line reads.
// - The view is a timeline Viewport (geometry.ts) of the editor's own: its x
//   is the session's frame, so the ruler reads the session's bars, and the
//   source is drawn from the clip's position less its source start; the clip's
//   range [position, position + length) is the source [sourceStart,
//   sourceStart + length). The first view shows the whole source; H and G
//   zoom about the range's centre (zoom.ts), kept by the editor, not the layout.
// - Dragging an end of the range is the event display's trim: the same
//   gestureCommand (timeline/commands.ts), snapped by the same snap settings
//   and snapperFor at the editor's zoom, Ctrl (Cmd on macOS) without snap
//   (keys/tool-modifiers.ts); the volume control is its clip.set_gain
//   (clipGainCommand, gainFromDrag; Shift fine). A release under the drag
//   threshold, or one that changes nothing, sends nothing. Every command goes
//   through `allows`: the engine lists its ops and the edit guard does not
//   hold them (editorAllows).
// Framework-free.

import { isStructural, structuralBlocked } from '../model/edit-guard';
import type { ClipEntity, MediaEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { toolModifiers, type ModifierFlags } from '../keys/tool-modifiers';
import { gestureCommand, type TimelineCommand } from '../timeline/commands';
import { clipGainCommand, gainFromDrag } from '../timeline/edit-commands';
import { DRAG_THRESHOLD_PX, HANDLE_PX, RULER_HEIGHT, deltaFrames, frameToX, gainBox, type Box, type Viewport } from '../timeline/geometry';
import { snapContext, snapperFor, type SnapSettings } from '../timeline/snap';
import { ZOOM_STEP, zoomAbout, zoomToRange } from '../timeline/zoom';

export interface EditorClip {
  readonly clip: ClipEntity;
  readonly media: MediaEntity;
}

// The clip the editor shows: the selected (primary) clip, in the audio domain, with its media.
export function editorClip(snapshot: Snapshot | null, selectedClipId: string | null): EditorClip | null {
  if (!snapshot || !selectedClipId) return null;
  const clip = snapshot.entities[`clip:${selectedClipId}`] as ClipEntity | undefined;
  if (!clip || clip.schema !== 'siann.entity.clip.v1' || clip.position.domain !== 'audio') return null;
  const media = snapshot.entities[`media:${clip.mediaId}`] as MediaEntity | undefined;
  if (!media || media.schema !== 'siann.entity.media.v1') return null;
  return { clip, media };
}

// The session frame the source's first frame is drawn at (it may be before 0).
export function sourceOrigin(clip: ClipEntity): bigint {
  return BigInt(clip.position.value) - BigInt(clip.sourceStart);
}

// The range's ends in CSS px.
export function rangePixels(clip: ClipEntity, view: Viewport): { start: number; end: number } {
  const start = BigInt(clip.position.value);
  return { start: frameToX(start, view), end: frameToX(start + BigInt(clip.length), view) };
}

// The whole source's ends in CSS px.
export function sourcePixels(clip: ClipEntity, media: MediaEntity, view: Viewport): { start: number; end: number } {
  const origin = sourceOrigin(clip);
  return { start: frameToX(origin, view), end: frameToX(origin + BigInt(media.frames), view) };
}

// The first view: the whole source across the width, with the event display's margin.
export function editorView(clip: ClipEntity, media: MediaEntity, width: number, height: number): Viewport {
  const origin = sourceOrigin(clip);
  const base: Viewport = { framesPerPixel: 1, scrollFrames: '0', rulerHeight: RULER_HEIGHT, lanesTop: RULER_HEIGHT, laneHeight: Math.max(1, height - RULER_HEIGHT), width: Math.max(1, width), height: Math.max(1, height) };
  return zoomToRange(base, origin, origin + BigInt(media.frames));
}

// The range as a box under the ruler: the clip's box the volume control sits in.
function rangeBox(clip: ClipEntity, view: Viewport): Box {
  const { start, end } = rangePixels(clip, view);
  return { x: start, y: RULER_HEIGHT, width: end - start, height: (view.height ?? 0) - RULER_HEIGHT };
}

// The volume control: draw()'s box at the range's lower left, as on the clip (null where it does not fit).
export function editorGainBox(clip: ClipEntity, view: Viewport): Box | null {
  return gainBox(rangeBox(clip, view));
}

export type EditorPart = 'rangeStart' | 'rangeEnd' | 'gain' | 'body';

// What a point hits: an end of the range (HANDLE_PX either side, the nearer
// one), the volume control, the range's body; nothing on the ruler or outside the range.
export function editorHit(clip: ClipEntity, view: Viewport, x: number, y: number): EditorPart | null {
  if (y < RULER_HEIGHT || y >= (view.height ?? 0)) return null;
  const { start, end } = rangePixels(clip, view);
  const toStart = Math.abs(x - start);
  const toEnd = Math.abs(x - end);
  if (toStart <= HANDLE_PX || toEnd <= HANDLE_PX) return toStart < toEnd ? 'rangeStart' : 'rangeEnd';
  if (x < start || x >= end) return null;
  const gain = editorGainBox(clip, view);
  if (gain && x >= gain.x && x < gain.x + gain.width && y >= gain.y && y < gain.y + gain.height) return 'gain';
  return 'body';
}

// H (direction 1, in) and G (-1, out): halve or double the frames per pixel
// about the range's centre, or the view's nearest edge while the range is out of view.
export function zoomEditor(view: Viewport, clip: ClipEntity, direction: 1 | -1): Viewport {
  const { start, end } = rangePixels(clip, view);
  const anchor = Math.min(view.width, Math.max(0, (start + end) / 2));
  return zoomAbout(view, anchor, direction === 1 ? 1 / ZOOM_STEP : ZOOM_STEP);
}

// Whether `op` may be sent: the engine lists it and the edit guard does not hold it.
export function editorAllows(listed: (op: string) => boolean, heard: string | null): (op: string) => boolean {
  return (op) => listed(op) && !(isStructural(op) && structuralBlocked(heard));
}

export interface EditorEnv {
  readonly platform: 'mac' | 'other';
  readonly flags: ModifierFlags;
  readonly allows: (op: string) => boolean;
}

export interface RangeEnv extends EditorEnv {
  readonly snap: SnapSettings;
  // The project cursor, for Magnetic Cursor (null: unknown).
  readonly cursor?: bigint | null;
}

export interface DragDelta {
  readonly clipId: string;
  readonly dx: number;
  readonly dy: number;
}

function moved({ dx, dy }: Pick<DragDelta, 'dx' | 'dy'>): boolean {
  return Math.abs(dx) >= DRAG_THRESHOLD_PX || Math.abs(dy) >= DRAG_THRESHOLD_PX;
}

// The session frame an end of the range lands on after a drag of dx px: the
// event display's snapped trim (snapped unless Ctrl), never before 0.
export function rangeDragTarget(snapshot: Snapshot, clip: ClipEntity, edge: 'left' | 'right', dx: number, view: Viewport, env: RangeEnv): { at: bigint; target: bigint; snapped: boolean } {
  const mods = toolModifiers(env.flags, env.platform);
  const type = env.snap.type ?? 'grid';
  const context = type === 'events' || type === 'cursor' ? snapContext(snapshot, [clip.id], type === 'cursor' ? (env.cursor ?? null) : null) : undefined;
  const snap = snapperFor(env.snap, view.framesPerPixel, snapshot.root?.tempo ?? [], snapshot.root?.sampleRate ?? 48000, mods.noSnap, BigInt(view.scrollFrames), context);
  const start = BigInt(clip.position.value);
  const at = edge === 'right' ? start + BigInt(clip.length) : start;
  const raw = at + deltaFrames(dx, view);
  return { at, target: snap(raw < 0n ? 0n : raw), snapped: env.snap.on && !mods.noSnap };
}

// A release of a drag of an end of the range: the event display's trim, or null.
export function rangeDragCommand(snapshot: Snapshot, drag: DragDelta & { readonly edge: 'left' | 'right' }, view: Viewport, env: RangeEnv): TimelineCommand | null {
  if (!moved(drag)) return null;
  const clip = snapshot.entities[`clip:${drag.clipId}`] as ClipEntity | undefined;
  if (!clip || clip.schema !== 'siann.entity.clip.v1' || clip.position.domain !== 'audio') return null;
  if (!env.allows('clip.trim') || (drag.edge === 'left' && !env.allows('clip.move'))) return null;
  const { at, target } = rangeDragTarget(snapshot, clip, drag.edge, drag.dx, view, env);
  return gestureCommand(snapshot, { kind: 'trim', clipId: clip.id, edge: drag.edge, deltaFrames: target - at });
}

// The gain a vertical drag of the volume control reaches (Shift fine).
export function gainDragValue(clip: ClipEntity, dy: number, env: Pick<EditorEnv, 'platform' | 'flags'>): number {
  return gainFromDrag(clip.gainMilliDb, dy, toolModifiers(env.flags, env.platform).fine);
}

// A release of a drag of the volume control: one clip.set_gain, or null.
export function gainDragCommand(snapshot: Snapshot, drag: DragDelta, env: EditorEnv): TimelineCommand | null {
  if (!moved(drag) || !env.allows('clip.set_gain')) return null;
  const clip = snapshot.entities[`clip:${drag.clipId}`] as ClipEntity | undefined;
  if (!clip || clip.schema !== 'siann.entity.clip.v1') return null;
  return clipGainCommand(snapshot, clip.id, gainDragValue(clip, drag.dy, env));
}
