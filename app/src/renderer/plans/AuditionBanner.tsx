// The audition banner (m5-ui-plan-panel; UI redesign 4.3 as corrected for
// P1-5): a row under the top bar, outside the zones, so it is visible
// whichever zones are open, while the side heard is a proposal branch. It
// names the plan as its card does (first step and step count; titles arrive
// with E-7), or reads "Hearing a proposal" when no plan the store holds has
// that branch, and offers Hear main, Merge and Discard, each only when
// engine.capabilities lists its method. A refusal is shown on the banner.
// The violet frame, solid ghosts, Shift+A and the branch chip are P2-3.

import { useState } from 'react';

import { refusalLine } from '../i18n/errors';
import { translator, useLocale } from '../i18n/t';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { Capable } from '../shell/Capable';
import { runAction, type PlanAction } from './actions';
import { describeStep } from './describe';
import { usePlanSnapshot, useStepNames } from './hooks';

export interface AuditionBannerProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
}

export function AuditionBanner({ client, plans }: AuditionBannerProps) {
  const locale = useLocale();
  const t = translator(locale);
  const snapshot = usePlanSnapshot(plans);
  const names = useStepNames(client);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ branch: string; line: string } | null>(null);
  const branch = snapshot.heard;
  if (branch === null || branch === 'main') return null;
  const plan = snapshot.plans.find((p) => p.proposalBranch === branch);
  const first = plan?.steps[0];
  const text = first
    ? t('banner.hearing', { lead: describeStep(first, t, names), steps: t('plans.steps', { count: plan!.steps.length }) })
    : t('banner.generic');
  const run = (action: PlanAction) => {
    if (busy) return;
    setBusy(true);
    void runAction(client, action).then((outcome) => {
      setBusy(false);
      setError(outcome.ok ? null : { branch, line: refusalLine(outcome.code, outcome.engineMessage, locale, outcome.detail) });
    });
  };
  return (
    <div className="audition-banner" data-testid="audition-banner" role="region" aria-label={t('banner.label')}>
      <span className="audition-banner-text">{text}</span>
      <Capable method="audition.hear">
        <button type="button" data-testid="banner-hear-main" disabled={busy} onClick={() => run({ kind: 'hear', side: 'main' })}>
          {t('plans.hearMain')}
        </button>
      </Capable>
      <Capable method="proposal.merge">
        <button type="button" className="primary" data-testid="banner-merge" disabled={busy} onClick={() => run({ kind: 'merge', branch })}>
          {t('plans.merge')}
        </button>
      </Capable>
      <Capable method="proposal.discard">
        <button type="button" data-testid="banner-discard" disabled={busy} onClick={() => run({ kind: 'discard', branch })}>
          {t('plans.discard')}
        </button>
      </Capable>
      {error && error.branch === branch ? (
        <span className="audition-banner-error" data-testid="banner-error">
          {error.line}
        </span>
      ) : null}
    </div>
  );
}
