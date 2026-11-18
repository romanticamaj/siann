// One step of the plan card (m5-ui-port-plans; mockup.html step(); UI
// redesign 10.10, P1-13): .step > .cb, .stepn, .t (.tdot, the title, .d with
// the detail line), .go, styled by ui/right-zone.css. The .cb is the step's
// checkbox for a plan under review (ticked by default) and an empty box
// otherwise; the number is 1-based (protocol indexes stay 0-based in the test
// ids). The row under the pointer is .hot. .t is the row's disclosure: open,
// a row under the step holds the raw step and the plan.preview entities it
// touches or causes (ref, before, after, the stale mark; entity-homes.ts), in
// the DOM only while open.
// .go is the step's target button (m5b-ui-ghosts; UI redesign 4.2): the
// keyboard path to its ghosts, as the pointer's hover is: it brings them into
// view, shows the MixConsole for a ghost on a strip, and pins the row (.hot
// with aria-current) until another step is located or the pointer enters
// another row. It sends no request.
// A title that names a clip (by its media's name, m5b-ui-media) is wrapped
// in the mockup's span[data-part=plan-step-N-title], as step() does.

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

const entityText = (entity: Record<string, unknown> | null) => (entity === null ? '—' : JSON.stringify(entity));

// The preview rows of a disclosure: each row's label and changes in user
// units, the stale mark, and the raw ref with its entities before and after.
export function EntityRows({ entities, names }: { readonly entities: ReadonlyArray<{ readonly index: number; readonly row: DiffRow }>; readonly names: StepNames }) {
  const t = useT();
  return (
    <>
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
    </>
  );
}

export interface StepRowProps {
  readonly index: number;
  readonly step: Record<string, unknown>;
  readonly row: StepRowData;
  readonly names: StepNames;
  // null: no checkbox (the plan cannot be approved); else ticked or not.
  readonly ticked: boolean | null;
  readonly disabled: boolean;
  readonly hot: boolean;
  // Pinned by its target button or a click on one of its ghosts: aria-current.
  readonly pinned?: boolean;
  readonly open: boolean;
  // The preview's rows with their index in the preview, for the disclosure.
  readonly entities: ReadonlyArray<{ readonly index: number; readonly row: DiffRow }>;
  readonly onTick: () => void;
  readonly onOpen: () => void;
  readonly onHot: (hot: boolean) => void;
  readonly onLocate?: () => void;
}

export function StepRow({ index, step, row, names, ticked, disabled, hot, pinned = false, open, entities, onTick, onOpen, onHot, onLocate }: StepRowProps) {
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
        aria-current={pinned ? 'step' : undefined}
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
          {row.namesClip ? <span data-part={`plan-step-${index + 1}-title`}>{segmentNodes(row.title)}</span> : segmentNodes(row.title)}
          <span className="d">{segmentNodes(row.detail)}</span>
        </button>
        <button type="button" className="go" data-testid={`step-go-${index}`} aria-label={t('plans.locate', { n: index + 1 })} title={t('plans.locate', { n: index + 1 })} onClick={onLocate}>
          <Icon name="target" small />
        </button>
      </div>
      {open ? (
        <div className="step-more" data-testid={`step-more-${index}`}>
          <pre className="step-raw" data-testid={`step-raw-${index}`}>
            {JSON.stringify(step)}
          </pre>
          <EntityRows entities={entities} names={names} />
        </div>
      ) : null}
    </>
  );
}
