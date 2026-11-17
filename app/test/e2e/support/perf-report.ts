// The performance scenario's report (m5b-nightly-quality, acceptance item 6):
// the pure half of perf.spec.ts, unit-tested in test/unit/perf-report.test.ts.
// The budgets are those of UI redesign spec 5.6; the report says per budget
// whether the measurement is within it, and missingMeasurements() names what
// was not measured, which is the only thing that fails the spec (report only
// at first: never a budget).

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

export const SCENARIO = { tracks: 64, clips: 2000 } as const;

export interface PerfInput {
  readonly commit: string;
  readonly platform: string;
  readonly scenario: { readonly tracks: number; readonly clips: number };
  // Main-thread work of each frame while playing, in ms (window.__siannFrames).
  readonly frameWorkMs: readonly number[];
  readonly heapBytes: number | null;
  readonly coldStartMs: number | null;
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
  const framesValid = frames.length >= MIN_FRAMES && frames.every((v) => Number.isFinite(v) && v >= 0);
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
    measurements: { frames: frames.length, frameMedianMs, frameP99Ms, heapMb, coldStartMs },
    budgets,
  };
}

// What the scenario failed to measure: a budget row without a value, or a
// session that is not the 64-track, 2,000-clip one.
export function missingMeasurements(report: PerfReport): string[] {
  const missing: string[] = [];
  if (report.scenario.tracks !== SCENARIO.tracks || report.scenario.clips !== SCENARIO.clips) missing.push('scenario');
  for (const row of report.budgets) if (row.value === null) missing.push(row.name);
  return missing;
}
