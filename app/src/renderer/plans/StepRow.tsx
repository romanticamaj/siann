// One step of the plan card (m5-ui-port-plans; mockup.html step(); UI
// redesign 10.10, P1-13): .step > .cb, .stepn, .t (.tdot, the title, .d with
// the detail line), .go, styled by ui/right-zone.css. The .cb is the step's
// checkbox for a plan under review (ticked by default) and an empty box
// otherwise; the number is 1-based (protocol indexes stay 0-based in the test
// ids). The row under the pointer is .hot. .t is the row's disclosure: open,
// a row under the step holds the raw step and the plan.preview entities it
// touches (ref, before, after, the stale mark), in the DOM only while open.
// .go stays empty until m5b-ui-ghosts lands the locate action (3.0).

import type { CSSProperties, ReactNode } from 'react';

import { useT } from '../i18n/t';
import { Icon } from '../shell/icons';
import { rowChanges, rowLabel, type DiffRow } from './diff';
import type { StepNames } from './describe';
import { ISOLATE } from './isolate';
import type { Segment, StepRow as StepRowData } from './step-rows';

export function segmentNodes(segments: readonly Segment[]): ReactNode[] {
  return segments.map((segment, index) => {
    switch (segment.kind) {
      case 'name':
        return <b key={index}>{segment.text}</b>;
      case 'struck':
        return <s key={index}>{segment.text}</s>;
      case 'em':
        return <em key={index}>{segment.text}</em>;
      default:
        return segment.text;
    }
  });
}

// The refs a step changes, as plan.preview names its entities.
export function refsOf(step: Record<string, unknown>): string[] {
  const id = (field: string) => (typeof step[field] === 'string' ? (step[field] as string) : undefined);
  const out: string[] = [];
  const op = typeof step.op === 'string' ? step.op : '';
  if (op.startsWith('track.') && id('trackId')) out.push(`track:${id('trackId')}`);
  if (op === 'track.add' || op === 'track.remove' || op.startsWith('session.')) out.push('root:root');
  if (op.startsWith('clip.') && id('clipId')) out.push(`clip:${id('clipId')}`);
  if (op.startsWith('media.') && id('mediaId')) out.push(`media:${id('mediaId')}`);
  if (op.startsWith('plugin.') && id('slotId')) out.push(`plugin_slot:${id('slotId')}`);
  if (op === 'plugin.insert' && id('trackId')) out.push(`track:${id('trackId')}`);
  return out;
}

const entityText = (entity: Record<string, unknown> | null) => (entity === null ? '—' : JSON.stringify(entity));

export interface StepRowProps {
  readonly index: number;
  readonly step: Record<string, unknown>;
  readonly row: StepRowData;
  readonly names: StepNames;
  // null: no checkbox (the plan cannot be approved); else ticked or not.
  readonly ticked: boolean | null;
  readonly disabled: boolean;
  readonly hot: boolean;
  readonly open: boolean;
  // The preview's rows with their index in the preview, for the disclosure.
  readonly entities: ReadonlyArray<{ readonly index: number; readonly row: DiffRow }>;
  readonly onTick: () => void;
  readonly onOpen: () => void;
  readonly onHot: (hot: boolean) => void;
}

export function StepRow({ index, step, row, names, ticked, disabled, hot, open, entities, onTick, onOpen, onHot }: StepRowProps) {
  const t = useT();
  const toggle = () => {
    if (!disabled) onTick();
  };
  return (
    <>
      <div
        className={hot ? 'step hot' : 'step'}
        data-part-item="plan-step"
        data-testid={`step-${index}`}
        onPointerEnter={() => onHot(true)}
        onPointerLeave={() => onHot(false)}
      >
        {ticked === null ? (
          <span className="cb" aria-hidden="true" />
        ) : (
          <span
            className="cb"
            role="checkbox"
            aria-checked={ticked}
            aria-disabled={disabled || undefined}
            aria-label={t('plans.tickStep', { n: index + 1 })}
            tabIndex={0}
            onClick={toggle}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                toggle();
              }
            }}
          >
            {ticked ? <Icon name="check" /> : null}
          </span>
        )}
        <span className="stepn" data-testid={`step-number-${index}`}>
          {String(index + 1)}
        </span>
        <button type="button" className="t" data-testid={`step-text-${index}`} aria-expanded={open} onClick={onOpen} {...ISOLATE}>
          <span className="tdot" style={{ '--c': `var(${row.colour})` } as CSSProperties} />
          {segmentNodes(row.title)}
          <span className="d">{segmentNodes(row.detail)}</span>
        </button>
        <span className="go" />
      </div>
      {open ? (
        <div className="step-more" data-testid={`step-more-${index}`}>
          <pre className="step-raw" data-testid={`step-raw-${index}`}>
            {JSON.stringify(step)}
          </pre>
          {entities.map(({ index: at, row: entity }) => (
            <div key={entity.ref} className="step-entity" data-testid={`diff-${at}`} data-kind={entity.kind} data-stale={entity.stale ? 'true' : 'false'}>
              <span className="step-entity-label">{rowLabel(entity, names, t)}</span>
              <span>{rowChanges(entity, names, t).join('; ')}</span>
              {entity.stale ? <span className="step-entity-stale">{t('diff.staleMark', { change: t(`diff.kind.${entity.staleChange ?? 'modified'}`) })}</span> : null}
              <code data-testid={`diff-raw-${at}`}>
                {entity.ref} {t('diff.before')} {entityText(entity.before)} {t('diff.after')} {entityText(entity.after)}
              </code>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
