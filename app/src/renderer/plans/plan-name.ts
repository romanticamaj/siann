// How a plan is named (m5b-ui-plan-metadata; UI redesign 4.3: one shared
// helper for the card's title line, the history rows, the audition banner and
// the toast, and for the ghosts' pill and the branch chip once those land).
// With features.planMetadata and a title: the title. Otherwise the M5
// wording: the first step in user wording and the step count; with no steps,
// the generic word ("a proposal"). Without the feature a title the plan
// carries is not shown, as on an engine before E-7.

import type { T } from '../i18n/t';
import type { CapabilitySelector } from '../model/capabilities';
import type { PlanEntry } from '../model/plan-store';
import { describeStep, type StepNames } from './describe';

export type PlanName =
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'steps'; readonly lead: string; readonly steps: string }
  | { readonly kind: 'generic' };

export function planName(plan: PlanEntry | undefined, t: T, names: StepNames, can: CapabilitySelector): PlanName {
  if (!plan) return { kind: 'generic' };
  if (can.feature('planMetadata') && plan.title !== undefined) return { kind: 'title', title: plan.title };
  const first = plan.steps[0];
  if (!first) return { kind: 'generic' };
  return { kind: 'steps', lead: describeStep(first, t, names), steps: t('plans.steps', { count: plan.steps.length }) };
}
