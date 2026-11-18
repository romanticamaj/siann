// Track colours (UI redesign spec 1.2 and 3.3): until the user chooses one
// (E-2), a track's colour is the palette entry --track-<n> of tokens.css with
// n a stable hash of its id (32-bit FNV-1a over the UTF-8 bytes, modulo the 12
// entries), so a track keeps its colour across windows and restarts. A clip is
// drawn in the palette of the mockup's draw() (m5-ui-port-arrange-canvas):
// clipPalette. The colours themselves are read from the tokens; this module
// only mixes them. Framework-free.

export const TRACK_PALETTE_SIZE = 12;

export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function trackColourIndex(trackId: string): number {
  return fnv1a32(trackId) % TRACK_PALETTE_SIZE;
}

// The custom property holding a track's colour.
export function trackColourVar(trackId: string): string {
  return `--track-${trackColourIndex(trackId)}`;
}

type Rgb = readonly [number, number, number];

// #rgb, #rrggbb or rgb(r, g, b) / rgb(r g b); black for anything else.
export function parseColour(text: string): Rgb {
  const value = text.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return [parseInt(short[1]! + short[1]!, 16), parseInt(short[2]! + short[2]!, 16), parseInt(short[3]! + short[3]!, 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(value);
  if (long) return [parseInt(long[1]!, 16), parseInt(long[2]!, 16), parseInt(long[3]!, 16)];
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [0, 0, 0];
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

// The mockup's mixHex: a + (b - a) * t per channel, rounded.
export function mix(a: string, b: string, t: number): string {
  const from = parseColour(a);
  const to = parseColour(b);
  return hex([0, 1, 2].map((i) => from[i]! + (to[i]! - from[i]!) * t) as unknown as Rgb);
}

// The tokens a clip's palette is mixed with (tokens.css, read by the caller).
export interface ClipPaletteTokens {
  // --bg-well
  readonly bgWell: string;
  // --select
  readonly select: string;
  // --black-a550, the outline of a clip that is not selected
  readonly outline: string;
}

export interface ClipPalette {
  readonly body: string;
  readonly title: string;
  readonly titleText: string;
  // The waveform's outer layer, drawn at waveOuterAlpha (by globalAlpha, never an rgba string).
  readonly waveOuter: string;
  readonly waveOuterAlpha: number;
  readonly waveInner: string;
  readonly outline: string;
  readonly outlineWidth: number;
}

// The outline's width: a clip's, and a selected clip's.
export const OUTLINE_W = 1;
export const SELECTED_OUTLINE_W = 1.5;

// draw()'s clip(): the body is the track's colour mixed 74 % into --bg-well
// (62 % selected); the title strip 12 % into --bg-well, or 12 % into --select
// when selected, with its text in --bg-well; the waveform's outer layer 12 %
// into --select (28 % selected) at 50 % alpha, its inner layer 25 % into
// --select (45 % selected); the outline --black-a550 at 1 px, or --select at
// 1.5 px when selected.
export function clipPalette(track: string, tokens: ClipPaletteTokens, selected: boolean): ClipPalette {
  return {
    body: mix(track, tokens.bgWell, selected ? 0.62 : 0.74),
    title: selected ? mix(track, tokens.select, 0.12) : mix(track, tokens.bgWell, 0.12),
    titleText: tokens.bgWell,
    waveOuter: mix(track, tokens.select, selected ? 0.28 : 0.12),
    waveOuterAlpha: 0.5,
    waveInner: mix(track, tokens.select, selected ? 0.45 : 0.25),
    outline: selected ? tokens.select : tokens.outline,
    outlineWidth: selected ? SELECTED_OUTLINE_W : OUTLINE_W,
  };
}
