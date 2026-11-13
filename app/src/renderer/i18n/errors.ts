// Engine errors through the catalogs (UI redesign spec 6.2): shown from their
// stable code. In Chinese a known code shows the catalog's text; in English
// the engine's own message is shown (it is English and names the specifics),
// with the catalog's text only when the engine sent none; an unknown code
// shows the engine's message in every locale. The refusal line keeps the code
// in front, so it reads the same machine token in every locale.

import type { MessageKey } from './en';
import type { Locale } from './locale';
import { translator } from './t';

const ERROR_KEYS = {
  revision_mismatch: 'error.revision_mismatch',
  plan_stale: 'error.plan_stale',
  invalid_state: 'error.invalid_state',
  already_exists: 'error.already_exists',
  session_mismatch: 'error.session_mismatch',
  disconnected: 'error.disconnected',
  audition_budget_exceeded: 'error.audition_budget_exceeded',
  not_found: 'error.not_found',
  invalid_params: 'error.invalid_params',
  internal_error: 'error.internal_error',
  not_supported: 'error.not_supported',
  nothing_to_undo: 'error.nothing_to_undo',
  nothing_to_redo: 'error.nothing_to_redo',
  session_locked: 'error.session_locked',
  media_missing: 'error.media_missing',
  device_open_failed: 'error.device_open_failed',
  device_lost: 'error.device_lost',
  no_device: 'error.no_device',
  plugin_not_approved: 'error.plugin_not_approved',
  gesture_open: 'error.gesture_open',
  queue_full: 'error.queue_full',
  lease_expired: 'error.lease_expired',
} as const satisfies Record<string, MessageKey>;

type KnownCode = keyof typeof ERROR_KEYS;

export const KNOWN_ERROR_CODES: readonly string[] = Object.keys(ERROR_KEYS);

function isKnown(code: string): code is KnownCode {
  return Object.prototype.hasOwnProperty.call(ERROR_KEYS, code);
}

export function errorText(code: string, engineMessage: string, locale: Locale): string {
  if (!isKnown(code)) return engineMessage;
  const t = translator(locale);
  if (locale === 'en') return engineMessage || t(ERROR_KEYS[code]);
  return t(ERROR_KEYS[code]);
}

// "<code>: <text>" (a refusal with a code), or the text alone.
export function refusalLine(code: string | null, engineMessage: string, locale: Locale, detail = ''): string {
  if (code === null) return engineMessage;
  return `${code}: ${errorText(code, engineMessage, locale)}${detail}`;
}
