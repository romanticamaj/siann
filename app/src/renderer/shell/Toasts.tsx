// The toast surface (UI redesign spec 1.6: toasts slide in over 160 ms; 4.4:
// a new plan raises a toast; 4.5 C8: the reconnect toast). A polite live
// region at the lower right of the window, above the status bar: over the
// right zone (or the lower zone when the right zone is a drawer), never over
// the timeline's canvas (spec 5.x: nothing may cover the overlay canvas). A
// toast announces and never interrupts: nothing here moves the keyboard
// focus. The texts come worded from the store; a toast with a reword follows
// a language switch.

import { useSyncExternalStore } from 'react';

import { translator, useLocale } from '../i18n/t';
import type { ToastStore } from './toast-store';

export function Toasts({ store }: { readonly store: ToastStore }) {
  const locale = useLocale();
  const t = translator(locale);
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <div className="toasts" data-testid="toasts" role="status" aria-live="polite" aria-label={t('toast.label')}>
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-testid="toast">
          <span className="toast-text" data-testid="toast-message">
            {toast.reword ? toast.reword(locale) : toast.text}
          </span>
          <button type="button" className="toast-close" aria-label={t('toast.dismiss')} onClick={() => store.dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
