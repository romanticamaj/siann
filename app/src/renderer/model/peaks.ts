// Peak pyramids as the engine serves them (docs/schemas/protocol-peaks-v0.md,
// spec Protocol v0 item 23): a decoder of the .peaks file, the level a zoom
// draws, and one pixel column's min and max. Framework-free and DOM-free.
//
// Frames are numbers here: the format's longest media (256 * 4^11 frames) is
// far below 2^53.

export class PeaksError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PeaksError';
  }
}

export interface PeakLevel {
  readonly binFrames: number;
  readonly binCount: number;
  // binCount * channels pairs {min, max}, channel-interleaved.
  readonly values: Int16Array;
}

export interface PeakPyramid {
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly levels: readonly PeakLevel[];
}

const BASE_BIN_FRAMES = 256;
const MAX_LEVEL = 11;
const HEADER_BYTES = 20;
const LEVEL_HEADER_BYTES = 8;

function refuse(why: string): never {
  throw new PeaksError('decode_failed', `not a peak pyramid: ${why}`);
}

// The bin counts the frames imply, the last the first of at most one bin.
function binCounts(frames: number): number[] {
  const counts: number[] = [];
  for (let level = 0; level <= MAX_LEVEL; level += 1) {
    const count = Math.ceil(frames / (BASE_BIN_FRAMES * 4 ** level));
    counts.push(count);
    if (count <= 1) return counts;
  }
  return refuse('more frames than the format holds');
}

export function decodePeaks(input: ArrayBuffer | Uint8Array): PeakPyramid {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_BYTES) refuse('shorter than its header');
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'SPKS') refuse('bad magic');
  if (view.getUint8(4) !== 1) refuse(`version ${view.getUint8(4)}`);
  if (view.getUint8(7) !== 0) refuse('reserved byte set');
  const channels = view.getUint8(5);
  const levelCount = view.getUint8(6);
  const frames64 = view.getBigUint64(8, true);
  if (channels < 1) refuse('no channels');
  if (frames64 > BigInt(BASE_BIN_FRAMES * 4 ** MAX_LEVEL)) refuse('more frames than the format holds');
  const frames = Number(frames64);
  const sampleRate = view.getUint32(16, true);
  const counts = binCounts(frames);
  if (levelCount !== counts.length) refuse(`${levelCount} levels where the frames imply ${counts.length}`);
  const levels: PeakLevel[] = [];
  let at = HEADER_BYTES;
  for (let k = 0; k < levelCount; k += 1) {
    if (bytes.byteLength - at < LEVEL_HEADER_BYTES) refuse(`cut off in level ${k}`);
    const binFrames = view.getUint32(at, true);
    const binCount = view.getUint32(at + 4, true);
    at += LEVEL_HEADER_BYTES;
    if (binFrames !== BASE_BIN_FRAMES * 4 ** k || binCount !== counts[k]) refuse(`level ${k} is not laid out as its frames imply`);
    const count = binCount * channels * 2;
    if (bytes.byteLength - at < count * 2) refuse(`cut off in level ${k}`);
    const values = new Int16Array(count);
    for (let i = 0; i < count; i += 1) values[i] = view.getInt16(at + i * 2, true);
    at += count * 2;
    levels.push(Object.freeze({ binFrames, binCount, values }));
  }
  if (at !== bytes.byteLength) refuse('bytes after the last level');
  return Object.freeze({ channels, frames, sampleRate, levels: Object.freeze(levels) });
}

// The coarsest level whose bins still fit in one pixel at this zoom (level 0
// when even its bins are wider than a pixel).
export function chooseLevel(pyramid: PeakPyramid, pixelsPerFrame: number): number {
  if (!(pixelsPerFrame > 0) || !Number.isFinite(pixelsPerFrame)) throw new RangeError(`not a zoom: ${pixelsPerFrame}`);
  const framesPerPixel = 1 / pixelsPerFrame;
  let chosen = 0;
  pyramid.levels.forEach((level, k) => {
    // A tolerance for 1 / (1 / n) not being exactly n.
    if (level.binFrames <= framesPerPixel * (1 + 1e-9)) chosen = k;
  });
  return chosen;
}

// The min and max of one channel over the frames [start, end) at a level,
// from every bin the range overlaps; null when the range holds no media frame.
export function columnRange(
  pyramid: PeakPyramid,
  levelIndex: number,
  channel: number,
  start: number,
  end: number,
): { min: number; max: number } | null {
  const level = pyramid.levels[levelIndex];
  if (!level || channel < 0 || channel >= pyramid.channels) return null;
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(pyramid.frames, Math.ceil(end));
  if (to <= from) return null;
  const first = Math.floor(from / level.binFrames);
  const last = Math.min(level.binCount - 1, Math.floor((to - 1) / level.binFrames));
  let min = 32767;
  let max = -32768;
  for (let bin = first; bin <= last; bin += 1) {
    const at = (bin * pyramid.channels + channel) * 2;
    min = Math.min(min, level.values[at]!);
    max = Math.max(max, level.values[at + 1]!);
  }
  return { min, max };
}
