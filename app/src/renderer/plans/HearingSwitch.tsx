// The hearing switch (m5-ui-plan-panel; UI redesign 4.3): Main | Proposal at
// the top of the right zone. It marks the side heard from the PlanStore only,
// which follows audition.changed and session.inspect; a click sends one
// audition.hear and the mark moves when the engine says so, never before.
// Proposal names the heard branch, or the proposal of a proposed plan when
// main is heard. Disabled while the side heard is unknown; absent when
// engine.capabilities does not list audition.hear. No branch id is shown.

import { useState } from 'react';

import { useT } from '../i18n/t';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { useCapabilities } from '../shell/Capable';
import { runAction } from './actions';
import { usePlanSnapshot } from './hooks';

export interface HearingSwitchProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
}

export function HearingSwitch({ client, plans }: HearingSwitchProps) {
  const t = useT();
  const can = useCapabilities();
  const snapshot = usePlanSnapshot(plans);
  const [busy, setBusy] = useState(false);
  if (!can.has('audition.hear')) return null;
  const heard = snapshot.heard;
  const proposals = snapshot.plans.filter((p) => p.proposalBranch !== undefined).map((p) => p.proposalBranch!);
  const proposal = heard !== null && heard !== 'main' ? heard : proposals[proposals.length - 1];
  const side = heard === null ? 'unknown' : heard === 'main' ? 'main' : 'proposal';
  const hear = (target: string | undefined) => {
    if (target === undefined || busy) return;
    setBusy(true);
    void runAction(client, { kind: 'hear', side: target }).then(() => setBusy(false));
  };
  return (
    <div className="hearing-switch" role="group" aria-label={t('hearing.label')} data-testid="plan-heard" data-heard={side}>
      <span className="hearing-label">{t('hearing.label')}</span>
      <button
        type="button"
        data-testid="hear-main"
        aria-pressed={side === 'main'}
        disabled={heard === null || busy}
        onClick={() => hear('main')}
      >
        {t('hearing.main')}
      </button>
      <button
        type="button"
        data-testid="hear-proposal"
        aria-pressed={side === 'proposal'}
        disabled={heard === null || busy || proposal === undefined}
        onClick={() => hear(proposal)}
      >
        {t('hearing.proposal')}
      </button>
    </div>
  );
}
