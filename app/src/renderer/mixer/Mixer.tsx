// The MixConsole in the lower zone (UI redesign spec 3.4, 5.1, 5.3; ported
// from the mockup's markup by m5-ui-port-mixer-strip, 10.10 P1-12): the
// mockup's .mixer with one strip per track in the user-visible order
// (snapshot.trackOrder), keyed by track id, then the master strip when the
// meter legend names "master". All meters are drawn by one canvas over the
// strips (MixerMeters), fed from the realtime channel through a MeterStore;
// the strips register their meter channels and peak values with it. React
// renders the chrome once per revision; no meter value reaches it.
//
// The canvas and the knob's gradient come after the strips, so the strips
// are the mixer's first children as in the mockup (its alternating
// backgrounds count them). The canvas's test hooks (window.__siannMeters
// under SIANN_SHELL_TEST=1) are handed to index.tsx through onMeterHooks.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { GestureController } from '../model/gesture-controller';
import { MeterStore } from '../model/meter-store';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { KnobGradient } from './Knob';
import { MetersContext, type MetersRegistry } from './meters-context';
import { MixerMeters, type MeterTestHooks, type PeakText } from './MixerMeters';
import { MasterStrip, Strip } from './Strip';

export interface MixerProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  // The track list's selected track: its strip is .sel.
  readonly selectedTrackId?: string | null;
  readonly onMeterHooks?: (hooks: MeterTestHooks | null) => void;
}

// The meter canvas and its registry of channels and peak values.
class MeterBoard implements MetersRegistry {
  readonly meters: MixerMeters;
  #container: HTMLElement | null = null;
  #canvas: HTMLCanvasElement | null = null;
  // The channels, observed while mounted: a channel can change size without
  // the mixer changing size (a strip's row growing), and its rect is measured
  // only when something says so.
  readonly #slots = new Set<HTMLElement>();
  #observer: ResizeObserver | null = null;

  constructor(realtime: RealtimeClient) {
    this.meters = new MixerMeters({
      store: new MeterStore(realtime),
      size: () => ({ width: this.#container?.scrollWidth ?? 0, height: this.#container?.clientHeight ?? 0 }),
    });
  }

  mount(container: HTMLElement | null, canvas: HTMLCanvasElement | null): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#container = container;
    this.#canvas = canvas;
    if (container) {
      const observer = new ResizeObserver(() => this.meters.invalidate());
      observer.observe(container);
      for (const element of this.#slots) observer.observe(element);
      this.#observer = observer;
    }
    this.meters.attach(canvas);
  }

  slot(ref: string, channel: number, element: HTMLElement): () => void {
    this.#slots.add(element);
    this.#observer?.observe(element);
    const remove = this.meters.addSlot({ ref, channel, measure: () => this.#measure(element) });
    return () => {
      this.#slots.delete(element);
      this.#observer?.unobserve(element);
      remove();
    };
  }

  peak(ref: string, element: HTMLElement): () => void {
    return this.meters.addPeak(ref, element as PeakText);
  }

  reset(ref: string): void {
    this.meters.reset(ref);
  }

  // The channel's inside: its well's border box less the border.
  #measure(element: HTMLElement) {
    const canvas = this.#canvas;
    if (!canvas || !element.isConnected) return null;
    const origin = canvas.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (element.clientWidth === 0 || element.clientHeight === 0) return null;
    return {
      x: box.left - origin.left + element.clientLeft,
      y: box.top - origin.top + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight,
    };
  }
}

export function Mixer({ client, gestures, realtime, selectedTrackId = null, onMeterHooks }: MixerProps) {
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
  const [board] = useState(() => new MeterBoard(realtime));
  const container = useRef<HTMLElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = container.current;
    const surface = canvas.current;
    if (!el || !surface) return undefined;
    const meters = board.meters;
    board.mount(el, surface);
    const offFrames = realtime.subscribe(() => meters.onFrame());
    const visible = () => meters.wake();
    document.addEventListener('visibilitychange', visible);
    onMeterHooks?.(meters.testHooks());
    return () => {
      offFrames();
      document.removeEventListener('visibilitychange', visible);
      onMeterHooks?.(null);
      board.mount(null, null);
    };
  }, [board, realtime, onMeterHooks]);

  // Strips moved without changing size (a new track order): measure again.
  useEffect(() => board.meters.invalidate(), [board, order, hasMaster]);

  return (
    <MetersContext.Provider value={board}>
      <section className="mixer" data-testid="mixer" data-part="mixer" aria-label={t('mixer.label')} ref={container}>
        {(order ?? []).map((trackId) => (
          <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} selected={trackId === selectedTrackId} />
        ))}
        {hasMaster ? <MasterStrip /> : null}
        <KnobGradient />
        <canvas className="mixer-meters" data-testid="mixer-meters" ref={canvas} aria-hidden="true" />
      </section>
    </MetersContext.Provider>
  );
}
