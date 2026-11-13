// The plan review's diff and partial-approval selection
// (m5-plan-review; spec "Frontend", plan review; docs/schemas/plan-v1.md,
// plan.preview). Pure functions over the engine's answers: the after-state
// comes from plan.preview, never from the renderer running commands itself.
// Step wording is plans/describe.ts; dB formatting is format.ts.

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
