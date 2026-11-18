// The position display's text (m5-ui-transport; UI redesign spec 3.1): a
// session frame in Bars+Beats (bar.beat.tick, 1-based, through root.tempo;
// 4/4 until E-10, which the Sig cell shows) or in Seconds as a
// fixed hh:mm:ss.mmm (the mockup's format, UI redesign 10.7, 1), the same
// bytes in every locale; a typed position read back
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

// hh:mm:ss.mmm, the milliseconds truncated (a frame short of a second is
// still x.999), hours unbounded (two digits at least).
export function formatSeconds(frames: number | string | bigint, sampleRate: number): string {
  let value = frameBig(frames);
  if (value < 0n) value = 0n;
  const millis = (value * 1000n) / wholeRate(sampleRate);
  const hours = millis / 3_600_000n;
  const minutes = (millis / 60_000n) % 60n;
  const seconds = (millis / 1000n) % 60n;
  const rest = millis % 1000n;
  const two = (n: bigint) => String(n).padStart(2, '0');
  return `${two(hours)}:${two(minutes)}:${two(seconds)}.${String(rest).padStart(3, '0')}`;
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

// The transport's tempo readout: BPM with two decimals (the mockup's 120.00;
// UI redesign 10.7, 1), truncated as the time is.
export function formatTempo(milliBpm: number): string {
  const centi = Math.max(0, Math.trunc(milliBpm / 10));
  return `${Math.trunc(centi / 100)}.${String(centi % 100).padStart(2, '0')}`;
}

const BARS = /^(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/;
// hh:mm:ss(.mmm) with minutes below 60, m:ss(.mmm) with minutes unbounded, or seconds.
const SECONDS = /^(?:(?:(\d+):([0-5]?\d):|(\d+):)([0-5]?\d(?:\.\d+)?)|(\d+(?:\.\d+)?))$/;

// A typed position in `format` as frames (a decimal string), or null for
// text that is no position: bar.beat.tick, bar.beat or bar (bar from 1, beat
// 1-4, tick 0-1919); seconds, m:ss.mmm, or hh:mm:ss.mmm as the display shows it.
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
  const [, hours, hourMinutes, minutes, rest, plain] = match;
  const seconds =
    plain !== undefined
      ? Number(plain)
      : hours !== undefined
        ? Number(hours) * 3600 + Number(hourMinutes) * 60 + Number(rest)
        : Number(minutes) * 60 + Number(rest);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const frames = Math.round(seconds * Number(wholeRate(sampleRate)));
  return Number.isSafeInteger(frames) ? String(frames) : null;
}
