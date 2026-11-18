// The branch chip (m5b-ui-audition; UI redesign 4.3, 2.4), ported from the
// mockup's top bar (mockup.html: span.chip[branch-chip] > the small branch
// icon, a span and span.num in --tx-3), styled by ui/top-bar.css. While main
// is heard (or the side is unknown) it reads `main` and the head revision;
// while a branch is heard it names the plan as the banner does
// (plans/plan-name.ts, heardPlanName: its first step and step count, the
// generic word when no held plan owns the branch), shortened with an
// ellipsis (shell.css) and the whole name in its title. No branch id is
// shown. It is rendered while a head revision is known, and goes under
// 1300 px (shell.css). Offline it keeps the last head the read model holds.

import { useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { useStepNames } from '../plans/hooks';
import { ISOLATE } from '../plans/isolate';
import { heardPlanName } from '../plans/plan-name';
import { Icon } from './icons';

export interface BranchChipProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  // The head revision of main, or null while none is known.
  readonly revision: string | null;
}

export function BranchChip({ client, plans, revision }: BranchChipProps) {
  const t = useT();
  const names = useStepNames(client);
  const snapshot = useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.getSnapshot(),
    () => plans.getSnapshot(),
  );
  if (revision === null) return null;
  const heard = heardPlanName(snapshot, t, names);
  if (heard !== null) {
    const name = heard.name ? t('chip.proposal', { lead: heard.name.lead, steps: heard.name.steps }) : t('chip.generic');
    return (
      <span className="chip" data-part="branch-chip" data-testid="branch-chip" data-heard="proposal" title={name}>
        <Icon name="branch" small />
        <span {...ISOLATE}>{name}</span>
      </span>
    );
  }
  return (
    <span className="chip" data-part="branch-chip" data-testid="branch-chip" data-heard="main" title={t('chip.mainTitle', { revision })}>
      <Icon name="branch" small />
      <span>{t('chip.main')}</span>
      <span className="num" style={{ color: 'var(--tx-3)' }}>
        {revision}
      </span>
    </span>
  );
}
