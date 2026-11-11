// The mixer (m5-mixer): one strip per track in the user-visible order
// (snapshot.trackOrder). React renders the chrome from the read model's
// snapshot; strips read their entity, with any gesture overlay, themselves.

import { useSyncExternalStore } from 'react';

import type { GestureController } from '../model/gesture-controller';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { Strip } from './Strip';

export interface MixerProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
}

export function Mixer({ client, gestures, realtime }: MixerProps) {
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
  );
  const order = snapshot?.trackOrder ?? [];
  return (
    <section className="mixer" data-testid="mixer" aria-label="Mixer">
      {order.map((trackId) => (
        <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} realtime={realtime} />
      ))}
    </section>
  );
}
