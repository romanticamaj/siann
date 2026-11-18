// Locale-free formatters (UI redesign spec 6.2): dB values, pan and timeline
// positions are the same bytes in every locale, as on hardware and in Cubase.
// None takes a locale; the words around them come from the catalogs.

// The model's minus infinity (Gain::kMinusInfinity, INT32_MIN).
export const MINUS_INFINITY_MILLI_DB = -2147483648;

// Gains are integer milli-dB (spec, "siann-model").
export function formatMilliDb(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return '-inf dB';
  const text = (milliDb / 1000).toFixed(2);
  return `${milliDb > 0 ? '+' : ''}${text} dB`;
}

// One decimal, rounded half away from zero, with an explicit sign (UI
// redesign spec 3.4: the mixer's and the Inspector's values).
function oneDecimal(tenths: number): string {
  if (tenths === 0) return '0.0';
  const text = (Math.abs(tenths) / 10).toFixed(1);
  return `${tenths > 0 ? '+' : '-'}${text}`;
}

// Two decimals, the same rules: half away from zero, an explicit sign, no
// sign on zero (the info line's volume, UI redesign 3.2 and 10.8).
function twoDecimals(hundredths: number): string {
  if (hundredths === 0) return '0.00';
  const text = (Math.abs(hundredths) / 100).toFixed(2);
  return `${hundredths > 0 ? '+' : '-'}${text}`;
}

// A gain in milli-dB with two decimals, as the info line shows a clip's
// volume: 0.00 dB, -3.50 dB, +1.24 dB, -inf dB.
export function formatDb2(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return '-inf dB';
  return `${twoDecimals(Math.sign(milliDb) * Math.round(Math.abs(milliDb) / 10))} dB`;
}

// A gain in milli-dB as the mixer shows it: +1.5 dB, -6.0 dB, 0.0 dB, -inf dB.
export function formatDb(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return '-inf dB';
  return `${oneDecimal(Math.sign(milliDb) * Math.round(Math.abs(milliDb) / 100))} dB`;
}

// A meter's linear peak in dBFS, the strip's peak value: -6.0, +0.4, -inf.
export function formatPeakDb(linear: number): string {
  if (!(linear > 0)) return '-inf';
  const tenths = 200 * Math.log10(linear);
  return oneDecimal(Math.sign(tenths) * Math.round(Math.abs(tenths)));
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
