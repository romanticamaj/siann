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
// e on a track strip (m5b-ui-editor-channel) is lit while the Channel zone
// shows its track (channelTrackId) and reports a press to onEditChannel. The
// Channel zone draws its strip's meter with a MeterBoard of its own over the
// same MeterStore (ChannelZone.tsx); useMeterBoard mounts either.
//
// The plan under review (m5b-ui-ghosts; UI redesign 4.2): a proposed track's
// strip (GhostStrip) follows the tracks' strips, before the master, in step
// order; a request to reveal a step's ghosts (a hovered or located step)
// scrolls the mixer by the least amount that shows its strips.

import { useContext, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

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
import { useRecordHost } from '../shell/record-context';
import { ReviewContext, useGhostView } from '../plans/ghost-context';

export interface MixerProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  // The track list's selected track: its strip is .sel.
  readonly selectedTrackId?: string | null;
  readonly onMeterHooks?: (hooks: MeterTestHooks | null) => void;
  // The rack switches (m5b-ui-inserts-master; siann.layout.v1): Inserts shows the strips' insert racks.
  readonly racks?: { readonly inserts: boolean };
  // The meter store the Meter tab shares (m5b-ui-meter); one of its own otherwise.
  readonly meterStore?: MeterStore;
  // The track the Channel zone shows while it is shown (its strip's e is lit), and e's press.
  readonly channelTrackId?: string | null;
  readonly onEditChannel?: (trackId: string) => void;
}

// Mounts a meter board on its container and canvas while both exist, feeds it
// the realtime frames and loudness, wakes it when the window shows again, and
// hands its test hooks out (the MixConsole's canvas, the Channel zone's).
export function useMeterBoard(
  board: MeterBoard,
  container: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
  realtime: Pick<RealtimeClient, 'subscribe'> & Partial<Pick<RealtimeClient, 'subscribeLoudness'>>,
  onMeterHooks?: (hooks: MeterTestHooks | null) => void,
): void {
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
  }, [board, container, canvas, realtime, onMeterHooks]);
}

export function Mixer({ client, gestures, realtime, selectedTrackId = null, onMeterHooks, racks, meterStore, channelTrackId = null, onEditChannel }: MixerProps) {
  const t = useT();
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

  useMeterBoard(board, container, canvas, realtime, onMeterHooks);

  // Strips moved without changing size (a new track order): measure again.
  const proposed = view.ghosts.filter((g) => g.kind === 'track-add').length;
  useEffect(() => board.meters.invalidate(), [board, order, hasMaster, proposed]);

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
      <section className="mixer" data-testid="mixer" data-part="mixer" aria-label={t('mixer.label')} ref={container}>
        {(order ?? []).map((trackId) => (
          <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} selected={trackId === selectedTrackId} inserts={racks?.inserts ?? true} editLit={trackId === channelTrackId} onEdit={onEditChannel} />
        ))}
        {view.ghosts.map((g) => (g.kind === 'track-add' ? <GhostStrip key={`ghost-${g.trackId}`} ghost={g} view={view} /> : null))}
        {hasMaster ? <MasterStrip client={client} gestures={gestures} /> : null}
        <KnobGradient />
        <canvas className="mixer-meters" data-testid="mixer-meters" ref={canvas} aria-hidden="true" />
      </section>
    </MetersContext.Provider>
  );
}
