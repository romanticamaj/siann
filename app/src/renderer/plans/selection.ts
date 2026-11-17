// Which plan the Plans tab's card shows (m5-ui-port-plans): not implemented yet.

import type { PlanEntry } from '../model/plan-store';

export function defaultSelection(_plans: readonly PlanEntry[]): string | null {
  return null;
}
