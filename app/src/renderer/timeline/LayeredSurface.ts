// The two-layer surface (spec "Frontend"; ADR-0019 point 3; UI redesign 5.1
// "the same renderer class", 5.2): two stacked canvases outside React state,
// sized to their container in device pixels (a ResizeObserver and a
// device-pixel-ratio media query) and never to the session. The content layer
// (below) is redrawn on its own animation frame only when its owner
// invalidates it; the overlay (on top) on another, so a frame in which only
// the overlay changed leaves the content alone, and while idle no frame is
// pending. The event display (TimelineCanvas) and the sample editor of the
// lower zone's Editor tab (m5b-ui-editor-channel; editor/SampleEditorCanvas)
// draw on it. Each draw is wrapped in the perf scenario's frame marks.

import { frameMarks } from '../perf/frame-marks';

export interface LayeredSurfaceOptions {
  readonly content: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  // Both canvases fill it; its box is their size.
  readonly container: HTMLElement;
  // The canvases' CSS size for the container's box.
  readonly measure: (container: HTMLElement) => { readonly width: number; readonly height: number };
  readonly drawContent: () => void;
  readonly drawOverlay: () => void;
  // The size or the device pixel ratio was read (each time, before the redraw it schedules).
  readonly resized: (width: number, height: number, ratio: number) => void;
}

export class LayeredSurface {
  readonly #options: LayeredSurfaceOptions;
  #contentFrame: number | null = null;
  #overlayFrame: number | null = null;
  #resize: ResizeObserver | null = null;
  #media: { query: MediaQueryList; listener: () => void } | null = null;
  #ratio = 1;
  #destroyed = false;

  constructor(options: LayeredSurfaceOptions) {
    this.#options = options;
    if (typeof ResizeObserver !== 'undefined') {
      this.#resize = new ResizeObserver(() => this.#sizeChanged());
      this.#resize.observe(options.container);
    }
    this.#watchRatio();
    this.#sizeChanged();
  }

  // The device pixel ratio the canvases are sized for.
  get ratio(): number {
    return this.#ratio;
  }

  // Schedules one redraw of both layers on the next animation frame.
  invalidate(): void {
    this.invalidateContent();
    this.invalidateOverlay();
  }

  invalidateContent(): void {
    if (this.#destroyed || this.#contentFrame !== null) return;
    this.#contentFrame = requestAnimationFrame(() => {
      this.#contentFrame = null;
      frameMarks().begin();
      this.#options.drawContent();
      frameMarks().end();
    });
  }

  invalidateOverlay(): void {
    if (this.#destroyed || this.#overlayFrame !== null) return;
    this.#overlayFrame = requestAnimationFrame(() => {
      this.#overlayFrame = null;
      frameMarks().begin();
      this.#options.drawOverlay();
      frameMarks().end();
    });
  }

  destroy(): void {
    this.#destroyed = true;
    this.#resize?.disconnect();
    this.#resize = null;
    this.#unwatchRatio();
    if (this.#contentFrame !== null) cancelAnimationFrame(this.#contentFrame);
    if (this.#overlayFrame !== null) cancelAnimationFrame(this.#overlayFrame);
    this.#contentFrame = null;
    this.#overlayFrame = null;
  }

  #watchRatio(): void {
    this.#ratio = globalThis.devicePixelRatio || 1;
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(`(resolution: ${this.#ratio}dppx)`);
    const listener = () => {
      this.#unwatchRatio();
      this.#watchRatio();
      this.#sizeChanged();
    };
    query.addEventListener('change', listener);
    this.#media = { query, listener };
  }

  #unwatchRatio(): void {
    if (this.#media) this.#media.query.removeEventListener('change', this.#media.listener);
    this.#media = null;
  }

  // The container's size (CSS px) and the device pixel ratio: both canvases follow.
  #sizeChanged(): void {
    if (this.#destroyed) return;
    const { width, height } = this.#options.measure(this.#options.container);
    const ratio = globalThis.devicePixelRatio || 1;
    this.#ratio = ratio;
    for (const canvas of [this.#options.content, this.#options.overlay]) {
      if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
      if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
      const w = Math.round(width * ratio);
      const h = Math.round(height * ratio);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    this.#options.resized(width, height, ratio);
    this.invalidate();
  }
}
