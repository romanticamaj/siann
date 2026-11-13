// A plan as a card (m5-ui-plan-panel; UI redesign 4.5 C1 and C6, P1-5), and
// a stale plan's reasons in user units. Pure functions over the store's plans.
//
// The lead is the first step in user wording (plans have no title until E-7),
// then the step count, a relative time, the state badge and the short hash.
// No protocol field carries a plan's submission time: the time is when this
// renderer first learnt of the plan through plan.changed (the store's
// firstSeen), else the plan's rejectedAt or approvedAt, else none. A rejected
// plan that another plan names as parentPlan is the parent of a partial
// approval: it reads "Split, N of M approved" and the engine's own note
// ("partially approved as sha256:...") is not shown; any other rejection
// shows its note. A stale approved plan keeps its Approved badge beside the
// Stale one (the engine never changes a plan's state on staleness).
//
// Stale reasons compare an entity at the head (plan.preview's `before`) with
// the same entity at the plan's baseRevision (session.fetch {refs, revision});
// without the base (the fetch was refused) they give the current value.

import { formatMilliDb, formatPan } from '../format';
import type { Locale } from '../i18n/locale';
import { relativeTime, translator, type T } from '../i18n/t';
import type { PlanEntry, PlanState } from '../model/plan-store';
import { describeStep, type StepNames } from './describe';

export type BadgeKey = 'draft' | 'needsReview' | 'approved' | 'approvedForAudition' | 'rejected' | 'applied' | 'rolledBack';

export interface PlanCardData {
  readonly lead: string;
  readonly stepCount: number;
  // "5 steps", worded.
  readonly steps: string;
  readonly time: string | null;
  readonly badge: BadgeKey;
  readonly stale: boolean;
  readonly shortHash: string;
  // "Split, N of M approved" for the parent of a partial approval.
  readonly split: string | null;
  // The rejection note shown as the reason.
  readonly reason: string | null;
  // "(part of <parent's short hash>)" for a sub-plan.
  readonly partOf: string | null;
  // The plan's proposal is the side heard.
  readonly heard: boolean;
}

export function hash8(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 8);
}

const BADGES: Record<PlanState, BadgeKey> = {
  draft: 'draft',
  validated: 'needsReview',
  approved: 'approved',
  rejected: 'rejected',
  applied: 'applied',
  rolled_back: 'rolledBack',
};

export function badgeOf(plan: PlanEntry): BadgeKey {
  if (plan.state === 'approved' && plan.proposalBranch !== undefined) return 'approvedForAudition';
  return BADGES[plan.state];
}

function timeOf(plan: PlanEntry, firstSeen: number | undefined, nowMs: number, locale: Locale): string | null {
  if (firstSeen !== undefined) return relativeTime(firstSeen, nowMs, locale);
  for (const field of ['rejectedAt', 'approvedAt'] as const) {
    const value = plan.raw[field];
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ms)) return relativeTime(ms, nowMs, locale);
  }
  return null;
}

export function cardOf(
  plan: PlanEntry,
  allPlans: readonly PlanEntry[],
  heard: string | null,
  nowMs: number,
  firstSeen: number | undefined,
  locale: Locale,
  names: StepNames,
): PlanCardData {
  const t = translator(locale);
  const child = plan.state === 'rejected' ? allPlans.find((p) => p.parentPlan === plan.hash) : undefined;
  const first = plan.steps[0];
  return {
    lead: first ? describeStep(first, t, names) : '',
    stepCount: plan.steps.length,
    steps: t('plans.steps', { count: plan.steps.length }),
    time: timeOf(plan, firstSeen, nowMs, locale),
    badge: badgeOf(plan),
    stale: plan.stale.length > 0 && (plan.state === 'validated' || plan.state === 'approved'),
    shortHash: hash8(plan.hash),
    split: child ? t('card.split', { approved: child.steps.length, total: plan.steps.length }) : null,
    reason: plan.state === 'rejected' && !child && plan.rejectionNote ? plan.rejectionNote : null,
    partOf: plan.parentPlan ? t('plans.partOf', { plan: hash8(plan.parentPlan) }) : null,
    heard: plan.proposalBranch !== undefined && plan.proposalBranch === heard,
  };
}

type Entity = Readonly<Record<string, unknown>>;

const nameOf = (entity: Entity | null | undefined): string | undefined =>
  typeof entity?.name === 'string' && entity.name !== '' ? entity.name : undefined;

// The changes of one track between the base and the head, one line each.
function trackChanges(name: string, base: Entity, head: Entity, t: T): string[] {
  const out: string[] = [];
  const onOff = (v: unknown) => t(v ? 'value.on' : 'value.off');
  if (base.gainMilliDb !== head.gainMilliDb && typeof base.gainMilliDb === 'number' && typeof head.gainMilliDb === 'number') {
    out.push(t('stale.volume', { name, before: formatMilliDb(base.gainMilliDb), after: formatMilliDb(head.gainMilliDb) }));
  }
  if (base.pan !== head.pan && typeof base.pan === 'number' && typeof head.pan === 'number') {
    out.push(t('stale.pan', { name, before: formatPan(base.pan), after: formatPan(head.pan) }));
  }
  if (base.mute !== head.mute) out.push(t('stale.mute', { name, before: onOff(base.mute), after: onOff(head.mute) }));
  if (base.solo !== head.solo) out.push(t('stale.solo', { name, before: onOff(base.solo), after: onOff(head.solo) }));
  if (base.name !== head.name && typeof base.name === 'string' && typeof head.name === 'string') {
    out.push(t('stale.name', { name, before: base.name, after: head.name }));
  }
  return out.length > 0 ? out : [t('stale.trackChanged', { name })];
}

// `head`: the entities at the head by ref (plan.preview's before, null where
// absent); `base`: the same at the plan's baseRevision, or null when it could
// not be read.
export function staleReasons(
  plan: PlanEntry,
  head: ReadonlyMap<string, Entity | null>,
  base: ReadonlyMap<string, Entity | null> | null,
  locale: Locale,
  names: StepNames,
): string[] {
  const t = translator(locale);
  const out: string[] = [];
  for (const { ref, change } of plan.stale) {
    const type = ref.slice(0, ref.indexOf(':'));
    const id = ref.slice(ref.indexOf(':') + 1);
    const now = head.get(ref) ?? null;
    const then = base?.get(ref) ?? null;
    if (type === 'track') {
      const name = nameOf(now) ?? nameOf(then) ?? names.track(id) ?? t('step.aTrack');
      if (change === 'removed') out.push(t('stale.removed', { name }));
      else if (change === 'added') out.push(t('stale.added', { name }));
      else if (now && then) out.push(...trackChanges(name, then, now, t));
      else if (now && typeof now.gainMilliDb === 'number' && typeof now.pan === 'number') {
        out.push(t('stale.trackNow', { name, volume: formatMilliDb(now.gainMilliDb), pan: formatPan(now.pan) }));
      } else out.push(t('stale.trackChanged', { name }));
      continue;
    }
    if (type === 'clip') {
      const clip = now ?? then;
      const trackId = typeof clip?.trackId === 'string' ? clip.trackId : names.clip(id)?.trackId;
      const track = trackId !== undefined ? names.track(trackId) : undefined;
      out.push(track ? t('stale.clip', { track }) : t('stale.clipAny'));
      continue;
    }
    out.push(t('stale.generic'));
  }
  return out;
}
