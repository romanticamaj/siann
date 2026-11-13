// A plan's steps with a checkbox each (m5-plan-review): ticking a non-empty
// proper subset enables Approve selected (partial approval). The summaries
// name tracks as the read model knows them and are worded through the catalogs
// (plans/describe.ts).

import { useT } from '../i18n/t';
import { describeStep } from './describe';
import { selection } from './diff';

export interface StepListProps {
  readonly steps: readonly Record<string, unknown>[];
  readonly ticked: ReadonlySet<number>;
  readonly onToggle: (index: number) => void;
  readonly trackName: (id: string) => string | undefined;
  readonly disabled: boolean;
}

export function StepList({ steps, ticked, onToggle, trackName, disabled }: StepListProps) {
  const t = useT();
  const chosen = selection(ticked, steps.length);
  return (
    <ol className="plan-steps" data-testid="plan-steps" start={0}>
      {steps.map((step, index) => (
        <li key={index} data-testid={`step-${index}`}>
          <label>
            <input
              type="checkbox"
              checked={chosen.steps.includes(index)}
              disabled={disabled}
              onChange={() => onToggle(index)}
            />{' '}
            {describeStep(step, t, trackName)}
          </label>
        </li>
      ))}
    </ol>
  );
}
