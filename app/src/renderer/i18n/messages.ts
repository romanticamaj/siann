// Toast messages built from the catalogs (UI redesign spec 6.2). The toast
// surface is shell/toast-store.ts and shell/Toasts.tsx (P1-5); a plan's
// arrival is raised by plans/arrivals.ts, the reconnect by P1-6.

import type { Locale } from './locale';
import { translator } from './t';

export function planArrivedMessage(locale: Locale, params: { readonly steps: number }): string {
  return translator(locale)('toast.planArrived', { steps: params.steps });
}

export function reconnectedMessage(locale: Locale, params: { readonly revision: string }): string {
  return translator(locale)('toast.reconnected', { revision: params.revision });
}
