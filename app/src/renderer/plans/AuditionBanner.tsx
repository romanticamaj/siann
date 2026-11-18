// The audition banner (m5-ui-plan-panel; UI redesign 4.3 as corrected for
// P1-5): a row under the top bar, outside the zones, so it is visible
// whichever zones are open, while the side heard is a proposal branch. It
// names the plan through plans/plan-name.ts (its title with
// features.planMetadata, m5b-ui-plan-metadata; else its first step and step
// count), or reads "Hearing a proposal" when no plan the store holds has
// that branch, and offers Hear main, Merge and Discard, each only when
// engine.capabilities lists its method. A refusal is shown on the banner as
// plans/RefusalLine shows it (no ids; the engine's text behind a disclosure).
// Since m5b-ui-audition (P2-3) it names the plan through heardPlanName, as
// the branch chip does, and the window around it has the violet frame
// (shell/Shell.tsx, .app[data-hearing="proposal"]); its buttons carry no key.

import { useState } from 'react';

import { translator, useLocale } from '../i18n/t';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { Capable, useCapabilities } from '../shell/Capable';
import { runAction, type PlanAction } from './actions';
import { ISOLATE, isolateName } from './isolate';
import { heardPlanName } from './plan-name';
import { usePlanSnapshot, useStepNames } from './hooks';
import { RefusalLine, type Refusal } from './RefusalLine';

export interface AuditionBannerProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
}

export function AuditionBanner({ client, plans }: AuditionBannerProps) {
  const locale = useLocale();
  const t = translator(locale);
  const snapshot = usePlanSnapshot(plans);
  const names = useStepNames(client);
  const can = useCapabilities();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ branch: string; refusal: Refusal } | null>(null);
  const heard = heardPlanName(snapshot, t, names, can);
  if (heard === null) return null;
  const { branch, name } = heard;
  const text =
    name.kind === 'title'
      ? t('banner.hearingTitled', { title: isolateName(name.title) })
      : name.kind === 'steps'
        ? t('banner.hearing', { lead: name.lead, steps: name.steps })
        : t('banner.generic');
  const run = (action: PlanAction) => {
    if (busy) return;
    setBusy(true);
    void runAction(client, action).then((outcome) => {
      setBusy(false);
      setError(
        outcome.ok
          ? null
          : { branch, refusal: { code: outcome.code, message: outcome.engineMessage, changedEntities: outcome.changedEntities } },
      );
    });
  };
  return (
    <div className="audition-banner" data-testid="audition-banner" role="region" aria-label={t('banner.label')}>
      <span className="audition-banner-text" {...ISOLATE}>
        {text}
      </span>
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
        <RefusalLine
          key={`${error.refusal.code ?? ''}:${error.refusal.message}`}
          refusal={error.refusal}
          locale={locale}
          names={names}
          testId="banner-error"
          className="audition-banner-error"
        />
      ) : null}
    </div>
  );
}
