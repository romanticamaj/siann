// The Plans tab's history rows (m5-ui-port-plans; mockup.html's .hrow; UI
// redesign 10.10, P1-13 notes): every plan but the one on the card, newest
// first, each one title line (the first step in user wording: plans have no
// title until E-7), one badge (Stale wins over Approved; the card keeps
// both, 4.5 C6) and one detail line: the split label of a partial
// approval's parent, the rejection note "sent to agent", the parent of a
// sub-plan, else the step count and the time.

import type { Locale } from '../i18n/locale';
import { translator } from '../i18n/t';
import type { PlanEntry, PlanState } from '../model/plan-store';
import { badgeText, cardOf, type BadgeKey } from './card';
import type { StepNames } from './describe';
import { isolateName } from './isolate';

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

export function historyOf(
  plans: readonly PlanEntry[],
  selected: string | null,
  nowMs: number,
  firstSeen: ReadonlyMap<string, number>,
  locale: Locale,
  names: StepNames,
): HistoryRow[] {
  const t = translator(locale);
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
              : ['summary', [card.steps, ...(card.time !== null ? [card.time] : [])].join(' · ')];
      return {
        hash: plan.hash,
        shortHash: card.shortHash,
        state: plan.state,
        title: card.lead,
        badge,
        badgeText: badgeText(plan, badge, t),
        detailKind,
        detail,
      };
    });
}
