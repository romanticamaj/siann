// The ghost model (m5b-ui-ghosts; UI redesign 4.2, P2-1). Stub: the
// descriptors' shape, no ghosts yet.

import type { Snapshot } from '../model/read-model';
import type { PlanPreview } from './diff';

export interface LocatorPair {
  readonly left: string;
  readonly right: string;
}

export type Ghost =
  | { readonly kind: 'track-add'; readonly step: number; readonly trackId: string; readonly name: string; readonly channels: number | null; readonly key: string }
  | { readonly kind: 'clip-place'; readonly step: number; readonly clipId: string; readonly trackId: string; readonly mediaId: string; readonly position: string; readonly sourceStart: string; readonly length: string }
  | {
      readonly kind: 'clip-move';
      readonly step: number;
      readonly clipId: string;
      readonly mediaId: string;
      readonly fromTrackId: string;
      readonly trackId: string;
      readonly from: string;
      readonly position: string;
      readonly sourceStart: string;
      readonly length: string;
    }
  | {
      readonly kind: 'clip-trim';
      readonly step: number;
      readonly clipId: string;
      readonly mediaId: string;
      readonly trackId: string;
      readonly position: string;
      readonly from: { readonly sourceStart: string; readonly length: string };
      readonly to: { readonly sourceStart: string; readonly length: string };
    }
  | {
      readonly kind: 'clip-remove';
      readonly step: number;
      readonly clipId: string;
      readonly mediaId: string;
      readonly trackId: string;
      readonly position: string;
      readonly sourceStart: string;
      readonly length: string;
      readonly cascade: boolean;
    }
  | { readonly kind: 'track-remove'; readonly step: number; readonly trackId: string }
  | { readonly kind: 'gain' | 'pan'; readonly step: number; readonly trackId: string; readonly before: number | null; readonly after: number }
  | { readonly kind: 'mute' | 'solo'; readonly step: number; readonly trackId: string; readonly before: boolean | null; readonly after: boolean }
  | { readonly kind: 'rename'; readonly step: number; readonly trackId: string; readonly before: string | null; readonly after: string }
  | { readonly kind: 'locators'; readonly step: number; readonly before: LocatorPair | null; readonly after: LocatorPair };

export function ghostsOf(
  _steps: readonly Record<string, unknown>[],
  _preview: PlanPreview | null,
  _snapshot: Snapshot | null,
  _ticked: ReadonlySet<number> | null,
): Ghost[] {
  return [];
}
