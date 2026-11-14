// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces are imperative canvas classes (ADR-0019
// point 3): the timeline's drawing is a canvas class it mounts, and the
// mixer's meters are MeterCanvas instances its strips mount. Plan review
// (m5-plan-review, m5-ui-plan-panel) is chrome over the PlanStore and
// plan.preview.
//
// The window is the zone shell of m5-ui-shell (UI redesign spec 2): the
// timeline in the project zone, the mixer on the lower zone's MixConsole tab,
// the Plans tab in the right zone, and the selected track in the left zone;
// the audition banner sits under the top bar and the toasts over the zones,
// so both are visible whichever zones are open. A new plan from an agent
// raises a toast (never the focus, never a zone). engine.capabilities, as the
// session client last heard it, decides which controls exist (spec 3.0,
// through Capable). The connection phase (m5-ui-connection) decides the
// shell's disconnected state, and each reconnect clears the clip and plan
// selections.

import { useEffect, useState, useSyncExternalStore } from 'react';

import { localeStore } from './i18n/t';
import type { CommandRegistry } from './keys/commands';
import type { ConnectionPhaseStore } from './model/connection-phase';
import type { EngineStatusSource } from './model/engine-status';
import type { GestureController } from './model/gesture-controller';
import type { PeaksCache } from './model/peaks-cache';
import type { PlanStore } from './model/plan-store';
import type { RealtimeClient } from './model/realtime-client';
import type { SessionClient } from './model/session-client';
import { Mixer } from './mixer/Mixer';
import { announceArrivals } from './plans/arrivals';
import { AuditionBanner } from './plans/AuditionBanner';
import { PlanPanel } from './plans/PlanPanel';
import { CapabilitiesContext } from './shell/Capable';
import { Inspector } from './shell/Inspector';
import type { LayoutStore } from './shell/layout-store';
import { Shell } from './shell/Shell';
import type { ToastStore } from './shell/toast-store';
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
  readonly connection: ConnectionPhaseStore;
  readonly toasts: ToastStore;
  readonly onTimelineHooks?: (hooks: TimelineTestHooks | null) => void;
}

export function App({
  client,
  gestures,
  realtime,
  peaks,
  plans,
  engineStatus,
  layout,
  commands,
  platform,
  connection,
  toasts,
  onTimelineHooks,
}: AppProps) {
  const capabilities = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().capabilities,
  );
  const phase = useSyncExternalStore(connection.subscribe, () => connection.getSnapshot().phase);
  const reconnects = useSyncExternalStore(connection.subscribe, () => connection.getSnapshot().reconnect?.count ?? 0);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  useEffect(() => announceArrivals(plans, toasts, () => localeStore().getSnapshot()), [plans, toasts]);
  return (
    <CapabilitiesContext.Provider value={capabilities}>
      <Shell
        client={client}
        plans={plans}
        engineStatus={engineStatus}
        store={layout}
        commands={commands}
        platform={platform}
        banner={<AuditionBanner client={client} plans={plans} />}
        phase={phase}
        toasts={toasts}
        left={<Inspector client={client} clipId={selectedClip} />}
        project={
          <Timeline
            client={client}
            peaks={peaks}
            commands={commands}
            onSelect={setSelectedClip}
            onHooks={onTimelineHooks}
            reconnects={reconnects}
          />
        }
        lower={<Mixer client={client} gestures={gestures} realtime={realtime} />}
        right={<PlanPanel client={client} plans={plans} reconnects={reconnects} />}
      />
    </CapabilitiesContext.Provider>
  );
}
