// The fader taper (UI redesign spec 4.5 C7, 3.4): a position of the travel,
// 0 at the bottom and 1 at the top, to integer milli-dB and back. Minus
// infinity at the bottom, 0 dB at 75 %, +6 dB at the top; piecewise linear in
// dB between the spec's breakpoints, and linear in amplitude below 5 %, so the
// travel is finer near 0 dB. A stored gain above +6 dB maps to the top
// (the cap pins there; the value shown stays the true one).

// The model's minus infinity (Gain::kMinusInfinity).
export const MINUS_INFINITY_MILLI_DB = -2147483648;
export const FADER_TOP_MILLI_DB = 6000;

// [position, dB], bottom to top (spec 4.5 C7).
const BREAKPOINTS: ReadonlyArray<readonly [number, number]> = [
  [0.05, -60],
  [0.15, -40],
  [0.3, -24],
  [0.5, -12],
  [0.75, 0],
  [1, 6],
];
const [LOW_POSITION, LOW_DB] = BREAKPOINTS[0]!;

export function positionToMilliDb(position: number): number {
  if (!(position > 0)) return MINUS_INFINITY_MILLI_DB;
  if (position >= 1) return FADER_TOP_MILLI_DB;
  if (position < LOW_POSITION) {
    // Linear in amplitude from silence to -60 dB.
    const db = LOW_DB + 20 * Math.log10(position / LOW_POSITION);
    return Math.round(db * 1000);
  }
  for (let i = 1; i < BREAKPOINTS.length; i += 1) {
    const [p1, d1] = BREAKPOINTS[i]!;
    if (position <= p1) {
      const [p0, d0] = BREAKPOINTS[i - 1]!;
      return Math.round((d0 + ((position - p0) / (p1 - p0)) * (d1 - d0)) * 1000);
    }
  }
  return FADER_TOP_MILLI_DB;
}

export function milliDbToPosition(milliDb: number): number {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return 0;
  if (milliDb >= FADER_TOP_MILLI_DB) return 1;
  const db = milliDb / 1000;
  if (db < LOW_DB) return LOW_POSITION * 10 ** ((db - LOW_DB) / 20);
  for (let i = 1; i < BREAKPOINTS.length; i += 1) {
    const [p1, d1] = BREAKPOINTS[i]!;
    if (db <= d1) {
      const [p0, d0] = BREAKPOINTS[i - 1]!;
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 1;
}

// True when the stored gain is above the fader's top: the cap pins there and
// the value shows in the warning colour.
export function isAboveCap(milliDb: number): boolean {
  return milliDb !== MINUS_INFINITY_MILLI_DB && milliDb > FADER_TOP_MILLI_DB;
}
