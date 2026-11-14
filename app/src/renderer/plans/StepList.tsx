// A plan's steps (m5-ui-plan-panel; UI redesign 4.5 C1 and P1-5): numbered
// from 1 (protocol step indexes stay 0-based in the test ids and requests),
// in user wording (plans/describe.ts, each step named with what the steps
// before it made), and for a plan under review a checkbox each, all ticked by
// default, with Select all and Select none: unticking turns the primary into
// "Approve N of M". The checkboxes exist only when engine.capabilities lists
// plan.approve (UI redesign 3.0). Each row's raw step is behind its
// disclosure and is in the DOM only while the disclosure is open.

import { useState } from 'react';

import { useT } from '../i18n/t';
import { describePlan, type StepNames } from './describe';
import { selection } from './diff';

export interface StepListProps {
  readonly steps: readonly Record<string, unknown>[];
  readonly names: StepNames;
  // null: every step ticked.
  readonly ticked: ReadonlySet<number> | null;
  // A reviewable plan with plan.approve listed: checkboxes and Select all / none.
  readonly selectable: boolean;
  readonly disabled: boolean;
  readonly onTicked: (ticked: ReadonlySet<number>) => void;
  // The rows whose disclosure starts open.
  readonly openSteps?: ReadonlySet<number>;
}

export function StepList({ steps, names, ticked, selectable, disabled, onTicked, openSteps }: StepListProps) {
  const t = useT();
  const [open, setOpen] = useState<ReadonlySet<number>>(() => openSteps ?? new Set());
  const chosen = new Set(selection(ticked, steps.length).steps);
  const texts = describePlan(steps, t, names);
  const toggle = (index: number) => {
    const next = new Set(chosen);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onTicked(next);
  };
  const disclose = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return (
    <div className="plan-steps-block">
      {selectable ? (
        <div className="plan-steps-select">
          <button type="button" data-testid="steps-all" disabled={disabled} onClick={() => onTicked(new Set(steps.map((_, i) => i)))}>
            {t('plans.selectAll')}
          </button>
          <button type="button" data-testid="steps-none" disabled={disabled} onClick={() => onTicked(new Set())}>
            {t('plans.selectNone')}
          </button>
        </div>
      ) : null}
      <ol className="plan-steps" data-testid="plan-steps" data-part="plan-steps" aria-label={t('plans.stepsLabel')}>
        {steps.map((step, index) => {
          const isOpen = open.has(index);
          const text = (
            <span className="step-text" data-testid={`step-text-${index}`}>
              {texts[index]}
            </span>
          );
          return (
            <li key={index} className="plan-step" data-testid={`step-${index}`} data-part-item="plan-step">
              <span className="step-number" data-testid={`step-number-${index}`}>
                {String(index + 1)}
              </span>
              {selectable ? (
                <label className="step-label">
                  <input type="checkbox" checked={chosen.has(index)} disabled={disabled} onChange={() => toggle(index)} />
                  {text}
                </label>
              ) : (
                text
              )}
              <button
                type="button"
                className="disclosure"
                data-testid={`step-details-${index}`}
                aria-expanded={isOpen}
                onClick={() => disclose(index)}
              >
                {t('plans.details')}
              </button>
              {isOpen ? (
                <pre className="step-raw" data-testid={`step-raw-${index}`}>
                  {JSON.stringify(step)}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
