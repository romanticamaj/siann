// The sample editor of the lower zone's Editor tab (m5b-ui-editor-channel; UI
// redesign 2.1, 5.1 "the same renderer class", 5.2, UR-18): an imperative
// class on the event display's two-layer surface (timeline/LayeredSurface.ts),
// outside React state. It shows one clip, the app's selected (primary) clip,
// over its whole source (editor-model.ts):
//
// - The content layer: the ruler (the event display's: its bar and beat
//   ticks and labels through root.tempo, ruler.ts), the whole source's
//   waveform from the engine's peak pyramid (PeaksCache, waveform.ts: one
//   min/max column per device pixel at the level chooseLevel picks), in the
//   track's colour, the part of the source outside the clip's range dimmed
//   (the fades' shade, --bg-0-a550), the range's ends as 1 px lines in
//   --select, and the clip's volume control (draw()'s box with its value). It
//   is redrawn only when the snapshot, the clip, the zoom, the size or the
//   peaks change.
// - The overlay: the pointer's hover over an end, a held drag's preview (the
//   end where it would land, the snap guide while snap applies) and the gain
//   a held drag of the volume control would set. It redraws on its own frame,
//   so while idle nothing runs.
//
// A drag of an end of the range resizes the clip and a vertical drag of the
// volume control sets its gain, with the event display's commands, snap and
// modifiers (editor-model.ts), each release one command.execute with the
// revision the drag began on; a click sends nothing. H and G zoom about the
// range's centre; the view is the editor's own and never the layout store's.
// Magnetic Cursor snaps an end to the project cursor, read from the realtime
// playhead through the event display's PlayheadClock. The only data it reads
// is the read model, PeaksCache.get(contentHash) and that playhead: no
// protocol request of its own. Colours are tokens.css custom properties
// read from the container, sizes tokens.ts's.

import { formatDb } from '../format';
import type { ClipEntity, MediaEntity } from '../model/document';
import type { PeaksCache } from '../model/peaks-cache';
import type { ReadModel, Snapshot } from '../model/read-model';
import type { ModifierFlags } from '../keys/tool-modifiers';
import { TOKENS } from '../tokens';
import type { TimelineCommand } from '../timeline/commands';
import { GAIN_RADIUS, RULER_HEIGHT, frameToX, type Box, type Viewport } from '../timeline/geometry';
import { LayeredSurface } from '../timeline/LayeredSurface';
import { barOf, gridMarks, rulerMarks } from '../timeline/ruler';
import { DEFAULT_SNAP, type SnapSettings } from '../timeline/snap';
import { RULER_MARKS, type PlayheadSource } from '../timeline/TimelineCanvas';
import { PlayheadClock } from '../transport/playhead-clock';
import { trackColourVar } from '../timeline/track-colour';
import { waveformColumns } from '../timeline/waveform';
import {
  editorClip,
  editorGainBox,
  editorHit,
  editorView,
  gainDragCommand,
  gainDragValue,
  rangeDragCommand,
  rangeDragTarget,
  rangePixels,
  sourcePixels,
  zoomEditor,
  type EditorPart,
} from './editor-model';

export interface SampleEditorOptions {
  readonly content: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly model: Pick<ReadModel, 'getSnapshot' | 'subscribe'>;
  readonly peaks: Pick<PeaksCache, 'get' | 'subscribe'>;
  // command.execute.
  readonly execute: (commands: TimelineCommand['commands'], expectedRevision: string) => Promise<unknown>;
  // Whether an op may be sent (listed, and not held by the edit guard); every op when absent.
  readonly allows?: (op: string) => boolean;
  // The layout store's snap settings (the event display's).
  readonly snap?: () => SnapSettings;
  readonly platform?: 'mac' | 'other';
  // The realtime playhead, for Magnetic Cursor as the event display reads it
  // (RealtimeClient fits); no cursor to snap to when absent.
  readonly playhead?: Pick<PlayheadSource, 'playhead'>;
  // The cursor clock's time in milliseconds (performance.now when absent).
  readonly now?: () => number;
}

// The editor's hooks for the tests (SIANN_SHELL_TEST=1: window.__siannEditor).
export interface EditorTestHooks {
  clipId(): string | null;
  view(): Viewport;
  // The range's and the source's ends (CSS px), the volume control, as last drawn.
  range(): { start: number; end: number } | null;
  source(): { start: number; end: number } | null;
  gain(): Box | null;
  // The waveform's device-pixel columns and the pyramid level of the last content frame.
  columns(): number;
  level(): number | null;
  contentDraws(): number;
  overlayDraws(): number;
}

interface Drag {
  readonly part: Exclude<EditorPart, 'body'>;
  readonly pointer: number;
  readonly startX: number;
  readonly startY: number;
  readonly snapshot: Snapshot;
  readonly clip: ClipEntity;
  dx: number;
  dy: number;
  flags: ModifierFlags;
}

// The waveform leaves this much above and below, as on a clip.
const WAVE_MARGIN = 2;
const GAIN_TEXT_X = 4;

export class SampleEditorCanvas {
  readonly #options: SampleEditorOptions;
  readonly #surface: LayeredSurface;
  readonly #unsubscribe: Array<() => void> = [];
  #clipId: string | null = null;
  #view: Viewport = { framesPerPixel: 1, scrollFrames: '0', rulerHeight: RULER_HEIGHT, laneHeight: 1, width: 1, height: 1 };
  // The view was fitted to this clip's source; another clip fits again.
  #fitted: string | null = null;
  #ratio = 1;
  #drag: Drag | null = null;
  #hover: EditorPart | null = null;
  #columns = 0;
  #level: number | null = null;
  #range: { start: number; end: number } | null = null;
  #source: { start: number; end: number } | null = null;
  #gain: Box | null = null;
  #contentDraws = 0;
  #overlayDraws = 0;
  readonly #clock: PlayheadClock;

  constructor(options: SampleEditorOptions) {
    this.#options = options;
    this.#clock = new PlayheadClock({ now: options.now ?? (() => performance.now()) });
    this.#unsubscribe.push(options.model.subscribe(() => this.#surface.invalidate()));
    this.#unsubscribe.push(options.peaks.subscribe(() => this.#surface.invalidateContent()));
    const overlay = options.overlay;
    const down = (e: PointerEvent) => this.#pointerDown(e);
    const move = (e: PointerEvent) => this.#pointerMove(e);
    const up = (e: PointerEvent) => this.#pointerUp(e);
    const cancel = () => this.#cancel();
    overlay.addEventListener('pointerdown', down);
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', cancel);
    this.#unsubscribe.push(() => {
      overlay.removeEventListener('pointerdown', down);
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', cancel);
    });
    this.#surface = new LayeredSurface({
      content: options.content,
      overlay,
      container: options.container,
      measure: (container) => ({ width: Math.max(1, Math.round(container.clientWidth)), height: Math.max(1, Math.round(container.clientHeight)) }),
      drawContent: () => this.#drawContent(),
      drawOverlay: () => this.#drawOverlay(),
      resized: (width, height, ratio) => {
        this.#ratio = ratio;
        if (width !== this.#view.width || height !== this.#view.height) {
          this.#view = { ...this.#view, width, height, laneHeight: Math.max(1, height - RULER_HEIGHT) };
          this.#fitted = null;
        }
      },
    });
  }

  // The clip to show (the app's selectedClipId), or none.
  setClip(clipId: string | null): void {
    if (clipId === this.#clipId) return;
    this.#clipId = clipId;
    this.#drag = null;
    this.#hover = null;
    this.#surface.invalidate();
  }

  getView(): Viewport {
    return this.#view;
  }

  // H: twice the detail, about the range's centre; false with no clip.
  zoomIn(): boolean {
    return this.#zoom(1);
  }

  // G: half the detail.
  zoomOut(): boolean {
    return this.#zoom(-1);
  }

  invalidate(): void {
    this.#surface.invalidate();
  }

  destroy(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#surface.destroy();
  }

  testHooks(): EditorTestHooks {
    return {
      clipId: () => (this.#shown() ? this.#clipId : null),
      view: () => this.#view,
      range: () => this.#range,
      source: () => this.#source,
      gain: () => this.#gain,
      columns: () => this.#columns,
      level: () => this.#level,
      contentDraws: () => this.#contentDraws,
      overlayDraws: () => this.#overlayDraws,
    };
  }

  #zoom(direction: 1 | -1): boolean {
    const shown = this.#shown();
    if (!shown) return false;
    this.#fit(shown.clip, shown.media);
    const next = zoomEditor(this.#view, shown.clip, direction);
    if (next === this.#view) return false;
    this.#view = next;
    this.#surface.invalidate();
    return true;
  }

  #shown(): { clip: ClipEntity; media: MediaEntity; snapshot: Snapshot } | null {
    const snapshot = this.#options.model.getSnapshot();
    const found = editorClip(snapshot, this.#clipId);
    return found && snapshot ? { ...found, snapshot } : null;
  }

  // The first view of a clip shows its whole source.
  #fit(clip: ClipEntity, media: MediaEntity): void {
    if (this.#fitted === clip.id) return;
    this.#fitted = clip.id;
    this.#view = editorView(clip, media, this.#view.width, this.#view.height ?? 1);
  }

  #allows(op: string): boolean {
    return this.#options.allows ? this.#options.allows(op) : true;
  }

  #point(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.#options.container.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  #flags(e: ModifierFlags): ModifierFlags {
    return { ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey };
  }

  #pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const shown = this.#shown();
    if (!shown) return;
    const { x, y } = this.#point(e);
    const part = editorHit(shown.clip, this.#view, x, y);
    if (part === null || part === 'body') return;
    const op = part === 'gain' ? 'clip.set_gain' : 'clip.trim';
    if (!this.#allows(op) || (part === 'rangeStart' && !this.#allows('clip.move'))) return;
    e.preventDefault?.();
    this.#options.overlay.setPointerCapture?.(e.pointerId);
    this.#drag = { part, pointer: e.pointerId, startX: x, startY: y, snapshot: shown.snapshot, clip: shown.clip, dx: 0, dy: 0, flags: this.#flags(e) };
    this.#surface.invalidateOverlay();
  }

  #pointerMove(e: PointerEvent): void {
    const { x, y } = this.#point(e);
    const drag = this.#drag;
    if (drag && drag.pointer === e.pointerId) {
      drag.dx = x - drag.startX;
      drag.dy = y - drag.startY;
      drag.flags = this.#flags(e);
      this.#surface.invalidateOverlay();
      return;
    }
    const shown = this.#shown();
    const hover = shown ? editorHit(shown.clip, this.#view, x, y) : null;
    if (hover !== this.#hover) {
      this.#hover = hover;
      this.#options.overlay.style.cursor = hover === 'rangeStart' || hover === 'rangeEnd' ? 'ew-resize' : hover === 'gain' ? 'ns-resize' : '';
      this.#surface.invalidateOverlay();
    }
  }

  #pointerUp(e: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    const { x, y } = this.#point(e);
    drag.dx = x - drag.startX;
    drag.dy = y - drag.startY;
    drag.flags = this.#flags(e);
    this.#drag = null;
    this.#options.overlay.releasePointerCapture?.(e.pointerId);
    this.#surface.invalidateOverlay();
    const env = { platform: this.#options.platform ?? 'other', flags: drag.flags, allows: (op: string) => this.#allows(op) };
    const delta = { clipId: drag.clip.id, dx: drag.dx, dy: drag.dy };
    const command =
      drag.part === 'gain'
        ? gainDragCommand(drag.snapshot, delta, env)
        : rangeDragCommand(drag.snapshot, { ...delta, edge: drag.part === 'rangeStart' ? 'left' : 'right' }, this.#view, { ...env, snap: this.#snap(), cursor: this.#cursorNow() });
    if (command) void this.#options.execute(command.commands, command.expectedRevision).catch(() => undefined);
  }

  #cancel(): void {
    if (!this.#drag) return;
    this.#drag = null;
    this.#surface.invalidateOverlay();
  }

  #snap(): SnapSettings {
    return this.#options.snap?.() ?? DEFAULT_SNAP;
  }

  // The project cursor now, from the clock, as the event display's
  // #cursorNow reads it: while playing the extrapolated position.
  #cursorNow(): bigint | null {
    this.#clock.observe(this.#options.playhead?.playhead() ?? null);
    const position = this.#clock.position(this.#options.model.getSnapshot()?.root?.sampleRate ?? 48000);
    return position === null ? null : BigInt(position);
  }

  #css(): (name: string) => string {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(this.#options.container) : null;
    return (name) => style?.getPropertyValue(name).trim() ?? '';
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
    const ctx = this.#context(this.#options.content);
    const shown = this.#shown();
    this.#columns = 0;
    this.#level = null;
    this.#range = null;
    this.#source = null;
    this.#gain = null;
    if (!ctx) return;
    const read = this.#css();
    const view = this.#view;
    const height = view.height ?? 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = read('--bg-0');
    ctx.fillRect(0, 0, view.width, height);
    if (!shown) return;
    const { clip, media, snapshot } = shown;
    this.#fit(clip, media);
    this.#drawRuler(ctx, snapshot, read);
    const source = sourcePixels(clip, media, this.#view);
    const range = rangePixels(clip, this.#view);
    this.#source = source;
    this.#range = range;
    const top = RULER_HEIGHT;
    const left = Math.max(0, source.start);
    const right = Math.min(view.width, source.end);
    // The source's well, the waveform, then the dim outside the range.
    ctx.fillStyle = read('--lane-even');
    if (right > left) ctx.fillRect(left, top, right - left, height - top);
    const pyramid = this.#options.peaks.get(media.contentHash);
    const half = (height - top) / 2 - WAVE_MARGIN;
    if (pyramid && half > 0 && right > left) {
      const mid = top + (height - top) / 2;
      const { level, columns } = waveformColumns(pyramid, {
        sourceStart: 0,
        length: Number(media.frames),
        framesPerPixel: this.#view.framesPerPixel,
        ratio: this.#ratio,
        x: source.start,
        clipLeft: left,
        clipRight: right,
        mid,
        half,
      });
      const colour = read(trackColourVar(clip.trackId)) || read('--tx-2');
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.5;
      for (const c of columns) ctx.fillRect(c.x, mid - c.outerSpan.up, c.w, c.outerSpan.up + c.outerSpan.down);
      ctx.globalAlpha = 1;
      for (const c of columns) ctx.fillRect(c.x, mid - c.innerSpan.up, c.w, c.innerSpan.up + c.innerSpan.down);
      this.#columns = columns.length;
      this.#level = level;
    }
    ctx.fillStyle = read('--bg-0-a550');
    if (range.start > left) ctx.fillRect(left, top, Math.min(range.start, right) - left, height - top);
    if (range.end < right) ctx.fillRect(Math.max(range.end, left), top, right - Math.max(range.end, left), height - top);
    // The range's ends.
    ctx.fillStyle = read('--select');
    for (const x of [range.start, range.end - 1]) if (x >= -1 && x <= view.width) ctx.fillRect(Math.round(x), top, 1, height - top);
    this.#gain = editorGainBox(clip, this.#view);
    if (this.#gain) this.#drawGain(ctx, this.#gain, clip.gainMilliDb, read);
  }

  #drawRuler(ctx: CanvasRenderingContext2D, snapshot: Snapshot, read: (name: string) => string): void {
    const view = this.#view;
    const ruler = RULER_HEIGHT;
    const marks = RULER_MARKS;
    ctx.fillStyle = read('--bg-2');
    ctx.fillRect(0, 0, view.width, ruler);
    const tempo = snapshot.root?.tempo ?? [];
    const rate = snapshot.root?.sampleRate ?? 48000;
    for (const mark of gridMarks(view, tempo, rate)) {
      const x = Math.round(mark.x);
      if (mark.kind === 'bar') {
        const major = (barOf(mark) - 1) % marks.barsPerMajor === 0;
        ctx.fillStyle = major ? read('--ruler-major') : read('--ruler-minor');
        ctx.fillRect(x, major ? marks.majorTickTop : ruler - marks.minorTick, 1, major ? ruler - marks.majorTickTop : marks.minorTick);
      } else {
        ctx.fillStyle = read('--button-line');
        ctx.fillRect(x, ruler - marks.quarterTick, 1, marks.quarterTick);
      }
    }
    ctx.font = `${TOKENS['fw-ui']} ${TOKENS['fs-micro']} ${read('--font-ui') || 'sans-serif'}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const mark of rulerMarks(view, tempo, rate)) {
      ctx.fillStyle = mark.kind === 'bar' && (barOf(mark) - 1) % marks.barsPerMajor === 0 ? read('--lit-1') : read('--tx-3');
      ctx.fillText(mark.label, Math.round(mark.x) + marks.labelX, marks.labelY);
    }
    ctx.fillStyle = read('--divider');
    ctx.fillRect(0, ruler - 1, view.width, 1);
  }

  // draw()'s volume control: the well, its line and the value.
  #drawGain(ctx: CanvasRenderingContext2D, gain: Box, value: number, read: (name: string) => string): void {
    ctx.globalAlpha = 1;
    ctx.fillStyle = read('--bg-well');
    ctx.beginPath();
    ctx.roundRect(gain.x, gain.y, gain.width, gain.height, GAIN_RADIUS);
    ctx.fill();
    ctx.strokeStyle = read('--white-a700');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(gain.x + 0.5, gain.y + 0.5, gain.width - 1, gain.height - 1, GAIN_RADIUS);
    ctx.stroke();
    ctx.fillStyle = read('--select');
    ctx.font = `${TOKENS['fw-strong']} ${TOKENS['fs-8']} ${read('--font-ui') || 'sans-serif'}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(formatDb(value), gain.x + GAIN_TEXT_X, gain.y + gain.height / 2 - 0.5, gain.width - 2 * GAIN_TEXT_X);
  }

  #drawOverlay(): void {
    this.#overlayDraws += 1;
    const ctx = this.#context(this.#options.overlay);
    const shown = this.#shown();
    if (!ctx || !shown) return;
    const read = this.#css();
    const height = this.#view.height ?? 0;
    const drag = this.#drag;
    const range = rangePixels(shown.clip, this.#view);
    // The hovered end.
    if (!drag && (this.#hover === 'rangeStart' || this.#hover === 'rangeEnd')) {
      ctx.fillStyle = read('--select');
      ctx.fillRect(Math.round(this.#hover === 'rangeStart' ? range.start : range.end - 1) - 1, RULER_HEIGHT, 3, height - RULER_HEIGHT);
    }
    if (!drag) return;
    if (drag.part === 'gain') {
      const gain = editorGainBox(drag.clip, this.#view);
      if (gain) this.#drawGain(ctx, gain, gainDragValue(drag.clip, drag.dy, { platform: this.#options.platform ?? 'other', flags: drag.flags }), read);
      return;
    }
    const edge = drag.part === 'rangeStart' ? 'left' : 'right';
    const { target, snapped } = rangeDragTarget(drag.snapshot, drag.clip, edge, drag.dx, this.#view, { snap: this.#snap(), cursor: this.#cursorNow(), platform: this.#options.platform ?? 'other', flags: drag.flags, allows: () => true });
    const x = Math.round(frameToX(target, this.#view));
    ctx.fillStyle = read('--select');
    ctx.fillRect(x - (edge === 'right' ? 1 : 0), RULER_HEIGHT, 1, height - RULER_HEIGHT);
    // The snap guide through the ruler while snap applies.
    if (snapped) {
      ctx.fillStyle = read('--white-a550');
      ctx.fillRect(x, 0, 1, RULER_HEIGHT);
    }
  }
}
