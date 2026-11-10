// The renderer's root component. React renders chrome only; the timeline's
// drawing is an imperative canvas class it mounts (ADR-0019 point 3), as the
// waveform and meter surfaces will be.

import type { PeaksCache } from './model/peaks-cache';
import type { SessionClient } from './model/session-client';
import { StatusPanel } from './StatusPanel';
import { Timeline } from './timeline/Timeline';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

export function App({
  client,
  peaks,
  onTimelineHooks,
}: {
  client: SessionClient;
  peaks: PeaksCache;
  onTimelineHooks?: (hooks: TimelineTestHooks | null) => void;
}) {
  return (
    <>
      <h1>SIANN</h1>
      <StatusPanel client={client} />
      <Timeline client={client} peaks={peaks} onHooks={onTimelineHooks} />
    </>
  );
}
