// Stub: the gesture commands land with the implementation.

import type { Snapshot } from '../model/read-model';
import type { TrimEdge } from './geometry';

export type TimelineGesture =
  | { readonly kind: 'place'; readonly mediaId: string; readonly trackId: string; readonly position: bigint }
  | { readonly kind: 'move'; readonly clipId: string; readonly deltaFrames: bigint; readonly trackId: string }
  | { readonly kind: 'trim'; readonly clipId: string; readonly edge: TrimEdge; readonly deltaFrames: bigint }
  | { readonly kind: 'delete'; readonly clipId: string };

export interface TimelineCommand {
  readonly expectedRevision: string;
  readonly commands: ReadonlyArray<Record<string, unknown>>;
}

export function newClipId(): string {
  return '';
}

export function gestureCommand(_snapshot: Snapshot, _gesture: TimelineGesture, _clipId: () => string = newClipId): TimelineCommand | null {
  return null;
}
