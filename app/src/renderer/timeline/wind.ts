// Rewind, forward and nudge cursor (m5b-ui-keymap). Not implemented yet.

import type { TempoPoint } from '../model/document';
import type { SnapSettings } from './snap';

export function windTarget(cursor: bigint, _direction: 1 | -1, _tempo: readonly TempoPoint[], _sampleRate: number): bigint {
  return cursor;
}

export function nudgeCursorTarget(cursor: bigint, _direction: 1 | -1, _snap: SnapSettings, _framesPerPixel: number, _tempo: readonly TempoPoint[], _sampleRate: number): bigint {
  return cursor;
}
