// Track colours (UI redesign spec 1.2 and 3.3): until the user chooses one
// (E-2), a track's colour is the palette entry --track-<n> of tokens.css with
// n a stable hash of its id (32-bit FNV-1a over the UTF-8 bytes, modulo the 12
// entries), so a track keeps its colour across windows and restarts. A clip is
// drawn in three tones of it: a title strip at 88 % over the lane background,
// a body at 26 %, and a waveform lightened 25 %. The colours themselves are
// read from the tokens; this module only mixes them. Framework-free.

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

function mix(colour: Rgb, background: Rgb, amount: number): Rgb {
  return [0, 1, 2].map((i) => colour[i]! * amount + background[i]! * (1 - amount)) as unknown as Rgb;
}

export interface ClipTones {
  readonly title: string;
  readonly body: string;
  readonly wave: string;
}

export function clipTones(colour: string, background: string): ClipTones {
  const c = parseColour(colour);
  const bg = parseColour(background);
  return {
    title: hex(mix(c, bg, 0.88)),
    body: hex(mix(c, bg, 0.26)),
    wave: hex(mix([255, 255, 255], c, 0.25)),
  };
}
