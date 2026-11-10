// Stub: the peaks decoder lands with the implementation.

export class PeaksError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PeakLevel {
  readonly binFrames: number;
  readonly binCount: number;
  readonly values: Int16Array;
}

export interface PeakPyramid {
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly levels: readonly PeakLevel[];
}

export function decodePeaks(_bytes: ArrayBuffer | Uint8Array): PeakPyramid {
  throw new PeaksError('not_implemented', 'decodePeaks');
}

export function chooseLevel(_pyramid: PeakPyramid, _pixelsPerFrame: number): number {
  return -1;
}

export function columnRange(_p: PeakPyramid, _l: number, _c: number, _s: number, _e: number): { min: number; max: number } | null {
  return null;
}
