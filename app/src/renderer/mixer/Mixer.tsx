// The MixConsole in the lower zone (UI redesign spec 3.4, 5.1, 5.3; ported
// from the mockup's markup by m5-ui-port-mixer-strip, 10.10 P1-12): the
// mockup's .mixer with one strip per track in the user-visible order
// (snapshot.trackOrder), keyed by track id, then the master strip when the
// meter legend names "master". All meters are drawn by one canvas over the
// strips (MixerMeters), fed from the realtime channel through a MeterStore;
// the strips register their meter channels and peak values with it, and the
// master strip its LUFS-S value (m5b-ui-meter; meter-board.ts). React
// renders the chrome once per revision; no meter value reaches it.
//
// The canvas and the knob's gradient come after the strips, so the strips
// are the mixer's first children as in the mockup (its alternating
// backgrounds count them). The canvas's test hooks (window.__siannMeters
// under SIANN_SHELL_TEST=1) are handed to index.tsx through onMeterHooks.
//
// The plan under review (m5b-ui-ghosts; UI redesign 4.2): a proposed track's
// strip (GhostStrip) follows the tracks' strips, before the master, in step
// order; a request to reveal a step's ghosts (a hovered or located step)
// scrolls the mixer by the least amount that shows its strips.
//
// Buses (m5b-ui-sends-buses; UI redesign 3.4; 10.11, 24): the bus strips
// (BusStrip) stand after the tracks' strips, in busOrder, then the ghost
// strips of the plan (proposed tracks, then proposed buses), then the
// master; an engine without features.buses shows none. A press on a bus
// strip selects the bus (busSelection), Escape in the zone clears it. The
// rack row of every strip shows the lit rack switch's rack (racks.shown),
// when the engine can show it. The meters are measured again when the
// strips move: a new track or bus order, or proposed strips.

import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { GestureController } from '../model/gesture-controller';
import { MeterStore } from '../model/meter-store';
import type { RealtimeClient } from '../model/realtime-client';
import { monitoredTracks } from '../model/record';
import type { SessionClient } from '../model/session-client';
import { KnobGradient } from './Knob';
import { MeterBoard } from './meter-board';
import { MetersContext } from './meters-context';
import type { MeterTestHooks } from './MixerMeters';
import { GhostStrip, MasterStrip, Strip } from './Strip';
import { BusStrip } from './BusStrip';
import type { BusSelection } from './bus-selection';
import { availableRacks, busesListed, shownRack } from './routing';
import { useCapabilities } from '../shell/Capable';
import type { Rack } from '../shell/layout';
import { useRecordHost } from '../shell/record-context';
import { ReviewContext, useGhostView } from '../plans/ghost-context';

export interface MixerProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  // The track list's selected track: its strip is .sel.
  readonly selectedTrackId?: string | null;
  readonly onMeterHooks?: (hooks: MeterTestHooks | null) => void;
  // The rack switches (m5b-ui-inserts-master, m5b-ui-sends-buses; siann.layout.v1): the lit one's rack.
  readonly racks?: { readonly shown: Rack | null };
  // The selected bus (m5b-ui-sends-buses).
  readonly busSelection?: BusSelection;
  // The meter store the Meter tab shares (m5b-ui-meter); one of its own otherwise.
  readonly meterStore?: MeterStore;
}

const NO_BUSES: readonly string[] = Object.freeze([]);
const NO_SELECTION = { subscribe: () => () => undefined, getSnapshot: () => null, set: () => undefined };

export function Mixer({ client, gestures, realtime, selectedTrackId = null, onMeterHooks, racks, meterStore, busSelection }: MixerProps) {
  const t = useT();
  const can = useCapabilities();
  const selection = busSelection ?? NO_SELECTION;
  const selectedBus = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
  const busOrder = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot()?.busOrder ?? NO_BUSES,
    () => client.model.getSnapshot()?.busOrder ?? NO_BUSES,
  );
  const buses = busesListed(can) ? busOrder : NO_BUSES;
  const rack = shownRack(racks?.shown === undefined ? 'inserts' : racks.shown, availableRacks(can));
  const order = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot()?.trackOrder,
    () => client.model.getSnapshot()?.trackOrder,
  );
  const hasMaster = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().legend?.entities.includes('master') === true,
    () => client.getState().legend?.entities.includes('master') === true,
  );
  const record = useRecordHost();
  const recordRef = useRef(record);
  recordRef.current = record;
  // The armed tracks' strips read their input meter; the monitoring tracks'
  // track meters stay live while stopped (m5b-ui-recording).
  const [board] = useState(() => {
    const armed = () => recordRef.current?.controller.store.getSnapshot()?.armed ?? [];
    const monitored = () => monitoredTracks(client.model.getSnapshot()?.tracks ?? [], armed());
    return new MeterBoard(meterStore ?? new MeterStore(realtime, { monitored }), realtime.loudness ?? null, armed);
  });
  const view = useGhostView();
  const review = useContext(ReviewContext);
  const container = useRef<HTMLElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = container.current;
    const surface = canvas.current;
    if (!el || !surface) return undefined;
    const meters = board.meters;
    board.mount(el, surface);
    const offFrames = realtime.subscribe(() => meters.onFrame());
    const offLoudness = typeof realtime.subscribeLoudness === 'function' ? realtime.subscribeLoudness(() => meters.onLoudness()) : () => undefined;
    const visible = () => meters.wake();
    document.addEventListener('visibilitychange', visible);
    onMeterHooks?.(meters.testHooks());
    return () => {
      offFrames();
      offLoudness();
      document.removeEventListener('visibilitychange', visible);
      onMeterHooks?.(null);
      board.mount(null, null);
    };
  }, [board, realtime, onMeterHooks]);

  // Strips moved without changing size (a new track order): measure again.
  const proposed = view.ghosts.filter((g) => g.kind === 'track-add' || g.kind === 'bus-add').length;
  useEffect(() => board.meters.invalidate(), [board, order, buses, hasMaster, proposed]);

  // A step's ghosts brought into view: the least scroll that shows its strips (after the zone has opened).
  useEffect(
    () =>
      review?.onReveal(({ step }) => {
        requestAnimationFrame(() => {
          const el = container.current?.querySelector(`[data-ghost~="${step}"]`);
          el?.closest('.strip')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      }),
    [review],
  );

  return (
    <MetersContext.Provider value={board}>
      <section
        className="mixer"
        data-testid="mixer"
        data-part="mixer"
        aria-label={t('mixer.label')}
        ref={container}
        onKeyDown={(event) => {
          if (event.key === 'Escape') selection.set(null);
        }}
      >
        {(order ?? []).map((trackId) => (
          <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} selected={trackId === selectedTrackId} rack={rack} />
        ))}
        {buses.map((busId) => (
          <BusStrip key={busId} busId={busId} client={client} gestures={gestures} selected={busId === selectedBus} rack={rack} onSelect={(id) => selection.set(id)} />
        ))}
        {view.ghosts.map((g) => (g.kind === 'track-add' ? <GhostStrip key={`ghost-${g.trackId}`} ghost={g} view={view} /> : null))}
        {busesListed(can) ? view.ghosts.map((g) => (g.kind === 'bus-add' ? <GhostStrip key={`ghost-bus-${g.busId}`} ghost={g} view={view} /> : null)) : null}
        {hasMaster ? <MasterStrip client={client} gestures={gestures} /> : null}
        <KnobGradient />
        <canvas className="mixer-meters" data-testid="mixer-meters" ref={canvas} aria-hidden="true" />
      </section>
    </MetersContext.Provider>
  );
}
