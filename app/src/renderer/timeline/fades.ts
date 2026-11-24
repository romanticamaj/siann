// A clip's fades in the event display (m5b-ui-fades; UI redesign 3.2, "Clip
// handles" and "How a fade is drawn"; 10.11, 23). Framework-free and DOM-free.
//
// - The gain is the architecture spec's ("siann-graph and siann-engine", clip
//   fades), the one the engine renders: curve(x) = x for linear and
//   sin(x * pi / 2) for equal power; over a clip of C frames,
//   g(n) = in(n) * out(n), in(n) = curve(n / Lin) for n < Lin, out(n) =
//   curve(m / Lout) with m = C - 1 - n for m < Lout, else 1.
// - A fade is drawn as draw() draws it, at its real length: the shade between
//   the curve and the clip's top edge below the title strip, the curve as a
//   1 px line, and the handle, draw()'s 8 x 6 px triangle with its tip at the
//   fade's end on the title strip's lower edge (x + f, and x + w - f for the
//   fade out, in the clip's box). The waveform's columns are scaled by the gain.
// - The handle's hit box is the triangle with the 4 px margin of the other
//   handles (geometry.ts HANDLE_PX); geometry.ts's hitTest takes it before
//   the edges and the body, the nearer handle where the fades meet.
// - A drag of a handle ends in one clip.set_fade naming only that side, its
//   end where the snapper puts it, clamped to 0 up to the clip's length less
//   the other side; nothing at the starting length. A side without a fade
//   takes linear, one that has a fade keeps its curve; "0" removes a side
//   (the curve still given, as the protocol checks it). A double-click
//   switches a side's curve with the same length, and sends nothing on a side
//   without a fade.

import type { ClipEntity, ClipFade } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { TimelineCommand } from './commands';
import { CLIP_TITLE_HEIGHT, HANDLE_PX, type Box } from './geometry';
import type { Snapper } from './snap';
import { MIN_HALF_HEIGHT, type WaveColumn, type WaveSpan } from './waveform';

export type FadeSide = 'fadeIn' | 'fadeOut';
export type FadeCurve = ClipFade['curve'];
export const FADE_SIDES: readonly FadeSide[] = ['fadeIn', 'fadeOut'];

// draw()'s triangle: 4 px either side of the tip, from 1 px above the title
// strip's lower edge to 5 px below it.
export const FADE_HANDLE_HALF_W = 4;
export const FADE_HANDLE_ABOVE = 1;
export const FADE_HANDLE_BELOW = 5;

// The fades of a clip: its length and its sides (absent: no fade).
export interface ClipFades {
  readonly length: string | bigint | number;
  readonly fadeIn?: ClipFade;
  readonly fadeOut?: ClipFade;
}

// The curve at x in [0, 1] (held at its ends outside).
export function fadeGain(curve: FadeCurve, x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return curve === 'equal_power' ? Math.sin((t * Math.PI) / 2) : t;
}

// The clip's fade gain at the clip offset n (0 to length - 1).
export function clipFadeGain(fades: ClipFades, n: number): number {
  const length = Number(fades.length);
  let gain = 1;
  if (fades.fadeIn) {
    const lin = Number(fades.fadeIn.length);
    if (lin > 0 && n < lin) gain *= fadeGain(fades.fadeIn.curve, n / lin);
  }
  if (fades.fadeOut) {
    const lout = Number(fades.fadeOut.length);
    const m = length - 1 - n;
    if (lout > 0 && m < lout) gain *= fadeGain(fades.fadeOut.curve, m / lout);
  }
  return gain;
}

// A fade's length in CSS pixels at the zoom.
export function fadePx(frames: string | bigint | number, framesPerPixel: number): number {
  return Number(frames) / framesPerPixel;
}

export interface FadeHandle extends Box {
  // The tip's x (the fade's end), and the triangle's three corners.
  readonly tipX: number;
  readonly points: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
}

// draw()'s handle of one side of a clip's box, `fadePx` from its edge.
export function fadeHandle(box: Box, side: FadeSide, px: number): FadeHandle {
  const tipX = side === 'fadeIn' ? box.x + px : box.x + box.width - px;
  const edge = box.y + Math.min(CLIP_TITLE_HEIGHT, box.height);
  const top = edge - FADE_HANDLE_ABOVE;
  const bottom = edge + FADE_HANDLE_BELOW;
  return {
    tipX,
    x: tipX - FADE_HANDLE_HALF_W,
    y: top,
    width: 2 * FADE_HANDLE_HALF_W,
    height: bottom - top,
    points: [
      [tipX - FADE_HANDLE_HALF_W, top],
      [tipX + FADE_HANDLE_HALF_W, top],
      [tipX, bottom],
    ],
  };
}

// Where a pointer takes the handle: its box with the other handles' margin.
export function fadeHandleHitBox(handle: Box): Box {
  return { x: handle.x - HANDLE_PX, y: handle.y - HANDLE_PX, width: handle.width + 2 * HANDLE_PX, height: handle.height + 2 * HANDLE_PX };
}

const inside = (b: Box, x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;

// The curve's y at the fraction u (0 at the clip's edge, 1 at the fade's end)
// of a fade: the bottom of the box at gain 0, the title strip's lower edge at 1.
function curveY(box: Box, curve: FadeCurve, u: number): number {
  const title = Math.min(CLIP_TITLE_HEIGHT, box.height);
  return box.y + box.height - fadeGain(curve, u) * (box.height - title);
}

// Whether (x, y) is in the shaded area of a side: between its curve and the
// top edge below the title strip, within the fade's length.
export function fadeAreaContains(box: Box, side: FadeSide, px: number, curve: FadeCurve, x: number, y: number): boolean {
  if (!(px > 0)) return false;
  const from = side === 'fadeIn' ? x - box.x : box.x + box.width - x;
  if (from < 0 || from >= px || x < box.x || x >= box.x + box.width) return false;
  const title = box.y + Math.min(CLIP_TITLE_HEIGHT, box.height);
  return y >= title && y < curveY(box, curve, from / px);
}

// The points of a side's curve from the clip's lower corner to the fade's end
// on the title strip's lower edge, one per CSS pixel (at least two).
export function fadeCurvePoints(box: Box, side: FadeSide, px: number, curve: FadeCurve): Array<readonly [number, number]> {
  const steps = Math.max(1, Math.ceil(px));
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const d = (px * i) / steps;
    points.push([side === 'fadeIn' ? box.x + d : box.x + box.width - d, curveY(box, curve, px > 0 ? d / px : 1)]);
  }
  return points;
}

// The shaded area's outline: the curve, then along the top edge back to the clip's edge.
export function fadeShadePoints(box: Box, side: FadeSide, px: number, curve: FadeCurve): Array<readonly [number, number]> {
  const title = box.y + Math.min(CLIP_TITLE_HEIGHT, box.height);
  const edge = side === 'fadeIn' ? box.x : box.x + box.width;
  return [[edge, title], ...fadeCurvePoints(box, side, px, curve)];
}

export interface FadedRect {
  // The CSS x of the clip's position, its length in frames, its fades.
  readonly x: number;
  readonly length: string;
  readonly fadeIn?: ClipFade;
  readonly fadeOut?: ClipFade;
}

function scaled(span: WaveSpan, gain: number): WaveSpan {
  let up = span.up * gain;
  let down = span.down * gain;
  if (up + down < 2 * MIN_HALF_HEIGHT) {
    const centre = (up - down) / 2;
    up = centre + MIN_HALF_HEIGHT;
    down = MIN_HALF_HEIGHT - centre;
  }
  return { up, down };
}

// The waveform's columns with each one's spans times the gain at its middle
// frame (the clip offset under the column's centre); the same array when the
// clip has no fade.
export function fadeScaledColumns(columns: readonly WaveColumn[], rect: FadedRect, framesPerPixel: number): readonly WaveColumn[] {
  if (!rect.fadeIn && !rect.fadeOut) return columns;
  const length = Number(rect.length);
  return columns.map((c) => {
    const n = Math.min(length - 1, Math.max(0, Math.floor((c.x + c.w / 2 - rect.x) * framesPerPixel)));
    const gain = clipFadeGain(rect as ClipFades, n);
    if (gain === 1) return c;
    const outerSpan = scaled(c.outerSpan, gain);
    const innerSpan = scaled(c.innerSpan, gain);
    return { ...c, outerSpan, innerSpan, outer: (outerSpan.up + outerSpan.down) / 2, inner: (innerSpan.up + innerSpan.down) / 2 };
  });
}

function clipOf(snapshot: Snapshot, clipId: string): ClipEntity | null {
  const clip = snapshot.entities[`clip:${clipId}`] as ClipEntity | undefined;
  return clip && clip.schema === 'siann.entity.clip.v1' && clip.position.domain === 'audio' ? clip : null;
}

const lengthOf = (fade: ClipFade | undefined) => (fade ? BigInt(fade.length) : 0n);

// The side's length a drag that ends at the timeline frame `end` gives:
// snapped, then clamped to 0 up to the clip's length less the other side.
export function fadeDragLength(clip: ClipEntity, side: FadeSide, end: bigint, snap: Snapper): bigint {
  const start = BigInt(clip.position.value);
  const length = BigInt(clip.length);
  const at = snap(end);
  const wanted = side === 'fadeIn' ? at - start : start + length - at;
  const other = lengthOf(side === 'fadeIn' ? clip.fadeOut : clip.fadeIn);
  const most = length - other < 0n ? 0n : length - other;
  return wanted < 0n ? 0n : wanted > most ? most : wanted;
}

// One clip.set_fade of `side` at `length` frames, or null when it is the length the side has.
export function fadeSetCommand(snapshot: Snapshot, clip: ClipEntity, side: FadeSide, length: bigint): TimelineCommand | null {
  const fade = clip[side];
  if (length === lengthOf(fade)) return null;
  const curve: FadeCurve = fade?.curve ?? 'linear';
  return { expectedRevision: snapshot.revision, commands: [{ op: 'clip.set_fade', clipId: clip.id, [side]: { length: length.toString(), curve } }] };
}

// The release of a handle drag whose fade ends at the timeline frame `end`.
export function fadeDragCommand(snapshot: Snapshot, clipId: string, side: FadeSide, end: bigint, snap: Snapper): TimelineCommand | null {
  const clip = clipOf(snapshot, clipId);
  if (!clip) return null;
  return fadeSetCommand(snapshot, clip, side, fadeDragLength(clip, side, end, snap));
}

// A double-click on a side's handle or shaded area: its curve switched, the same length.
export function fadeCurveToggleCommand(snapshot: Snapshot, clipId: string, side: FadeSide): TimelineCommand | null {
  const clip = clipOf(snapshot, clipId);
  const fade = clip?.[side];
  if (!clip || !fade) return null;
  const curve: FadeCurve = fade.curve === 'linear' ? 'equal_power' : 'linear';
  return { expectedRevision: snapshot.revision, commands: [{ op: 'clip.set_fade', clipId: clip.id, [side]: { length: fade.length, curve } }] };
}

// ---- milliseconds (UI redesign 3.2, "Info line"; 6.2): "<n> ms", the same in every locale.

// Frames as whole milliseconds, rounded half up.
export function framesToMs(frames: string | bigint, sampleRate: number): bigint {
  const rate = BigInt(Math.max(1, Math.round(sampleRate)));
  return (BigInt(frames) * 2000n + rate) / (2n * rate);
}

export function formatMs(frames: string | bigint, sampleRate: number): string {
  return `${framesToMs(frames, sampleRate)} ms`;
}

// Milliseconds as frames: round(ms * sampleRate / 1000), half up.
export function msToFrames(ms: number, sampleRate: number): bigint {
  const rate = BigInt(Math.max(1, Math.round(sampleRate)));
  return (BigInt(ms) * rate * 2n + 1000n) / 2000n;
}

// The handle, box and fade of each side of a clip as the canvas hits them.
export function fadeHandles(box: Box, fades: { readonly fadeIn?: ClipFade; readonly fadeOut?: ClipFade }, framesPerPixel: number): Record<FadeSide, FadeHandle> {
  return {
    fadeIn: fadeHandle(box, 'fadeIn', fadePx(lengthOf(fades.fadeIn), framesPerPixel)),
    fadeOut: fadeHandle(box, 'fadeOut', fadePx(lengthOf(fades.fadeOut), framesPerPixel)),
  };
}

// The fade handle under (x, y) in a clip's box, the nearer one where both
// boxes take it (on a tie, left of the fade in's tip is the fade in), or null.
export function fadeHandleAt(box: Box, fades: { readonly fadeIn?: ClipFade; readonly fadeOut?: ClipFade }, framesPerPixel: number, x: number, y: number): FadeSide | null {
  const handles = fadeHandles(box, fades, framesPerPixel);
  const hitIn = inside(fadeHandleHitBox(handles.fadeIn), x, y);
  const hitOut = inside(fadeHandleHitBox(handles.fadeOut), x, y);
  if (hitIn && hitOut) {
    const dIn = Math.abs(x - handles.fadeIn.tipX);
    const dOut = Math.abs(x - handles.fadeOut.tipX);
    if (dIn !== dOut) return dIn < dOut ? 'fadeIn' : 'fadeOut';
    return x < handles.fadeIn.tipX ? 'fadeIn' : 'fadeOut';
  }
  return hitIn ? 'fadeIn' : hitOut ? 'fadeOut' : null;
}

// The side a hit part belongs to (a handle or a shaded area), or null: what a
// double-click there switches. m5b-ui-editor-channel's double-click on the
// body comes after this one (UI redesign 3.2; 10.11, 10).
export function fadeSideOf(part: string | null | undefined): FadeSide | null {
  if (part === 'fadeIn' || part === 'fadeInArea') return 'fadeIn';
  if (part === 'fadeOut' || part === 'fadeOutArea') return 'fadeOut';
  return null;
}

// The side whose shaded area holds (x, y), or null.
export function fadeAreaAt(box: Box, fades: { readonly fadeIn?: ClipFade; readonly fadeOut?: ClipFade }, framesPerPixel: number, x: number, y: number): FadeSide | null {
  for (const side of FADE_SIDES) {
    const fade = fades[side];
    if (fade && fadeAreaContains(box, side, fadePx(fade.length, framesPerPixel), fade.curve, x, y)) return side;
  }
  return null;
}
