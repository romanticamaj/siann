// The diff of a plan against the current revision (m5-plan-review,
// m5-ui-plan-panel): one row per entity of the engine's plan.preview answer,
// named and worded in user units (a track by its name, volume in dB, pan as
// L/C/R, positions in seconds), with the entities plan.status reports stale
// marked. The ref and the raw before and after are behind each row's
// disclosure and are in the DOM only while it is open. The rows are computed
// by plans/diff.ts; nothing here runs commands.

import { Fragment, useState } from 'react';

import { useT } from '../i18n/t';
import type { StaleRef } from '../model/plan-store';
import type { StepNames } from './describe';
import { diffRows, rowChanges, rowLabel, type PlanPreview } from './diff';

export interface PlanDiffProps {
  readonly preview: PlanPreview;
  readonly stale: readonly StaleRef[];
  readonly names: StepNames;
  // The rows whose disclosure starts open.
  readonly openRows?: ReadonlySet<number>;
}

function entityText(entity: Record<string, unknown> | null): string {
  return entity === null ? '—' : JSON.stringify(entity);
}

export function PlanDiff({ preview, stale, names, openRows }: PlanDiffProps) {
  const t = useT();
  const [open, setOpen] = useState<ReadonlySet<number>>(() => openRows ?? new Set());
  const rows = diffRows(preview, stale);
  const disclose = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return (
    <table className="plan-diff" data-testid="plan-diff">
      <thead>
        <tr>
          <th>{t('diff.entity')}</th>
          <th>{t('diff.change')}</th>
          <th>{t('diff.stale')}</th>
          <th aria-label={t('plans.details')} />
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const isOpen = open.has(index);
          return (
            <Fragment key={row.ref}>
              <tr data-testid={`diff-${index}`} data-kind={row.kind} data-stale={row.stale ? 'true' : 'false'}>
                <td className="diff-label">{rowLabel(row, names, t)}</td>
                <td data-testid="diff-fields">{rowChanges(row, names, t).join('; ')}</td>
                <td data-testid="diff-stale">
                  {row.stale ? t('diff.staleMark', { change: t(`diff.kind.${row.staleChange ?? 'modified'}`) }) : ''}
                </td>
                <td>
                  <button
                    type="button"
                    className="disclosure"
                    data-testid={`diff-details-${index}`}
                    aria-expanded={isOpen}
                    onClick={() => disclose(index)}
                  >
                    {t('plans.details')}
                  </button>
                </td>
              </tr>
              {isOpen ? (
                <tr className="plan-diff-raw" data-testid={`diff-raw-${index}`}>
                  <td colSpan={4}>
                    <code>{row.ref}</code>
                    <dl>
                      <dt>{t('diff.before')}</dt>
                      <dd>
                        <code>{entityText(row.before)}</code>
                      </dd>
                      <dt>{t('diff.after')}</dt>
                      <dd>
                        <code>{entityText(row.after)}</code>
                      </dd>
                    </dl>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
