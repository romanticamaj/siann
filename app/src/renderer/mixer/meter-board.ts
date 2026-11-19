// A meter canvas and its registry of channels, peak values and loudness texts
// (UI redesign 5.3): the MixConsole's one canvas over its strips, and the
// Meter tab's over its two master channels (m5b-ui-meter). Both draw from
// one MeterStore and one LoudnessStore through a MixerMeters each; the
// elements register under the meter's ref while mounted (meters-context.ts).

import type { LoudnessField, LoudnessReadings } from '../model/loudness-store';
import type { MeterStore } from '../model/meter-store';
import type { MetersRegistry } from './meters-context';
import { MixerMeters, type PeakText } from './MixerMeters';

export class MeterBoard implements MetersRegistry {
  readonly meters: MixerMeters;
  #container: HTMLElement | null = null;
  #canvas: HTMLCanvasElement | null = null;
  // The channels, observed while mounted: a channel can change size without
  // the container changing size (a strip's row growing), and its rect is
  // measured only when something says so.
  readonly #slots = new Set<HTMLElement>();
  #observer: ResizeObserver | null = null;

  // armed: the armed tracks' ids, whose strips read their input meter (m5b-ui-recording).
  constructor(store: MeterStore, loudness: LoudnessReadings | null = null, armed: () => readonly string[] = () => []) {
    this.meters = new MixerMeters({
      store,
      loudness,
      size: () => ({ width: this.#container?.scrollWidth ?? 0, height: this.#container?.clientHeight ?? 0 }),
      armed,
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

  loudness(field: LoudnessField, element: HTMLElement): () => void {
    return this.meters.addLoudness(field, element as PeakText);
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
