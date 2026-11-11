// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces are imperative canvas classes (ADR-0019
// point 3): the timeline's drawing is a canvas class it mounts, and the
// mixer's meters are MeterCanvas instances its strips mount.

import type { GestureController } from './model/gesture-controller';
import type { PeaksCache } from './model/peaks-cache';
import type { RealtimeClient } from './model/realtime-client';
import type { SessionClient } from './model/session-client';
import { Mixer } from './mixer/Mixer';
import { StatusPanel } from './StatusPanel';
import { Timeline } from './timeline/Timeline';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

export interface AppProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  readonly peaks: PeaksCache;
  readonly onTimelineHooks?: (hooks: TimelineTestHooks | null) => void;
}

export function App({ client, gestures, realtime, peaks, onTimelineHooks }: AppProps) {
  return (
    <>
      <h1>SIANN</h1>
      <StatusPanel client={client} />
      <Timeline client={client} peaks={peaks} onHooks={onTimelineHooks} />
      <Mixer client={client} gestures={gestures} realtime={realtime} />
    </>
  );
}
