// Track colours (UI redesign spec 1.2 and 3.0): until the document carries a
// colour (E-2), the renderer assigns one from a stable hash of the track id,
// so a track keeps its colour across sessions, clients and restarts. The
// palette is the spec's twelve colours at equal lightness, held in tokens.css
// as --track-1..--track-12 for CSS; canvases and inline styles use these
// values. Violet stays the agent's (--ai) and is not among them.

export const TRACK_PALETTE: readonly string[] = Object.freeze([
  '#F0675B',
  '#F2994A',
  '#E6C547',
  '#A8D05A',
  '#57C98A',
  '#3FC4A8',
  '#3FC4DD',
  '#5B8FF5',
  '#7C7CF0',
  '#B57BEA',
  '#EC6BB0',
  '#9AA3B2',
]);

// FNV-1a, 32 bit, over the id's UTF-16 code units.
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function trackColour(trackId: string): string {
  return TRACK_PALETTE[hash(trackId) % TRACK_PALETTE.length]!;
}
