// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces are imperative canvas classes (ADR-0019
// point 3): the timeline's drawing is a canvas class it mounts, and the
// mixer's meters are MeterCanvas instances its strips mount. Plan review
// (m5-plan-review) is chrome over the PlanStore and plan.preview.

import type { GestureController } from './model/gesture-controller';
import type { PeaksCache } from './model/peaks-cache';
import type { PlanStore } from './model/plan-store';
import type { RealtimeClient } from './model/realtime-client';
import type { SessionClient } from './model/session-client';
import { Mixer } from './mixer/Mixer';
import { PlanReview } from './plans/PlanReview';
import { StatusPanel } from './StatusPanel';
import { Timeline } from './timeline/Timeline';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

export interface AppProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  readonly peaks: PeaksCache;
  readonly plans: PlanStore;
  readonly onTimelineHooks?: (hooks: TimelineTestHooks | null) => void;
}

export function App({ client, gestures, realtime, peaks, plans, onTimelineHooks }: AppProps) {
  return (
    <>
      <h1>SIANN</h1>
      <StatusPanel client={client} />
      <Timeline client={client} peaks={peaks} onHooks={onTimelineHooks} />
      <Mixer client={client} gestures={gestures} realtime={realtime} />
      <PlanReview client={client} plans={plans} />
    </>
  );
}
