// Bars and beats for display (UI redesign spec 3.2, 6.2): sample frames to
// musical ticks and back through root.tempo, the engine's tempo map of
// constant-tempo segments with step changes (native/libs/time: a point is
// {ticks, milliBpm}, 120 BPM is 120000, kTicksPerQuarter is 1920). The
// engine's conversions are exact integer arithmetic; these are for the ruler
// and the info line only, in doubles, rounded to the nearest tick. 4/4 until
// the meter map arrives (E-10). An empty tempo list reads as 120 BPM, as a new
// session's. Positions are 1-based (bar 1, beat 1); lengths 0-based. The text
// is the same in every locale. Framework-free.

import type { TempoPoint } from '../model/document';

export const TICKS_PER_QUARTER = 1920;
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BAR = TICKS_PER_QUARTER * BEATS_PER_BAR;
export const DEFAULT_MILLI_BPM = 120_000;

interface Segment {
  readonly startTick: number;
  readonly startFrame: number;
  readonly framesPerTick: number;
}

function framesPerTick(milliBpm: number, sampleRate: number): number {
  // A quarter is 60000 / milliBpm seconds.
  return (sampleRate * 60_000) / (milliBpm * TICKS_PER_QUARTER);
}

export function tempoSegments(tempo: readonly TempoPoint[], sampleRate: number): Segment[] {
  const points = tempo.length > 0 ? [...tempo].sort((a, b) => Number(a.ticks) - Number(b.ticks)) : [{ ticks: '0', milliBpm: DEFAULT_MILLI_BPM }];
  const segments: Segment[] = [];
  for (const point of points) {
    const startTick = Number(point.ticks);
    const previous = segments[segments.length - 1];
    const startFrame = previous ? previous.startFrame + (startTick - previous.startTick) * previous.framesPerTick : 0;
    segments.push({ startTick: previous ? startTick : 0, startFrame, framesPerTick: framesPerTick(point.milliBpm, sampleRate) });
  }
  return segments;
}

function segmentAtFrame(segments: readonly Segment[], frame: number): Segment {
  let found = segments[0]!;
  for (const segment of segments) if (segment.startFrame <= frame) found = segment;
  return found;
}

function segmentAtTick(segments: readonly Segment[], tick: number): Segment {
  let found = segments[0]!;
  for (const segment of segments) if (segment.startTick <= tick) found = segment;
  return found;
}

// The tick at a frame (nearest).
export function framesToTicks(frames: number, tempo: readonly TempoPoint[], sampleRate: number): number {
  const segments = tempoSegments(tempo, sampleRate);
  const segment = segmentAtFrame(segments, frames);
  return Math.round(segment.startTick + (frames - segment.startFrame) / segment.framesPerTick);
}

// The frame at a tick (nearest).
export function ticksToFrames(ticks: number, tempo: readonly TempoPoint[], sampleRate: number): number {
  const segments = tempoSegments(tempo, sampleRate);
  const segment = segmentAtTick(segments, ticks);
  return Math.round(segment.startFrame + (ticks - segment.startTick) * segment.framesPerTick);
}

function parts(ticks: number): { bars: number; beats: number; rest: number } {
  const t = Math.max(0, Math.round(ticks));
  return {
    bars: Math.floor(t / TICKS_PER_BAR),
    beats: Math.floor((t % TICKS_PER_BAR) / TICKS_PER_QUARTER),
    rest: t % TICKS_PER_QUARTER,
  };
}

// A position: bar.beat.tick, 1-based, the tick padded to three digits (3.1.000).
export function formatBbt(ticks: number): string {
  const { bars, beats, rest } = parts(ticks);
  return `${bars + 1}.${beats + 1}.${String(rest).padStart(3, '0')}`;
}

// A length: bars.beats.ticks counted from zero.
export function formatBbtLength(ticks: number): string {
  const { bars, beats, rest } = parts(ticks);
  return `${bars}.${beats}.${String(rest).padStart(3, '0')}`;
}

// A signed length, for the drag tooltip's delta.
export function formatBbtDelta(ticks: number): string {
  return `${ticks < 0 ? '-' : '+'}${formatBbtLength(Math.abs(ticks))}`;
}
