// The info line (m5-ui-port-toolbar; UI redesign spec 3.2, "Info line",
// 10.8 and 10.9; read-only in phase 1), ported from the mockup's
// app.innerHTML template (mockup.html, div.infoline): one span.f per field,
// the name first (the track's colour in <i>, the clip's title in <b>), then
// start, end, length, offset and volume, each its label and b.num, styled by
// ui/project-zone.css. The values are info-line.ts's. The fade fields belong
// to m5b-ui-fades: their boxes stay at the end of the line, empty (spec 3.0,
// --hold-info-fade-*-w), so the volume field keeps the hairline the shared
// rule draws after it. With no clip selected the line holds nothing between
// its edges. data-clip names the selected clip for the e2e.

import { useSyncExternalStore } from 'react';

import { useT, type MessageKey } from '../i18n/t';
import type { SessionClient } from '../model/session-client';
import { infoLine, type InfoLineValues } from './info-line';

type ValueField = Exclude<keyof InfoLineValues, 'name' | 'colour'>;

// The value fields in the template's order: the part id, the value and its label.
const FIELDS: ReadonlyArray<readonly [string, ValueField, MessageKey]> = [
  ['info-start', 'start', 'info.start'],
  ['info-end', 'end', 'info.end'],
  ['info-length', 'length', 'info.length'],
  ['info-offset', 'offset', 'info.offset'],
  ['info-volume', 'volume', 'info.volume'],
];

export function InfoLine({ client, clipId }: { client: SessionClient; clipId: string | null }) {
  const t = useT();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const values = infoLine(snapshot, clipId);
  return (
    <div className="infoline" data-testid="info-line" data-part="info-line" data-clip={values ? (clipId ?? '') : ''} aria-label={t('info.label')}>
      {values ? (
        <>
          <span className="f" data-part="info-name">
            <i style={{ background: `var(${values.colour})` }} />
            <b data-testid="info-name" dir="auto">
              {values.name}
            </b>
          </span>
          {FIELDS.map(([part, field, label]) => (
            <span key={part} className="f" data-part={part}>
              {t(label)}
              <b className="num" data-testid={part}>
                {values[field]}
              </b>
            </span>
          ))}
          {/* Fade In and Fade Out (m5b-ui-fades): their boxes, empty. */}
          <span className="hold-info-fade-in" aria-hidden="true" />
          <span className="hold-info-fade-out" aria-hidden="true" />
        </>
      ) : null}
    </div>
  );
}
