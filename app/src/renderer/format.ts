// Locale-free formatters (UI redesign spec 6.2): dB values, pan and timeline
// positions are the same bytes in every locale, as on hardware and in Cubase.
// None takes a locale; the words around them come from the catalogs.

// The model's minus infinity (Gain::kMinusInfinity, INT32_MIN).
const MINUS_INFINITY_MILLI_DB = -2147483648;

// Gains are integer milli-dB (spec, "siann-model").
export function formatMilliDb(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return '-inf dB';
  const text = (milliDb / 1000).toFixed(2);
  return `${milliDb > 0 ? '+' : ''}${text} dB`;
}

// Pan is -10000 (hard left) to 10000 (hard right): L35 / C / R40.
export function formatPan(pan: number): string {
  const percent = Math.round(Math.abs(pan) / 100);
  if (percent === 0) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${percent}`;
}

// A ruler position in seconds, at most two decimals, no trailing zeros.
export function formatSeconds(seconds: number): string {
  return String(Number(seconds.toFixed(2)));
}
