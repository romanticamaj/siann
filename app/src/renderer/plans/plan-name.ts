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

// The name as the toolbar's proposal pill and the Inspector's Agent changes
// section show it (m5b-ui-ghosts): a lead (the title, else the first step in
// user wording) and the step count, as the mockup's pill reads "<b>Lift the
// chorus</b> · 6 changes". A plan without steps has none.
export function planNameParts(plan: PlanEntry | undefined, t: T, names: StepNames, can: CapabilitySelector): { readonly lead: string; readonly steps: string } | null {
  if (!plan || plan.steps.length === 0) return null;
  const name = planName(plan, t, names, can);
  if (name.kind === 'generic') return null;
  return { lead: name.kind === 'title' ? name.title : name.lead, steps: t('plans.steps', { count: plan.steps.length }) };
}
