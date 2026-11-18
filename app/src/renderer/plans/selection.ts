// Which plan the Plans tab's card shows when the user has selected none
// (m5-ui-port-plans; UI redesign 10.10, P1-13 notes): on first load and after
// a reconnect, the newest plan that awaits a decision (validated or approved),
// a non-stale one first; else the newest plan; none without a plan. `plans`
// is in submission order, so the newest is the last.

import type { PlanEntry } from '../model/plan-store';

const awaiting = (plan: PlanEntry) => plan.state === 'validated' || plan.state === 'approved';

export function defaultSelection(plans: readonly PlanEntry[]): string | null {
  const newestFirst = [...plans].reverse();
  const pick =
    newestFirst.find((p) => awaiting(p) && p.stale.length === 0) ?? newestFirst.find(awaiting) ?? newestFirst[0];
  return pick?.hash ?? null;
}

// The plan on the card: the selected one while the store holds it, else the default.
export function cardPlan(plans: readonly PlanEntry[], selected: string | null): PlanEntry | undefined {
  const chosen = selected !== null ? plans.find((p) => p.hash === selected) : undefined;
  if (chosen) return chosen;
  const hash = defaultSelection(plans);
  return hash !== null ? plans.find((p) => p.hash === hash) : undefined;
}
