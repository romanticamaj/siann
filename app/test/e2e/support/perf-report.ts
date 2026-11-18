// The performance scenario's report (m5b-nightly-quality, acceptance item 6):
// the pure half of perf.spec.ts, unit-tested in test/unit/perf-report.test.ts.
// The budgets are those of UI redesign spec 5.6; the report says per budget
// whether the measurement is within it, and missingMeasurements() names what
// was not measured, which is the only thing that fails the spec (report only
// at first: never a budget). The frame figures count only when the window they
// were taken in was played with the meters running (5.6 row 1): the spec hands
// the transport's playing state at the window's start and end and the meter
// frames drawn inside it, and without that evidence the frames are missing
// (the header meters' animation frame, and so the frame marks, run on an idle
// window as well).

export const BUDGETS = {
  // Main-thread work per frame while playing, 64 tracks, 2,000 clips, meters running.
  frameMedianMs: 4,
  frameP99Ms: 8,
  // JS heap on the 64-track session (performance.memory).
  heapMb: 300,
  // Cold start to the first painted session, after the engine is ready.
  coldStartMs: 1500,
} as const;

// Fewer frames than this is no frame measurement (one second at 60 Hz).
export const MIN_FRAMES = 60;

// Fewer meter frames than this inside the window is no "meters running".
export const MIN_METER_FRAMES = 10;

export const SCENARIO = { tracks: 64, clips: 2000 } as const;

export interface PerfInput {
  readonly commit: string;
  readonly platform: string;
  readonly scenario: { readonly tracks: number; readonly clips: number };
  // Main-thread work of each frame while playing, in ms (window.__siannFrames).
  readonly frameWorkMs: readonly number[];
  readonly heapBytes: number | null;
  readonly coldStartMs: number | null;
  // The measured window: the transport's playing flag (the play button's
  // aria-pressed, from the realtime channel) when it started and when it
  // ended, and the meter frames the track meters drew inside it.
  readonly playback?: {
    readonly playingAtStart: boolean;
    readonly playingAtEnd: boolean;
    readonly meterFrames: number;
  };
}

export type BudgetName = keyof typeof BUDGETS;

export interface BudgetRow {
  readonly name: BudgetName;
  readonly value: number | null;
  readonly budget: number;
  readonly unit: 'ms' | 'MB';
  // Strictly under the budget; null without a value.
  readonly withinBudget: boolean | null;
}

export interface PerfReport {
  readonly schema: 'siann.perf-report.v0';
  readonly commit: string;
  readonly platform: string;
  readonly scenario: { readonly tracks: number; readonly clips: number };
  readonly measurements: {
    readonly frames: number;
    // Playing at both ends of the window.
    readonly playing: boolean;
    // Meter frames drawn inside the window (0 without the evidence).
    readonly meterFrames: number;
    readonly frameMedianMs: number | null;
    readonly frameP99Ms: number | null;
    readonly heapMb: number | null;
    readonly coldStartMs: number | null;
  };
  readonly budgets: readonly BudgetRow[];
}

function sorted(samples: readonly number[]): number[] {
  return [...samples].sort((a, b) => a - b);
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0) return Number.NaN;
  const s = sorted(samples);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Nearest rank: the smallest sample with at least p % of the samples at or below it.
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const s = sorted(samples);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1]!;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export function buildPerfReport(input: PerfInput): PerfReport {
  const frames = input.frameWorkMs;
  const playing = input.playback?.playingAtStart === true && input.playback.playingAtEnd === true;
  const rawMeterFrames = input.playback?.meterFrames;
  const meterFrames = typeof rawMeterFrames === 'number' && Number.isFinite(rawMeterFrames) && rawMeterFrames > 0 ? rawMeterFrames : 0;
  const framesValid =
    playing &&
    meterFrames >= MIN_METER_FRAMES &&
    frames.length >= MIN_FRAMES &&
    frames.every((v) => Number.isFinite(v) && v >= 0);
  const frameMedianMs = framesValid ? round(median(frames)) : null;
  const frameP99Ms = framesValid ? round(percentile(frames, 99)) : null;
  const heapMb =
    input.heapBytes !== null && Number.isFinite(input.heapBytes) && input.heapBytes > 0
      ? round(input.heapBytes / (1024 * 1024))
      : null;
  const coldStartMs =
    input.coldStartMs !== null && Number.isFinite(input.coldStartMs) && input.coldStartMs >= 0
      ? round(input.coldStartMs)
      : null;
  const values: Record<BudgetName, number | null> = { frameMedianMs, frameP99Ms, heapMb, coldStartMs };
  const budgets = (Object.keys(BUDGETS) as BudgetName[]).map((name): BudgetRow => {
    const value = values[name];
    return {
      name,
      value,
      budget: BUDGETS[name],
      unit: name === 'heapMb' ? 'MB' : 'ms',
      withinBudget: value === null ? null : value < BUDGETS[name],
    };
  });
  return {
    schema: 'siann.perf-report.v0',
    commit: input.commit,
    platform: input.platform,
    scenario: { tracks: input.scenario.tracks, clips: input.scenario.clips },
    measurements: { frames: frames.length, playing, meterFrames, frameMedianMs, frameP99Ms, heapMb, coldStartMs },
    budgets,
  };
}

// What the scenario failed to measure: a budget row without a value, a
// session that is not the 64-track, 2,000-clip one, or a frame window that was
// not played (playing) or drew too few meter frames (meterFrames).
export function missingMeasurements(report: PerfReport): string[] {
  const missing: string[] = [];
  if (report.scenario.tracks !== SCENARIO.tracks || report.scenario.clips !== SCENARIO.clips) missing.push('scenario');
  if (!report.measurements.playing) missing.push('playing');
  if (report.measurements.meterFrames < MIN_METER_FRAMES) missing.push('meterFrames');
  for (const row of report.budgets) if (row.value === null) missing.push(row.name);
  return missing;
}

// Throws when a measurement is missing: the one failure of the scenario besides
// a crash. A measurement over its budget is reported (withinBudget false) and
// never throws.
export function assertComplete(report: PerfReport): void {
  const missing = missingMeasurements(report);
  if (missing.length > 0) throw new Error(`the performance scenario did not measure ${missing.join(', ')}`);
}
