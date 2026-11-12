// The one set of formatters the renderer shows values with (UX pass: gain in
// dB with one decimal, pan as L/C/R, positions as mm:ss.mmm and
// bars.beats.ticks, plan times relative to now), and the parser of a typed
// gain. Every surface (mixer, track headers, plan steps, diff rows, toasts)
// formats through here so the same value reads the same everywhere.
// Framework-free and DOM-free.

// The model's minus infinity (Gain::kMinusInfinity, INT32_MIN).
export const MINUS_INFINITY_MILLI_DB = -2147483648;
// The engine's gain range for a finite value (protocol-gestures-v0.md: a gain
// is clamped to -144000..24000).
export const GAIN_MIN_MILLI_DB = -144_000;
export const GAIN_MAX_MILLI_DB = 24_000;
export const PAN_RANGE = 10_000;

// "+1.5 dB", "0.0 dB", "-12.0 dB", "-inf dB". Gains are integer milli-dB.
export function formatGainDb(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB || milliDb <= GAIN_MIN_MILLI_DB - 1000) return '-inf dB';
  const tenths = Math.round(milliDb / 100);
  if (tenths === 0) return '0.0 dB';
  return `${tenths > 0 ? '+' : '-'}${(Math.abs(tenths) / 10).toFixed(1)} dB`;
}

// A typed gain ("-6", "+1.5 dB", "−3,5", "-inf", "inf") as milli-dB rounded to
// 0.1 dB and clamped to the engine's range, or null when it is not a gain.
export function parseGainDb(text: string): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/−/g, '-')
    .replace(/,/g, '.')
    .replace(/\s*db$/, '')
    .trim();
  if (cleaned === '') return null;
  if (/^-?(inf|infinity|∞)$/.test(cleaned)) return MINUS_INFINITY_MILLI_DB;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const db = Number(cleaned);
  if (!Number.isFinite(db)) return null;
  const milli = Math.round(db * 10) * 100;
  return Math.min(GAIN_MAX_MILLI_DB, Math.max(GAIN_MIN_MILLI_DB, milli));
}

// Pan -10000..10000 as "L35", "C", "R40" (percent of the way to a side).
export function formatPan(pan: number): string {
  const percent = Math.round((Math.max(-PAN_RANGE, Math.min(PAN_RANGE, pan)) / PAN_RANGE) * 100);
  if (percent === 0) return 'C';
  return percent < 0 ? `L${-percent}` : `R${percent}`;
}

// Seconds as "mm:ss.mmm" (negative positions keep a leading minus).
export function formatClock(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const totalMs = Math.round(Math.abs(seconds) * 1000);
  const minutes = Math.floor(totalMs / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${sign}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function samplesToSeconds(samples: string | bigint | number, rate: number): number {
  const value = typeof samples === 'number' ? samples : Number(samples);
  return rate > 0 ? value / rate : 0;
}

export const TICKS_PER_BEAT = 960;

// A position as bars.beats.ticks at a constant tempo (the root's first tempo
// point) and meter (the document has no time signature yet: 4/4), 1-based
// bars and beats: "1.1.000", "3.2.480".
export function formatBarsBeats(seconds: number, milliBpm: number, beatsPerBar = 4): string {
  const bpm = milliBpm > 0 ? milliBpm / 1000 : 120;
  const totalTicks = Math.floor(Math.max(0, seconds) * (bpm / 60) * TICKS_PER_BEAT + 1e-6);
  const beatsTotal = Math.floor(totalTicks / TICKS_PER_BEAT);
  const ticks = totalTicks % TICKS_PER_BEAT;
  const bar = Math.floor(beatsTotal / beatsPerBar) + 1;
  const beat = (beatsTotal % beatsPerBar) + 1;
  return `${bar}.${beat}.${String(ticks).padStart(3, '0')}`;
}

// A seconds value for rulers and tooltips: "1.25 s" (trailing zeros dropped).
export function formatSeconds(seconds: number, decimals = 3): string {
  return `${Number(seconds.toFixed(decimals))} s`;
}

// A signed delta for drag tooltips: "+0.250 s", "-1.000 s".
export function formatDeltaSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000;
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded).toFixed(3)} s`;
}

// How long ago `then` was, for plan rows: "just now", "5 s ago", "3 min ago",
// "2 h ago", "4 d ago".
export function formatRelativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// A media entity's display name. The document has no name for media yet, so
// the id stands in without its med_ prefix.
export function mediaDisplayName(mediaId: string): string {
  return mediaId.replace(/^med_/, '') || mediaId;
}
