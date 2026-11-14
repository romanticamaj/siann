// The info line (UI redesign spec 3.2, "Info line"; read-only in phase 1):
// the selected clip's start, end, length, offset and volume in bars.beats.ticks
// and dB (info-line.ts), as text with no field to type in. Empty with no
// selection; data-clip names the selected clip for the e2e.

import { useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { SessionClient } from '../model/session-client';
import { infoLine, type InfoLineValues } from './info-line';

const FIELDS: ReadonlyArray<keyof InfoLineValues> = ['start', 'end', 'length', 'offset', 'gain'];

export function InfoLine({ client, clipId }: { client: SessionClient; clipId: string | null }) {
  const t = useT();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const values = infoLine(snapshot, clipId);
  return (
    <dl className="info-line" data-testid="info-line" data-part="info-line" data-clip={values ? (clipId ?? '') : ''} aria-label={t('info.label')}>
      {FIELDS.map((field) => (
        <div key={field} className="info-field" data-part={`info-${field}`}>
          <dt>{t(`info.${field}`)}</dt>
          <dd data-testid={`info-${field}`}>{values ? values[field] : ''}</dd>
        </div>
      ))}
    </dl>
  );
}
