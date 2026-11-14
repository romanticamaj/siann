// Toast messages built from the catalogs (UI redesign spec 6.2), for the
// toast surface (shell/Toasts.tsx): the reconnect toast of P1-6 and the
// new-plan toast of P1-5.

import type { Locale } from './locale';
import { translator } from './t';

export function planArrivedMessage(locale: Locale, params: { readonly steps: number }): string {
  return translator(locale)('toast.planArrived', { steps: params.steps });
}

export function reconnectedMessage(locale: Locale, params: { readonly revision: string }): string {
  return translator(locale)('toast.reconnected', { revision: params.revision });
}
