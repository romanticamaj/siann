// The plan review's diff, step list and partial-approval selection
// (m5-plan-review; spec "Frontend", plan review; docs/schemas/plan-v1.md,
// plan.preview). Pure functions over the engine's answers: the after-state
// comes from plan.preview, never from the renderer running commands itself.

import type { StaleRef } from '../model/plan-store';

export interface PreviewEntity {
  readonly ref: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

export interface PlanPreview {
  readonly revision: string;
  readonly documentHash: string;
  readonly stale: readonly StaleRef[];
  readonly entities: readonly PreviewEntity[];
}

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export type RowKind = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DiffRow {
  readonly ref: string;
  readonly kind: RowKind;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  // The top-level fields whose value differs, sorted (modified rows only).
  readonly fields: readonly string[];
  readonly changes: readonly FieldChange[];
  readonly stale: boolean;
  readonly staleChange?: StaleRef['change'];
}

// Canonical enough to compare entity JSON: keys sorted at every level.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function changesOf(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields
    .filter((field) => canonical(before[field]) !== canonical(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

// One row per preview entity, in the preview's order, then a row for each
// stale ref the preview does not list. `stale` is plan.status's.
export function diffRows(preview: PlanPreview, stale: readonly StaleRef[] = preview.stale): DiffRow[] {
  const staleByRef = new Map(stale.map((s) => [s.ref, s.change] as const));
  const rows: DiffRow[] = preview.entities.map((entity) => {
    const { before, after } = entity;
    let kind: RowKind;
    let changes: FieldChange[] = [];
    if (before === null && after === null) kind = 'unchanged';
    else if (before === null) kind = 'added';
    else if (after === null) kind = 'removed';
    else {
      changes = changesOf(before, after);
      kind = changes.length > 0 ? 'modified' : 'unchanged';
    }
    const staleChange = staleByRef.get(entity.ref);
    return {
      ref: entity.ref,
      kind,
      before,
      after,
      fields: changes.map((c) => c.field),
      changes,
      stale: staleChange !== undefined,
      ...(staleChange !== undefined ? { staleChange } : {}),
    };
  });
  const listed = new Set(rows.map((r) => r.ref));
  for (const s of stale) {
    if (listed.has(s.ref)) continue;
    rows.push({ ref: s.ref, kind: 'unchanged', before: null, after: null, fields: [], changes: [], stale: true, staleChange: s.change });
  }
  return rows;
}

export function formatValue(value: unknown): string {
  return value === undefined ? '—' : JSON.stringify(value);
}

// The model's minus infinity (Gain::kMinusInfinity, INT32_MIN).
const MINUS_INFINITY_MILLI_DB = -2147483648;

// Gains are integer milli-dB (spec, "siann-model").
export function formatMilliDb(milliDb: number): string {
  if (milliDb === MINUS_INFINITY_MILLI_DB) return '-inf dB';
  const text = (milliDb / 1000).toFixed(2);
  return `${milliDb > 0 ? '+' : ''}${text} dB`;
}

// A one-line summary of a step for the step list. `trackName` names a track
// by id from the read model, when it knows the track.
export function stepSummary(step: Record<string, unknown>, trackName: (id: string) => string | undefined = () => undefined): string {
  const trackId = typeof step.trackId === 'string' ? step.trackId : '';
  const track = trackName(trackId) ?? trackId;
  switch (step.op) {
    case 'track.add':
      return `Add track ${typeof step.name === 'string' ? step.name : trackId}`;
    case 'track.remove':
      return `Remove track ${track}`;
    case 'track.rename':
      return `Rename ${track} to ${String(step.name)}`;
    case 'track.set_gain':
      if (typeof step.gainMilliDb === 'number') return `Set gain of ${track} to ${formatMilliDb(step.gainMilliDb)}`;
      break;
    case 'track.set_pan':
      return `Set pan of ${track} to ${String(step.pan)}`;
    case 'track.set_mute':
      return `${step.mute ? 'Mute' : 'Unmute'} ${track}`;
    case 'track.set_solo':
      return `${step.solo ? 'Solo' : 'Unsolo'} ${track}`;
    default:
      break;
  }
  const { op, ...params } = step;
  return `${String(op)} ${JSON.stringify(params)}`;
}

export interface Selection {
  // A non-empty proper subset of the steps is ticked.
  readonly canApproveSelected: boolean;
  // The ticked step indexes inside the plan, sorted.
  readonly steps: readonly number[];
}

export function selection(ticked: ReadonlySet<number>, stepCount: number): Selection {
  const steps = [...ticked].filter((i) => Number.isInteger(i) && i >= 0 && i < stepCount).sort((a, b) => a - b);
  return { canApproveSelected: steps.length > 0 && steps.length < stepCount, steps };
}
