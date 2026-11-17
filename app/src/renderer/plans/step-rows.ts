// A plan's step rows in the mockup's wording (m5-ui-port-plans): not implemented yet.

import type { T } from '../i18n/t';
import type { StepNames } from './describe';
import type { PlanPreview } from './diff';

export type SegmentKind = 'plain' | 'name' | 'struck' | 'em';

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

export interface StepRow {
  readonly title: readonly Segment[];
  readonly detail: readonly Segment[];
  readonly colour: string;
}

export function stepRows(_steps: readonly Record<string, unknown>[], _preview: PlanPreview | null, _names: StepNames, _t?: T): StepRow[] {
  return [];
}
