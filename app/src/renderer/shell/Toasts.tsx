// The toast region (m5-ui-plan-panel; UI redesign 4.4): a polite status
// region in a corner of the window, over the zones. A toast announces and
// never interrupts: nothing here moves the keyboard focus, and a new toast
// opens no zone. Each one has a dismiss button the user can reach.

import { useSyncExternalStore } from 'react';

import { translator, useLocale } from '../i18n/t';
import type { ToastStore } from './toast-store';

export function Toasts({ store }: { store: ToastStore }) {
  const locale = useLocale();
  const t = translator(locale);
  const get = () => store.getSnapshot();
  const toasts = useSyncExternalStore((listener) => store.subscribe(listener), get, get);
  return (
    <div className="toasts" data-testid="toasts" role="status" aria-live="polite" aria-label={t('toast.label')}>
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-testid="toast">
          <span className="toast-message" data-testid="toast-message">
            {toast.reword ? toast.reword(locale) : toast.message}
          </span>
          <button type="button" className="toast-dismiss" aria-label={t('toast.dismiss')} onClick={() => store.dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
