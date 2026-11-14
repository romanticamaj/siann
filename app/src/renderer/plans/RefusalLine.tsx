// A refusal as the Plans tab and the audition banner show it (m5-ui-plan-panel;
// UI redesign P1-5: no entity id, milli-dB value or pan unit is visible
// without opening a disclosure). The line is "<code>: <catalog text>" in every
// locale, not the engine's message, which names ids ("the plan is stale:
// track:trk_a (modified)", "a track with id trk_new already exists"); a
// plan_stale refusal adds its changedEntities in user wording ("(Keys)"). The
// engine's message and the raw refs are behind the line's Details disclosure
// and are in the DOM only while it is open.

import { useState } from 'react';

import { errorText } from '../i18n/errors';
import { translator, type T } from '../i18n/t';
import type { Locale } from '../i18n/locale';
import { ProtocolError } from '../model/session-client';
import { describeRef, type StepNames } from './describe';

export interface Refusal {
  // null for an error without a protocol code.
  readonly code: string | null;
  // The engine's own message (shown only behind the disclosure).
  readonly message: string;
  // plan_stale's changed refs ("<type>:<id>"), empty otherwise.
  readonly changedEntities: readonly string[];
}

export function refusalOf(error: unknown): Refusal {
  return error instanceof ProtocolError
    ? { code: error.code, message: error.message, changedEntities: [] }
    : { code: null, message: String(error), changedEntities: [] };
}

// The line without ids, in `locale`.
export function refusalSummary(refusal: Refusal, locale: Locale, names: StepNames, t: T = translator(locale)): string {
  const text = refusal.code !== null ? errorText(refusal.code, '', locale) : '';
  const line = refusal.code !== null ? `${refusal.code}: ${text || t('plans.refused')}` : t('plans.refused');
  const changed = [...new Set(refusal.changedEntities.map((ref) => describeRef(ref, t, names)))];
  return changed.length > 0 ? `${line} (${changed.join(', ')})` : line;
}

export interface RefusalLineProps {
  readonly refusal: Refusal | null;
  readonly locale: Locale;
  readonly names: StepNames;
  // The line's test id; the disclosure is `<testId>-details`, its content `<testId>-raw`.
  readonly testId: string;
  readonly className: string;
  readonly role?: 'status';
  // The disclosure starts open (tests).
  readonly open?: boolean;
}

export function RefusalLine({ refusal, locale, names, testId, className, role, open: startOpen = false }: RefusalLineProps) {
  const [open, setOpen] = useState(startOpen);
  const t = translator(locale);
  return (
    <div className={className} data-testid={testId} role={role} data-code={refusal?.code ?? undefined}>
      {refusal ? (
        <>
          <span className="refusal-text">{refusalSummary(refusal, locale, names, t)}</span>{' '}
          <button type="button" className="disclosure" data-testid={`${testId}-details`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {t('plans.details')}
          </button>
          {open ? (
            <pre className="refusal-raw" data-testid={`${testId}-raw`}>
              {[refusal.message, ...refusal.changedEntities].join('\n')}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
