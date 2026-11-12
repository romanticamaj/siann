// The plan review's words for people (UX pass, A7/A8/A9/A12/B7/B9): diff rows
// as an entity's display name and its changed fields in user units, the rows
// in plan-step order with the steps that write each, why a stale plan is
// stale, a split parent's label, and which steps a decided plan approved.
// Pure functions over protocol answers (plan.preview, plan.list).

import { formatGainDb, formatPan, formatSeconds, mediaDisplayName } from '../format';
import type { PlanEntry, StaleRef } from '../model/plan-store';
import { changesOf, formatValue, stepSummary, type DiffRow, type FieldChange, type PlanPreview } from './diff';

// The entity refs a step writes, as plan.preview names them: a track op its
// track (and the root, whose trackOrder an add or remove changes), a clip op
// its clip.
export function stepRefs(step: Record<string, unknown>): string[] {
  const op = typeof step.op === 'string' ? step.op : '';
  const refs: string[] = [];
  if (op.startsWith('track.') && typeof step.trackId === 'string') {
    refs.push(`track:${step.trackId}`);
    if (op === 'track.add' || op === 'track.remove' || op === 'track.move') refs.push('root:root');
  }
  if (op.startsWith('clip.') && typeof step.clipId === 'string') refs.push(`clip:${step.clipId}`);
  if (op.startsWith('plugin.') && typeof step.slotId === 'string') refs.push(`plugin_slot:${step.slotId}`);
  return refs;
}

export interface OrderedRow extends DiffRow {
  // The plan's step indexes that write this entity (empty when no step names it).
  readonly steps: readonly number[];
}

// The diff rows in plan-step order: a row goes where the first step that
// writes its entity is (the step's own entity before the root it also
// touches); rows no step names (stale only, or knock-on changes) follow in
// their order.
export function orderRowsBySteps(rows: readonly DiffRow[], steps: readonly Record<string, unknown>[]): OrderedRow[] {
  const byRef = new Map<string, number[]>();
  steps.forEach((step, index) => {
    for (const ref of stepRefs(step)) {
      const list = byRef.get(ref) ?? [];
      if (!list.includes(index)) list.push(index);
      byRef.set(ref, list);
    }
  });
  const ordered = rows.map((row, position) => ({ row: { ...row, steps: byRef.get(row.ref) ?? [] } as OrderedRow, position }));
  ordered.sort((a, b) => {
    const fa = a.row.steps.length > 0 ? a.row.steps[0]! : Infinity;
    const fb = b.row.steps.length > 0 ? b.row.steps[0]! : Infinity;
    if (fa !== fb) return fa - fb;
    const ra = a.row.ref === 'root:root' ? 1 : 0;
    const rb = b.row.ref === 'root:root' ? 1 : 0;
    return ra - rb || a.position - b.position;
  });
  return ordered.map((o) => o.row);
}

// Names entities for people.
export interface EntityNames {
  track(id: string): string | undefined;
  // The session's sample rate, for clip positions (48000 when absent).
  readonly sampleRate?: number;
}

function nameOf(entity: Record<string, unknown> | null | undefined): string | undefined {
  return entity && typeof entity.name === 'string' ? entity.name : undefined;
}

// The track names a preview knows (before first, so a renamed track keeps the
// name people know it by), backed by the read model's.
export function previewNames(preview: PlanPreview | null, model: (id: string) => string | undefined, sampleRate?: number): EntityNames {
  const names = new Map<string, string>();
  for (const entity of preview?.entities ?? []) {
    if (!entity.ref.startsWith('track:')) continue;
    const name = nameOf(entity.before) ?? nameOf(entity.after);
    if (name) names.set(entity.ref.slice('track:'.length), name);
  }
  return {
    track: (id) => model(id) ?? names.get(id),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
  };
}

function trackLabel(id: string, names: EntityNames): string {
  return names.track(id) ?? id;
}

// "Track order: Pad added after Vox BG", "Track order: FX removed",
// "Track order: Kick moved".
export function summarizeTrackOrder(before: readonly string[], after: readonly string[], names: EntityNames): string {
  const parts: string[] = [];
  for (const id of after.filter((t) => !before.includes(t))) {
    const index = after.indexOf(id);
    parts.push(`${trackLabel(id, names)} added ${index === 0 ? 'at the top' : `after ${trackLabel(after[index - 1]!, names)}`}`);
  }
  for (const id of before.filter((t) => !after.includes(t))) parts.push(`${trackLabel(id, names)} removed`);
  if (parts.length === 0) {
    const keptBefore = before.filter((t) => after.includes(t));
    const keptAfter = after.filter((t) => before.includes(t));
    const moved = keptAfter.filter((id, i) => keptBefore[i] !== id);
    parts.push(moved.length > 0 ? `${moved.map((id) => trackLabel(id, names)).join(', ')} moved` : 'unchanged');
  }
  return `Track order: ${parts.join('; ')}`;
}

function onOff(value: unknown): string {
  return value ? 'on' : 'off';
}

function seconds(value: unknown, rate: number): string {
  const frames = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(frames) ? formatSeconds(frames / rate) : formatValue(value);
}

function positionText(value: unknown, rate: number): string {
  const position = value as { domain?: unknown; value?: unknown } | null;
  return position && position.domain === 'audio' ? seconds(position.value, rate) : formatValue(value);
}

// A field change in people's units: [label, before, after], or null for a
// field worded whole (trackOrder) or not known.
function fieldWords(type: string, change: FieldChange, names: EntityNames): [string, string, string] | null {
  const { field, before, after } = change;
  const rate = names.sampleRate ?? 48000;
  if (field === 'gainMilliDb' && typeof before === 'number' && typeof after === 'number') {
    return ['Gain', formatGainDb(before), formatGainDb(after)];
  }
  if (field === 'pan' && typeof before === 'number' && typeof after === 'number') return ['Pan', formatPan(before), formatPan(after)];
  if (field === 'mute') return ['Mute', onOff(before), onOff(after)];
  if (field === 'solo') return ['Solo', onOff(before), onOff(after)];
  if (field === 'bypass') return ['Bypass', onOff(before), onOff(after)];
  if (field === 'name') return ['Name', String(before ?? '—'), String(after ?? '—')];
  if (field === 'channels') return ['Channels', String(before ?? '—'), String(after ?? '—')];
  if (field === 'inserts') {
    const count = (v: unknown) => String(Array.isArray(v) ? v.length : 0);
    return ['Inserts', count(before), count(after)];
  }
  if (type === 'clip') {
    if (field === 'position') return ['Start', positionText(before, rate), positionText(after, rate)];
    if (field === 'length') return ['Length', seconds(before, rate), seconds(after, rate)];
    if (field === 'sourceStart') return ['Source start', seconds(before, rate), seconds(after, rate)];
    if (field === 'trackId') return ['Track', trackLabel(String(before), names), trackLabel(String(after), names)];
  }
  return null;
}

// One changed field: "Gain -9.0 dB → -6.0 dB", "Mute on → off".
export function describeChange(type: string, change: FieldChange, names: EntityNames): string {
  if (change.field === 'trackOrder' && Array.isArray(change.before) && Array.isArray(change.after)) {
    return summarizeTrackOrder(change.before as string[], change.after as string[], names);
  }
  const words = fieldWords(type, change, names);
  if (words) return `${words[0]} ${words[1]} → ${words[2]}`;
  return `${change.field}: ${formatValue(change.before)} → ${formatValue(change.after)}`;
}

function typeOf(ref: string): string {
  return ref.slice(0, ref.indexOf(':'));
}

// The row's entity for people: "Track: Vox BG", "Session", "Clip: kick on Kick".
export function entityLabel(row: Pick<DiffRow, 'ref' | 'before' | 'after'>, names: EntityNames): string {
  const type = typeOf(row.ref);
  const id = row.ref.slice(type.length + 1);
  const entity = row.after ?? row.before;
  switch (type) {
    case 'root':
      return 'Session';
    case 'track':
      return `Track: ${nameOf(row.before) ?? nameOf(row.after) ?? trackLabel(id, names)}`;
    case 'clip': {
      const media = entity && typeof entity.mediaId === 'string' ? mediaDisplayName(entity.mediaId) : id;
      const trackId = entity && typeof entity.trackId === 'string' ? entity.trackId : null;
      return `Clip: ${media}${trackId ? ` on ${trackLabel(trackId, names)}` : ''}`;
    }
    case 'media':
      return `Media: ${mediaDisplayName(id)}`;
    case 'plugin_slot':
      return `Plugin: ${nameOf(entity) ?? id}`;
    default:
      return row.ref;
  }
}

// What a row changes, one phrase per field, in people's units.
export function describeRow(row: DiffRow, names: EntityNames): string[] {
  const type = typeOf(row.ref);
  if (row.kind === 'added') {
    const after = row.after ?? {};
    if (type === 'track') {
      const details = [
        typeof after.channels === 'number' ? `${after.channels} ch` : null,
        typeof after.gainMilliDb === 'number' ? formatGainDb(after.gainMilliDb) : null,
        typeof after.pan === 'number' ? `pan ${formatPan(after.pan)}` : null,
      ].filter((d): d is string => d !== null);
      return [`Added${details.length > 0 ? ` (${details.join(', ')})` : ''}`];
    }
    return ['Added'];
  }
  if (row.kind === 'removed') return ['Removed'];
  if (row.kind === 'unchanged') return row.stale ? [] : ['No change'];
  return row.changes.map((change) => describeChange(type, change, names));
}

// Why a stale entity makes the plan stale, for people: "Vox Lead gain changed
// since this plan was made (was +1.5 dB, now +0.5 dB)". `base` is the entity
// at the plan's base revision when the engine still has it, `head` the entity
// now.
export function staleMessage(
  stale: StaleRef,
  base: Record<string, unknown> | null | undefined,
  head: Record<string, unknown> | null | undefined,
  names: EntityNames,
): string {
  const label = entityLabel({ ref: stale.ref, before: base ?? null, after: head ?? null }, names).replace(/^Track: /, '');
  if (stale.change === 'removed') return `${label} was removed since this plan was made`;
  if (stale.change === 'added') return `${label} was added since this plan was made`;
  if (!base || !head) return `${label} changed since this plan was made`;
  const type = typeOf(stale.ref);
  const changes = changesOf(base, head);
  if (changes.length === 0) return `${label} changed since this plan was made`;
  const worded = changes.map((change) => ({ change, words: fieldWords(type, change, names) }));
  const what = worded.map(({ change, words }) => (words ? words[0].toLowerCase() : change.field)).join(' and ');
  const details = worded.map(({ change, words }) => {
    if (!words) return describeChange(type, change, names);
    return `${worded.length > 1 ? `${words[0].toLowerCase()} ` : ''}was ${words[1]}, now ${words[2]}`;
  });
  return `${label} ${what} changed since this plan was made (${details.join('; ')})`;
}

// ---------------------------------------------------------------- plan rows

// The sub-plans a partial approval made of `plan`.
export function childrenOf(plan: PlanEntry, plans: readonly PlanEntry[]): PlanEntry[] {
  return plans.filter((p) => p.parentPlan === plan.hash);
}

export type BadgeTone = 'pending' | 'approved' | 'rejected' | 'applied' | 'split' | 'muted';

// The state badge of a plan row. A rejected plan whose steps went partly into
// an approved sub-plan reads "split (3/5 approved)" (its protocol state stays
// rejected).
export function stateBadge(plan: PlanEntry, plans: readonly PlanEntry[]): { readonly text: string; readonly tone: BadgeTone } {
  if (plan.state === 'rejected') {
    const children = childrenOf(plan, plans);
    if (children.length > 0) {
      const approved = Math.min(plan.steps.length, children.reduce((sum, child) => sum + child.steps.length, 0));
      return { text: `split (${approved}/${plan.steps.length} approved)`, tone: 'split' };
    }
    return { text: 'rejected', tone: 'rejected' };
  }
  switch (plan.state) {
    case 'validated':
      return { text: 'validated', tone: 'pending' };
    case 'approved':
      return { text: 'approved', tone: 'approved' };
    case 'applied':
      return { text: 'applied', tone: 'applied' };
    case 'rolled_back':
      return { text: 'rolled back', tone: 'muted' };
    default:
      return { text: plan.state, tone: 'muted' };
  }
}

// Whether the plan is stale for a decision still open (validated or approved).
export function isStale(plan: PlanEntry): boolean {
  return plan.stale.length > 0 && (plan.state === 'validated' || plan.state === 'approved');
}

// The plan row's lead: the plan's intent when it carries one, else its first
// step and how many more.
export function planSummary(plan: PlanEntry, trackName: (id: string) => string | undefined): string {
  const intent = plan.raw.intent;
  if (typeof intent === 'string' && intent.trim() !== '') return intent.trim();
  const first = plan.steps[0];
  if (!first) return 'Empty plan';
  const more = plan.steps.length - 1;
  return `${stepSummary(first, trackName)}${more > 0 ? ` + ${more} more` : ''}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export type StepMark = 'approved' | 'rejected' | null;

// What became of each step of a decided plan: all approved for an approved
// or applied plan, all rejected for a rejected one, and for a split parent
// approved where its sub-plans carry the step. null while undecided.
export function stepMarks(plan: PlanEntry, plans: readonly PlanEntry[]): StepMark[] {
  if (plan.state === 'approved' || plan.state === 'applied') return plan.steps.map(() => 'approved');
  if (plan.state !== 'rejected') return plan.steps.map(() => null);
  const carried = new Map<string, number>();
  for (const child of childrenOf(plan, plans)) {
    for (const step of child.steps) {
      const key = canonical(step);
      carried.set(key, (carried.get(key) ?? 0) + 1);
    }
  }
  return plan.steps.map((step) => {
    const key = canonical(step);
    const left = carried.get(key) ?? 0;
    if (left === 0) return 'rejected';
    carried.set(key, left - 1);
    return 'approved';
  });
}
