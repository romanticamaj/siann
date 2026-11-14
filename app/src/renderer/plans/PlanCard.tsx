// A plan card in the Plans tab (m5-ui-plan-panel; UI redesign P1-5): the
// first step, the step count, the time, the state badge (with a Stale badge
// beside it) and the short hash; the split label, the rejection reason or
// the parent of a sub-plan. The whole card is the button that selects the
// plan. Words come from plans/card.ts; no id is shown.

import { useT } from '../i18n/t';
import type { PlanEntry } from '../model/plan-store';
import type { PlanCardData } from './card';

export interface PlanCardProps {
  readonly plan: PlanEntry;
  readonly card: PlanCardData;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export function PlanCard({ plan, card, selected, onSelect }: PlanCardProps) {
  const t = useT();
  const id = card.shortHash;
  return (
    <button type="button" className="plan-card" data-testid={`plan-${id}`} aria-pressed={selected} onClick={onSelect}>
      <span className="plan-card-lead">{card.lead}</span>
      <span className="plan-card-meta">
        <span>{card.steps}</span>
        {card.time !== null ? <span>{card.time}</span> : null}
        <code className="plan-card-hash">{id}</code>
      </span>
      <span className="plan-card-badges">
        <span className={`badge badge-${card.badge}`} data-testid={`plan-state-${id}`} data-state={plan.state} data-badge={card.badge}>
          {t(`badge.${card.badge}`)}
        </span>
        {card.stale ? (
          <span className="badge badge-stale" data-testid={`plan-stale-${id}`}>
            {t('badge.stale')}
          </span>
        ) : null}
      </span>
      {card.split !== null ? (
        <span className="plan-card-split" data-testid={`plan-split-${id}`}>
          {card.split}
        </span>
      ) : null}
      {card.reason !== null ? (
        <span className="plan-card-reason" data-testid={`plan-reason-${id}`}>
          {card.reason}
        </span>
      ) : null}
      {card.partOf !== null ? <span className="plan-card-part">{card.partOf}</span> : null}
    </button>
  );
}
