// Frame marks for the performance scenario (m5b-nightly-quality; UI redesign
// spec 5.6, "main-thread work per frame ... reading performance.measure marks
// through the test hook"). The display-rate draw callbacks (the timeline's
// content and overlay layers, the mixer's meters) call frameMarks().begin()
// and .end() around their work. Under the test hook (the preload's siannTest,
// SIANN_SHELL_TEST=1) index.tsx installs a FrameRecorder: each bracket is a
// performance.mark / performance.measure pair (so a profile shows it), and the
// recorder sums the brackets of one animation frame into one sample in a
// preallocated ring, read through window.__siannFrames. In a plain run nothing
// is installed and the marks are a no-op that touches no performance API.
//
// It also takes the cold start of 5.6 ("after the engine is ready"): from the
// engine's ready line to the first content frame that draws a session's clips.
// The ready line is read by the main process supervisor, which keeps the time
// of the first one (EngineSupervisor.firstReadyAt, epoch ms) and hands it to
// the renderer under the test hook (window.siannTest.engineReadyAt);
// readyLineAt() puts it on the renderer's performance clock. So the figure
// includes everything after the ready line: the endpoint's IPC, any window or
// bundle load still pending, the WebSocket connect and the token handshake. A
// paint counts once the session client has connected, so a frame drawn before
// the engine answered is not this engine's session.

export const FRAME_MARK = 'siann.frame.start';
export const FRAME_MEASURE = 'siann.frame';

export interface PerfLike {
  now(): number;
  mark(name: string): unknown;
  measure(name: string, startMark: string): unknown;
  clearMarks(name?: string): void;
  clearMeasures(name?: string): void;
}

export interface FrameMarks {
  begin(): void;
  end(): void;
  // A content frame drew a session's clips.
  sessionPainted(): void;
}

export const NO_FRAME_MARKS: FrameMarks = {
  begin() {},
  end() {},
  sessionPainted() {},
};

let current: FrameMarks = NO_FRAME_MARKS;

export function frameMarks(): FrameMarks {
  return current;
}

export function installFrameMarks(marks: FrameMarks | null): void {
  current = marks ?? NO_FRAME_MARKS;
}

export interface FrameRecorderOptions {
  readonly perf: PerfLike;
  // The current animation frame's time: the same for every callback of one
  // frame (document.timeline.currentTime in the browser).
  readonly frameTime: () => number | null;
  // Samples kept, newest last (default 8192: over two minutes at 60 Hz).
  readonly capacity?: number;
}

export class FrameRecorder implements FrameMarks {
  readonly #perf: PerfLike;
  readonly #frameTime: () => number | null;
  readonly #ring: Float64Array;
  #written = 0;
  // The frame being summed: its time and its work so far.
  #frame: number | null = null;
  #work = 0;
  #worked = false;
  #open = false;
  #start = 0;
  #ready: number | null = null;
  #connected = false;
  #painted: number | null = null;

  constructor(options: FrameRecorderOptions) {
    this.#perf = options.perf;
    this.#frameTime = options.frameTime;
    this.#ring = new Float64Array(options.capacity ?? 8192);
  }

  begin(): void {
    const frame = this.#frameTime();
    if (frame !== this.#frame) {
      this.#flush();
      this.#frame = frame;
    }
    this.#open = true;
    this.#perf.mark(FRAME_MARK);
    this.#start = this.#perf.now();
  }

  end(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#work += this.#perf.now() - this.#start;
    this.#worked = true;
    this.#perf.measure(FRAME_MEASURE, FRAME_MARK);
  }

  // The engine's first ready line, on this recorder's performance clock
  // (readyLineAt). Only the first one counts.
  engineReadyAt(at: number): void {
    if (this.#ready === null && Number.isFinite(at)) this.#ready = at;
  }

  // The session client connected: from here a painted session is this
  // engine's.
  connected(): void {
    this.#connected = true;
  }

  sessionPainted(): void {
    if (this.#connected && this.#painted === null) this.#painted = this.#perf.now();
  }

  // The ready line to the first painted session, in ms, or null before both.
  coldStartMs(): number | null {
    return this.#ready !== null && this.#painted !== null ? this.#painted - this.#ready : null;
  }

  // The main-thread work of each recorded frame in ms, oldest first (the frame
  // still being summed included).
  samples(): number[] {
    const out: number[] = [];
    const size = Math.min(this.#written, this.#ring.length);
    for (let i = this.#written - size; i < this.#written; i += 1) out.push(this.#ring[i % this.#ring.length]!);
    if (this.#frame !== null && this.#worked) out.push(this.#work);
    return out.length > this.#ring.length ? out.slice(out.length - this.#ring.length) : out;
  }

  count(): number {
    return this.samples().length;
  }

  clear(): void {
    this.#written = 0;
    this.#frame = null;
    this.#work = 0;
    this.#worked = false;
    this.#open = false;
    this.#perf.clearMarks(FRAME_MARK);
    this.#perf.clearMeasures(FRAME_MEASURE);
  }

  #flush(): void {
    if (this.#frame === null) return;
    this.#ring[this.#written % this.#ring.length] = this.#work;
    this.#written += 1;
    this.#work = 0;
    this.#worked = false;
  }
}

// The ready line's time (epoch ms, from the main process) on the renderer's
// performance clock (performance.timeOrigin is the epoch time of its zero);
// negative when the engine was ready before the page loaded. Null for no time.
export function readyLineAt(epochMs: number | null, timeOrigin: number): number | null {
  return typeof epochMs === 'number' && Number.isFinite(epochMs) ? epochMs - timeOrigin : null;
}

// A recorder only under the test hook (the preload's siannTest); null otherwise.
export function createFrameRecorder(testHooks: object | undefined, options: FrameRecorderOptions): FrameRecorder | null {
  return testHooks ? new FrameRecorder(options) : null;
}

// What window.__siannFrames hands the perf scenario.
export interface FrameTestHooks {
  samples(): number[];
  clear(): void;
  coldStartMs(): number | null;
}
