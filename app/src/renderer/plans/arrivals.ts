// A new plan raises a toast (m5-ui-plan-panel; UI redesign 4.4): each arrival
// the PlanStore reports pushes the catalog's planArrived message in the
// locale shown at that moment, re-worded if the language is switched. With
// features.planMetadata a titled plan is named by its title (m5b-ui-plan-
// metadata; plans/plan-name.ts), otherwise by its step count as in M5. The
// count on the Plans button follows the store by itself (TopBar). Returns the
// unsubscribe function.

import type { Locale } from '../i18n/locale';
import { planArrivedMessage, planArrivedTitledMessage } from '../i18n/messages';
import { translator } from '../i18n/t';
import { capabilitySelector, type CapabilitySelector } from '../model/capabilities';
import type { PlanStore } from '../model/plan-store';
import type { ToastStore } from '../shell/toast-store';
import { NO_NAMES } from './describe';
import { isolateName } from './isolate';
import { planName } from './plan-name';

export function announceArrivals(
  plans: PlanStore,
  toasts: ToastStore,
  locale: () => Locale,
  // engine.capabilities at the arrival (unknown: M5's wording).
  can: () => CapabilitySelector = () => capabilitySelector(null),
): () => void {
  return plans.onArrival((plan) => {
    const name = planName(plan, translator(locale()), NO_NAMES, can());
    if (name.kind === 'title') {
      const title = isolateName(name.title);
      toasts.push(planArrivedTitledMessage(locale(), { title }), (next) => planArrivedTitledMessage(next, { title }));
      return;
    }
    const steps = plan.steps.length;
    toasts.push(planArrivedMessage(locale(), { steps }), (next) => planArrivedMessage(next, { steps }));
  });
}
