// The position display's text (m5-ui-transport; UI redesign spec 3.1): a
// session frame in Bars+Beats (bar.beat.tick, 1-based, through root.tempo;
// 4/4 until E-10, which the display's tooltip states) or in Seconds as a
// fixed m:ss.mmm, the same bytes in every locale; a typed position read back
// in the primary format; the exchange of the primary and secondary format
// (the period key); and the tempo readout at the cursor (spec 3.1: "Tempo:
// display P1-2"). Framework-free.

import type { TempoPoint } from '../model/document';
import {
  BEATS_PER_BAR,
  DEFAULT_MILLI_BPM,
  TICKS_PER_BAR,
  TICKS_PER_QUARTER,
  formatBbt,
  framesToTicks,
  tempoSegments,
  ticksToFrames,
} from './musical-time';

export type TimeFormat = 'bars' | 'seconds';

export interface TimeFormats {
  readonly primary: TimeFormat;
  readonly secondary: TimeFormat;
}

export function otherFormat(format: TimeFormat): TimeFormat {
  return format === 'bars' ? 'seconds' : 'bars';
}

export function exchange(formats: TimeFormats): TimeFormats {
  return { primary: formats.secondary, secondary: formats.primary };
}

function wholeRate(sampleRate: number): bigint {
  return BigInt(Math.max(1, Math.round(sampleRate)));
}

function frameBig(frames: number | string | bigint): bigint {
  if (typeof frames === 'bigint') return frames;
  if (typeof frames === 'number') return BigInt(Math.trunc(frames));
  return /^-?\d+$/.test(frames) ? BigInt(frames) : 0n;
}

// m:ss.mmm, the milliseconds truncated (a frame short of a second is still
// x.999), minutes unbounded.
export function formatSeconds(frames: number | string | bigint, sampleRate: number): string {
  let value = frameBig(frames);
  if (value < 0n) value = 0n;
  const millis = (value * 1000n) / wholeRate(sampleRate);
  const minutes = millis / 60_000n;
  const seconds = (millis / 1000n) % 60n;
  const rest = millis % 1000n;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

export function formatPosition(frames: number | string | bigint, tempo: readonly TempoPoint[], sampleRate: number, format: TimeFormat): string {
  if (format === 'seconds') return formatSeconds(frames, sampleRate);
  const value = frameBig(frames);
  return formatBbt(framesToTicks(Number(value < 0n ? 0n : value), tempo, sampleRate));
}

// The tempo in force at a frame, in milli-BPM (root.tempo's unit; 120 BPM
// for an empty map, as a new session's).
export function tempoAt(frames: number | string | bigint, tempo: readonly TempoPoint[], sampleRate: number): number {
  if (tempo.length === 0) return DEFAULT_MILLI_BPM;
  const frame = Number(frameBig(frames));
  // One segment per point, in tick order (musical-time.ts).
  const points = [...tempo].sort((a, b) => Number(a.ticks) - Number(b.ticks));
  const segments = tempoSegments(points, sampleRate);
  let found = 0;
  segments.forEach((segment, index) => {
    if (segment.startFrame <= frame) found = index;
  });
  return points[found]!.milliBpm;
}

// The transport's tempo readout: BPM with three decimals, as Cubase shows it.
export function formatTempo(milliBpm: number): string {
  return (milliBpm / 1000).toFixed(3);
}

const BARS = /^(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/;
const SECONDS = /^(?:(\d+):([0-5]?\d(?:\.\d+)?)|(\d+(?:\.\d+)?))$/;

// A typed position in `format` as frames (a decimal string), or null for
// text that is no position: bar.beat.tick, bar.beat or bar (bar from 1, beat
// 1-4, tick 0-1919); seconds, or m:ss.mmm.
export function parsePosition(text: string, tempo: readonly TempoPoint[], sampleRate: number, format: TimeFormat): string | null {
  const typed = text.trim();
  if (format === 'bars') {
    const match = BARS.exec(typed);
    if (!match) return null;
    const bar = Number(match[1]);
    const beat = match[2] === undefined ? 1 : Number(match[2]);
    const tick = match[3] === undefined ? 0 : Number(match[3]);
    if (bar < 1 || beat < 1 || beat > BEATS_PER_BAR || tick >= TICKS_PER_QUARTER) return null;
    const ticks = (bar - 1) * TICKS_PER_BAR + (beat - 1) * TICKS_PER_QUARTER + tick;
    if (!Number.isSafeInteger(ticks)) return null;
    return String(ticksToFrames(ticks, tempo, sampleRate));
  }
  const match = SECONDS.exec(typed);
  if (!match) return null;
  const seconds = match[3] !== undefined ? Number(match[3]) : Number(match[1]) * 60 + Number(match[2]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const frames = Math.round(seconds * Number(wholeRate(sampleRate)));
  return Number.isSafeInteger(frames) ? String(frames) : null;
}
