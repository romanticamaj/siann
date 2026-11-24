// The Channel zone's content (m5b-ui-editor-channel; UI redesign 2.1, 3.4):
// one full MixConsole strip for the selected track, the strip component of
// the MixConsole (Strip, variant 'channel') with the same controls, gestures
// and meter. The mockup draws the zone button only; the zone is built from
// the shared rules (.strip and its rows, ui/lower-zone.css) and laid out by
// shell.css on existing tokens (the strip fills the zone's width).
//
//   div.channel-zone            the zone body's content (shell.css)
//     div.strip                 the selected track's strip, without
//                               data-part-item and with its test ids
//                               prefixed channel- (Strip.tsx)
//     canvas.channel-meters     the zone's meter surface
//
// Its meter is a MeterBoard of its own over the MeterStore the MixConsole
// draws from (as the Meter tab's is), so both meters show the same
// ballistics, mounted by the MixConsole's useMeterBoard; no meter value
// passes through React. With no track selected the zone is shown empty: no
// strip, no text, no placeholder (UI redesign 3.0).

import { useRef, useState } from 'react';

import type { GestureController } from '../model/gesture-controller';
import type { MeterStore } from '../model/meter-store';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { useCapabilities } from '../shell/Capable';
import type { Rack } from '../shell/layout';
import { useRecordHost } from '../shell/record-context';
import { MeterBoard } from './meter-board';
import { MetersContext } from './meters-context';
import type { MeterTestHooks } from './MixerMeters';
import { useMeterBoard } from './Mixer';
import { availableRacks, shownRack } from './routing';
import { Strip } from './Strip';

export interface ChannelZoneProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: Pick<RealtimeClient, 'subscribe'> & Partial<Pick<RealtimeClient, 'subscribeLoudness' | 'loudness'>>;
  // The MixConsole's store, shared.
  readonly store: MeterStore;
  // The primary selected track, or null.
  readonly trackId: string | null;
  // The rack switches (siann.layout.v1): the lit one's rack, as the MixConsole's strips show it.
  readonly racks?: { readonly shown: Rack | null };
  // The strip's e: lit while the zone shows its track (always, while shown), and its press.
  readonly onEditChannel?: (trackId: string) => void;
  // Test-only (SIANN_SHELL_TEST=1): the zone's meter canvas hooks.
  readonly onMeterHooks?: (hooks: MeterTestHooks | null) => void;
}

export function ChannelZone({ client, gestures, realtime, store, trackId, racks, onEditChannel, onMeterHooks }: ChannelZoneProps) {
  const can = useCapabilities();
  const rack = shownRack(racks?.shown === undefined ? 'inserts' : racks.shown, availableRacks(can));
  const record = useRecordHost();
  const recordRef = useRef(record);
  recordRef.current = record;
  const [board] = useState(() => new MeterBoard(store, realtime.loudness ?? null, () => recordRef.current?.controller.store.getSnapshot()?.armed ?? []));
  const container = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useMeterBoard(board, container, canvas, realtime, onMeterHooks);
  return (
    <MetersContext.Provider value={board}>
      <div className="channel-zone" data-testid="channel-zone" ref={container}>
        {trackId ? <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} rack={rack} variant="channel" editLit onEdit={onEditChannel} /> : null}
        <canvas className="channel-meters" ref={canvas} aria-hidden="true" />
      </div>
    </MetersContext.Provider>
  );
}
