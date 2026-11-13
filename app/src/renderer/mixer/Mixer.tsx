// The MixConsole in the lower zone (UI redesign spec 3.4, 5.1, 5.3): one
// strip per track in the user-visible order (snapshot.trackOrder), keyed by
// track id, then the meter-only master strip when the meter legend names
// "master". All meters are drawn by one canvas over the strips (MixerMeters),
// fed from the realtime channel through a MeterStore; the strips register
// their meter slots and peak values with it. React renders the chrome once
// per revision; no meter value reaches it.
//
// The canvas's test hooks (window.__siannMeters under SIANN_SHELL_TEST=1) are
// handed to index.tsx through onMeterHooks.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { GestureController } from '../model/gesture-controller';
import { MeterStore } from '../model/meter-store';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { MetersContext, type MetersRegistry } from './meters-context';
import { DEFAULT_PALETTE, MixerMeters, type MeterPalette, type MeterTestHooks, type PeakText } from './MixerMeters';
import { MasterStrip, Strip } from './Strip';

export interface MixerProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  readonly onMeterHooks?: (hooks: MeterTestHooks | null) => void;
}

function paletteFromTokens(): MeterPalette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    well: token('--bg-0', DEFAULT_PALETTE.well),
    green: token('--meter-green', DEFAULT_PALETTE.green),
    yellow: token('--meter-yellow', DEFAULT_PALETTE.yellow),
    red: token('--meter-red', DEFAULT_PALETTE.red),
    hold: token('--meter-hold', DEFAULT_PALETTE.hold),
    clip: token('--meter-red', DEFAULT_PALETTE.clip),
  };
}

// The meter canvas and its registry of slots and peak values.
class MeterBoard implements MetersRegistry {
  readonly meters: MixerMeters;
  #container: HTMLElement | null = null;
  #canvas: HTMLCanvasElement | null = null;
  readonly #peaks = new Map<string, HTMLElement>();

  constructor(realtime: RealtimeClient) {
    this.meters = new MixerMeters({
      store: new MeterStore(realtime),
      size: () => ({ width: this.#container?.scrollWidth ?? 0, height: this.#container?.clientHeight ?? 0 }),
    });
  }

  mount(container: HTMLElement | null, canvas: HTMLCanvasElement | null): void {
    this.#container = container;
    this.#canvas = canvas;
    this.meters.attach(canvas);
  }

  slot(ref: string, element: HTMLElement): () => void {
    const peaks = this.#peaks;
    const board = this;
    return this.meters.addSlot({
      ref,
      measure: () => board.#measure(element),
      get peakText(): PeakText | null {
        return peaks.get(ref) ?? null;
      },
    });
  }

  peak(ref: string, element: HTMLElement): () => void {
    this.#peaks.set(ref, element);
    this.meters.invalidate();
    return () => {
      if (this.#peaks.get(ref) === element) this.#peaks.delete(ref);
    };
  }

  reset(ref: string): void {
    this.meters.reset(ref);
  }

  #measure(element: HTMLElement) {
    const canvas = this.#canvas;
    if (!canvas || !element.isConnected) return null;
    const origin = canvas.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height };
  }
}

export function Mixer({ client, gestures, realtime, onMeterHooks }: MixerProps) {
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
    meters.setPalette(paletteFromTokens());
    board.mount(el, surface);
    const offFrames = realtime.subscribe(() => meters.onFrame());
    const resize = new ResizeObserver(() => meters.invalidate());
    resize.observe(el);
    const visible = () => meters.wake();
    document.addEventListener('visibilitychange', visible);
    onMeterHooks?.(meters.testHooks());
    return () => {
      offFrames();
      resize.disconnect();
      document.removeEventListener('visibilitychange', visible);
      onMeterHooks?.(null);
      board.mount(null, null);
    };
  }, [board, realtime, onMeterHooks]);

  return (
    <MetersContext.Provider value={board}>
      <section className="mixer" data-testid="mixer" aria-label={t('mixer.label')} ref={container}>
        <canvas className="mixer-meters" data-testid="mixer-meters" ref={canvas} aria-hidden="true" />
        {(order ?? []).map((trackId) => (
          <Strip key={trackId} trackId={trackId} client={client} gestures={gestures} />
        ))}
        {hasMaster ? <MasterStrip /> : null}
      </section>
    </MetersContext.Provider>
  );
}
