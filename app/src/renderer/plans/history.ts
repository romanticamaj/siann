// The Plans tab's history rows (m5-ui-port-plans): not implemented yet.

import type { Locale } from '../i18n/locale';
import type { PlanEntry, PlanState } from '../model/plan-store';
import type { BadgeKey } from './card';
import type { StepNames } from './describe';

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

export function historyOf(
  _plans: readonly PlanEntry[],
  _selected: string | null,
  _nowMs: number,
  _firstSeen: ReadonlyMap<string, number>,
  _locale: Locale,
  _names: StepNames,
): HistoryRow[] {
  return [];
}
