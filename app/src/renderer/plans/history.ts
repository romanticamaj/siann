// The Plans tab's history rows (m5-ui-port-plans; mockup.html's .hrow; UI
// redesign 10.10, P1-13 notes): every plan but the one on the card, newest
// first, each one title line (plans/plan-name.ts: the plan's title with
// features.planMetadata, m5b-ui-plan-metadata, else the first step in user
// wording), one badge (Stale wins over Approved; the card keeps both, 4.5 C6)
// and one detail line: the split label of a partial approval's parent, the
// rejection note "sent to agent", the parent of a sub-plan, else the step
// count, the agent's name for a plan an MCP agent submitted (with the
// feature, as the mockup's rows read), and the time.

import type { Locale } from '../i18n/locale';
import { translator } from '../i18n/t';
import { capabilitySelector, type CapabilitySelector } from '../model/capabilities';
import type { PlanEntry, PlanState } from '../model/plan-store';
import { badgeText, cardOf, type BadgeKey } from './card';
import type { StepNames } from './describe';
import { isolateName } from './isolate';
import { planName } from './plan-name';

export type RowBadge = BadgeKey | 'stale';

export interface HistoryRow {
  readonly hash: string;
  readonly shortHash: string;
  readonly state: PlanState;
  readonly title: string;
  readonly badge: RowBadge;
  readonly badgeText: string;
  readonly detailKind: 'split' | 'reason' | 'partOf' | 'summary';
  readonly detail: string;
}

// The rejection note as the mockup's row words it; the note is the user's
// text, so it is its own isolate inside the sentence.
export function rejectionLine(note: string, locale: Locale): string {
  return translator(locale)('history.rejected', { note: isolateName(note) });
}

// "N steps", and "N steps · <agent>" for an MCP agent's plan with the feature.
function summaryOf(plan: PlanEntry, steps: string, metadata: boolean, locale: Locale): string {
  if (!metadata || plan.actor?.kind !== 'mcp') return steps;
  return translator(locale)('history.summaryBy', { steps, name: isolateName(plan.actor.name) });
}

export function historyOf(
  plans: readonly PlanEntry[],
  selected: string | null,
  nowMs: number,
  firstSeen: ReadonlyMap<string, number>,
  locale: Locale,
  names: StepNames,
  // engine.capabilities (unknown: M5's rows).
  can: CapabilitySelector = capabilitySelector(null),
): HistoryRow[] {
  const t = translator(locale);
  const metadata = can.feature('planMetadata');
  return [...plans]
    .reverse()
    .filter((plan) => plan.hash !== selected)
    .map((plan) => {
      const card = cardOf(plan, plans, null, nowMs, firstSeen.get(plan.hash), locale, names);
      const badge: RowBadge = card.stale ? 'stale' : card.badge;
      const [detailKind, detail]: [HistoryRow['detailKind'], string] =
        card.split !== null
          ? ['split', card.split]
          : card.reason !== null
            ? ['reason', rejectionLine(card.reason, locale)]
            : card.partOf !== null
              ? ['partOf', card.partOf]
              : ['summary', [summaryOf(plan, card.steps, metadata, locale), ...(card.time !== null ? [card.time] : [])].join(' · ')];
      const name = planName(plan, t, names, can);
      return {
        hash: plan.hash,
        shortHash: card.shortHash,
        state: plan.state,
        title: name.kind === 'title' ? name.title : card.lead,
        badge,
        badgeText: badgeText(plan, badge, t),
        detailKind,
        detail,
      };
    });
}
