// A plan's name until E-7 gives plans a title (m5b-ui-ghosts; UI redesign
// 4.2, 4.3): its first step in user wording (plans/describe.ts) and its step
// count ("3 steps"). One helper for every place that names a plan by it: the
// audition banner, the toolbar's proposal pill, the Inspector's Agent changes
// section and the card's lead. A plan without steps has no name.

import type { T } from '../i18n/t';
import type { PlanEntry } from '../model/plan-store';
import { describeStep, type StepNames } from './describe';

export interface PlanName {
  // The first step in user wording.
  readonly lead: string;
  // "N steps", in the locale.
  readonly steps: string;
}

export function planName(plan: Pick<PlanEntry, 'steps'>, t: T, names: StepNames): PlanName | null {
  const first = plan.steps[0];
  if (!first) return null;
  return { lead: describeStep(first, t, names), steps: t('plans.steps', { count: plan.steps.length }) };
}
