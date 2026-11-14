// A new plan raises a toast (m5-ui-plan-panel; UI redesign 4.4): each arrival
// the PlanStore reports pushes the catalog's planArrived message in the
// locale shown at that moment, re-worded if the language is switched. The count on the Plans button follows the
// store by itself (TopBar). Returns the unsubscribe function.

import type { Locale } from '../i18n/locale';
import { planArrivedMessage } from '../i18n/messages';
import type { PlanStore } from '../model/plan-store';
import type { ToastStore } from '../shell/toast-store';

export function announceArrivals(plans: PlanStore, toasts: ToastStore, locale: () => Locale): () => void {
  return plans.onArrival((plan) => {
    const steps = plan.steps.length;
    toasts.push(planArrivedMessage(locale(), { steps }), (next) => planArrivedMessage(next, { steps }));
  });
}
