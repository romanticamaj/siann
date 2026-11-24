// Rewind, forward and nudge cursor (m5b-ui-keymap; UI redesign 3.1, 3.6;
// research/cubase.md 7.1): where Num - / Num + (and - / = off the keypad) and
// Ctrl+Num - / Ctrl+Num + (Ctrl+- / Ctrl+=) send the project cursor, as a
// frame for transport.locate. Rewind and forward move one bar per key event,
// so the key's repeat winds; nudge cursor moves one step of the snap grid
// (the toolbar's grid type, Adapt to Zoom at the event display's zoom),
// whether snap is on or not. Both count in musical ticks through the tempo
// map, so a bar is a bar across a tempo change, and never go before the
// project start. Framework-free; no document revision.

import type { TempoPoint } from '../model/document';
import { TICKS_PER_BAR, framesToTicks, ticksToFrames } from './musical-time';
import { gridStepTicks, pixelsPerTick, type SnapSettings } from './snap';

function moved(cursor: bigint, ticks: number, tempo: readonly TempoPoint[], sampleRate: number): bigint {
  const at = framesToTicks(Number(cursor < 0n ? 0n : cursor), tempo, sampleRate) + ticks;
  if (at <= 0) return 0n;
  return BigInt(Math.max(0, Math.round(ticksToFrames(at, tempo, sampleRate))));
}

// One bar back (-1) or on (1) from the cursor.
export function windTarget(cursor: bigint, direction: 1 | -1, tempo: readonly TempoPoint[], sampleRate: number): bigint {
  return moved(cursor, direction * TICKS_PER_BAR, tempo, sampleRate);
}

// One grid step back (-1) or on (1) from the cursor, the step the event
// display's grid shows at the cursor at this zoom.
export function nudgeCursorTarget(cursor: bigint, direction: 1 | -1, snap: SnapSettings, framesPerPixel: number, tempo: readonly TempoPoint[], sampleRate: number): bigint {
  const step = gridStepTicks(snap.grid, pixelsPerTick(framesPerPixel, tempo, sampleRate, cursor < 0n ? 0n : cursor));
  return moved(cursor, direction * step, tempo, sampleRate);
}
