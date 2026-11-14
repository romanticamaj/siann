// The event display surface (spec "Frontend"; ADR-0019 point 3; UI redesign
// spec 3.2 and 5.2): an imperative class that owns two stacked canvases,
// outside React state, sized to their container (a ResizeObserver and a
// device-pixel-ratio media query) and never to the session; scrolling changes
// what is drawn, not a DOM scroll offset.
//
// - The content layer draws the ruler (bars and beats through root.tempo, in
//   two halves), the lanes in root.trackOrder at their heights, and each
//   audio clip in three tones of its track's colour with a title strip and its
//   waveform as min/max columns from the engine's peak pyramid (PeaksCache).
//   It is redrawn only when the snapshot, the zoom, the scroll, the size, the
//   lane heights, the peaks or the locale change.
// - The overlay layer draws the project cursor (the realtime playhead), the
//   selected clip's 2 px outline and the preview of a drag, and positions the
//   drag tooltip. It redraws on its own animation frame, scheduled only when
//   one of those moved, so while stopped and idle nothing runs, and a frame
//   in which only the cursor moved leaves the content alone.
//
// Pointer gestures (drag a clip, drag a trim handle, click a lane to place
// the armed media) end in one command.execute each (timeline/commands.ts),
// with the revision of the snapshot the gesture began on; the model then
// follows session.changed (structural edits are never optimistic), and a
// refusal is shown as the last error and the gesture discarded. A gesture
// whose commands engine.capabilities does not list (`allows`) does not begin
// and sends nothing (UI redesign spec 3.0). A vertical drag in the lower half
// of the ruler zooms about the pointer; the upper half is the locators' (P1-7)
// and inert until then. The wheel is the surface's (non-passive, default
// prevented): plain scrolls the lanes, Shift scrolls horizontally, Ctrl zooms
// at the pointer, Ctrl+Shift changes every track's height. Lane heights are
// the layout store's (per session id); the canvas reads them through
// `laneHeights` and asks for changes through onLaneHeights.
//
// Colours are tokens.css custom properties read from the container; the one
// sentence the canvas words itself, the empty session's guidance, comes from
// the catalogs through the `t` it is given and is redrawn on a locale change.

import { translator, type T } from '../i18n/t';
import type { MediaEntity } from '../model/document';
import type { MeterFrame } from '../model/meter-frames';
import { chooseLevel, columnRange } from '../model/peaks';
import type { PeaksCache } from '../model/peaks-cache';
import type { ReadModel, Snapshot } from '../model/read-model';
import { gestureCommand, newClipId, type TimelineCommand, type TimelineGesture } from './commands';
import { DIMMED_ALPHA, dimmedTracks } from './dimming';
import {
  DEFAULT_LANE_HEIGHT,
  clipRects,
  deltaFrames,
  frameToX,
  hitTest,
  laneHeightOf,
  laneTops,
  lanesHeight,
  snapMove,
  snapTrim,
  trackAt,
  xToFrame,
  type ClipRect,
  type HitPart,
  type Viewport,
} from './geometry';
import { formatBbt, formatBbtDelta, framesToTicks } from './musical-time';
import { rulerMarks } from './ruler';
import { clipTones, trackColourVar } from './track-colour';
import { ZOOM_STEP, maxScrollY, scrollFramesBy, scrollYBy, stepLaneHeight, zoomAbout, zoomFull } from './zoom';

export interface TimelineState {
  readonly selectedClipId: string | null;
  // The media a click on a lane places (the media pool's armed entry).
  readonly placingMediaId: string | null;
  // The last refusal (its protocol code, null for none, and the engine's
  // message); null after a command succeeds. The chrome words it.
  readonly error: TimelineRefusal | null;
}

export interface TimelineRefusal {
  readonly code: string | null;
  readonly message: string;
}

// The locale the canvas draws its own words in, and its changes.
export interface TimelineLocale {
  t(): T;
  subscribe(listener: () => void): () => void;
}

// The realtime playhead (RealtimeClient fits).
export interface PlayheadSource {
  latest(): MeterFrame | null;
  subscribe(listener: () => void): () => void;
}

// Track id -> lane height in px, and its changes (the layout store's, per session id).
export interface LaneHeightSource {
  get(): Readonly<Record<string, number>>;
  subscribe(listener: () => void): () => void;
}

export interface TimelineCanvasOptions {
  // The content layer (below) and the overlay layer (on top, takes the pointer).
  readonly content: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  // The event display both fill; its box is their size; it takes the wheel.
  readonly container: HTMLElement;
  readonly model: ReadModel;
  readonly peaks: PeaksCache;
  // command.execute; rejects with an error carrying `code`.
  readonly execute: (commands: TimelineCommand['commands'], expectedRevision: string) => Promise<unknown>;
  readonly framesPerPixel?: number;
  // English, unchanging, when absent.
  readonly locale?: TimelineLocale;
  // Whether a command op may be sent (engine.capabilities' commands); every
  // op when absent.
  readonly allows?: (op: string) => boolean;
  readonly playhead?: PlayheadSource;
  readonly laneHeights?: LaneHeightSource;
  // The drag tooltip: shown, worded and placed by the overlay while dragging.
  readonly tooltip?: HTMLElement | null;
}

// What the e2e reads through window.__siannTimeline (SIANN_SHELL_TEST=1 only).
export interface TimelineTestHooks {
  clips(): ClipRect[];
  peakColumns(clipId: string): { drawn: number; nonZero: number };
  view(): Viewport;
  lanes(): string[];
  // The ruler labels of the last content frame, left to right.
  rulerLabels(): string[];
  // How many times each layer has been drawn.
  contentDraws(): number;
  overlayDraws(): number;
  // The project cursor's x in the last overlay frame, or null without a playhead.
  cursorX(): number | null;
  // The width of the selected clip's outline in the last overlay frame (0: none).
  selectionOutline(): number;
  // The dimmed lanes of the last content frame (muted, or implicitly by a solo).
  dimmedLanes(): string[];
  // The empty session's guidance as last drawn, or null.
  guidance(): string | null;
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

interface RulerDrag {
  readonly startY: number;
  readonly anchorX: number;
  readonly view: Viewport;
}

interface Palette {
  readonly bg0: string;
  readonly bg1: string;
  readonly bg2: string;
  readonly bg3: string;
  readonly line: string;
  readonly line2: string;
  readonly tx1: string;
  readonly tx2: string;
  readonly tx3: string;
  readonly select: string;
  readonly font: string;
  track(trackId: string): string;
}

export const DEFAULT_FRAMES_PER_PIXEL = 100;
// Two halves: the locators' (upper) and the cursor's and zoom's (lower).
export const RULER_HEIGHT = 32;
// A pointer that moved less than this is a click (select), not a drag.
const DRAG_THRESHOLD_PX = 3;
const PLACE_ATTEMPTS = 3;
// A vertical ruler drag of this many px halves or doubles the frames per pixel.
const RULER_DRAG_PX_PER_STEP = 40;
// Ctrl+wheel: this many px of wheel delta are one H or G step.
const WHEEL_PX_PER_STEP = 300;
const LINE_PX = 16;
const TITLE_PX = 14;
export const OUTLINE_PX = 2;

export class TimelineCanvas {
  readonly #options: TimelineCanvasOptions;
  readonly #content: HTMLCanvasElement;
  readonly #overlay: HTMLCanvasElement;
  readonly #container: HTMLElement;
  readonly #listeners = new Set<() => void>();
  readonly #viewListeners = new Set<() => void>();
  readonly #unsubscribe: Array<() => void> = [];
  #state: TimelineState = { selectedClipId: null, placingMediaId: null, error: null };
  #view: Viewport;
  #drag: Drag | null = null;
  #rulerDrag: RulerDrag | null = null;
  #contentFrame: number | null = null;
  #overlayFrame: number | null = null;
  #columns = new Map<string, { drawn: number; nonZero: number }>();
  #rects: ClipRect[] = [];
  #resize: ResizeObserver | null = null;
  #ratio = 1;
  #media: { query: MediaQueryList; listener: () => void } | null = null;
  #destroyed = false;
  #rulerLabels: string[] = [];
  #contentDraws = 0;
  #overlayDraws = 0;
  #cursorX: number | null = null;
  #playhead: string | null = null;
  #outline = 0;
  #dimmed: string[] = [];
  #guidance: string | null = null;
  #lastPointer: { x: number; y: number } | null = null;
  #heightRequests: Array<(trackIds: readonly string[], height: number) => void> = [];

  constructor(options: TimelineCanvasOptions) {
    this.#options = options;
    this.#content = options.content;
    this.#overlay = options.overlay;
    this.#container = options.container;
    this.#view = {
      framesPerPixel: options.framesPerPixel ?? DEFAULT_FRAMES_PER_PIXEL,
      scrollFrames: '0',
      rulerHeight: RULER_HEIGHT,
      laneHeight: DEFAULT_LANE_HEIGHT,
      laneHeights: options.laneHeights?.get() ?? {},
      scrollY: 0,
      width: 1,
      height: 1,
    };
    this.#unsubscribe.push(options.model.subscribe(() => this.#modelChanged()));
    this.#unsubscribe.push(options.peaks.subscribe(() => this.invalidate()));
    if (options.locale) this.#unsubscribe.push(options.locale.subscribe(() => this.invalidate()));
    if (options.playhead) this.#unsubscribe.push(options.playhead.subscribe(() => this.#playheadChanged()));
    if (options.laneHeights) {
      const source = options.laneHeights;
      this.#unsubscribe.push(source.subscribe(() => this.#setView({ ...this.#view, laneHeights: source.get() })));
    }
    const overlay = this.#overlay;
    const down = (e: PointerEvent) => this.#pointerDown(e);
    const move = (e: PointerEvent) => this.#pointerMove(e);
    const up = (e: PointerEvent) => this.#pointerUp(e);
    const cancel = () => this.#cancelDrag();
    const leave = () => {
      this.#lastPointer = null;
    };
    overlay.addEventListener('pointerdown', down);
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', cancel);
    overlay.addEventListener('pointerleave', leave);
    // Non-passive, so preventDefault keeps the page from scrolling and Chromium from zooming.
    const wheel = (e: WheelEvent) => this.#wheel(e);
    this.#container.addEventListener('wheel', wheel, { passive: false });
    this.#unsubscribe.push(() => {
      overlay.removeEventListener('pointerdown', down);
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', cancel);
      overlay.removeEventListener('pointerleave', leave);
      this.#container.removeEventListener('wheel', wheel);
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.#resize = new ResizeObserver(() => this.#sizeChanged());
      this.#resize.observe(this.#container);
    }
    this.#watchRatio();
    this.#sizeChanged();
  }

  destroy(): void {
    this.#destroyed = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#resize?.disconnect();
    this.#unwatchRatio();
    if (this.#contentFrame !== null) cancelAnimationFrame(this.#contentFrame);
    if (this.#overlayFrame !== null) cancelAnimationFrame(this.#overlayFrame);
    this.#contentFrame = null;
    this.#overlayFrame = null;
    this.#listeners.clear();
    this.#viewListeners.clear();
    this.#heightRequests = [];
    this.#hideTooltip();
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

  // The view as last drawn by the content layer, and its changes (the track
  // list follows the vertical scroll and the lane heights from here, in the
  // same animation frame as the canvas).
  getView(): Viewport {
    return this.#view;
  }

  subscribeView(listener: () => void): () => void {
    this.#viewListeners.add(listener);
    return () => {
      this.#viewListeners.delete(listener);
    };
  }

  // Where a request to change lane heights goes (the layout store).
  onLaneHeights(listener: (trackIds: readonly string[], height: number) => void): () => void {
    this.#heightRequests.push(listener);
    return () => {
      this.#heightRequests = this.#heightRequests.filter((l) => l !== listener);
    };
  }

  // Arms (or disarms, with null) the media a click on a lane places.
  setPlacing(mediaId: string | null): void {
    this.#update({ placingMediaId: mediaId });
  }

  // Drops the selection (and an open drag): a reconnect clears it (UI
  // redesign spec 4.5 C8), even when the recovered session still has the clip.
  clearSelection(): void {
    this.#drag = null;
    this.#update({ selectedClipId: null });
  }

  // clip.remove of the selected clip.
  async deleteSelected(): Promise<void> {
    const snapshot = this.#options.model.getSnapshot();
    const clipId = this.#state.selectedClipId;
    if (!snapshot || !clipId) return;
    await this.#issue(snapshot, { kind: 'delete', clipId });
  }

  // H and G: about the project cursor when it is in view, else the view's centre.
  zoomIn(): void {
    this.#setView(zoomAbout(this.#view, this.#keyAnchor(), 1 / ZOOM_STEP));
  }

  zoomOut(): void {
    this.#setView(zoomAbout(this.#view, this.#keyAnchor(), ZOOM_STEP));
  }

  // Shift+F: [0, the last clip's end] in the width.
  zoomFull(): void {
    const snapshot = this.#options.model.getSnapshot();
    let end = 0n;
    for (const clip of snapshot?.clips ?? []) {
      if (clip.position.domain !== 'audio') continue;
      const clipEnd = BigInt(clip.position.value) + BigInt(clip.length);
      if (clipEnd > end) end = clipEnd;
    }
    this.#setView(zoomFull(this.#view, end));
  }

  // The zoom slider: frames per pixel about the view's centre.
  setFramesPerPixel(framesPerPixel: number): void {
    if (!(framesPerPixel > 0)) return;
    this.#setView(zoomAbout(this.#view, this.#view.width / 2, framesPerPixel / this.#view.framesPerPixel));
  }

  // Shift+H and Shift+G: every track one preset taller or shorter.
  tracksTaller(): void {
    this.#stepHeights(1);
  }

  tracksShorter(): void {
    this.#stepHeights(-1);
  }

  testHooks(): TimelineTestHooks {
    return {
      clips: () => this.#rects.map((r) => ({ ...r })),
      peakColumns: (clipId) => ({ ...(this.#columns.get(clipId) ?? { drawn: 0, nonZero: 0 }) }),
      view: () => ({ ...this.#view, laneHeights: { ...(this.#view.laneHeights ?? {}) } }),
      lanes: () => [...(this.#options.model.getSnapshot()?.trackOrder ?? [])],
      rulerLabels: () => [...this.#rulerLabels],
      contentDraws: () => this.#contentDraws,
      overlayDraws: () => this.#overlayDraws,
      cursorX: () => this.#cursorX,
      selectionOutline: () => this.#outline,
      dimmedLanes: () => [...this.#dimmed],
      guidance: () => this.#guidance,
    };
  }

  // Schedules one redraw of both layers on the next animation frame.
  invalidate(): void {
    this.#invalidateContent();
    this.#invalidateOverlay();
  }

  #invalidateContent(): void {
    if (this.#destroyed || this.#contentFrame !== null) return;
    this.#contentFrame = requestAnimationFrame(() => {
      this.#contentFrame = null;
      this.#drawContent();
    });
  }

  #invalidateOverlay(): void {
    if (this.#destroyed || this.#overlayFrame !== null) return;
    this.#overlayFrame = requestAnimationFrame(() => {
      this.#overlayFrame = null;
      this.#drawOverlay();
    });
  }

  #setView(next: Viewport): void {
    if (next === this.#view) return;
    this.#view = next;
    this.invalidate();
  }

  #keyAnchor(): number {
    const x = this.#cursorX;
    return x !== null && x >= 0 && x <= this.#view.width ? x : this.#view.width / 2;
  }

  #stepHeights(direction: 1 | -1): void {
    const snapshot = this.#options.model.getSnapshot();
    const order = snapshot?.trackOrder ?? [];
    if (order.length === 0) return;
    const height = stepLaneHeight(laneHeightOf(order[0]!, this.#view), direction);
    for (const request of [...this.#heightRequests]) request(order, height);
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
    const width = Math.max(1, Math.round(this.#container.clientWidth));
    const height = Math.max(1, Math.round(this.#container.clientHeight));
    const ratio = globalThis.devicePixelRatio || 1;
    this.#ratio = ratio;
    for (const canvas of [this.#content, this.#overlay]) {
      if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
      if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
      const w = Math.round(width * ratio);
      const h = Math.round(height * ratio);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    if (width !== this.#view.width || height !== this.#view.height) this.#view = { ...this.#view, width, height };
    this.invalidate();
  }

  #modelChanged(): void {
    const snapshot = this.#options.model.getSnapshot();
    const selected = this.#state.selectedClipId;
    if (selected && !snapshot?.entities[`clip:${selected}`]) this.#update({ selectedClipId: null });
    const placing = this.#state.placingMediaId;
    if (placing && !snapshot?.entities[`media:${placing}`]) this.#update({ placingMediaId: null });
    this.invalidate();
  }

  #playheadChanged(): void {
    const frame = this.#options.playhead?.latest() ?? null;
    const playhead = frame ? frame.playheadSamples : null;
    if (playhead === this.#playhead) return;
    this.#playhead = playhead;
    this.#invalidateOverlay();
  }

  #update(patch: Partial<TimelineState>): void {
    const next = { ...this.#state, ...patch };
    if ((Object.keys(patch) as Array<keyof TimelineState>).every((k) => next[k] === this.#state[k])) return;
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
    this.#invalidateOverlay();
  }

  #point(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.#container.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  #wheel(e: WheelEvent): void {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? (this.#view.height ?? 1) : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const snapshot = this.#options.model.getSnapshot();
    if (e.ctrlKey && e.shiftKey) {
      // Chromium on Windows and Linux reports a vertical wheel with Shift held
      // as deltaX (deltaY = 0), as the plain Shift branch below allows for.
      const delta = dy !== 0 ? dy : dx;
      if (delta !== 0) this.#stepHeights(delta < 0 ? 1 : -1);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const delta = dy !== 0 ? dy : dx;
      if (delta === 0) return;
      const { x } = this.#point(e);
      // At most one H or G step per event, however large its delta.
      const steps = Math.max(-1, Math.min(1, delta / WHEEL_PX_PER_STEP));
      this.#setView(zoomAbout(this.#view, x, Math.pow(ZOOM_STEP, steps)));
      return;
    }
    if (e.shiftKey) {
      this.#setView(scrollFramesBy(this.#view, dy !== 0 ? dy : dx));
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      this.#setView(scrollFramesBy(this.#view, dx));
      return;
    }
    const content = lanesHeight(snapshot?.trackOrder ?? [], this.#view);
    this.#setView(scrollYBy(this.#view, dy, content));
  }

  #pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const snapshot = this.#options.model.getSnapshot();
    const { x, y } = this.#point(e);
    if (y < this.#view.rulerHeight) {
      // The lower half zooms by a vertical drag; the upper half is P1-7's.
      if (y >= this.#view.rulerHeight / 2) {
        this.#rulerDrag = { startY: y, anchorX: x, view: this.#view };
        this.#capture(e);
      }
      return;
    }
    if (!snapshot) return;
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
    // A move sends clip.move; a trim clip.trim (and clip.move for the left edge).
    const ops = hit.part === 'body' ? ['clip.move'] : hit.part === 'left' ? ['clip.trim', 'clip.move'] : ['clip.trim'];
    if (!ops.every((op) => this.#allows(op))) return;
    this.#drag = { rect: hit.rect, part: hit.part, startX: x, startY: y, snapshot, dx: 0, dy: 0 };
    this.#capture(e);
  }

  #capture(e: PointerEvent): void {
    try {
      this.#overlay.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer without capture still delivers its events here
    }
  }

  #pointerMove(e: PointerEvent): void {
    const { x, y } = this.#point(e);
    this.#lastPointer = { x, y };
    const ruler = this.#rulerDrag;
    if (ruler) {
      const factor = Math.pow(2, -(y - ruler.startY) / RULER_DRAG_PX_PER_STEP);
      this.#setView(zoomAbout({ ...ruler.view, width: this.#view.width, height: this.#view.height, laneHeights: this.#view.laneHeights }, ruler.anchorX, factor));
      return;
    }
    const drag = this.#drag;
    if (drag) {
      drag.dx = x - drag.startX;
      drag.dy = y - drag.startY;
      this.#invalidateOverlay();
      return;
    }
    const hit = y >= this.#view.rulerHeight ? hitTest(this.#rects, x, y) : null;
    this.#overlay.style.cursor = this.#state.placingMediaId
      ? 'copy'
      : y < this.#view.rulerHeight && y >= this.#view.rulerHeight / 2
        ? 'ns-resize'
        : hit?.part === 'body'
          ? 'grab'
          : hit
            ? 'ew-resize'
            : 'default';
  }

  #pointerUp(e: PointerEvent): void {
    if (this.#rulerDrag) {
      this.#pointerMove(e);
      this.#rulerDrag = null;
      this.#release(e);
      return;
    }
    const drag = this.#drag;
    if (!drag) return;
    this.#pointerMove(e);
    this.#drag = null;
    this.#release(e);
    this.#hideTooltip();
    this.#invalidateOverlay();
    if (!this.#moved(drag)) return;
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

  #release(e: PointerEvent): void {
    try {
      this.#overlay.releasePointerCapture(e.pointerId);
    } catch {
      // not captured
    }
  }

  #moved(drag: Drag): boolean {
    return Math.abs(drag.dx) >= DRAG_THRESHOLD_PX || Math.abs(drag.dy) >= DRAG_THRESHOLD_PX;
  }

  #cancelDrag(): void {
    this.#drag = null;
    this.#rulerDrag = null;
    this.#hideTooltip();
    this.#invalidateOverlay();
  }

  // One command.execute for a finished gesture. already_exists on a
  // placement is retried with a new clip id; anything else refused is shown
  // and the gesture discarded (never retried at a newer revision).
  async #issue(snapshot: Snapshot, gesture: TimelineGesture): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const command = gestureCommand(snapshot, gesture, newClipId);
      if (!command) return;
      if (!command.commands.every((c) => this.#allows(String((c as { op?: unknown }).op)))) return;
      try {
        await this.#options.execute(command.commands, command.expectedRevision);
        this.#update({ error: null });
        return;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (gesture.kind === 'place' && code === 'already_exists' && attempt < PLACE_ATTEMPTS) continue;
        const refusal: TimelineRefusal =
          typeof code === 'string' ? { code, message: (error as Error).message } : { code: null, message: String(error) };
        this.#update({ error: refusal });
        return;
      }
    }
  }

  #allows(op: string): boolean {
    return this.#options.allows ? this.#options.allows(op) : true;
  }

  // The clip as the open drag shows it (a preview; the document is unchanged).
  #preview(rect: ClipRect, snapshot: Snapshot): ClipRect {
    const drag = this.#drag;
    if (!drag || drag.rect.clipId !== rect.clipId || !this.#moved(drag)) return rect;
    const view = this.#view;
    const delta = deltaFrames(drag.dx, view);
    const clip = snapshot.entities[`clip:${rect.clipId}`];
    const media = snapshot.entities[`media:${rect.mediaId}`] as MediaEntity | undefined;
    if (!clip || clip.schema !== 'siann.entity.clip.v1' || !media) return rect;
    if (drag.part === 'body') {
      const trackId = trackAt(snapshot, drag.startY + drag.dy, view) ?? rect.trackId;
      const lane = Math.max(0, snapshot.trackOrder.indexOf(trackId));
      const position = snapMove(rect.position, delta);
      return {
        ...rect,
        trackId,
        position,
        x: frameToX(position, view),
        y: laneTops(snapshot.trackOrder, view)[lane] ?? rect.y,
        height: laneHeightOf(trackId, view),
      };
    }
    const trimmed = snapTrim(clip, media.frames, drag.part, delta);
    return {
      ...rect,
      position: trimmed.position,
      sourceStart: trimmed.sourceStart,
      length: trimmed.length,
      x: frameToX(trimmed.position, view),
      width: Number(trimmed.length) / view.framesPerPixel,
    };
  }

  #palette(): Palette {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(this.#container) : null;
    const read = (name: string) => style?.getPropertyValue(name).trim() ?? '';
    const tracks = new Map<string, string>();
    return {
      bg0: read('--bg-0'),
      bg1: read('--bg-1'),
      bg2: read('--bg-2'),
      bg3: read('--bg-3'),
      line: read('--line'),
      line2: read('--line-2'),
      tx1: read('--tx-1'),
      tx2: read('--tx-2'),
      tx3: read('--tx-3'),
      select: read('--select'),
      font: read('--font-ui') || 'sans-serif',
      track: (trackId) => {
        let colour = tracks.get(trackId);
        if (colour === undefined) {
          colour = read(trackColourVar(trackId));
          tracks.set(trackId, colour);
        }
        return colour;
      },
    };
  }

  #context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    ctx.clearRect(0, 0, this.#view.width, this.#view.height ?? 0);
    return ctx;
  }

  #drawContent(): void {
    this.#contentDraws += 1;
    const snapshot = this.#options.model.getSnapshot();
    const order = snapshot?.trackOrder ?? [];
    // The scroll stays inside the lanes when tracks go or shrink.
    const limit = maxScrollY(this.#view, lanesHeight(order, this.#view));
    if ((this.#view.scrollY ?? 0) > limit) this.#view = { ...this.#view, scrollY: limit };
    const view = this.#view;
    for (const listener of [...this.#viewListeners]) listener();
    this.#rects = snapshot ? clipRects(snapshot, view) : [];
    const columns = new Map<string, { drawn: number; nonZero: number }>();
    const dimmed = dimmedTracks(snapshot?.tracks ?? []);
    this.#dimmed = order.filter((id) => dimmed.has(id));
    const words = this.#options.locale?.t() ?? translator('en');
    this.#guidance = snapshot && order.length === 0 ? words('timeline.empty') : null;
    const ctx = this.#context(this.#content);
    if (!ctx) {
      this.#columns = columns;
      return;
    }
    const palette = this.#palette();
    const width = view.width;
    const height = view.height ?? 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.bg1;
    ctx.fillRect(0, 0, width, height);
    if (snapshot) {
      const tops = laneTops(order, view);
      order.forEach((trackId, index) => {
        const top = tops[index]!;
        const laneHeight = laneHeightOf(trackId, view);
        if (top + laneHeight < view.rulerHeight || top > height) return;
        ctx.globalAlpha = dimmed.has(trackId) ? DIMMED_ALPHA : 1;
        ctx.fillStyle = palette.bg0;
        ctx.fillRect(0, top, width, laneHeight);
        ctx.fillStyle = palette.line;
        ctx.fillRect(0, top + laneHeight - 1, width, 1);
      });
      for (const rect of this.#rects) {
        if (rect.x > width || rect.x + rect.width < 0 || rect.y > height || rect.y + rect.height < view.rulerHeight) continue;
        ctx.globalAlpha = dimmed.has(rect.trackId) ? DIMMED_ALPHA : 1;
        columns.set(rect.clipId, this.#drawClip(ctx, snapshot, rect, palette, width));
      }
      ctx.globalAlpha = 1;
      if (this.#guidance) {
        ctx.fillStyle = palette.tx3;
        ctx.font = `12px ${palette.font}`;
        ctx.textAlign = 'center';
        ctx.fillText(this.#guidance, width / 2, view.rulerHeight + Math.max(40, (height - view.rulerHeight) / 2));
        ctx.textAlign = 'left';
      }
    }
    this.#drawRuler(ctx, snapshot, palette);
    this.#columns = columns;
  }

  #drawRuler(ctx: CanvasRenderingContext2D, snapshot: Snapshot | null, palette: Palette): void {
    const view = this.#view;
    const half = view.rulerHeight / 2;
    ctx.globalAlpha = 1;
    // Upper half: the locators' (P1-7); lower half: bars and beats, cursor and zoom.
    ctx.fillStyle = palette.bg2;
    ctx.fillRect(0, 0, view.width, half);
    ctx.fillStyle = palette.bg3;
    ctx.fillRect(0, half, view.width, half);
    ctx.fillStyle = palette.line2;
    ctx.fillRect(0, view.rulerHeight - 1, view.width, 1);
    if (!snapshot) {
      this.#rulerLabels = [];
      return;
    }
    const marks = rulerMarks(view, snapshot.root?.tempo ?? [], snapshot.root?.sampleRate ?? 48000);
    ctx.font = `10px ${palette.font}`;
    const labels: string[] = [];
    for (const mark of marks) {
      const tall = mark.kind === 'bar' ? half : mark.kind === 'beat' ? half / 2 : half / 3;
      ctx.fillStyle = mark.kind === 'bar' ? palette.tx2 : palette.tx3;
      ctx.fillRect(Math.round(mark.x), view.rulerHeight - tall, 1, tall);
      labels.push(mark.label);
      ctx.fillText(mark.label, Math.round(mark.x) + 3, half + 10);
    }
    this.#rulerLabels = labels;
  }

  // A clip in its track's three tones: body, title strip, waveform. Returns
  // the waveform columns drawn from the pyramid and how many are not silent.
  #drawClip(ctx: CanvasRenderingContext2D, snapshot: Snapshot, rect: ClipRect, palette: Palette, width: number): { drawn: number; nonZero: number } {
    const tones = clipTones(palette.track(rect.trackId), palette.bg0);
    const x = rect.x;
    const top = rect.y + 1;
    const h = rect.height - 2;
    ctx.fillStyle = tones.body;
    ctx.fillRect(x, top, rect.width, h);
    const title = Math.min(TITLE_PX, Math.max(0, h - 8));
    if (title >= 10) {
      ctx.fillStyle = tones.title;
      ctx.fillRect(x, top, rect.width, title);
      ctx.fillStyle = palette.bg0;
      ctx.font = `10px ${palette.font}`;
      const name = rect.mediaId;
      ctx.fillText(name, Math.max(x, 0) + 4, top + title - 3);
    }
    return this.#drawWaveform(ctx, snapshot, { ...rect, y: top + title, height: h - title }, tones.wave, width);
  }

  // The clip's waveform: one min/max column per pixel from the level the zoom
  // picks, over the media frames the column covers.
  #drawWaveform(ctx: CanvasRenderingContext2D, snapshot: Snapshot, rect: ClipRect, colour: string, width: number): { drawn: number; nonZero: number } {
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
    const half = Math.max(1, rect.height / 2 - 2);
    ctx.fillStyle = colour;
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

  #drawOverlay(): void {
    this.#overlayDraws += 1;
    const view = this.#view;
    const snapshot = this.#options.model.getSnapshot();
    const ctx = this.#context(this.#overlay);
    const palette = ctx ? this.#palette() : null;
    // The selected clip (or the dragged one, previewed): a 2 px outline.
    this.#outline = 0;
    const selected = this.#state.selectedClipId;
    const base = selected ? this.#rects.find((r) => r.clipId === selected) : undefined;
    const rect = base && snapshot ? this.#preview(base, snapshot) : undefined;
    if (rect && rect.x < view.width && rect.x + rect.width > 0) {
      this.#outline = OUTLINE_PX;
      if (ctx && palette) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, view.rulerHeight, view.width, (view.height ?? 0) - view.rulerHeight);
        ctx.clip();
        if (rect !== base) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = palette.track(rect.trackId);
          ctx.fillRect(rect.x, rect.y + 1, rect.width, rect.height - 2);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = palette.select;
        ctx.lineWidth = OUTLINE_PX;
        ctx.strokeRect(rect.x + 1, rect.y + 2, Math.max(0, rect.width - 2), Math.max(0, rect.height - 4));
        ctx.restore();
      }
    }
    this.#placeTooltip(snapshot, base, rect);
    // The project cursor, from the realtime playhead.
    const playhead = this.#playhead;
    this.#cursorX = playhead === null ? null : frameToX(playhead, view);
    if (ctx && palette && this.#cursorX !== null && this.#cursorX >= 0 && this.#cursorX <= view.width) {
      ctx.fillStyle = palette.tx1;
      ctx.fillRect(Math.round(this.#cursorX), 0, 1, view.height ?? 0);
    }
  }

  // The drag tooltip: the new position (start, or the trimmed edge) and the
  // delta, in bars.beats.ticks, the same in every locale.
  #placeTooltip(snapshot: Snapshot | null, base: ClipRect | undefined, rect: ClipRect | undefined): void {
    const tooltip = this.#options.tooltip;
    const drag = this.#drag;
    if (!tooltip) return;
    if (!snapshot || !drag || !base || !rect || rect === base || !this.#moved(drag)) {
      this.#hideTooltip();
      return;
    }
    const tempo = snapshot.root?.tempo ?? [];
    const rate = snapshot.root?.sampleRate ?? 48000;
    const ticks = (frames: string) => framesToTicks(Number(frames), tempo, rate);
    const edge = drag.part === 'right'
      ? [ticks(String(BigInt(base.position) + BigInt(base.length))), ticks(String(BigInt(rect.position) + BigInt(rect.length)))]
      : [ticks(base.position), ticks(rect.position)];
    tooltip.textContent = `${formatBbt(edge[1]!)}  ${formatBbtDelta(edge[1]! - edge[0]!)}`;
    const pointer = this.#lastPointer ?? { x: rect.x, y: rect.y };
    tooltip.style.transform = `translate(${Math.round(pointer.x + 12)}px, ${Math.round(pointer.y + 12)}px)`;
    tooltip.hidden = false;
  }

  #hideTooltip(): void {
    const tooltip = this.#options.tooltip;
    if (tooltip && !tooltip.hidden) tooltip.hidden = true;
  }
}
