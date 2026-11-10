// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces are imperative canvas classes (ADR-0019
// point 3): the mixer's meters are MeterCanvas instances its strips mount.

import type { GestureController } from './model/gesture-controller';
import type { RealtimeClient } from './model/realtime-client';
import type { SessionClient } from './model/session-client';
import { Mixer } from './mixer/Mixer';
import { StatusPanel } from './StatusPanel';

export interface AppProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
}

export function App({ client, gestures, realtime }: AppProps) {
  return (
    <>
      <h1>SIANN</h1>
      <StatusPanel client={client} />
      <Mixer client={client} gestures={gestures} realtime={realtime} />
    </>
  );
}
