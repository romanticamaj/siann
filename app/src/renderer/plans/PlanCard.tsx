// The plan card of the Plans tab (m5-ui-port-plans; mockup.html's .card; UI
// redesign 10.10, P1-13), the selected plan, styled by ui/right-zone.css:
//
//   .card[plan-card]
//     .card-h[plan-head]  .top[plan-meta]: the state badge (and Stale beside
//                         it, 4.5 C6), the time and base revision, the short
//                         hash; the split, rejection or part-of row; the
//                         title's and intent's holds (E-7, m5b-ui-plan-metadata);
//                         .sum[plan-summary], the count chips
//     .steps[plan-steps]  .steps-h with one link (Select none, or Select all
//                         while some step is unticked), a StepRow per step
//     the app-only rows   the stale reasons, the refusal lines, "Other
//                         changes" (the preview entities no step names or
//                         causes, behind a disclosure; entity-homes.ts), the
//                         reason field (opened by the first press of Reject)
//     .acts[plan-actions] three cells: the secondary action, the primary, the
//                         icon-only danger button (Reject or Discard)
//
// Nothing here runs a request: PlanPanel does. No id is shown.

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { translator, useLocale } from '../i18n/t';
import type { PlanEntry } from '../model/plan-store';
import { Hold } from '../shell/Hold';
import { Icon, type IconName } from '../shell/icons';
import { actionCells, actionLabel, isDanger, type ActionEntry, type ActionId, type ActionSet } from './actions';
import { badgeClass, badgeText, type PlanCardData } from './card';
import { chipsOf } from './chips';
import type { StepNames } from './describe';
import { diffRows, selection, type DiffRow, type PlanPreview } from './diff';
import { entityHomes } from './entity-homes';
import { rejectionLine } from './history';
import { ISOLATE } from './isolate';
import { RefusalLine, type Refusal } from './RefusalLine';
import { stepRows } from './step-rows';
import { EntityRows, StepRow } from './StepRow';

export const ACTION_TEST_IDS: Record<ActionId, string> = {
  approveApply: 'plan-approve-apply',
  apply: 'plan-apply',
  audition: 'plan-audition',
  reject: 'plan-reject',
  merge: 'plan-merge',
  hearMain: 'plan-hear-main',
  hearProposal: 'plan-hear-proposal',
  discard: 'plan-discard',
};

// The mockup's ids of the three actions it draws, on those actions only.
const ACTION_PARTS: Partial<Record<ActionId, string>> = { audition: 'plan-audition', approveApply: 'plan-approve', reject: 'plan-reject' };

const ACTION_ICONS: Record<ActionId, IconName> = {
  approveApply: 'check',
  apply: 'check',
  merge: 'check',
  audition: 'phones',
  hearMain: 'phones',
  hearProposal: 'phones',
  reject: 'x',
  discard: 'x',
};

export interface PlanCardProps {
  readonly plan: PlanEntry;
  readonly card: PlanCardData;
  readonly names: StepNames;
  // The actions valid now, after the capability rule.
  readonly set: ActionSet;
  readonly allowed: (entry: ActionEntry) => boolean;
  readonly selectable: boolean;
  // null: every step ticked.
  readonly ticked: ReadonlySet<number> | null;
  readonly busy: boolean;
  readonly note: string;
  readonly rejecting: boolean;
  readonly hotStep: number | null;
  // The step pinned by its target button or a click on a ghost (m5b-ui-ghosts).
  readonly pinnedStep?: number | null;
  readonly error: Refusal | null;
  readonly preview: PlanPreview | null;
  readonly previewError: Refusal | null;
  readonly staleReasons: readonly string[];
  readonly openSteps?: ReadonlySet<number>;
  readonly openError?: boolean;
  readonly openOther?: boolean;
  readonly onTicked: (ticked: ReadonlySet<number>) => void;
  readonly onNote: (note: string) => void;
  readonly onRun: (entry: ActionEntry) => void;
  readonly onRejecting: (open: boolean) => void;
  readonly onHotStep: (index: number | null) => void;
  // The target button of a step (m5b-ui-ghosts): locate its ghosts.
  readonly onLocate?: (index: number) => void;
}

export function PlanCard(props: PlanCardProps) {
  const { plan, card, names, set, busy, ticked } = props;
  const locale = useLocale();
  const t = translator(locale);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => props.openSteps ?? new Set());
  const [otherOpen, setOtherOpen] = useState(props.openOther ?? false);
  const noteRef = useRef<HTMLInputElement | null>(null);
  const id = card.shortHash;
  const total = plan.steps.length;
  const chosen = selection(ticked, total);
  const tickedSet = new Set(chosen.steps);
  const rows = stepRows(plan.steps, props.preview, names, t);
  const diff: DiffRow[] = props.preview ? diffRows(props.preview, plan.stale) : [];
  // Every row of the diff has a home: the disclosures of steps, or the other row.
  const homes = entityHomes(plan.steps, diff);
  const rowsAt = (indexes: readonly number[]) => indexes.map((at) => ({ index: at, row: diff[at]! }));
  const cells = actionCells({ ...set, primary: set.primary && props.allowed(set.primary) ? set.primary : null, secondary: set.secondary.filter(props.allowed) });
  const reject = cells[2]?.id === 'reject' ? cells[2] : null;
  const noting = props.rejecting && reject !== null;
  useEffect(() => {
    if (noting) noteRef.current?.focus();
  }, [noting]);

  const tick = (index: number) => {
    const next = new Set(tickedSet);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    props.onTicked(next);
  };
  const disclose = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const press = (entry: ActionEntry) => {
    // Reject asks for its reason first (UI redesign 10.10, P1-13 notes, b).
    if (entry.id === 'reject' && !props.rejecting) props.onRejecting(true);
    else props.onRun(entry);
  };
  const all = chosen.steps.length === total;
  const link = props.selectable ? (
    <a
      role="button"
      tabIndex={0}
      aria-disabled={busy || undefined}
      data-testid={all ? 'steps-none' : 'steps-all'}
      onClick={() => {
        if (!busy) props.onTicked(all ? new Set() : new Set(plan.steps.map((_, i) => i)));
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !busy) {
          event.preventDefault();
          props.onTicked(all ? new Set() : new Set(plan.steps.map((_, i) => i)));
        }
      }}
    >
      {t(all ? 'plans.selectNone' : 'plans.selectAll')}
    </a>
  ) : null;

  const button = (entry: ActionEntry | null, cell: number): ReactNode => {
    if (entry === null) return <span key={cell} className="acts-empty" aria-hidden="true" />;
    const reason = set.disabled.get(entry.id);
    const label = actionLabel(entry, total, t);
    const danger = isDanger(entry.id);
    const part = ACTION_PARTS[entry.id];
    return (
      <button
        key={cell}
        type="button"
        className={cell === 1 ? 'btn primary' : danger ? 'btn danger' : 'btn'}
        data-testid={ACTION_TEST_IDS[entry.id]}
        {...(part ? { 'data-part': part } : {})}
        disabled={busy || reason !== undefined}
        title={reason !== undefined ? t(`actionReason.${reason}`) : danger ? label : undefined}
        aria-label={danger ? label : undefined}
        onClick={() => press(entry)}
      >
        <Icon name={ACTION_ICONS[entry.id]} small />
        {danger ? null : label}
      </button>
    );
  };

  const base = typeof plan.raw.baseRevision === 'string' ? plan.raw.baseRevision : null;
  const when = [card.time, base !== null ? t('card.base') : null].filter((part): part is string => part !== null).join(' · ');
  const reasonLine = card.reason !== null ? rejectionLine(card.reason, locale) : null;
  return (
    <div className="card" data-part="plan-card" data-plan={id} data-testid="plan-card">
      <div className="card-h" data-part="plan-head">
        <div className="top" data-part="plan-meta">
          <span className={badgeClass(card.badge)} data-part="plan-badge" data-testid={`plan-state-${id}`} data-state={plan.state} data-badge={card.badge}>
            {badgeText(plan, card.badge, t)}
          </span>
          {card.stale ? (
            <span className={badgeClass('stale')} data-testid={`plan-stale-${id}`}>
              {t('badge.stale')}
            </span>
          ) : null}
          <span>
            {base !== null ? `${when} ` : when}
            {base !== null ? <span className="num">{base}</span> : null}
          </span>
          <span className="hash mono">{id}</span>
        </div>
        {card.split !== null ? (
          <div className="card-note" data-testid={`plan-split-${id}`}>
            {card.split}
          </div>
        ) : null}
        {reasonLine !== null ? (
          <div className="card-note" data-testid={`plan-reason-${id}`} {...ISOLATE}>
            {reasonLine}
          </div>
        ) : null}
        {card.partOf !== null ? (
          <div className="card-note" data-testid="plan-part-of">
            {card.partOf}
          </div>
        ) : null}
        <Hold className="hold-plan-title" />
        <Hold className="hold-plan-intent" />
        <div className="sum" data-part="plan-summary">
          {chipsOf(plan.steps, t).map((chip) => (
            <span key={chip.kind}>
              <b>{chip.figure}</b>
              {` ${chip.word}`}
            </span>
          ))}
        </div>
      </div>
      <div className="steps" data-part="plan-steps" data-testid="plan-steps" aria-label={t('plans.stepsLabel')}>
        <div className="steps-h up" data-part="plan-steps-head">
          {props.selectable ? t('plans.stepsHead', { count: chosen.steps.length, total }) : t('plans.stepsLabel')}
          {link}
        </div>
        {plan.steps.map((step, index) => (
          <StepRow
            key={index}
            index={index}
            step={step}
            row={rows[index]!}
            names={names}
            ticked={props.selectable ? tickedSet.has(index) : null}
            disabled={busy}
            hot={props.hotStep === index || props.pinnedStep === index}
            pinned={props.pinnedStep === index}
            onLocate={() => props.onLocate?.(index)}
            open={open.has(index)}
            entities={rowsAt(homes.steps[index] ?? [])}
            onTick={() => tick(index)}
            onOpen={() => disclose(index)}
            onHot={(hot) => props.onHotStep(hot ? index : null)}
          />
        ))}
      </div>
      {homes.rest.length > 0 ? (
        <div className="card-row" data-testid="plan-other">
          <button type="button" className="disclosure" data-testid="plan-other-toggle" aria-expanded={otherOpen} onClick={() => setOtherOpen(!otherOpen)}>
            {t('plans.otherChanges', { count: homes.rest.length })}
          </button>
          {otherOpen ? <EntityRows entities={rowsAt(homes.rest)} names={names} /> : null}
        </div>
      ) : null}
      {props.staleReasons.length > 0 ? (
        <div className="card-row plan-stale-reasons" data-testid="plan-stale-reasons">
          <b>{t('plans.staleTitle')}</b>
          <ul>
            {props.staleReasons.map((reason, index) => (
              <li key={index} {...ISOLATE}>
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {props.error ? (
        <RefusalLine
          key={`${props.error.code ?? ''}:${props.error.message}`}
          refusal={props.error}
          locale={locale}
          names={names}
          testId="plan-error"
          className="card-row plan-error"
          role="status"
          open={props.openError}
        />
      ) : null}
      {props.previewError ? (
        <RefusalLine refusal={props.previewError} locale={locale} names={names} testId="plan-preview-error" className="card-row" />
      ) : null}
      {noting ? (
        <div className="card-row plan-note">
          <label>
            {t('plans.reason')}
            <input
              ref={noteRef}
              data-testid="plan-note"
              value={props.note}
              disabled={busy}
              onChange={(event) => props.onNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (reject) props.onRun(reject);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onRejecting(false);
                }
              }}
            />
          </label>
        </div>
      ) : null}
      <div className="acts" data-part="plan-actions">
        {cells.map((cell, index) => button(cell, index))}
      </div>
    </div>
  );
}
