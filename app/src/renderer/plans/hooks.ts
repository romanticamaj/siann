// React readers for the Plans tab (m5-ui-plan-panel): the PlanStore's
// snapshot and the read model's names, through useSyncExternalStore (with
// the same getter on the server, for the static-markup tests).

import { useContext, useMemo, useSyncExternalStore } from 'react';

import type { PlanSnapshot, PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { TimeFormatContext } from '../shell/time-format';
import { namesFromSnapshot, type StepNames } from './describe';

export function usePlanSnapshot(plans: PlanStore): PlanSnapshot {
  const get = () => plans.getSnapshot();
  return useSyncExternalStore((listener) => plans.subscribe(listener), get, get);
}

export function useModelSnapshot(client: SessionClient) {
  const get = () => client.model.getSnapshot();
  return useSyncExternalStore((listener) => client.model.subscribe(listener), get, get);
}

export function useStepNames(client: SessionClient): StepNames {
  const snapshot = useModelSnapshot(client);
  const timeFormat = useContext(TimeFormatContext);
  return useMemo(() => namesFromSnapshot(snapshot, timeFormat), [snapshot, timeFormat]);
}
