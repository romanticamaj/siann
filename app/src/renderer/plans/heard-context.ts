// The side heard for the zones (m5b-ui-audition; UI redesign 4.3, 4.5 C5):
// App provides the PlanStore's heard (audition.changed, session.inspect);
// without a provider (a zone rendered alone) nothing is heard. useEditGuard()
// is the edit guard's reason in the locale while a branch is heard
// (model/edit-guard.ts), null otherwise: a structural control is disabled
// with it as its tooltip.

import { createContext, useContext } from 'react';

import { useT } from '../i18n/t';
import { GUARD_REASON, structuralBlocked } from '../model/edit-guard';

export const HeardContext = createContext<string | null>(null);

export function useHeard(): string | null {
  return useContext(HeardContext);
}

export function useEditGuard(): string | null {
  const t = useT();
  return structuralBlocked(useHeard()) ? t(GUARD_REASON) : null;
}
