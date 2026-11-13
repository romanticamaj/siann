// A fake event display for the TimelineCanvas tests: a container element, a
// content canvas and an overlay canvas whose 2D contexts record the calls
// made on them, a hand-driven animation-frame queue, a ResizeObserver and a
// devicePixelRatio media query the test fires itself. No DOM, no timers.

export interface Recorded {
  readonly texts: string[];
  readonly strokes: Array<{ lineWidth: number; rect: [number, number, number, number] }>;
  readonly alphas: number[];
  clear(): void;
}

function recordingContext(): { ctx: CanvasRenderingContext2D; recorded: Recorded } {
  const texts: string[] = [];
  const strokes: Recorded['strokes'] = [];
  const alphas: number[] = [];
  const state: Record<string | symbol, unknown> = { lineWidth: 1, globalAlpha: 1 };
  const target: Record<string | symbol, unknown> = {
    fillText: (text: string) => void texts.push(text),
    strokeRect: (x: number, y: number, w: number, h: number) => void strokes.push({ lineWidth: Number(state.lineWidth), rect: [x, y, w, h] }),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const ctx = new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : key in state ? state[key] : () => undefined),
    set: (_t, key, value) => {
      state[key] = value;
      if (key === 'globalAlpha') alphas.push(Number(value));
      return true;
    },
  });
  const recorded: Recorded = {
    texts,
    strokes,
    alphas,
    clear: () => {
      texts.length = 0;
      strokes.length = 0;
      alphas.length = 0;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, recorded };
}

export interface FakeCanvas {
  width: number;
  height: number;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  getContext(): CanvasRenderingContext2D;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  setPointerCapture(): void;
  releasePointerCapture(): void;
}

export interface FakeSurface {
  readonly content: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly contentCalls: Recorded;
  readonly overlayCalls: Recorded;
  // Dispatches to the listeners registered on the overlay and the container.
  fire(type: string, init: Record<string, unknown>): { defaultPrevented: boolean };
  resize(width: number, height: number): void;
}

const resizeCallbacks: Array<() => void> = [];
const mediaListeners: Array<() => void> = [];
const frames = new Map<number, () => void>();
let nextFrame = 1;

// Installs the globals the canvas uses: requestAnimationFrame, ResizeObserver,
// matchMedia and devicePixelRatio. Idempotent.
export function installSurfaceGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = (fn: () => void) => {
    const id = nextFrame++;
    frames.set(id, fn);
    return id;
  };
  g.cancelAnimationFrame = (id: number) => void frames.delete(id);
  g.ResizeObserver = class {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = () => callback();
    }
    observe(): void {
      resizeCallbacks.push(this.#callback);
    }
    disconnect(): void {
      const at = resizeCallbacks.indexOf(this.#callback);
      if (at >= 0) resizeCallbacks.splice(at, 1);
    }
  };
  g.matchMedia = () => ({
    matches: true,
    addEventListener: (_type: string, fn: () => void) => void mediaListeners.push(fn),
    removeEventListener: (_type: string, fn: () => void) => {
      const at = mediaListeners.indexOf(fn);
      if (at >= 0) mediaListeners.splice(at, 1);
    },
  });
  if (typeof g.devicePixelRatio !== 'number') g.devicePixelRatio = 1;
}

// Runs the queued animation frames once; returns how many ran.
export function flushFrames(): number {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn();
  return pending.length;
}

export function clearFrames(): void {
  frames.clear();
}

export function setDevicePixelRatio(ratio: number): void {
  (globalThis as unknown as Record<string, unknown>).devicePixelRatio = ratio;
  for (const fn of [...mediaListeners]) fn();
}

function fakeCanvas(recorded: { ctx: CanvasRenderingContext2D }, listeners: Map<string, Set<(event: unknown) => void>>): FakeCanvas {
  return {
    width: 0,
    height: 0,
    style: {},
    dataset: {},
    getContext: () => recorded.ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn),
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
  };
}

export function fakeSurface(width = 800, height = 300): FakeSurface {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const content = recordingContext();
  const overlay = recordingContext();
  const size = { width, height };
  const container = {
    get clientWidth() {
      return size.width;
    },
    get clientHeight() {
      return size.height;
    },
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size.width, height: size.height }),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => void listeners.get(type)?.delete(fn),
    appendChild: () => undefined,
  };
  return {
    content: fakeCanvas(content, new Map()) as unknown as HTMLCanvasElement,
    overlay: fakeCanvas(overlay, listeners) as unknown as HTMLCanvasElement,
    container: container as unknown as HTMLElement,
    contentCalls: content.recorded,
    overlayCalls: overlay.recorded,
    fire(type, init) {
      const event = {
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        deltaX: 0,
        deltaY: 0,
        deltaMode: 0,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...init,
      };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
      return event;
    },
    resize(w, h) {
      size.width = w;
      size.height = h;
      for (const fn of [...resizeCallbacks]) fn();
    },
  };
}
