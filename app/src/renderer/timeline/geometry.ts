// Stub: the timeline geometry lands with the implementation.

import type { ClipEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';

export interface Viewport {
  readonly framesPerPixel: number;
  readonly scrollFrames: string;
  readonly rulerHeight: number;
  readonly laneHeight: number;
  readonly width: number;
}

export interface ClipRect {
  readonly clipId: string;
  readonly trackId: string;
  readonly mediaId: string;
  readonly sourceStart: string;
  readonly length: string;
  readonly position: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type HitPart = 'body' | 'left' | 'right';
export type TrimEdge = 'left' | 'right';

export const HANDLE_PX = 6;

export function frameToX(_frame: string | bigint, _view: Viewport): number {
  return Number.NaN;
}
export function xToFrame(_x: number, _view: Viewport): bigint {
  return -1n;
}
export function deltaFrames(_dx: number, _view: Viewport): bigint {
  return -1n;
}
export function trackAt(_snapshot: Snapshot, _y: number, _view: Viewport): string | null {
  return null;
}
export function clipRects(_snapshot: Snapshot, _view: Viewport): ClipRect[] {
  return [];
}
export function hitTest(_rects: readonly ClipRect[], _x: number, _y: number): { rect: ClipRect; part: HitPart } | null {
  return null;
}
export function snapMove(_position: string, _delta: bigint): string {
  return '';
}
export function snapTrim(_clip: ClipEntity, _mediaFrames: string, _edge: TrimEdge, _delta: bigint): { position: string; sourceStart: string; length: string } {
  return { position: '', sourceStart: '', length: '' };
}
