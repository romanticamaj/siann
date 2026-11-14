// The project cursor's clock (m5-ui-transport; UI redesign spec 5.3;
// protocol-events-v1.md: the realtime frame carries the playhead and "the UI
// interpolates"). The realtime channel ticks slower than the display, so
// while playing the position display and the overlay cursor extrapolate from
// the newest frame by the time since it arrived, at the session's sample
// rate. The lead is bounded (MAX_LEAD_MS), so a late frame, a stop or a
// locate never shows a position far beyond what the engine reached; a new
// frame (a stop, a locate) replaces the extrapolation at once. Stopped, the
// position is the frame's. Framework-free; `now` is injected (milliseconds,
// performance.now in the app).

export interface ClockFrame {
  // A decimal string of frames (the realtime frame's playheadSamples).
  readonly playheadSamples: string;
  readonly playing: boolean;
}

// About one or two realtime ticks.
export const MAX_LEAD_MS = 100;

export interface PlayheadClockOptions {
  readonly now: () => number;
  readonly maxLeadMs?: number;
}

export class PlayheadClock {
  readonly #now: () => number;
  readonly #maxLeadMs: number;
  #frame: ClockFrame | null = null;
  #base = 0n;
  #receivedAt = 0;

  constructor(options: PlayheadClockOptions) {
    this.#now = options.now;
    this.#maxLeadMs = options.maxLeadMs ?? MAX_LEAD_MS;
  }

  // The newest frame, or null without one (a disconnect). The same frame
  // object again changes nothing.
  observe(frame: ClockFrame | null): void {
    if (frame === this.#frame) return;
    this.#frame = frame;
    if (!frame) return;
    this.#base = /^-?\d+$/.test(frame.playheadSamples) ? BigInt(frame.playheadSamples) : 0n;
    this.#receivedAt = this.#now();
  }

  playing(): boolean {
    return this.#frame?.playing ?? false;
  }

  // The position at `now` (the injected clock's when omitted), a decimal
  // string of frames, or null without a frame.
  position(sampleRate: number, now: number = this.#now()): string | null {
    const frame = this.#frame;
    if (!frame) return null;
    if (!frame.playing) return this.#base.toString();
    const elapsed = Math.min(Math.max(0, now - this.#receivedAt), this.#maxLeadMs);
    const lead = Math.floor((elapsed * Math.max(1, Math.round(sampleRate))) / 1000);
    return (this.#base + BigInt(lead)).toString();
  }
}
