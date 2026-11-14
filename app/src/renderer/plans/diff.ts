// The plan review's diff and partial-approval selection
// (m5-plan-review; spec "Frontend", plan review; docs/schemas/plan-v1.md,
// plan.preview). Pure functions over the engine's answers: the after-state
// comes from plan.preview, never from the renderer running commands itself.
// Step wording is plans/describe.ts; dB formatting is format.ts. A row is
// worded in user units (rowLabel, rowChanges: names, dB, L/C/R, seconds); the
// ref and the raw entities are for the row's disclosure only.

import { formatMilliDb, formatPan, formatSeconds } from '../format';
import type { MessageKey } from '../i18n/en';
import type { T } from '../i18n/t';
import type { StaleRef } from '../model/plan-store';
import type { StepNames } from './describe';

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

// `ticked` null: every step (the default, UI redesign 4.5 C1).
export function selection(ticked: ReadonlySet<number> | null, stepCount: number): Selection {
  if (ticked === null) return { canApproveSelected: false, steps: Array.from({ length: stepCount }, (_, i) => i) };
  const steps = [...ticked].filter((i) => Number.isInteger(i) && i >= 0 && i < stepCount).sort((a, b) => a - b);
  return { canApproveSelected: steps.length > 0 && steps.length < stepCount, steps };
}

// What a row is about, named as the user knows it: a track by its name, a
// clip by its track, a plugin by its name, the rest by its kind.
export function rowLabel(row: DiffRow, names: StepNames, t: T): string {
  const entity = row.after ?? row.before;
  const type = row.ref.slice(0, row.ref.indexOf(':'));
  const name = typeof entity?.name === 'string' && entity.name !== '' ? entity.name : undefined;
  switch (type) {
    case 'track':
      return name ?? t('step.aTrack');
    case 'clip': {
      const track = typeof entity?.trackId === 'string' ? names.track(entity.trackId) : undefined;
      return track ? t('step.clipOn', { track }) : t('step.aClip');
    }
    case 'root':
      return t('diff.session');
    case 'media':
      return t('diff.audioFile');
    case 'plugin_slot':
      return name ?? t('step.aPlugin');
    default:
      return t('diff.other');
  }
}

const onOff = (value: unknown, t: T) => t(value ? 'value.on' : 'value.off');

function framesText(value: unknown, names: StepNames, t: T): string {
  const frames = typeof value === 'string' ? value : (value as { value?: unknown } | null | undefined)?.value;
  if (typeof frames !== 'string' || !names.sampleRate || !/^-?\d+$/.test(frames)) return '—';
  return t('step.seconds', { value: formatSeconds(Number(frames) / names.sampleRate) });
}

type FieldWording = { key: MessageKey; value?: (v: unknown) => string };

// The fields a user knows, per entity type; any other field is "other details".
function fieldWording(type: string, field: string, names: StepNames, t: T): FieldWording | null {
  const db = (v: unknown) => (typeof v === 'number' ? formatMilliDb(v) : '—');
  const pan = (v: unknown) => (typeof v === 'number' ? formatPan(v) : '—');
  const text = (v: unknown) => (typeof v === 'string' ? v : '—');
  const toggle = (v: unknown) => onOff(v, t);
  const time = (v: unknown) => framesText(v, names, t);
  if (field === 'gainMilliDb') return { key: 'diff.field.volume', value: db };
  if (field === 'name') return { key: 'diff.field.name', value: text };
  if (type === 'track') {
    if (field === 'pan') return { key: 'diff.field.pan', value: pan };
    if (field === 'mute') return { key: 'diff.field.mute', value: toggle };
    if (field === 'solo') return { key: 'diff.field.solo', value: toggle };
    if (field === 'inserts') return { key: 'diff.field.plugins' };
  }
  if (type === 'root') {
    if (field === 'trackOrder') return { key: 'diff.field.trackOrder' };
    if (field === 'tempo') return { key: 'diff.field.tempo' };
  }
  if (type === 'clip') {
    if (field === 'position') return { key: 'diff.field.position', value: time };
    if (field === 'length') return { key: 'diff.field.length', value: time };
  }
  if (type === 'plugin_slot' && field === 'bypass') return { key: 'diff.field.bypass', value: toggle };
  return null;
}

// "volume 0.00 dB → -3.00 dB", ... for a modified row; the change kind otherwise.
export function rowChanges(row: DiffRow, names: StepNames, t: T): string[] {
  if (row.kind !== 'modified') return [t(`diff.kind.${row.kind}`)];
  const type = row.ref.slice(0, row.ref.indexOf(':'));
  const out: string[] = [];
  let other = false;
  for (const change of row.changes) {
    const wording = fieldWording(type, change.field, names, t);
    if (!wording) {
      other = true;
      continue;
    }
    const { key, value } = wording;
    const line = value ? t(key, { before: value(change.before), after: value(change.after) }) : t(key);
    if (!out.includes(line)) out.push(line);
  }
  if (other) out.push(t('diff.field.other'));
  return out;
}
