// The timeline surface (spec "Frontend"; ADR-0019 point 3): an imperative
// class that owns one <canvas>, outside React state. It draws the read model's
// snapshot (tracks in root.trackOrder, clips as rectangles) with each clip's
// waveform as min/max columns from the engine's peak pyramid (PeaksCache), on
// requestAnimationFrame and only when something changed. Pointer gestures
// (drag a clip, drag a trim handle, click a lane to place the armed media)
// end in one command.execute each (timeline/commands.ts), with the revision
// of the snapshot the gesture began on; the model then follows
// session.changed (structural edits are never optimistic), and a refusal is
// shown as the last error and the gesture discarded.

import type { MediaEntity } from '../model/document';
import { chooseLevel, columnRange } from '../model/peaks';
import type { PeaksCache } from '../model/peaks-cache';
import type { ReadModel, Snapshot } from '../model/read-model';
import { gestureCommand, newClipId, type TimelineCommand, type TimelineGesture } from './commands';
import { clipRects, deltaFrames, hitTest, laneTop, snapMove, snapTrim, trackAt, xToFrame, type ClipRect, type HitPart, type Viewport } from './geometry';

export interface TimelineState {
  readonly selectedClipId: string | null;
  // The media a click on a lane places (the media pool's armed entry).
  readonly placingMediaId: string | null;
  // The last refusal, as "<code>: <message>"; empty after a command succeeds.
  readonly error: string;
}

export interface TimelineCanvasOptions {
  readonly canvas: HTMLCanvasElement;
  readonly model: ReadModel;
  readonly peaks: PeaksCache;
  // command.execute; rejects with an error carrying `code`.
  readonly execute: (commands: TimelineCommand['commands'], expectedRevision: string) => Promise<unknown>;
  readonly framesPerPixel?: number;
}

// What the e2e reads through window.__siannTimeline (SIANN_SHELL_TEST=1 only).
export interface TimelineTestHooks {
  clips(): ClipRect[];
  peakColumns(clipId: string): { drawn: number; nonZero: number };
  view(): Viewport;
  lanes(): string[];
}

interface Drag {
  readonly rect: ClipRect;
  readonly part: HitPart;
  readonly startX: number;
  readonly startY: number;
  // The snapshot the gesture began on: its revision is the expectedRevision.
  readonly snapshot: Snapshot;
  dx: number;
  dy: number;
}

export const DEFAULT_FRAMES_PER_PIXEL = 100;
const RULER_HEIGHT = 20;
const LANE_HEIGHT = 60;
// A pointer that moved less than this is a click (select), not a drag.
const DRAG_THRESHOLD_PX = 3;
const PLACE_ATTEMPTS = 3;

export class TimelineCanvas {
  readonly #options: TimelineCanvasOptions;
  readonly #canvas: HTMLCanvasElement;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: Array<() => void> = [];
  #state: TimelineState = { selectedClipId: null, placingMediaId: null, error: '' };
  #view: Viewport;
  #drag: Drag | null = null;
  #frame: number | null = null;
  #columns = new Map<string, { drawn: number; nonZero: number }>();
  #rects: ClipRect[] = [];
  #resize: ResizeObserver | null = null;
  #destroyed = false;

  constructor(options: TimelineCanvasOptions) {
    this.#options = options;
    this.#canvas = options.canvas;
    this.#view = {
      framesPerPixel: options.framesPerPixel ?? DEFAULT_FRAMES_PER_PIXEL,
      scrollFrames: '0',
      rulerHeight: RULER_HEIGHT,
      laneHeight: LANE_HEIGHT,
      width: Math.max(1, this.#canvas.clientWidth),
    };
    this.#unsubscribe.push(options.model.subscribe(() => this.#modelChanged()));
    this.#unsubscribe.push(options.peaks.subscribe(() => this.invalidate()));
    const canvas = this.#canvas;
    const down = (e: PointerEvent) => this.#pointerDown(e);
    const move = (e: PointerEvent) => this.#pointerMove(e);
    const up = (e: PointerEvent) => this.#pointerUp(e);
    const cancel = () => this.#cancelDrag();
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    this.#unsubscribe.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.#resize = new ResizeObserver(() => this.invalidate());
      this.#resize.observe(canvas);
    }
    this.invalidate();
  }

  destroy(): void {
    this.#destroyed = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#resize?.disconnect();
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#listeners.clear();
  }

  getState(): TimelineState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Arms (or disarms, with null) the media a click on a lane places.
  setPlacing(mediaId: string | null): void {
    this.#update({ placingMediaId: mediaId });
  }

  // clip.remove of the selected clip.
  async deleteSelected(): Promise<void> {
    const snapshot = this.#options.model.getSnapshot();
    const clipId = this.#state.selectedClipId;
    if (!snapshot || !clipId) return;
    await this.#issue(snapshot, { kind: 'delete', clipId });
  }

  testHooks(): TimelineTestHooks {
    return {
      clips: () => this.#rects.map((r) => ({ ...r })),
      peakColumns: (clipId) => ({ ...(this.#columns.get(clipId) ?? { drawn: 0, nonZero: 0 }) }),
      view: () => ({ ...this.#view }),
      lanes: () => [...(this.#options.model.getSnapshot()?.trackOrder ?? [])],
    };
  }

  // Schedules one redraw on the next animation frame.
  invalidate(): void {
    if (this.#destroyed || this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#draw();
    });
  }

  #modelChanged(): void {
    const snapshot = this.#options.model.getSnapshot();
    const selected = this.#state.selectedClipId;
    if (selected && !snapshot?.entities[`clip:${selected}`]) this.#update({ selectedClipId: null });
    const placing = this.#state.placingMediaId;
    if (placing && !snapshot?.entities[`media:${placing}`]) this.#update({ placingMediaId: null });
    this.invalidate();
  }

  #update(patch: Partial<TimelineState>): void {
    const next = { ...this.#state, ...patch };
    if ((Object.keys(patch) as Array<keyof TimelineState>).every((k) => next[k] === this.#state[k])) return;
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
    this.invalidate();
  }

  #point(e: PointerEvent): { x: number; y: number } {
    const box = this.#canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  #pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot) return;
    const { x, y } = this.#point(e);
    const placing = this.#state.placingMediaId;
    if (placing) {
      const trackId = trackAt(snapshot, y, this.#view);
      if (trackId) {
        this.#update({ placingMediaId: null });
        void this.#issue(snapshot, { kind: 'place', mediaId: placing, trackId, position: xToFrame(x, this.#view) });
      }
      return;
    }
    const hit = hitTest(clipRects(snapshot, this.#view), x, y);
    if (!hit) {
      this.#update({ selectedClipId: null });
      return;
    }
    this.#update({ selectedClipId: hit.rect.clipId });
    this.#drag = { rect: hit.rect, part: hit.part, startX: x, startY: y, snapshot, dx: 0, dy: 0 };
    try {
      this.#canvas.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer without capture still delivers its events here
    }
  }

  #pointerMove(e: PointerEvent): void {
    const drag = this.#drag;
    if (drag) {
      const { x, y } = this.#point(e);
      drag.dx = x - drag.startX;
      drag.dy = y - drag.startY;
      this.invalidate();
      return;
    }
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot) return;
    const { x, y } = this.#point(e);
    const hit = hitTest(this.#rects, x, y);
    this.#canvas.style.cursor = this.#state.placingMediaId
      ? 'copy'
      : hit?.part === 'body'
        ? 'grab'
        : hit
          ? 'ew-resize'
          : 'default';
  }

  #pointerUp(e: PointerEvent): void {
    const drag = this.#drag;
    if (!drag) return;
    this.#pointerMove(e);
    this.#drag = null;
    try {
      this.#canvas.releasePointerCapture(e.pointerId);
    } catch {
      // not captured
    }
    this.invalidate();
    if (Math.abs(drag.dx) < DRAG_THRESHOLD_PX && Math.abs(drag.dy) < DRAG_THRESHOLD_PX) return;
    const delta = deltaFrames(drag.dx, this.#view);
    const gesture: TimelineGesture =
      drag.part === 'body'
        ? {
            kind: 'move',
            clipId: drag.rect.clipId,
            deltaFrames: delta,
            trackId: trackAt(drag.snapshot, drag.startY + drag.dy, this.#view) ?? drag.rect.trackId,
          }
        : { kind: 'trim', clipId: drag.rect.clipId, edge: drag.part, deltaFrames: delta };
    void this.#issue(drag.snapshot, gesture);
  }

  #cancelDrag(): void {
    this.#drag = null;
    this.invalidate();
  }

  // One command.execute for a finished gesture. already_exists on a
  // placement is retried with a new clip id; anything else refused is shown
  // and the gesture discarded (never retried at a newer revision).
  async #issue(snapshot: Snapshot, gesture: TimelineGesture): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const command = gestureCommand(snapshot, gesture, newClipId);
      if (!command) return;
      try {
        await this.#options.execute(command.commands, command.expectedRevision);
        this.#update({ error: '' });
        return;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (gesture.kind === 'place' && code === 'already_exists' && attempt < PLACE_ATTEMPTS) continue;
        const text = typeof code === 'string' ? `${code}: ${(error as Error).message}` : String(error);
        this.#update({ error: text });
        return;
      }
    }
  }

  // The clip as the open drag shows it (a preview; the document is unchanged).
  #preview(rect: ClipRect, snapshot: Snapshot): ClipRect {
    const drag = this.#drag;
    if (!drag || drag.rect.clipId !== rect.clipId) return rect;
    if (Math.abs(drag.dx) < DRAG_THRESHOLD_PX && Math.abs(drag.dy) < DRAG_THRESHOLD_PX) return rect;
    const view = this.#view;
    const delta = deltaFrames(drag.dx, view);
    const clip = snapshot.entities[`clip:${rect.clipId}`];
    const media = snapshot.entities[`media:${rect.mediaId}`] as MediaEntity | undefined;
    if (!clip || clip.schema !== 'siann.entity.clip.v1' || !media) return rect;
    if (drag.part === 'body') {
      const trackId = trackAt(snapshot, drag.startY + drag.dy, view) ?? rect.trackId;
      const lane = Math.max(0, snapshot.trackOrder.indexOf(trackId));
      const position = snapMove(rect.position, delta);
      return { ...rect, position, x: rect.x + (Number(BigInt(position) - BigInt(rect.position)) / view.framesPerPixel), y: laneTop(lane, view) };
    }
    const trimmed = snapTrim(clip, media.frames, drag.part, delta);
    const shift = Number(BigInt(trimmed.position) - BigInt(rect.position)) / view.framesPerPixel;
    return {
      ...rect,
      position: trimmed.position,
      sourceStart: trimmed.sourceStart,
      length: trimmed.length,
      x: rect.x + shift,
      width: Number(trimmed.length) / view.framesPerPixel,
    };
  }

  #draw(): void {
    const canvas = this.#canvas;
    const snapshot = this.#options.model.getSnapshot();
    const lanes = snapshot?.trackOrder.length ?? 0;
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = RULER_HEIGHT + Math.max(1, lanes) * LANE_HEIGHT;
    this.#view = { ...this.#view, width };
    if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
    const ratio = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    const columns = new Map<string, { drawn: number; nonZero: number }>();
    this.#rects = snapshot ? clipRects(snapshot, this.#view) : [];
    if (!ctx) {
      this.#columns = columns;
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1d2026';
    ctx.fillRect(0, 0, width, height);
    if (!snapshot) {
      this.#columns = columns;
      return;
    }
    this.#drawRuler(ctx, snapshot, width);
    snapshot.trackOrder.forEach((trackId, index) => {
      const top = laneTop(index, this.#view);
      ctx.fillStyle = index % 2 === 0 ? '#262a31' : '#22252b';
      ctx.fillRect(0, top, width, LANE_HEIGHT);
      ctx.fillStyle = '#8a93a3';
      ctx.font = '11px system-ui, sans-serif';
      const track = snapshot.entities[`track:${trackId}`];
      ctx.fillText(track && 'name' in track ? String(track.name) : trackId, 4, top + 12);
    });
    for (const base of this.#rects) {
      const rect = this.#preview(base, snapshot);
      const selected = rect.clipId === this.#state.selectedClipId;
      ctx.fillStyle = selected ? '#3d6fb6' : '#35557f';
      ctx.fillRect(rect.x, rect.y + 1, rect.width, rect.height - 2);
      columns.set(rect.clipId, this.#drawWaveform(ctx, snapshot, rect, width));
      ctx.strokeStyle = selected ? '#e8eefc' : '#6f8fbf';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 1.5, Math.max(0, rect.width - 1), rect.height - 3);
    }
    this.#columns = columns;
  }

  #drawRuler(ctx: CanvasRenderingContext2D, snapshot: Snapshot, width: number): void {
    const rate = snapshot.root?.sampleRate ?? 48000;
    const view = this.#view;
    ctx.fillStyle = '#15171b';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.fillStyle = '#8a93a3';
    ctx.font = '10px system-ui, sans-serif';
    const secondsPerPixel = view.framesPerPixel / rate;
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s / secondsPerPixel >= 60) ?? 120;
    const scroll = Number(view.scrollFrames) / rate;
    for (let t = Math.ceil(scroll / step) * step; (t - scroll) / secondsPerPixel < width; t += step) {
      const x = (t - scroll) / secondsPerPixel;
      ctx.fillRect(x, RULER_HEIGHT - 6, 1, 6);
      ctx.fillText(`${Number(t.toFixed(2))}s`, x + 2, 11);
    }
  }

  // The clip's waveform: one min/max column per pixel from the level the zoom
  // picks, over the media frames the column covers. Returns how many columns
  // were drawn from the pyramid and how many of them are not silent.
  #drawWaveform(ctx: CanvasRenderingContext2D, snapshot: Snapshot, rect: ClipRect, width: number): { drawn: number; nonZero: number } {
    const counts = { drawn: 0, nonZero: 0 };
    const media = snapshot.entities[`media:${rect.mediaId}`] as MediaEntity | undefined;
    if (!media) return counts;
    const pyramid = this.#options.peaks.get(media.contentHash);
    if (!pyramid) return counts;
    const fpp = this.#view.framesPerPixel;
    const level = chooseLevel(pyramid, 1 / fpp);
    const sourceStart = Number(rect.sourceStart);
    const sourceEnd = sourceStart + Number(rect.length);
    const middle = rect.y + rect.height / 2;
    const half = rect.height / 2 - 4;
    ctx.fillStyle = '#b9d3ff';
    const first = Math.max(0, Math.floor(rect.x));
    const last = Math.min(width, Math.ceil(rect.x + rect.width));
    for (let px = first; px < last; px += 1) {
      const start = Math.max(sourceStart, sourceStart + (px - rect.x) * fpp);
      const end = Math.min(sourceEnd, sourceStart + (px + 1 - rect.x) * fpp);
      let min = Infinity;
      let max = -Infinity;
      for (let c = 0; c < pyramid.channels; c += 1) {
        const range = columnRange(pyramid, level, c, start, end);
        if (!range) continue;
        min = Math.min(min, range.min);
        max = Math.max(max, range.max);
      }
      if (min === Infinity) continue;
      counts.drawn += 1;
      if (min !== 0 || max !== 0) counts.nonZero += 1;
      const top = middle - (max / 32767) * half;
      const bottom = middle - (min / 32767) * half;
      ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
    }
    return counts;
  }
}
