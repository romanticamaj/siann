// Toast messages built from the catalogs (UI redesign spec 6.2). The toast
// surface itself arrives with P1-5 and P1-6; the builders and their wording
// per locale exist now so those tickets only place them.

import type { Locale } from './locale';
import { translator } from './t';

export function planArrivedMessage(locale: Locale, params: { readonly steps: number }): string {
  return translator(locale)('toast.planArrived', { steps: params.steps });
}

export function reconnectedMessage(locale: Locale, params: { readonly revision: string }): string {
  return translator(locale)('toast.reconnected', { revision: params.revision });
}
