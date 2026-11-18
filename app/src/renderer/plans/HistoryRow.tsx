// A history row of the Plans tab (m5-ui-port-plans; mockup.html's .hrow;
// UI redesign 10.10, P1-13): an earlier plan's title line (b), one badge and
// one detail line (small), styled by ui/right-zone.css. The title keeps to one
// line with an ellipsis (shell.css), the whole title in its tooltip and in the
// button's name. The row is the button
// that selects the plan (a click, or Enter), keeping the test id
// plan-<hash8> the cards had. Words come from plans/history.ts; no id is
// shown, and the agent's and the user's text is isolated.

import { badgeClass } from './card';
import type { HistoryRow as HistoryRowData } from './history';
import { ISOLATE } from './isolate';

const DETAIL_TEST_IDS: Record<HistoryRowData['detailKind'], string | null> = {
  split: 'plan-split',
  reason: 'plan-reason',
  partOf: 'plan-part-of',
  summary: null,
};

export function HistoryRow({ row, onSelect }: { row: HistoryRowData; onSelect: () => void }) {
  const detail = DETAIL_TEST_IDS[row.detailKind];
  return (
    <button type="button" className="hrow" data-part-item="plan-history" data-testid={`plan-${row.shortHash}`} data-plan={row.shortHash} onClick={onSelect}>
      <b title={row.title} {...ISOLATE}>
        {row.title}
      </b>
      <span className={badgeClass(row.badge)} data-testid={`plan-state-${row.shortHash}`} data-state={row.state} data-badge={row.badge}>
        {row.badgeText}
      </span>
      <small {...(detail ? { 'data-testid': `${detail}-${row.shortHash}` } : {})} {...ISOLATE}>
        {row.detail}
      </small>
    </button>
  );
}
