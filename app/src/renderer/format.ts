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

// The user's dB (UI redesign spec 3.3, 3.4: the track header, the info line
// and the MixConsole): one decimal, an explicit sign, no sign on a value that
// rounds to zero.
export function formatDb(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return '-inf dB';
  const tenths = Math.round(milliDb / 100);
  if (tenths === 0) return '0.0 dB';
  return `${tenths > 0 ? '+' : '-'}${(Math.abs(tenths) / 10).toFixed(1)} dB`;
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
