// A fake event display for the TimelineCanvas tests: a container element, a
// content canvas and an overlay canvas whose 2D contexts record the calls
// made on them, a hand-driven animation-frame queue, a ResizeObserver and a
// devicePixelRatio media query the test fires itself. No DOM, no timers.

// One path segment as the canvas code built it.
export interface Segment {
  readonly op: 'moveTo' | 'lineTo' | 'rect' | 'roundRect' | 'arc' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath' | 'ellipse';
  readonly args: readonly number[];
}

// Every drawing call in order, with the state it drew in.
export interface Call {
  readonly kind: 'fillRect' | 'strokeRect' | 'fill' | 'stroke' | 'fillText' | 'clip';
  readonly style: string;
  readonly alpha: number;
  readonly lineWidth: number;
  readonly font: string;
  // fillRect, strokeRect: [x, y, w, h]; fillText: [x, y] (and maxWidth).
  readonly args: readonly number[];
  readonly text?: string;
  // fill, stroke, clip: the current path.
  readonly path?: readonly Segment[];
  // The line dash (setLineDash) the call drew with; [] for an unbroken line.
  readonly dash: readonly number[];
}

export interface Recorded {
  readonly texts: string[];
  readonly strokes: Array<{ lineWidth: number; rect: [number, number, number, number] }>;
  readonly alphas: number[];
  // Every fillRect with the fillStyle it drew in.
  readonly fills: Array<{ style: string; rect: [number, number, number, number] }>;
  readonly paths: Array<{ style: string }>;
  readonly labels: Array<{ text: string; style: string }>;
  readonly calls: Call[];
  clear(): void;
}

function recordingContext(): { ctx: CanvasRenderingContext2D; recorded: Recorded } {
  const texts: string[] = [];
  const strokes: Recorded['strokes'] = [];
  const alphas: number[] = [];
  const fills: Recorded['fills'] = [];
  const paths: Recorded['paths'] = [];
  const labels: Recorded['labels'] = [];
  const calls: Call[] = [];
  let path: Segment[] = [];
  let state: Record<string | symbol, unknown> = { lineWidth: 1, globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineDash: [] as number[] };
  const stack: Array<Record<string | symbol, unknown>> = [];
  const call = (kind: Call['kind'], style: unknown, args: readonly number[], extra: Partial<Call> = {}) =>
    calls.push({ kind, style: String(style), alpha: Number(state.globalAlpha), lineWidth: Number(state.lineWidth), font: String(state.font), args, dash: [...(state.lineDash as number[])], ...extra });
  const segment = (op: Segment['op']) => (...args: unknown[]) => void path.push({ op, args: args.filter((a): a is number => typeof a === 'number') });
  const target: Record<string | symbol, unknown> = {
    fillText: (text: string, ...args: number[]) => {
      texts.push(text);
      labels.push({ text, style: String(state.fillStyle) });
      call('fillText', state.fillStyle, args, { text });
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({ style: String(state.fillStyle), rect: [x, y, w, h] });
      call('fillRect', state.fillStyle, [x, y, w, h]);
    },
    fill: () => {
      paths.push({ style: String(state.fillStyle) });
      call('fill', state.fillStyle, [], { path: [...path] });
    },
    stroke: () => void call('stroke', state.strokeStyle, [], { path: [...path] }),
    clip: () => void call('clip', '', [], { path: [...path] }),
    strokeRect: (x: number, y: number, w: number, h: number) => {
      strokes.push({ lineWidth: Number(state.lineWidth), rect: [x, y, w, h] });
      call('strokeRect', state.strokeStyle, [x, y, w, h]);
    },
    beginPath: () => {
      path = [];
    },
    moveTo: segment('moveTo'),
    lineTo: segment('lineTo'),
    rect: segment('rect'),
    roundRect: segment('roundRect'),
    arc: segment('arc'),
    ellipse: segment('ellipse'),
    quadraticCurveTo: segment('quadraticCurveTo'),
    bezierCurveTo: segment('bezierCurveTo'),
    closePath: segment('closePath'),
    save: () => void stack.push({ ...state }),
    restore: () => {
      const previous = stack.pop();
      if (previous) state = previous;
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    setLineDash: (dash: readonly number[]) => {
      state.lineDash = [...dash];
    },
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
    fills,
    paths,
    labels,
    calls,
    clear: () => {
      texts.length = 0;
      strokes.length = 0;
      alphas.length = 0;
      fills.length = 0;
      paths.length = 0;
      labels.length = 0;
      calls.length = 0;
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
