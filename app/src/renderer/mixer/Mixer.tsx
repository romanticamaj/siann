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

import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { GestureController } from '../model/gesture-controller';
import { MeterStore } from '../model/meter-store';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { KnobGradient } from './Knob';
import { MeterBoard } from './meter-board';
import { MetersContext } from './meters-context';
import type { MeterTestHooks } from './MixerMeters';
import { GhostStrip, MasterStrip, Strip } from './Strip';
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
}

export function Mixer({ client, gestures, realtime, selectedTrackId = null, onMeterHooks, racks, meterStore }: MixerProps) {
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
  const [board] = useState(() => new MeterBoard(meterStore ?? new MeterStore(realtime), realtime.loudness ?? null));
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
          <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} selected={trackId === selectedTrackId} inserts={racks?.inserts ?? true} />
        ))}
        {view.ghosts.map((g) => (g.kind === 'track-add' ? <GhostStrip key={`ghost-${g.trackId}`} ghost={g} view={view} /> : null))}
        {hasMaster ? <MasterStrip client={client} gestures={gestures} /> : null}
        <KnobGradient />
        <canvas className="mixer-meters" data-testid="mixer-meters" ref={canvas} aria-hidden="true" />
      </section>
    </MetersContext.Provider>
  );
}
