// A plan's name until E-7 (m5b-ui-ghosts; UI redesign 4.2, 4.3). Stub.

import type { T } from '../i18n/t';
import type { PlanEntry } from '../model/plan-store';
import type { StepNames } from './describe';

export interface PlanName {
  readonly lead: string;
  readonly steps: string;
}

export function planName(_plan: PlanEntry, _t: T, _names: StepNames): PlanName | null {
  return null;
}
