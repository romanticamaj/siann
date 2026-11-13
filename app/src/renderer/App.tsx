// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces are imperative canvas classes (ADR-0019
// point 3): the timeline's drawing is a canvas class it mounts, and the
// mixer's meters are MeterCanvas instances its strips mount. Plan review
// (m5-plan-review) is chrome over the PlanStore and plan.preview.
//
// The window is the zone shell of m5-ui-shell (UI redesign spec 2): the
// timeline in the project zone, the mixer on the lower zone's MixConsole tab,
// plan review on the right zone's Plans tab, and the selected track in the
// left zone. engine.capabilities, as the session client last heard it, decides
// which controls exist (spec 3.0, through Capable).

import { useState, useSyncExternalStore } from 'react';

import type { CommandRegistry } from './keys/commands';
import type { EngineStatusSource } from './model/engine-status';
import type { GestureController } from './model/gesture-controller';
import type { PeaksCache } from './model/peaks-cache';
import type { PlanStore } from './model/plan-store';
import type { RealtimeClient } from './model/realtime-client';
import type { SessionClient } from './model/session-client';
import { Mixer } from './mixer/Mixer';
import { PlanReview } from './plans/PlanReview';
import { CapabilitiesContext } from './shell/Capable';
import { Inspector } from './shell/Inspector';
import type { LayoutStore } from './shell/layout-store';
import { Shell } from './shell/Shell';
import { Timeline } from './timeline/Timeline';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

export interface AppProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  readonly peaks: PeaksCache;
  readonly plans: PlanStore;
  readonly engineStatus: EngineStatusSource;
  readonly layout: LayoutStore;
  readonly commands: CommandRegistry;
  readonly platform: 'mac' | 'other';
  readonly onTimelineHooks?: (hooks: TimelineTestHooks | null) => void;
}

export function App({ client, gestures, realtime, peaks, plans, engineStatus, layout, commands, platform, onTimelineHooks }: AppProps) {
  const capabilities = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().capabilities,
  );
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  return (
    <CapabilitiesContext.Provider value={capabilities}>
      <Shell
        client={client}
        plans={plans}
        engineStatus={engineStatus}
        store={layout}
        commands={commands}
        platform={platform}
        left={<Inspector client={client} clipId={selectedClip} />}
        project={<Timeline client={client} peaks={peaks} commands={commands} onSelect={setSelectedClip} onHooks={onTimelineHooks} />}
        lower={<Mixer client={client} gestures={gestures} realtime={realtime} />}
        right={<PlanReview client={client} plans={plans} />}
      />
    </CapabilitiesContext.Provider>
  );
}
