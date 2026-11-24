// The event display surface (spec "Frontend"; ADR-0019 point 3; UI redesign
// spec 3.2 and 5.2): an imperative class that owns two stacked canvases,
// outside React state, sized to their container (a ResizeObserver and a
// device-pixel-ratio media query) and never to the session; scrolling changes
// what is drawn, not a DOM scroll offset.
//
// - The content layer is the mockup's draw() (m5-ui-port-arrange-canvas; UI
//   redesign 10.9), its sizes from tokens.ts and its colours from tokens.css:
//   the lanes in root.trackOrder at their heights in --lane-even and
//   --lane-odd, the locator range's tint, the beat and bar lines (bars and
//   beats through root.tempo), the lane dividers, the ruler's two halves
//   with the locator band, ticks and bar numbers, the --marker-h marker
//   track row (m5b-ui-markers, while `markersEnabled`: draw()'s --bg-info row
//   and divider, each position marker's tint, bar and "N  name" label in its
//   track-palette colour, then each cycle marker's tinted range with a bar at
//   both ends; a plan's marker steps as ghost flags and ranges in the agent
//   violet with their step, a moved or removed marker at 38 %; markers.ts;
//   otherwise the row is left empty, UI redesign 3.0), and each audio clip as
//   draw()'s clip(): its box inset from its bars and lane, the body and the
//   title strip in its track's colour mixed into the tokens, the title
//   (clip-title.ts), the waveform in two tones from the engine's peak
//   pyramid (PeaksCache, waveform.ts), the outline, and a selected clip's
//   palette and lower corner squares. A clip of a muted (or solo-muted) track
//   is drawn at 50 %, a selected clip with draw()'s repeat handle (the disc on
//   its right border, m5b-ui-edit-more). A clip's fades (m5b-ui-fades; UI
//   redesign 3.2, "How a fade is drawn"; fades.ts) are draw()'s shade and 1 px
//   line on the real gain curve at the real length, with the waveform's
//   columns scaled by the gain, on every clip that has them; a selected clip
//   carries draw()'s fade triangles (the hovered clip's are the overlay's)
//   while the engine lists features.clipFades and clip.set_fade
//   (`fadesEnabled`). A plan's fade step is a dashed violet curve on its clip
//   (a side set to 0: the current shade cross-hatched) with its step's disc,
//   solid while heard. The selected plan's ghosts (m5b-ui-ghosts; UI redesign 4.2,
//   5.2) are, from the `ghosts` source (model/review-store.ts), in the agent
//   violet as draw() draws its ghosts (ghost-geometry.ts): a proposed track
//   as a hatched lane under the last lane, a placed clip, the new place of a
//   moved clip and the new box of a trimmed one as a hatched, dashed ghost
//   clip with its waveform and its step number, the original of a moved or
//   trimmed clip at 38 % with an arrow to its ghost, a removed clip at 38 %
//   and cross-hatched, a removed track's lane cross-hatched with its step
//   (under its clips, which are removed clips), and a locator change as a ghost band in the ruler's
//   upper half. While the proposal is heard (m5b-ui-audition; UI redesign
//   4.3) every one of them is solid (mode 'solid': no hatch, no dash, the
//   ghost body over a proposed or removed lane), and the original of a moved
//   or trimmed clip, main's place, is a faint outline instead of the clip at
//   38 %. They appear at once (no fade: UI redesign 1.6). It is
//   redrawn only when the snapshot, the selection, the zoom, the scroll, the
//   size, the lane heights, the peaks, the locale or the ghosts change.
// - The overlay layer draws the project cursor (the realtime playhead) as
//   draw() does, its line from the ruler's lower half to the top of the
//   scroll-zoom bar with its head, the handles of the hovered clip and the
//   volume control of the selected and the hovered clip (draw()'s box with
//   its value), the preview of a drag (a move, an Alt-drag copy, a resize),
//   the snap guide and the Split tool's line, and positions the drag
//   tooltip, and outlines the ghosts of the hovered or pinned step. It
//   redraws on its own animation frame, scheduled only when one of those
//   moved, so while stopped and idle nothing runs, and a frame in which only
//   the cursor moved leaves the content alone. A click on a ghost clip or a
//   ghost lane pins its step (and selects nothing); a click on the original
//   of a moved, trimmed or removed clip selects it as before and pins the
//   step too; reveal(step) scrolls by the least amount that shows a step's
//   ghosts.
//
// Pointer gestures end in one command.execute each (timeline/commands.ts and
// edit-commands.ts), with the revision of the snapshot the gesture began on;
// the model then follows session.changed (structural edits are never
// optimistic), and a refusal is shown as the last error and the gesture
// discarded. With the Object Selection tool (UI redesign spec 3.2, P1-8): a
// click selects a clip (Shift-click adds or removes one), a drag moves the
// selection (Ctrl keeps it to one axis), an Alt-drag copies it, an Alt-click
// splits the clip there, a lower corner (or the 4 px edge) resizes, and the
// volume control changes the clip's gain by a vertical drag (Shift: fine),
// sent once on release. With the Split tool a click splits the clip.
// m5b-ui-edit-more (spec 3.2): with the Glue tool a click joins the clip with
// the next piece of its track (Alt: every following piece; on a selected clip
// with others selected, each run of the selection) and a refusal goes to
// `onRefuse` (a toast); with the Erase tool a click removes the clip; with
// the Object Selection tool a drag from empty space draws a rubber band on
// the overlay that selects every clip it touches (Shift adds; a plain click
// still clears), and a drag of a selected clip's repeat handle repeats the
// selection by the drag's distance in spans. m5b-ui-fades (spec 3.2; 10.11,
// 23): a fade handle, hit before the edge and the body, drags that side's
// length (the preview and the tooltip in ms on the overlay) and its release
// sends one clip.set_fade (fades.ts fadeDragCommand: snapped unless Ctrl,
// clamped, nothing at the starting length); a double-click on a handle or in
// a shaded area switches that side's curve. Snap types Events and Magnetic
// Cursor read the other clips' edges and the cursor (snap.ts, snapContext). The
// modifiers come from keys/tool-modifiers.ts; a pointer that moved less than
// DRAG_THRESHOLD_PX is a click. Moves, copies, resizes, splits by click and
// placements land on the grid while snap is on (timeline/snap.ts; Ctrl while
// resizing ignores it). A gesture whose commands engine.capabilities does not
// list (`allows`) does not begin and sends nothing (UI redesign spec 3.0). A
// vertical drag in the lower half of the ruler zooms about the pointer; the
// upper half is the locators' (m5-ui-loop-click, spec 3.2): a drag draws the
// range, a drag of the band moves it, a drag of an end adjusts it, a click on
// the band toggles cycle, Ctrl-click (Mod) and Alt-click set the left and the
// right locator; each sends one session.set_locators on release, through the
// `locators` source, snapped as clips are (locators.ts says what is sent).
// The band (light with cycle on, grey with it off, with its L and R flags)
// and its tint over the lanes are drawn on the content layer from the
// document's locators and the source's cycle flag, which the canvas hears
// directly, never through React; without the source (an engine that lacks
// the command) the upper half is inert and nothing is drawn. The wheel is the
// surface's (non-passive, default prevented): plain scrolls the lanes, Shift
// scrolls horizontally, Ctrl zooms at the pointer, Ctrl+Shift changes every
// track's height. Lane heights are the layout store's (per session id); the
// canvas reads them through `laneHeights` and asks for changes through
// onLaneHeights. The snap state is the layout store's too, given by setSnap.
// In the lower half of the ruler a click (a press and release that moved
// less than DRAG_THRESHOLD_PX) locates the project cursor through onLocate,
// also while stopped, as a Shift+Alt-click anywhere in the event display
// locates without selecting, splitting or placing (m5-ui-transport). With
// auto-scroll on (F) the overlay frame turns the page when the cursor leaves
// the view while playing, never while a drag is held (auto-scroll.ts), so the
// content layer redraws only on a page turn.
//
// The marker track (m5b-ui-markers; UI redesign 3.2, "Marker track"), while
// `markersEnabled` and through `allows` (the edit guard): Alt-click adds a
// position marker there (snapped), a Ctrl-drag (Mod) on its empty space draws
// a cycle marker, a drag of a marker moves it (snapped, Ctrl unsnapped), a
// drag of a cycle marker's edge resizes it, a click selects a marker (and
// drops the clip selection; the two exclude each other) and Delete removes it
// (deleteSelected), a double-click on its name opens an input over the label
// (Enter renames, Escape and leaving it cancel) and a double-click elsewhere
// on a cycle marker sets the locators to it through the `locators` source.
// Each gesture is one command.execute (markers.ts builds them). insertMarker
// (Insert) adds one at the project cursor; goToMarker, nextMarker and
// previousMarker locate.
//
// Colours are tokens.css custom properties read from the container; the one
// sentence the canvas words itself, the empty session's guidance, comes from
// the catalogs through the `t` it is given and is redrawn on a locale change.

import { formatDb } from '../format';
import type { Ghost } from '../plans/ghosts';
import { TOKENS } from '../tokens';
import { translator, type T } from '../i18n/t';
import { toolModifiers, type ModifierFlags } from '../keys/tool-modifiers';
import type { ClipEntity, ClipFade, MediaEntity } from '../model/document';
import type { MeterFrame } from '../model/meter-frames';
import type { PeaksCache } from '../model/peaks-cache';
import { WAVE_FRAMES, type RecordingClip } from '../model/record-clip';
import type { ReadModel, Snapshot } from '../model/read-model';
import { MAX_LEAD_MS, PlayheadClock } from '../transport/playhead-clock';
import { nextScroll } from './auto-scroll';
import { gestureCommand, newClipId, type TimelineCommand } from './commands';
import { clipTitle } from './clip-title';
import { CLIP_DIMMED_ALPHA, dimmedTracks } from './dimming';
import {
  ARROW,
  GHOST_HATCH_PITCH,
  GHOST_HATCH_WIDTH,
  GHOST_OUTLINE_W,
  HOT_OUTLINE_W,
  LANE_HATCH_PITCH,
  LANE_HATCH_WIDTH,
  MOVED_ORIGINAL_ALPHA,
  STEP_DISC,
  arrowOf,
  ghostClipBox,
  ghostLaneRects,
  ghostStroke,
  locatorGhostRect,
  revealScroll,
  type GhostLane,
} from './ghost-geometry';
import { CLIPBOARD, type Clipboard } from './clipboard';
import {
  FADE_SIDES,
  fadeCurvePoints,
  fadeCurveToggleCommand,
  fadeDragCommand,
  fadeDragLength,
  fadeHandles,
  fadePx,
  fadeScaledColumns,
  fadeShadePoints,
  fadeSideOf,
  formatMs,
  framesToMs,
  type FadeCurve,
  type FadeHandle,
  type FadeSide,
} from './fades';
import {
  clipGainCommand,
  constrainAxis,
  copyClips,
  copyCommand,
  cutCommand,
  duplicateCommand,
  gainFromDrag,
  glueCommand,
  glueSelectionCommand,
  isGlueRefused,
  moveSelectionCommand,
  nudgeCommand,
  pasteCommand,
  repeatCommand,
  repeatCountFromDrag,
  selectionLength,
  splitAtCursor as splitAtCursorCommand,
  splitCommand,
  type GlueRefusal,
  type NudgeMode,
} from './edit-commands';
import {
  CLIP_INSET_TOP,
  CLIP_RADIUS,
  CLIP_TITLE_HEIGHT,
  DEFAULT_LANE_HEIGHT,
  GAIN_RADIUS,
  LANES_TOP,
  RULER_HEIGHT,
  RULER_LOWER,
  RULER_UPPER,
  clipBox,
  clipRects,
  cornerHandles,
  deltaFrames,
  frameToX,
  gainBox,
  hitTest,
  laneHeightOf,
  laneTops,
  lanesHeight,
  lanesTopOf,
  repeatHandle,
  snapMove,
  snapTrim,
  titleStrip,
  trackAt,
  trimEdgeOf,
  xToFrame,
  type Box,
  type ClipRect,
  type HitPart,
  type TrimEdge,
  type Viewport,
} from './geometry';
import { formatBbt, formatBbtDelta, framesToTicks } from './musical-time';
import { barOf, gridMarks, rulerMarks } from './ruler';
import {
  clickSelection,
  nextClipFrame,
  selectionSpan as spanOf,
  previousClipFrame,
  pruneSelection,
  rubberBandSelection,
  selectAllClips,
  selectNone,
  selectionStart,
  zoomToSelection as fitSelection,
} from './selection';
import {
  BAND_LINE,
  FLAG_W,
  LABEL_INSET,
  bandRect,
  dragEnd,
  drawRange,
  frameAt,
  locatorHit,
  moveRange,
  rangeOf,
  setLeft,
  setRight,
  type BandRect,
  type LocatorGrid,
  type LocatorHit,
  type LocatorRange,
} from './locators';
import { DEFAULT_SNAP, gridStepFrames, moveSnapperFor, snapContext, snapperFor, type SnapSettings, type Snapper } from './snap';
import {
  MARKER_LABEL_MIX,
  MARKER_TINT_ALPHA,
  addCycleCommand,
  addMarkerCommand,
  clipsEnd,
  cycleBox,
  flagBox,
  labelBox,
  locatorsOf,
  markerColourVar,
  markerHit,
  markerLabel,
  markerShapes,
  moveMarkerCommand,
  newMarkerId,
  nextMarker as nextMarkerFrame,
  positionMarkerByNumber,
  previousMarker as previousMarkerFrame,
  removeMarkerCommand,
  renameMarkerCommand,
  resizeCycleCommand,
  type MarkerShape,
} from './markers';
import type { MarkerEntity } from '../model/document';
import { planDrop, type DropPlan } from './media-drop';
import { SELECTED_OUTLINE_W, clipPalette, mix, trackColourVar, type ClipPalette } from './track-colour';
import { waveformColumns, type WaveColumn } from './waveform';
import { ZOOM_STEP, maxScrollY, scrollFramesBy, scrollYBy, stepLaneHeight, zoomAbout, zoomFull, zoomToRange } from './zoom';
import { frameMarks } from '../perf/frame-marks';

// The tools of P1-8: 1 Object Selection, 3 Split; of m5b-ui-edit-more: 4
// Glue, 5 Erase (UI redesign spec 3.2).
export type Tool = 'select' | 'split' | 'glue' | 'erase';
const TOOLS: readonly Tool[] = ['select', 'split', 'glue', 'erase'];

export interface TimelineState {
  // The primary selected clip (the info line's, the last clicked), or null.
  readonly selectedClipId: string | null;
  // Every selected clip, the primary included.
  readonly selectedClipIds: readonly string[];
  // The media a click on a lane places (the media pool's armed entry).
  readonly placingMediaId: string | null;
  // The last refusal (its protocol code, null for none, and the engine's
  // message); null after a command succeeds. The chrome words it.
  readonly error: TimelineRefusal | null;
  readonly tool: Tool;
}

export const IDLE_STATE: TimelineState = Object.freeze({
  selectedClipId: null,
  selectedClipIds: Object.freeze([]) as readonly string[],
  placingMediaId: null,
  error: null,
  tool: 'select',
});

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
  playhead(): MeterFrame | null;
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
  // Which key is Mod for the tool modifiers ('other' when absent).
  readonly platform?: 'mac' | 'other';
  // transport.locate for L, N and B; absent when the engine does not list it.
  readonly locate?: (frame: bigint) => unknown;
  // A click in the ruler's lower half or a Shift+Alt-click in the event
  // display: locate the project cursor to this frame (a non-negative decimal
  // string; m5-ui-transport).
  readonly onLocate?: (frames: string) => void;
  // Auto-scroll in page mode while playing (off when absent; setAutoScroll).
  readonly autoScroll?: boolean;
  // The locators of the ruler's upper half (m5-ui-loop-click); absent, the
  // upper half is inert and no band is drawn.
  readonly locators?: LocatorBandSource;
  // The cursor clock's time in milliseconds (performance.now when absent;
  // the tests move it by hand).
  readonly now?: () => number;
  // The selected plan's ghosts (m5b-ui-ghosts); none when absent.
  readonly ghosts?: GhostSource;
  // The takes being recorded (m5b-ui-recording): their red clips on the overlay.
  readonly recording?: RecordingSource;
  // A glue the Glue tool or edit.glue refuses, and why (m5b-ui-edit-more):
  // the chrome words it as a toast; nothing is sent.
  readonly onRefuse?: (reason: GlueRefusal | 'selection') => void;
  // Where Ctrl+C and Ctrl+X put the clips (the window's clipboard when absent).
  readonly clipboard?: Clipboard;
  // Whether the fade handles are drawn and hit (m5b-ui-fades: the engine lists
  // features.clipFades and clip.set_fade); off when absent. What a gesture
  // sends still goes through `allows` (the edit guard).
  readonly fadesEnabled?: () => boolean;
  // Whether the marker track is drawn and takes its gestures and keys
  // (m5b-ui-markers: the engine lists features.markers and the marker
  // commands); off when absent, the row left empty.
  readonly markersEnabled?: () => boolean;
}

// A clip's fades as the canvas draws and hits them (m5b-ui-fades; the e2e
// reads it): its lengths, its handles' triangles (null with fades disabled)
// and whether they are drawn (the clip selected or hovered).
export interface FadeDrawn {
  readonly clipId: string;
  readonly position: string;
  readonly length: string;
  readonly fadeIn: ClipFade | null;
  readonly fadeOut: ClipFade | null;
  readonly handles: { readonly fadeIn: Box; readonly fadeOut: Box } | null;
  readonly shown: boolean;
}

// The ghosts of the plan under review (m5b-ui-ghosts; model/review-store.ts):
// the descriptors to draw, the step whose ghosts are outlined (1-based, or
// null), their changes, where a click on a ghost goes, and the requests to
// bring a step's ghosts into view.
// The takes being recorded (m5b-ui-recording; UI redesign 3.5): the red
// clips at a playhead and each take's live waveform columns (WAVE_FRAMES
// frames each, the input meter's loudest peak), and a change of either.
export interface RecordingSource {
  clips(playhead: bigint | null): readonly RecordingClip[];
  columns(takeId: string): readonly number[];
  subscribe(listener: () => void): () => void;
}

// A red clip as the last overlay frame drew it (the e2e reads it).
export interface RecordingDrawn {
  readonly takeId: string;
  readonly trackId: string;
  readonly start: string;
  readonly end: string;
  readonly x: number;
  readonly width: number;
  readonly columns: number;
}

export interface GhostSource {
  ghosts(): readonly Ghost[];
  outlineStep(): number | null;
  subscribe(listener: () => void): () => void;
  pin(step: number): void;
  onReveal?(listener: (step: number) => void): () => void;
}

// The locator band's link to the engine (m5-ui-loop-click): whether the
// engine lists what the band needs now (checked at each press and frame), the
// cycle flag as the engine last said and its changes, and where an edit goes.
export interface LocatorBandSource {
  enabled(): boolean;
  cycle(): boolean;
  subscribe(listener: () => void): () => void;
  // One session.set_locators (the source skips null and the range already set).
  setLocators(range: LocatorRange | null): void;
  // A click on the band: cycle on or off; false when it sends nothing (no device).
  toggleCycle(): boolean;
}

// The band as the last content frame drew it (the e2e and the fidelity gate).
export interface LocatorBandDrawn extends BandRect {
  // Light (cycle on) or grey (cycle off).
  readonly cycle: boolean;
  readonly left: string;
  readonly right: string;
}

// A part of the surface as the mockup's draw() records it for the fidelity
// run (window.__fidelity): its id and box in canvas pixels.
export interface SurfacePart {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// A clip's drawn waveform columns, and how many are not silence.
export interface PeakColumns {
  readonly drawn: number;
  readonly nonZero: number;
  readonly outline?: true;
}

// What the e2e reads through window.__siannTimeline (SIANN_SHELL_TEST=1 only).
export interface TimelineTestHooks {
  // Each clip's lane rectangle and its title (clip-title.ts) as last drawn.
  clips(): Array<ClipRect & { readonly title: string }>;
  // Its peak columns as last drawn. While a proposal is heard the original of
  // a moved or trimmed clip is main's place as a faint outline, with no
  // waveform: it reports `outline: true` and no columns (m5b-ui-audition).
  peakColumns(clipId: string): PeakColumns;
  // The outer half-heights of a clip's waveform columns in the last content frame.
  waveColumns(clipId: string): number[];
  // The surface's parts with the mockup's ids (ruler-upper, ruler-lower,
  // lane-N, clip-N, locator-band, cursor, cursor-head) and the waveform
  // interiors, as the last frames drew them.
  parts(): SurfacePart[];
  masks(): Array<Omit<SurfacePart, 'id'>>;
  view(): Viewport;
  lanes(): string[];
  // The ruler labels of the last content frame, left to right.
  rulerLabels(): string[];
  // How many times each layer has been drawn.
  contentDraws(): number;
  overlayDraws(): number;
  // The project cursor's x in the last overlay frame, or null without a playhead.
  cursorX(): number | null;
  // The width of the selected clips' outline in the last content frame (0: none in view).
  selectionOutline(): number;
  // The dimmed lanes of the last content frame (muted, or implicitly by a solo).
  dimmedLanes(): string[];
  // The empty session's guidance as last drawn, or null.
  guidance(): string | null;
  // Every selected clip (m5-ui-edit-basics).
  selectedClips(): string[];
  tool(): Tool;
  snap(): SnapSettings;
  // The snap guide's x in the last overlay frame, or null without one.
  snapGuide(): number | null;
  // The locator band of the last content frame, or null (m5-ui-loop-click).
  locatorBand(): LocatorBandDrawn | null;
  // Diagnostic: what the last Alt+X decided and from what (PR #120's macOS e2e).
  lastEdit(): EditProbe | null;
  // The ghosts of the last content frame, and the step the last overlay frame outlined (m5b-ui-ghosts).
  ghosts(): Ghost[];
  ghostOutline(): number | null;
  // The red clips of the last overlay frame (m5b-ui-recording).
  recordingClips(): RecordingDrawn[];
  // Each clip's fades and handles (m5b-ui-fades), and the part a point hits.
  fades(): FadeDrawn[];
  hitAt(x: number, y: number): { clipId: string; part: HitPart } | null;
  // The markers of the last content frame as drawn (m5b-ui-markers; none
  // with the marker track off), and the selected marker.
  markers(): MarkerShape[];
  selectedMarker(): string | null;
}

// Why the last split at the cursor sent nothing, or what it built, with the
// cursor (frames) and the clock's newest frame it read and the snapshot's
// clips (id, position, length) at that moment.
export interface EditProbe {
  readonly reason: string;
  readonly cursor: string | null;
  readonly frame: { readonly playheadSamples: string; readonly playing: boolean } | null;
  readonly revision: string | null;
  readonly clips: ReadonlyArray<string>;
  readonly selection: ReadonlyArray<string>;
}

interface Drag {
  // A clip part (move, copy, resize, Alt-click), the volume control, the
  // repeat handle of a selected clip (m5b-ui-edit-more) or a fade handle (m5b-ui-fades).
  readonly kind: 'clip' | 'gain' | 'repeat' | 'fade';
  // The side a fade drag changes.
  readonly side?: FadeSide;
  readonly rect: ClipRect;
  readonly part: HitPart;
  readonly startX: number;
  readonly startY: number;
  // The snapshot the gesture began on: its revision is the expectedRevision.
  readonly snapshot: Snapshot;
  // The clips a move or a copy takes (the selection, or the clip alone).
  readonly ids: readonly string[];
  // The selection a click without a move leaves (the clicked clip alone).
  readonly onClick: readonly string[] | null;
  // The volume control's starting gain.
  readonly gain: number;
  dx: number;
  dy: number;
  // The modifier flags of the latest pointer event.
  flags: ModifierFlags;
}

// A rubber band from empty space (m5b-ui-edit-more): where it began, whether
// Shift adds, and the selection it began on.
interface BandDrag {
  readonly startX: number;
  readonly startY: number;
  readonly add: boolean;
  readonly base: readonly string[];
  x: number;
  y: number;
  moved: boolean;
}

// What a clip drag ends in, as the overlay previews it and the release sends it.
type Plan =
  | { readonly kind: 'none' }
  | { readonly kind: 'split'; readonly frame: bigint }
  | { readonly kind: 'move' | 'copy'; readonly delta: bigint; readonly lanes: number; readonly guide: bigint | null }
  | { readonly kind: 'trim'; readonly edge: TrimEdge; readonly delta: bigint; readonly guide: bigint | null };

// A ghost's box in the last content frame (m5b-ui-ghosts): `pure` for a
// ghost clip or a proposed lane (a click pins its step), the clip id of an
// original drawn at 38 % (a click selects it and pins the step), `ruler` for
// the locator ghost band.
interface GhostBox {
  readonly step: number;
  readonly box: Box;
  readonly pure: boolean;
  readonly clipId?: string;
  readonly ruler?: boolean;
  // A marker ghost in the marker row (m5b-ui-markers): reveal scrolls to it sideways only.
  readonly marker?: boolean;
  // While the proposal is heard (m5b-ui-audition): the band drawn unbroken.
  readonly mode?: 'solid';
}

// A gesture on the marker track (m5b-ui-markers): a marker's move, a cycle
// marker's edge, or a Ctrl-drag that draws a cycle marker; the marker, where
// it began, the snapshot it began on, and the pointer so far.
interface MarkerDrag {
  readonly kind: 'move' | 'left' | 'right' | 'draw';
  readonly markerId: string | null;
  readonly startX: number;
  readonly snapshot: Snapshot;
  // The id a drawn cycle marker gets (one per gesture).
  readonly newId: string;
  x: number;
  flags: ModifierFlags;
  moved: boolean;
}

// A ghost clip to draw: its box, the rectangle its waveform reads, its title
// and a moved clip's arrow.
interface GhostShape {
  readonly step: number;
  readonly box: Box & { readonly radius: number };
  readonly rect: ClipRect;
  readonly title: string;
  readonly arrow: { x0: number; y0: number; x1: number; y1: number } | null;
  // While the proposal is heard (m5b-ui-audition): drawn solid, unhatched.
  readonly mode?: 'solid';
}

interface RulerDrag {
  readonly startX: number;
  readonly startY: number;
  readonly anchorX: number;
  readonly view: Viewport;
  // Past DRAG_THRESHOLD_PX: a zoom; until then a release is a click (locate).
  moved: boolean;
}

// A gesture in the ruler's upper half: from where, on what, and the range it
// would end in so far (null: nothing to send).
interface LocatorDrag {
  readonly hit: LocatorHit;
  readonly startX: number;
  readonly range: LocatorRange | null;
  readonly snapshot: Snapshot;
  readonly flags: ModifierFlags;
  moved: boolean;
  preview: LocatorRange | null;
}

// The colours of draw(), read from tokens.css on the container.
interface Palette {
  readonly bg2: string;
  readonly bgWell: string;
  readonly laneEven: string;
  readonly laneOdd: string;
  readonly beatLine: string;
  readonly barLine: string;
  readonly barLine4: string;
  readonly divider: string;
  readonly rulerUpper: string;
  readonly rulerLine: string;
  readonly rulerMajor: string;
  readonly rulerMinor: string;
  readonly rulerQuarter: string;
  readonly lit1: string;
  readonly tx1: string;
  readonly tx3: string;
  readonly select: string;
  readonly clipOutline: string;
  readonly cursorGlow: string;
  readonly gainLine: string;
  readonly font: string;
  // The locator band (m5-ui-loop-click): light, grey, its labels, the tint.
  readonly bandFill: string;
  readonly bandLine: string;
  readonly bandLabel: string;
  readonly bandOffFill: string;
  readonly bandOff: string;
  readonly bandTint: string;
  // The red clip of a recording (m5b-ui-recording): its outline, body and waveform.
  readonly rec: string;
  readonly recBody: string;
  readonly recWave: string;
  // The ghosts (m5b-ui-ghosts): draw()'s agent violet.
  readonly ai: string;
  readonly aiBody: string;
  readonly aiHatch: string;
  readonly aiTitle: string;
  readonly aiWaveOuter: string;
  readonly aiWaveInner: string;
  readonly aiTitleText: string;
  readonly aiInk: string;
  readonly aiLane: string;
  // A fade's shade (m5b-ui-fades: draw()'s --bg-0-a550).
  readonly fadeShade: string;
  // The marker row (m5b-ui-markers: draw()'s --bg-info).
  readonly bgInfo: string;
  track(trackId: string): string;
  // A marker's colour: the track palette by the hash of its id.
  marker(markerId: string): string;
}

// A fade ghost to draw (m5b-ui-fades): its clip's box and the ghost.
interface FadeGhostShape {
  readonly box: Box & { readonly radius: number };
  readonly ghost: Extract<Ghost, { kind: 'fade' }>;
}

export const DEFAULT_FRAMES_PER_PIXEL = 100;
// The ruler (UI redesign spec 3.2): the locators' half above (RULER_UPPER),
// the cursor's and zoom's below (RULER_LOWER); geometry.ts reads them from
// tokens.css --ruler-h, --ruler-upper-h and --ruler-lower-h.
export { RULER_HEIGHT, RULER_LOWER, RULER_UPPER };
// A pointer that moved less than this is a click (select), not a drag.
const DRAG_THRESHOLD_PX = 3;
const PLACE_ATTEMPTS = 3;
// A vertical ruler drag of this many px halves or doubles the frames per pixel.
const RULER_DRAG_PX_PER_STEP = 40;
// Ctrl+wheel: this many px of wheel delta are one H or G step.
const WHEEL_PX_PER_STEP = 300;
const LINE_PX = 16;
// A drag's preview (a moved, copied or resized clip) over the lanes.
const PREVIEW_ALPHA = 0.35;
// The rubber band's fill over the lanes (m5b-ui-edit-more).
const BAND_FILL_ALPHA = 0.12;
// The scroll-zoom bar under the canvases (--scrollbar-h): the canvases end
// at its top, where the mockup's #tl ends.
const SCROLLBAR_H = Number.parseFloat(TOKENS['scrollbar-h']);
// draw()'s numbers. The ruler's lower half: a major tick every fourth bar
// from RU + 3, a minor one MINOR_TICK high, quarter ticks QUARTER_TICK high,
// the bar number LABEL_X right of its bar at RU + LABEL_Y.
const BARS_PER_MAJOR = 4;
const MAJOR_TICK_TOP = 3;
const MINOR_TICK = 9;
const QUARTER_TICK = 5;
const LABEL_X = 4;
const LABEL_Y = 10;
// A clip: its title TITLE_X inside the box at the strip's middle, drawn
// on a box wider than TITLE_MIN_W; the outline half a pixel inside (a
// quarter when selected).
const TITLE_X = 6;
const TITLE_Y = 7;
const TITLE_MIN_W = 26;
const OUTLINE_INSET = 0.5;
const SELECTED_OUTLINE_INSET = 0.25;
// The waveform's half-height leaves WAVE_MARGIN above and below.
const WAVE_MARGIN = 2;
// The project cursor: its line and head from RU + CURSOR_TOP, the head
// CURSOR_HEAD_W wide down to RU + 8 and its point at RU + 13, the glow
// CURSOR_GLOW wide over the lanes.
const CURSOR_TOP = 2;
const CURSOR_HEAD_HALF = 5.5;
const CURSOR_HEAD_SIDE = 8;
const CURSOR_HEAD_POINT = 13;
const CURSOR_GLOW = 6;
// The volume control's value: GAIN_TEXT_X inside its box, at its middle.
const GAIN_TEXT_X = 4;
// A marker ghost (m5b-ui-markers): its step disc right of the 2 px bar, its
// label after the disc (the ghost clip's title offset, STEP_DISC.titleX).
const GHOST_DISC_X = Number.parseFloat(TOKENS['space-half']);
const GHOST_LABEL_X = STEP_DISC.titleX;
// The marker rename field: this far left of the label, at least this wide.
const RENAME_PAD = Number.parseFloat(TOKENS['space']);
const RENAME_MIN_W = Number.parseFloat(TOKENS['track-list-w']) / 2;

export class TimelineCanvas {
  readonly #options: TimelineCanvasOptions;
  readonly #content: HTMLCanvasElement;
  readonly #overlay: HTMLCanvasElement;
  readonly #container: HTMLElement;
  readonly #listeners = new Set<() => void>();
  readonly #viewListeners = new Set<() => void>();
  readonly #unsubscribe: Array<() => void> = [];
  #state: TimelineState = IDLE_STATE;
  #snap: SnapSettings = DEFAULT_SNAP;
  #hoverClipId: string | null = null;
  #guideX: number | null = null;
  #view: Viewport;
  #drag: Drag | null = null;
  #band: BandDrag | null = null;
  #rulerDrag: RulerDrag | null = null;
  #locatorDrag: LocatorDrag | null = null;
  #locatorBand: LocatorBandDrawn | null = null;
  #contentFrame: number | null = null;
  #overlayFrame: number | null = null;
  #columns = new Map<string, PeakColumns>();
  #rects: ClipRect[] = [];
  #resize: ResizeObserver | null = null;
  #ratio = 1;
  #media: { query: MediaQueryList; listener: () => void } | null = null;
  #destroyed = false;
  #rulerLabels: string[] = [];
  #contentDraws = 0;
  #overlayDraws = 0;
  #recordingDrawn: RecordingDrawn[] = [];
  #cursorX: number | null = null;
  // The last split's diagnostic (testHooks().lastEdit).
  #lastEdit: EditProbe | null = null;
  // The cursor's position as last drawn, from the clock.
  #playhead: string | null = null;
  // The newest realtime frame's playhead, as received.
  #framePlayhead: string | null = null;
  #playing = false;
  readonly #clock: PlayheadClock;
  #autoScroll: boolean;
  #outline = 0;
  #dimmed: string[] = [];
  #guidance: string | null = null;
  // What the last content frame drew, for the hooks: each clip's title and
  // waveform columns (outer half-heights), the parts and the waveform interiors.
  #titles = new Map<string, string>();
  #waves = new Map<string, number[]>();
  #contentParts: SurfacePart[] = [];
  #masks: Array<Omit<SurfacePart, 'id'>> = [];
  // The cursor's parts in the last overlay frame (none out of view).
  #cursorParts: SurfacePart[] = [];
  #lastPointer: { x: number; y: number } | null = null;
  #heightRequests: Array<(trackIds: readonly string[], height: number) => void> = [];
  // The ghosts of the last content frame, their boxes (for the outline, the
  // hit test and reveal) and the step the last overlay frame outlined.
  #ghosts: readonly Ghost[] = [];
  #ghostBoxes: GhostBox[] = [];
  // The lanes of the tracks whose ghosts live on the header and the strip only
  // (gain, pan, mute, solo, rename): reveal scrolls to them, nothing draws them.
  #ghostRows: Array<{ readonly step: number; readonly top: number; readonly height: number }> = [];
  #ghostOutline: number | null = null;
  #ghostLanes = 0;
  // The marker track (m5b-ui-markers): the shapes of the last content frame
  // (hit and reported from there), the selected marker, an open gesture and
  // an open rename field.
  #markerShapes: MarkerShape[] = [];
  #selectedMarker: string | null = null;
  #markerDrag: MarkerDrag | null = null;
  #rename: { readonly markerId: string; readonly input: HTMLInputElement } | null = null;

  constructor(options: TimelineCanvasOptions) {
    this.#options = options;
    this.#content = options.content;
    this.#overlay = options.overlay;
    this.#container = options.container;
    this.#autoScroll = options.autoScroll ?? false;
    this.#clock = new PlayheadClock({ now: options.now ?? (() => performance.now()) });
    this.#view = {
      framesPerPixel: options.framesPerPixel ?? DEFAULT_FRAMES_PER_PIXEL,
      scrollFrames: '0',
      rulerHeight: RULER_HEIGHT,
      lanesTop: LANES_TOP,
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
    // The cycle flag: the band redraws from here, not through React.
    if (options.locators) this.#unsubscribe.push(options.locators.subscribe(() => this.#invalidateContent()));
    if (options.recording) this.#unsubscribe.push(options.recording.subscribe(() => this.#invalidateOverlay()));
    if (options.ghosts) {
      const source = options.ghosts;
      this.#unsubscribe.push(source.subscribe(() => this.#ghostsChanged()));
      if (source.onReveal) this.#unsubscribe.push(source.onReveal((step) => this.reveal(step)));
    }
    if (options.laneHeights) {
      const source = options.laneHeights;
      this.#unsubscribe.push(source.subscribe(() => this.#setView({ ...this.#view, laneHeights: source.get() })));
    }
    const overlay = this.#overlay;
    const down = (e: PointerEvent) => this.#pointerDown(e);
    const move = (e: PointerEvent) => this.#pointerMove(e);
    const up = (e: PointerEvent) => this.#pointerUp(e);
    const cancel = () => this.#cancelDrag();
    const dblclick = (e: MouseEvent) => this.#doubleClick(e);
    const leave = () => {
      this.#lastPointer = null;
      if (this.#hoverClipId !== null || this.#state.tool === 'split') {
        this.#hoverClipId = null;
        this.#invalidateOverlay();
      }
    };
    overlay.addEventListener('pointerdown', down);
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', cancel);
    overlay.addEventListener('pointerleave', leave);
    overlay.addEventListener('dblclick', dblclick);
    // Non-passive, so preventDefault keeps the page from scrolling and Chromium from zooming.
    const wheel = (e: WheelEvent) => this.#wheel(e);
    this.#container.addEventListener('wheel', wheel, { passive: false });
    this.#unsubscribe.push(() => {
      overlay.removeEventListener('pointerdown', down);
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', cancel);
      overlay.removeEventListener('pointerleave', leave);
      overlay.removeEventListener('dblclick', dblclick);
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
    this.#closeRename();
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

  // Where a drop of `count` files or a Media tab row at a client point lands
  // (m5b-ui-media; media-drop.ts): the snapped position and each file's lane,
  // with this canvas's view and snap state; null on the ruler or the marker row.
  dropPlan(clientX: number, clientY: number, count: number): DropPlan | null {
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot) return null;
    const { x, y } = this.#point({ clientX, clientY });
    return planDrop({ snapshot, view: this.#view, snap: this.#snap, x, y, count });
  }

  // Arms (or disarms, with null) the media a click on a lane places.
  setPlacing(mediaId: string | null): void {
    this.#update({ placingMediaId: mediaId });
  }

  // Drops the selection (and an open drag): a reconnect clears it (UI
  // redesign spec 4.5 C8), even when the recovered session still has the clip.
  clearSelection(): void {
    this.#drag = null;
    this.#band = null;
    this.#select([], null);
  }

  // Delete and Backspace: the selected marker's marker.remove (m5b-ui-markers;
  // a marker and clips are never selected together), else clip.remove of
  // every selected clip, in one list.
  async deleteSelected(): Promise<void> {
    const snapshot = this.#options.model.getSnapshot();
    const marker = this.#selectedMarker;
    if (snapshot && marker !== null && this.#markersOn()) {
      await this.#send(() => removeMarkerCommand(snapshot, marker));
      return;
    }
    const ids = this.#state.selectedClipIds;
    if (!snapshot || ids.length === 0) return;
    await this.#send(() => {
      const commands = ids.filter((id) => snapshot.entities[`clip:${id}`]).map((clipId) => ({ op: 'clip.remove', clipId }));
      return commands.length > 0 ? { expectedRevision: snapshot.revision, commands } : null;
    });
  }

  // Insert (m5b-ui-markers): a position marker at the project cursor, as it
  // is (no snap); false when the marker track is off or the command is held.
  insertMarker(): boolean {
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot || !this.#markersOn() || !this.#allows('marker.add')) return false;
    const at = this.#cursorFrame();
    void this.#send(() => addMarkerCommand(snapshot, at, (frame) => frame, newMarkerId()));
    return true;
  }

  // Shift+3..9, Num 3..9: the cursor to position marker `number` (never a cycle marker).
  goToMarker(number: number): boolean {
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot || !this.#markersOn()) return false;
    const marker = positionMarkerByNumber(snapshot, number);
    return this.#locate(marker ? BigInt(marker.position) : null);
  }

  // Shift+N and Shift+B: the next or previous marker start (both kinds) from the cursor.
  nextMarker(): boolean {
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot || !this.#markersOn()) return false;
    return this.#locate(nextMarkerFrame(snapshot, this.#cursorFrame()));
  }

  previousMarker(): boolean {
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot || !this.#markersOn()) return false;
    return this.#locate(previousMarkerFrame(snapshot, this.#cursorFrame()));
  }

  // 1, 3, 4 and 5: the Object Selection, Split, Glue and Erase tools.
  setTool(tool: Tool): void {
    if (!TOOLS.includes(tool)) return;
    this.#update({ tool });
    this.#overlay.style.cursor = tool === 'split' ? 'crosshair' : tool === 'select' ? 'default' : 'pointer';
  }

  // The snap state (the layout store's): on / off, the grid type and the snap type.
  setSnap(snap: SnapSettings): void {
    const type = snap.type ?? 'grid';
    if (snap.on === this.#snap.on && snap.grid === this.#snap.grid && type === this.#snap.type) return;
    this.#snap = { on: snap.on, grid: snap.grid, type };
    this.#invalidateOverlay();
  }

  // A command list built elsewhere (the info line's edit): sent as a gesture's is.
  async sendCommand(command: TimelineCommand | null): Promise<void> {
    await this.#send(() => command);
  }

  // edit.glue: each run of the selection; a refusal when none joins.
  async glueSelection(): Promise<boolean> {
    const snapshot = this.#options.model.getSnapshot();
    const ids = this.#state.selectedClipIds;
    if (!snapshot || ids.length === 0) return false;
    const command = glueSelectionCommand(snapshot, ids);
    if (!command) {
      this.#options.onRefuse?.('selection');
      return true;
    }
    await this.#send(() => command);
    return true;
  }

  // Ctrl+C: the selection into the clipboard; nothing is sent.
  copy(): boolean {
    const snapshot = this.#options.model.getSnapshot();
    const copied = snapshot ? copyClips(snapshot, this.#state.selectedClipIds) : null;
    if (!copied) return false;
    (this.#options.clipboard ?? CLIPBOARD).set(copied);
    return true;
  }

  // Ctrl+X: copied, then clip.remove of each selected clip.
  async cut(): Promise<boolean> {
    const snapshot = this.#options.model.getSnapshot();
    const ids = this.#state.selectedClipIds;
    if (!snapshot || !this.copy()) return false;
    await this.#send(() => cutCommand(snapshot, ids));
    return true;
  }

  // Ctrl+V at the project cursor, Alt+V at the origin.
  async paste(atOrigin = false): Promise<boolean> {
    const snapshot = this.#options.model.getSnapshot();
    const clipboard = (this.#options.clipboard ?? CLIPBOARD).get();
    if (!snapshot || !clipboard) return false;
    const at = atOrigin ? 'origin' : this.#cursorFrame();
    await this.#send((clipId) => pasteCommand(snapshot, clipboard, at, clipId), true);
    return true;
  }

  // Ctrl+K once counted: `count` copies of the selection after it.
  async repeat(count: number): Promise<void> {
    const snapshot = this.#options.model.getSnapshot();
    const ids = this.#state.selectedClipIds;
    if (!snapshot || ids.length === 0) return;
    await this.#send((clipId) => repeatCommand(snapshot, ids, count, clipId), true);
  }

  // The nudges (Ctrl+Left/Right and the Alt arrows): one grid step at the selection's start.
  async nudge(mode: NudgeMode, direction: 1 | -1 = 1): Promise<boolean> {
    const snapshot = this.#options.model.getSnapshot();
    const ids = this.#state.selectedClipIds;
    const range = snapshot ? spanOf(snapshot, ids) : null;
    if (!snapshot || !range) return false;
    const step = gridStepFrames(this.#snap, this.#view.framesPerPixel, snapshot.root?.tempo ?? [], snapshot.root?.sampleRate ?? 48000, range.start);
    await this.#send(() => nudgeCommand(snapshot, ids, mode === 'position' ? BigInt(direction) * step : step, mode));
    return true;
  }

  // Ctrl+Shift+A: nothing selected.
  selectNone(): void {
    this.#select(selectNone(), null);
  }

  // Alt+X: the selected clips at the project cursor, or every clip under it.
  async splitAtCursor(): Promise<void> {
    const snapshot = this.#options.model.getSnapshot();
    const cursor = this.#cursorNow();
    const selection = this.#state.selectedClipIds;
    this.#probeEdit(snapshot, cursor, selection);
    if (!snapshot || cursor === null) return;
    await this.#send((clipId) => splitAtCursorCommand(snapshot, selection, BigInt(cursor), clipId), true);
  }

  // Diagnostic, read through testHooks().lastEdit: what this split will do and why.
  #probeEdit(snapshot: Snapshot | null, cursor: string | null, selection: readonly string[]): void {
    let reason: string;
    if (!snapshot) reason = 'no-snapshot';
    else if (cursor === null) reason = 'no-cursor';
    else {
      const built = splitAtCursorCommand(snapshot, selection, BigInt(cursor), () => 'probe');
      if (!built) reason = 'no-clip-under-cursor';
      else if (!built.commands.every((c) => this.#allows(String((c as { op?: unknown }).op)))) reason = 'capability';
      else reason = `built ${built.commands.length}`;
    }
    const frame = this.#options.playhead?.playhead() ?? null;
    this.#lastEdit = {
      reason,
      cursor,
      frame: frame ? { playheadSamples: frame.playheadSamples, playing: frame.playing } : null,
      revision: snapshot?.revision ?? null,
      clips: (snapshot?.clips ?? []).map((c) => `${c.id}@${c.position.value}+${c.length}`),
      selection: [...selection],
    };
  }

  // Ctrl+D: a copy of the selection directly after it.
  async duplicate(): Promise<void> {
    const snapshot = this.#options.model.getSnapshot();
    const selection = this.#state.selectedClipIds;
    if (!snapshot || selection.length === 0) return;
    await this.#send((clipId) => duplicateCommand(snapshot, selection, clipId), true);
  }

  // Ctrl+A: every clip.
  selectAll(): void {
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot) return;
    const ids = selectAllClips(snapshot);
    const primary = this.#state.selectedClipId !== null && ids.includes(this.#state.selectedClipId) ? this.#state.selectedClipId : (ids[0] ?? null);
    this.#select(ids, primary);
  }

  // P and Alt+P (m5-ui-loop-click): the selection's span, or null.
  selectionSpan(): { start: bigint; end: bigint } | null {
    const snapshot = this.#options.model.getSnapshot();
    return snapshot ? spanOf(snapshot, this.#state.selectedClipIds) : null;
  }

  // L: the cursor to the selection's start.
  locateSelection(): boolean {
    const snapshot = this.#options.model.getSnapshot();
    const start = snapshot ? selectionStart(snapshot, this.#state.selectedClipIds) : null;
    return this.#locate(start);
  }

  // N and B: the cursor to the next or previous clip start on these tracks (all when none).
  locateNextClip(trackIds: readonly string[] = []): boolean {
    const snapshot = this.#options.model.getSnapshot();
    return this.#locate(snapshot ? nextClipFrame(snapshot, this.#cursorFrame(), trackIds) : null);
  }

  locatePreviousClip(trackIds: readonly string[] = []): boolean {
    const snapshot = this.#options.model.getSnapshot();
    return this.#locate(snapshot ? previousClipFrame(snapshot, this.#cursorFrame(), trackIds) : null);
  }

  // Alt+S: the selection fits the view.
  zoomToSelection(): void {
    const snapshot = this.#options.model.getSnapshot();
    if (snapshot) this.#setView(fitSelection(this.#view, snapshot, this.#state.selectedClipIds));
  }

  // Shift+E: the primary selected clip fits the view.
  zoomToEvent(): void {
    const snapshot = this.#options.model.getSnapshot();
    const id = this.#state.selectedClipId;
    const clip = id ? (snapshot?.entities[`clip:${id}`] as ClipEntity | undefined) : undefined;
    if (!clip || clip.position.domain !== 'audio') return;
    const start = BigInt(clip.position.value);
    this.#setView(zoomToRange(this.#view, start, start + BigInt(clip.length)));
  }

  #cursorFrame(): bigint {
    const cursor = this.#cursorNow();
    return cursor === null ? 0n : BigInt(cursor);
  }

  // The project cursor now, from the clock (m5-ui-transport): while playing
  // the extrapolated position, not the one the last overlay frame drew.
  #cursorNow(): string | null {
    this.#clock.observe(this.#options.playhead?.playhead() ?? null);
    return this.#clock.position(this.#options.model.getSnapshot()?.root?.sampleRate ?? 48000);
  }

  #locate(frame: bigint | null): boolean {
    const locate = this.#options.locate;
    if (frame === null || !locate) return false;
    void Promise.resolve(locate(frame)).catch(() => undefined);
    return true;
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

  // F: auto-scroll in page mode while playing (UI redesign spec 3.1).
  setAutoScroll(enabled: boolean): void {
    if (enabled === this.#autoScroll) return;
    this.#autoScroll = enabled;
    this.#invalidateOverlay();
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
      clips: () => this.#rects.map((r) => ({ ...r, title: this.#titles.get(r.clipId) ?? r.mediaId })),
      peakColumns: (clipId) => ({ ...(this.#columns.get(clipId) ?? { drawn: 0, nonZero: 0 }) }),
      waveColumns: (clipId) => [...(this.#waves.get(clipId) ?? [])],
      parts: () => {
        const band = this.#locatorBand ? [{ id: 'locator-band', x: this.#locatorBand.x, y: this.#locatorBand.y, w: this.#locatorBand.width, h: this.#locatorBand.height }] : [];
        return [...this.#contentParts, ...band, ...this.#cursorParts].map((p) => ({ ...p }));
      },
      masks: () => this.#masks.map((m) => ({ ...m })),
      view: () => ({ ...this.#view, laneHeights: { ...(this.#view.laneHeights ?? {}) } }),
      lanes: () => [...(this.#options.model.getSnapshot()?.trackOrder ?? [])],
      rulerLabels: () => [...this.#rulerLabels],
      contentDraws: () => this.#contentDraws,
      overlayDraws: () => this.#overlayDraws,
      recordingClips: () => [...this.#recordingDrawn],
      cursorX: () => this.#cursorX,
      selectionOutline: () => this.#outline,
      dimmedLanes: () => [...this.#dimmed],
      guidance: () => this.#guidance,
      selectedClips: () => [...this.#state.selectedClipIds],
      tool: () => this.#state.tool,
      snap: () => ({ ...this.#snap }),
      snapGuide: () => this.#guideX,
      locatorBand: () => (this.#locatorBand ? { ...this.#locatorBand } : null),
      lastEdit: () => this.#lastEdit,
      ghosts: () => [...this.#ghosts],
      ghostOutline: () => this.#ghostOutline,
      fades: () => {
        const on = this.#fadesOn();
        const selected = new Set(this.#state.selectedClipIds);
        const box = (h: FadeHandle): Box => ({ x: h.x, y: h.y, width: h.width, height: h.height });
        return this.#rects.map((r) => {
          const handles = on ? fadeHandles(clipBox(r), r, this.#view.framesPerPixel) : null;
          return {
            clipId: r.clipId,
            position: r.position,
            length: r.length,
            fadeIn: r.fadeIn ? { ...r.fadeIn } : null,
            fadeOut: r.fadeOut ? { ...r.fadeOut } : null,
            handles: handles ? { fadeIn: box(handles.fadeIn), fadeOut: box(handles.fadeOut) } : null,
            shown: on && !this.#drag && (selected.has(r.clipId) || r.clipId === this.#hoverClipId),
          };
        });
      },
      hitAt: (x, y) => {
        const hit = hitTest(this.#rects, x, y, { fades: this.#fadeHits() });
        return hit ? { clipId: hit.rect.clipId, part: hit.part } : null;
      },
      markers: () => this.#markerShapes.map((s) => ({ ...s })),
      selectedMarker: () => this.#selectedMarker,
    };
  }

  // The marker track is drawn and takes its gestures (m5b-ui-markers).
  #markersOn(): boolean {
    return this.#options.markersEnabled?.() ?? false;
  }

  // The fade handles are drawn and hit (the engine lists the feature and the command).
  #fadesOn(): boolean {
    return this.#options.fadesEnabled?.() ?? false;
  }

  // ... and hit with the Object Selection tool only (10.11, 23).
  #fadeHits(): boolean {
    return this.#fadesOn() && this.#state.tool === 'select';
  }

  // A double-click on a fade handle or inside a fade's shaded area switches
  // that side's curve, the same length (one clip.set_fade); nothing on a side
  // without a fade (UI redesign 3.2; 10.11, 23).
  #doubleClick(e: MouseEvent): void {
    if (e.button !== 0) return;
    const snapshot = this.#options.model.getSnapshot();
    if (!snapshot) return;
    const { x, y } = this.#point(e);
    if (y >= this.#view.rulerHeight && y < lanesTopOf(this.#view)) {
      if (this.#markersOn()) this.#markerDoubleClick(snapshot, x, y);
      return;
    }
    if (!this.#fadeHits()) return;
    if (y < lanesTopOf(this.#view)) return;
    const hit = hitTest(clipRects(snapshot, this.#view), x, y, { fades: true });
    const side = fadeSideOf(hit?.part);
    if (!hit || !side || !this.#allows('clip.set_fade')) return;
    const clipId = hit.rect.clipId;
    void this.#send(() => fadeCurveToggleCommand(snapshot, clipId, side));
  }

  // The frame a fade drag's end is at so far: the side's end at the press plus the pointer's travel.
  #fadeEnd(drag: Drag): bigint {
    const clip = drag.snapshot.entities[`clip:${drag.rect.clipId}`] as ClipEntity | undefined;
    const position = BigInt(drag.rect.position);
    const length = BigInt(drag.rect.length);
    const side = drag.side ?? 'fadeIn';
    const fade = BigInt(clip?.[side]?.length ?? '0');
    const at = side === 'fadeIn' ? position + fade : position + length - fade;
    return at + deltaFrames(drag.dx, this.#view);
  }

  // The length a held fade drag gives so far, or null for another drag.
  #fadePreview(drag: Drag | null): { clip: ClipEntity; side: FadeSide; length: bigint; snapped: bigint | null } | null {
    if (!drag || drag.kind !== 'fade' || !drag.side) return null;
    const clip = drag.snapshot.entities[`clip:${drag.rect.clipId}`] as ClipEntity | undefined;
    if (!clip || clip.schema !== 'siann.entity.clip.v1') return null;
    const mods = toolModifiers(drag.flags, this.#platform());
    const snap = this.#snapper(drag.snapshot, mods.noSnap, [clip.id]);
    const end = this.#fadeEnd(drag);
    const length = this.#moved(drag) ? fadeDragLength(clip, drag.side, end, snap) : BigInt(clip[drag.side]?.length ?? '0');
    return { clip, side: drag.side, length, snapped: this.#snap.on && !mods.noSnap && this.#moved(drag) ? snap(end) : null };
  }

  // Scrolls by the least amount that shows the ghosts of `step` (1-based) as
  // the last content frame drew them; nothing when they show already. A ghost
  // on a track header only (gain, pan, mute, solo, rename) scrolls the lanes,
  // which the track list follows, to its track's row and never sideways.
  reveal(step: number): void {
    const boxes = this.#ghostBoxes.filter((b) => b.step === step);
    const rows = this.#ghostRows.filter((r) => r.step === step);
    if (boxes.length === 0 && rows.length === 0) return;
    const view = this.#view;
    const top = lanesTopOf(view);
    const x0 = boxes.length > 0 ? Math.min(...boxes.map((b) => b.box.x)) : 0;
    const x1 = boxes.length > 0 ? Math.max(...boxes.map((b) => b.box.x + b.box.width)) : 0;
    // The ruler's ghost (the locator band) scrolls only sideways.
    const lanes = [...boxes.filter((b) => !b.ruler && !b.marker).map((b) => ({ y: b.box.y, bottom: b.box.y + b.box.height })), ...rows.map((r) => ({ y: r.top, bottom: r.top + r.height }))];
    const y0 = lanes.length > 0 ? Math.min(...lanes.map((b) => b.y)) : top;
    const y1 = lanes.length > 0 ? Math.max(...lanes.map((b) => b.bottom)) : top;
    const order = this.#options.model.getSnapshot()?.trackOrder ?? [];
    const limit = maxScrollY(view, lanesHeight(order, view) + this.#ghostLanes * view.laneHeight);
    const move = revealScroll({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, view, top, limit);
    if (!move) return;
    const frames = BigInt(view.scrollFrames) + BigInt(move.dx) * BigInt(view.framesPerPixel);
    this.#setView({ ...view, scrollFrames: (frames < 0n ? 0n : frames).toString(), scrollY: (view.scrollY ?? 0) + move.dy });
  }

  // The ghost source changed: new ghosts redraw the content, a new outline the overlay.
  #ghostsChanged(): void {
    const source = this.#options.ghosts;
    if (!source) return;
    if (source.ghosts() !== this.#ghosts) this.#invalidateContent();
    if (source.outlineStep() !== this.#ghostOutline) this.#invalidateOverlay();
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
      // The perf scenario's frame marks (perf/frame-marks.ts; a no-op outside the test hook).
      frameMarks().begin();
      this.#drawContent();
      frameMarks().end();
    });
  }

  #invalidateOverlay(): void {
    if (this.#destroyed || this.#overlayFrame !== null) return;
    this.#overlayFrame = requestAnimationFrame(() => {
      this.#overlayFrame = null;
      frameMarks().begin();
      this.#drawOverlay();
      frameMarks().end();
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
    // Above the scroll-zoom bar: the cursor ends at its top, as in the mockup.
    const height = Math.max(1, Math.round(this.#container.clientHeight - SCROLLBAR_H));
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
    const ids = pruneSelection(this.#state.selectedClipIds, snapshot);
    const primary = this.#state.selectedClipId;
    if (ids !== this.#state.selectedClipIds || (primary && !snapshot?.entities[`clip:${primary}`])) {
      this.#select(ids, primary && ids.includes(primary) ? primary : (ids[ids.length - 1] ?? null));
    }
    const placing = this.#state.placingMediaId;
    if (placing && !snapshot?.entities[`media:${placing}`]) this.#update({ placingMediaId: null });
    // A removed marker is no longer selected, and its rename field closes.
    if (this.#selectedMarker !== null && !snapshot?.entities[`marker:${this.#selectedMarker}`]) this.#selectedMarker = null;
    if (this.#rename && !snapshot?.entities[`marker:${this.#rename.markerId}`]) this.#closeRename();
    this.invalidate();
  }

  // A realtime frame: the clock restarts from it. While playing the overlay
  // runs on every animation frame anyway (#drawOverlay asks for the next);
  // stopped, a frame whose playhead did not move draws nothing.
  #playheadChanged(): void {
    const frame = this.#options.playhead?.playhead() ?? null;
    this.#clock.observe(frame);
    const playhead = frame ? frame.playheadSamples : null;
    const playing = frame?.playing ?? false;
    if (playhead === this.#framePlayhead && playing === this.#playing) return;
    this.#framePlayhead = playhead;
    this.#playing = playing;
    this.#invalidateOverlay();
  }

  #update(patch: Partial<TimelineState>): void {
    const next = { ...this.#state, ...patch };
    if ((Object.keys(patch) as Array<keyof TimelineState>).every((k) => next[k] === this.#state[k])) return;
    // A selected clip is drawn in its selected palette (draw()): the content follows the selection.
    if (next.selectedClipIds !== this.#state.selectedClipIds) this.#invalidateContent();
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
    const content = lanesHeight(snapshot?.trackOrder ?? [], this.#view) + this.#ghostLanes * this.#view.laneHeight;
    this.#setView(scrollYBy(this.#view, dy, content));
  }

  #select(ids: readonly string[], primary: string | null): void {
    // Clips and a marker are never selected together (m5b-ui-markers).
    if (ids.length > 0) this.#selectMarker(null);
    const same = ids.length === this.#state.selectedClipIds.length && ids.every((id, i) => id === this.#state.selectedClipIds[i]);
    this.#update({ selectedClipIds: same ? this.#state.selectedClipIds : [...ids], selectedClipId: primary });
  }

  #platform(): 'mac' | 'other' {
    return this.#options.platform ?? 'other';
  }

  #flags(e: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): ModifierFlags {
    return { ctrlKey: e.ctrlKey === true, altKey: e.altKey === true, shiftKey: e.shiftKey === true, metaKey: e.metaKey === true };
  }

  // The snap of a frame at this zoom (the identity with snap off or ignored);
  // Events and Magnetic Cursor reach the edges of the clips not in `dragged`
  // and the project cursor.
  #snapper(snapshot: Snapshot, ignore = false, dragged: readonly string[] = []): Snapper {
    const view = this.#view;
    return snapperFor(this.#snap, view.framesPerPixel, snapshot.root?.tempo ?? [], snapshot.root?.sampleRate ?? 48000, ignore, BigInt(view.scrollFrames), this.#snapContext(snapshot, dragged));
  }

  #snapContext(snapshot: Snapshot, dragged: readonly string[]) {
    const type = this.#snap.type ?? 'grid';
    if (type !== 'events' && type !== 'cursor') return undefined;
    const cursor = type === 'cursor' ? this.#cursorNow() : null;
    return snapContext(snapshot, dragged, cursor === null ? null : BigInt(cursor));
  }

  #pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const snapshot = this.#options.model.getSnapshot();
    const { x, y } = this.#point(e);
    if (y < this.#view.rulerHeight) {
      // The lower half: a click locates, a vertical drag zooms; the upper half is the locators'.
      if (y >= RULER_UPPER) {
        this.#rulerDrag = { startX: x, startY: y, anchorX: x, view: this.#view, moved: false };
        this.#capture(e);
      } else if (snapshot && this.#bandEnabled()) {
        const range = rangeOf(snapshot.locators);
        const hit = locatorHit(range, this.#view, x, y);
        this.#locatorDrag = { hit, startX: x, range, snapshot, flags: this.#flags(e), moved: false, preview: null };
        this.#capture(e);
      }
      return;
    }
    // The marker track (m5b-ui-markers): its gestures while it is on; with it off a press there does nothing.
    if (y < lanesTopOf(this.#view)) {
      if (snapshot && this.#markersOn()) this.#markerDown(e, snapshot, x, y);
      return;
    }
    // A press on the lanes drops the marker selection (m5b-ui-markers).
    this.#selectMarker(null);
    // Shift+Alt-click in the event display locates too (spec 3.1, "Set the
    // cursor"), on a clip or not, and neither selects, drags nor places.
    if (e.shiftKey && e.altKey) {
      const frame = xToFrame(x, this.#view);
      this.#options.onLocate?.((frame < 0n ? 0n : frame).toString());
      return;
    }
    if (!snapshot) return;
    const placing = this.#state.placingMediaId;
    if (placing) {
      const trackId = trackAt(snapshot, y, this.#view);
      if (trackId) {
        this.#update({ placingMediaId: null });
        const position = this.#snapper(snapshot)(xToFrame(x, this.#view));
        void this.#send((clipId) => gestureCommand(snapshot, { kind: 'place', mediaId: placing, trackId, position }, clipId), true);
      }
      return;
    }
    // A ghost clip or a proposed lane: its step is pinned, nothing else happens.
    const ghost = this.#ghostAt(x, y);
    if (ghost !== null) {
      this.#options.ghosts?.pin(ghost);
      return;
    }
    const flags = this.#flags(e);
    const mods = toolModifiers(flags, this.#platform());
    const found = hitTest(clipRects(snapshot, this.#view), x, y, { fades: this.#fadeHits() });
    const hit = found ? { rect: found.rect, part: found.part } : null;
    // A fade's shaded area is the body for a press (its double-click is #doubleClick's).
    if (hit && (hit.part === 'fadeInArea' || hit.part === 'fadeOutArea')) hit.part = 'body';
    // The original of a moved, trimmed or removed clip is a clip: it selects as before, and pins its step.
    const original = hit ? this.#ghostBoxes.find((b) => b.clipId === hit.rect.clipId) : undefined;
    if (original) this.#options.ghosts?.pin(original.step);
    if (this.#state.tool === 'split') {
      // The Split tool: a click splits the clip under the pointer there.
      if (!hit || !this.#allows('clip.trim') || !this.#allows('clip.place')) return;
      const frame = this.#snapper(snapshot, false, [hit.rect.clipId])(xToFrame(x, this.#view));
      const clipId = hit.rect.clipId;
      void this.#send((id) => splitCommand(snapshot, [clipId], frame, id), true);
      return;
    }
    if (this.#state.tool === 'glue') {
      // The Glue tool: the clip and the next piece; Alt, the whole run; a
      // selected clip with others selected, each run of the selection.
      if (!hit || !this.#allows('clip.remove') || !this.#allows('clip.trim')) return;
      const clipId = hit.rect.clipId;
      const selected = this.#state.selectedClipIds;
      if (selected.length > 1 && selected.includes(clipId)) {
        void this.glueSelection();
        return;
      }
      const glued = glueCommand(snapshot, clipId, { all: flags.altKey });
      if (isGlueRefused(glued)) {
        this.#options.onRefuse?.(glued.refused);
        return;
      }
      void this.#send(() => glued);
      return;
    }
    if (this.#state.tool === 'erase') {
      // The Erase tool: a click removes the clip.
      if (!hit || !this.#allows('clip.remove')) return;
      const clipId = hit.rect.clipId;
      void this.#send(() => gestureCommand(snapshot, { kind: 'delete', clipId }));
      return;
    }
    const selection = this.#state.selectedClipIds;
    if (!hit) {
      // Empty space: a rubber band once the pointer moves; a click clears the
      // selection (Shift keeps it).
      this.#band = { startX: x, startY: y, add: mods.fine, base: selection, x, y, moved: false };
      this.#capture(e);
      return;
    }
    // The repeat handle is drawn on the selected clips only; on another clip its point is the right edge's.
    if (hit.part === 'repeat' && !selection.includes(hit.rect.clipId)) hit.part = 'right';
    if (hit.part === 'repeat') {
      if (!this.#allows('clip.place')) return;
      this.#drag = { kind: 'repeat', rect: hit.rect, part: hit.part, startX: x, startY: y, snapshot, ids: selection, onClick: null, gain: 0, dx: 0, dy: 0, flags };
      this.#capture(e);
      return;
    }
    const clipId = hit.rect.clipId;
    if (hit.part === 'fadeIn' || hit.part === 'fadeOut') {
      // A fade handle (m5b-ui-fades): the drag changes this clip's side only,
      // also with others selected; an unselected clip becomes the selection.
      if (!selection.includes(clipId)) this.#select([clipId], clipId);
      if (!this.#allows('clip.set_fade')) return;
      this.#drag = { kind: 'fade', side: hit.part, rect: hit.rect, part: hit.part, startX: x, startY: y, snapshot, ids: [clipId], onClick: null, gain: 0, dx: 0, dy: 0, flags };
      this.#capture(e);
      this.#invalidateOverlay();
      return;
    }
    let ids: readonly string[];
    let onClick: readonly string[] | null = null;
    if (hit.part === 'gain') {
      ids = selection.includes(clipId) ? selection : [clipId];
    } else if (mods.fine) {
      // Shift-click adds the clip, or takes it out.
      ids = clickSelection(selection, clipId, true);
      if (!ids.includes(clipId)) {
        this.#select(ids, ids[ids.length - 1] ?? null);
        return;
      }
    } else if (selection.includes(clipId)) {
      // A selected clip drags the whole selection; a click leaves it alone.
      ids = selection;
      onClick = [clipId];
    } else {
      ids = [clipId];
    }
    this.#select(ids, clipId);
    if (hit.part === 'gain') {
      if (!this.#allows('clip.set_gain')) return;
      const clip = snapshot.entities[`clip:${clipId}`] as ClipEntity | undefined;
      this.#drag = { kind: 'gain', rect: hit.rect, part: hit.part, startX: x, startY: y, snapshot, ids: [clipId], onClick: null, gain: clip?.gainMilliDb ?? 0, dx: 0, dy: 0, flags };
      this.#capture(e);
      this.#invalidateOverlay();
      return;
    }
    this.#drag = { kind: 'clip', rect: hit.rect, part: hit.part, startX: x, startY: y, snapshot, ids, onClick, gain: 0, dx: 0, dy: 0, flags };
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
    const marking = this.#markerDrag;
    if (marking) {
      marking.x = x;
      marking.flags = this.#flags(e);
      if (!marking.moved && Math.abs(x - marking.startX) < DRAG_THRESHOLD_PX) return;
      marking.moved = true;
      this.#invalidateContent();
      return;
    }
    const ruler = this.#rulerDrag;
    if (ruler) {
      if (!ruler.moved && Math.abs(y - ruler.startY) < DRAG_THRESHOLD_PX && Math.abs(x - ruler.startX) < DRAG_THRESHOLD_PX) return;
      ruler.moved = true;
      const factor = Math.pow(2, -(y - ruler.startY) / RULER_DRAG_PX_PER_STEP);
      this.#setView(zoomAbout({ ...ruler.view, width: this.#view.width, height: this.#view.height, laneHeights: this.#view.laneHeights }, ruler.anchorX, factor));
      return;
    }
    const locator = this.#locatorDrag;
    if (locator) {
      if (!locator.moved && Math.abs(x - locator.startX) < DRAG_THRESHOLD_PX) return;
      locator.moved = true;
      locator.preview = this.#locatorPlan(locator, x);
      this.#invalidateContent();
      return;
    }
    const band = this.#band;
    if (band) {
      band.x = x;
      band.y = y;
      if (!band.moved && Math.abs(x - band.startX) < DRAG_THRESHOLD_PX && Math.abs(y - band.startY) < DRAG_THRESHOLD_PX) return;
      band.moved = true;
      this.#invalidateOverlay();
      return;
    }
    const drag = this.#drag;
    if (drag) {
      drag.dx = x - drag.startX;
      drag.dy = y - drag.startY;
      drag.flags = this.#flags(e);
      this.#invalidateOverlay();
      return;
    }
    const hit = y >= lanesTopOf(this.#view) ? hitTest(this.#rects, x, y, { fades: this.#fadeHits() }) : null;
    const hover = hit?.rect.clipId ?? null;
    if (hover !== this.#hoverClipId || this.#state.tool === 'split') {
      this.#hoverClipId = hover;
      this.#invalidateOverlay();
    }
    const gain = hit?.part === 'gain';
    const title = gain ? (this.#options.locale?.t() ?? translator('en'))('clip.gainControl') : '';
    if (this.#overlay.title !== title) this.#overlay.title = title;
    this.#overlay.style.cursor = this.#cursorFor(hit?.part ?? null, y, e.altKey === true, x);
  }

  #cursorFor(part: HitPart | null, y: number, alt: boolean, x = 0): string {
    if (this.#state.placingMediaId) return 'copy';
    if (y < this.#view.rulerHeight) {
      if (y >= RULER_UPPER) return 'ns-resize';
      if (!this.#bandEnabled()) return 'default';
      const hit = locatorHit(rangeOf(this.#options.model.getSnapshot()?.locators), this.#view, x, y);
      return hit === 'left' || hit === 'right' ? 'ew-resize' : hit === 'body' ? 'grab' : 'default';
    }
    if (y < lanesTopOf(this.#view)) {
      // The marker track: an edge resizes, a marker moves.
      if (!this.#markersOn()) return 'default';
      const hit = markerHit(this.#markerShapes, x, y)?.part;
      return hit === 'cycle-left' || hit === 'cycle-right' ? 'ew-resize' : hit && hit !== 'empty' ? 'grab' : 'default';
    }
    if (this.#state.tool === 'split') return part ? 'crosshair' : 'default';
    if (this.#state.tool === 'glue' || this.#state.tool === 'erase') return part ? 'pointer' : 'default';
    switch (part) {
      case null:
        return 'default';
      case 'body':
      case 'fadeInArea':
      case 'fadeOutArea':
        return alt ? 'copy' : 'grab';
      case 'gain':
        return 'ns-resize';
      case 'repeat':
        return this.#hoverClipId !== null && this.#state.selectedClipIds.includes(this.#hoverClipId) ? 'copy' : 'ew-resize';
      case 'cornerLeft':
        return 'nesw-resize';
      case 'cornerRight':
        return 'nwse-resize';
      default:
        return 'ew-resize';
    }
  }

  #pointerUp(e: PointerEvent): void {
    const marking = this.#markerDrag;
    if (marking) {
      this.#pointerMove(e);
      this.#markerDrag = null;
      this.#release(e);
      this.#invalidateContent();
      if (!marking.moved) {
        // A plain click on empty space drops the marker selection.
        if (marking.kind === 'draw' || marking.markerId === null) this.#selectMarker(null);
        return;
      }
      const command = this.#markerPlan(marking);
      if (command) void this.#send(() => command);
      return;
    }
    const locator = this.#locatorDrag;
    if (locator) {
      this.#pointerMove(e);
      this.#locatorDrag = null;
      this.#release(e);
      this.#locatorReleased(locator);
      return;
    }
    const ruler = this.#rulerDrag;
    if (ruler) {
      this.#pointerMove(e);
      this.#rulerDrag = null;
      this.#release(e);
      // A click (no movement past the threshold): locate to the pressed frame.
      if (!ruler.moved) {
        const frame = xToFrame(ruler.startX, ruler.view);
        this.#options.onLocate?.((frame < 0n ? 0n : frame).toString());
      }
      return;
    }
    const band = this.#band;
    if (band) {
      this.#pointerMove(e);
      this.#band = null;
      this.#release(e);
      this.#invalidateOverlay();
      if (!band.moved) {
        if (!band.add) this.#select([], null);
        return;
      }
      const ids = rubberBandSelection(this.#rects, this.#bandBox(band), band.base, band.add);
      const primary = ids.includes(this.#state.selectedClipId ?? '') ? this.#state.selectedClipId : (ids[ids.length - 1] ?? null);
      this.#select(ids, primary);
      return;
    }
    const drag = this.#drag;
    if (!drag) return;
    this.#pointerMove(e);
    this.#drag = null;
    this.#release(e);
    this.#hideTooltip();
    this.#invalidateOverlay();
    const snapshot = drag.snapshot;
    if (drag.kind === 'repeat') {
      const count = this.#repeatCount(drag);
      if (count > 0) void this.#send((clipId) => repeatCommand(snapshot, drag.ids, count, clipId), true);
      return;
    }
    if (drag.kind === 'gain') {
      if (!this.#moved(drag)) return;
      const gain = gainFromDrag(drag.gain, drag.dy, toolModifiers(drag.flags, this.#platform()).fine);
      void this.#send(() => clipGainCommand(snapshot, drag.rect.clipId, gain));
      return;
    }
    if (drag.kind === 'fade') {
      // One clip.set_fade on release; a click (no movement) sends nothing.
      if (!this.#moved(drag) || !drag.side) return;
      const side = drag.side;
      const snap = this.#snapper(snapshot, toolModifiers(drag.flags, this.#platform()).noSnap, [drag.rect.clipId]);
      const end = this.#fadeEnd(drag);
      void this.#send(() => fadeDragCommand(snapshot, drag.rect.clipId, side, end, snap));
      return;
    }
    const plan = this.#plan(drag);
    switch (plan.kind) {
      case 'none':
        if (!this.#moved(drag) && drag.onClick) this.#select(drag.onClick, drag.rect.clipId);
        return;
      case 'split':
        if (!this.#allows('clip.trim') || !this.#allows('clip.place')) return;
        void this.#send((clipId) => splitCommand(snapshot, [drag.rect.clipId], plan.frame, clipId), true);
        return;
      case 'copy':
        void this.#send((clipId) => copyCommand(snapshot, drag.ids, plan.delta, plan.lanes, clipId), true);
        return;
      case 'move':
        void this.#send(() => moveSelectionCommand(snapshot, drag.ids, plan.delta, plan.lanes));
        return;
      case 'trim':
        void this.#send(() => gestureCommand(snapshot, { kind: 'trim', clipId: drag.rect.clipId, edge: plan.edge, deltaFrames: plan.delta }));
        return;
    }
  }

  // What a clip drag ends in at its current pointer and modifiers.
  #plan(drag: Drag): Plan {
    const mods = toolModifiers(drag.flags, this.#platform());
    const snapshot = drag.snapshot;
    const view = this.#view;
    if (!this.#moved(drag)) {
      // Alt-click splits the clip there.
      if (mods.splitClick) return { kind: 'split', frame: this.#snapper(snapshot, false, [drag.rect.clipId])(xToFrame(drag.startX, view)) };
      return { kind: 'none' };
    }
    const edge = trimEdgeOf(drag.part);
    if (edge) {
      if (!this.#allows('clip.trim') || (edge === 'left' && !this.#allows('clip.move'))) return { kind: 'none' };
      const snap = this.#snapper(snapshot, mods.noSnap, [drag.rect.clipId]);
      const raw = deltaFrames(drag.dx, view);
      const start = BigInt(drag.rect.position);
      const at = edge === 'right' ? start + BigInt(drag.rect.length) : start;
      const target = snap(at + raw < 0n ? 0n : at + raw);
      return { kind: 'trim', edge, delta: target - at, guide: this.#snap.on && !mods.noSnap ? target : null };
    }
    const copy = mods.copy;
    if (copy ? !this.#allows('clip.place') : !this.#allows('clip.move')) return { kind: 'none' };
    let dx = drag.dx;
    let lanes = this.#lanesMoved(drag);
    if (mods.constrain) {
      const axis = constrainAxis(drag.dx, drag.dy);
      if (axis !== 'y') lanes = 0;
      if (axis !== 'x') dx = 0;
    }
    const start = BigInt(drag.rect.position);
    const move = moveSnapperFor(this.#snap, {
      framesPerPixel: view.framesPerPixel,
      tempo: snapshot.root?.tempo ?? [],
      sampleRate: snapshot.root?.sampleRate ?? 48000,
      atFrame: BigInt(view.scrollFrames),
      context: this.#snapContext(snapshot, copy ? [] : drag.ids),
    });
    const delta = dx === 0 ? 0n : move(start, BigInt(drag.rect.length), deltaFrames(dx, view));
    return { kind: copy ? 'copy' : 'move', delta, lanes, guide: this.#snap.on && dx !== 0 ? start + delta : null };
  }

  // The copies a drag of the repeat handle makes so far.
  #repeatCount(drag: Drag): number {
    if (!this.#moved(drag)) return 0;
    return repeatCountFromDrag(deltaFrames(drag.dx, this.#view), selectionLength(drag.snapshot, drag.ids));
  }

  // The rubber band's box in canvas pixels.
  #bandBox(band: BandDrag): Box {
    return { x: band.startX, y: band.startY, width: band.x - band.startX, height: band.y - band.startY };
  }

  // The lanes between the dragged clip's lane and the one under the pointer.
  #lanesMoved(drag: Drag): number {
    const order = drag.snapshot.trackOrder;
    const target = trackAt(drag.snapshot, drag.startY + drag.dy, this.#view);
    if (!target) return 0;
    return order.indexOf(target) - order.indexOf(drag.rect.trackId);
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

  // The upper half's gesture ends: a click (Ctrl-click, Alt-click, a click on
  // the band) or a drag (draw, move, adjust), each one edit or none.
  #locatorReleased(drag: LocatorDrag): void {
    const source = this.#options.locators;
    if (drag.moved) this.#invalidateContent();
    if (!source || !this.#bandEnabled()) return;
    if (drag.moved) {
      source.setLocators(drag.preview);
      return;
    }
    const mods = toolModifiers(drag.flags, this.#platform());
    const frame = this.#locatorGrid(drag.snapshot).snap(frameAt(drag.startX, this.#view));
    if (mods.constrain) {
      source.setLocators(setLeft(drag.range, frame));
      return;
    }
    if (drag.flags.altKey) {
      source.setLocators(setRight(drag.range, frame));
      return;
    }
    if (drag.hit !== 'outside') source.toggleCycle();
  }

  // The range a moved upper-half gesture would end in at x.
  #locatorPlan(drag: LocatorDrag, x: number): LocatorRange | null {
    const grid = this.#locatorGrid(drag.snapshot);
    const view = this.#view;
    const range = drag.range;
    if (!range || drag.hit === 'outside') return drawRange(frameAt(drag.startX, view), frameAt(x, view), grid);
    if (drag.hit === 'body') return moveRange(range, deltaFrames(x - drag.startX, view), grid);
    return dragEnd(range, drag.hit, frameAt(x, view), grid);
  }

  // Snap for the locators: the clips' grid, and one grid step (one pixel with
  // snap off) as the least gap between the ends.
  #locatorGrid(snapshot: Snapshot): LocatorGrid {
    const view = this.#view;
    const tempo = snapshot.root?.tempo ?? [];
    const rate = snapshot.root?.sampleRate ?? 48000;
    const settings = this.#snap;
    return {
      snap: this.#snapper(snapshot),
      minGap: (at) => (settings.on ? gridStepFrames(settings, view.framesPerPixel, tempo, rate, at) : BigInt(Math.max(1, Math.round(view.framesPerPixel)))),
    };
  }

  #bandEnabled(): boolean {
    return this.#options.locators?.enabled() ?? false;
  }

  // ---- the marker track (m5b-ui-markers)

  // The selected marker (null: none); a marker drops the clip selection.
  #selectMarker(markerId: string | null): void {
    if (markerId === this.#selectedMarker) return;
    this.#selectedMarker = markerId;
    if (markerId !== null && this.#state.selectedClipIds.length > 0) this.#select([], null);
    this.#invalidateContent();
  }

  // A press on the marker track: Alt-click adds a position marker there
  // (snapped); on a marker it selects it and begins its move (or, on a cycle
  // marker's edge, its resize); a Ctrl-press on empty space begins drawing a
  // cycle marker; a plain press on empty space drops the selection.
  #markerDown(e: PointerEvent, snapshot: Snapshot, x: number, y: number): void {
    const hit = markerHit(this.#markerShapes, x, y);
    if (!hit) return;
    const flags = this.#flags(e);
    const mods = toolModifiers(flags, this.#platform());
    if (flags.altKey && !flags.shiftKey) {
      const position = this.#snapper(snapshot)(frameAt(x, this.#view));
      void this.#send(() => addMarkerCommand(snapshot, position, (frame) => frame, newMarkerId()));
      return;
    }
    if (hit.part === 'empty') {
      if (!mods.noSnap) {
        this.#selectMarker(null);
        return;
      }
      this.#markerDrag = { kind: 'draw', markerId: null, startX: x, snapshot, newId: newMarkerId(), x, flags, moved: false };
      this.#capture(e);
      return;
    }
    this.#selectMarker(hit.markerId);
    const kind = hit.part === 'cycle-left' ? 'left' : hit.part === 'cycle-right' ? 'right' : 'move';
    this.#markerDrag = { kind, markerId: hit.markerId, startX: x, snapshot, newId: '', x, flags, moved: false };
    this.#capture(e);
  }

  // What a marker gesture sends at its current pointer and modifiers: snapped
  // (the dragged marker is no target of its own snap) unless Ctrl is held for
  // a move or a resize; a drawn cycle marker's ends always snap.
  #markerPlan(drag: MarkerDrag) {
    const snapshot = drag.snapshot;
    const view = this.#view;
    const mods = toolModifiers(drag.flags, this.#platform());
    if (drag.kind === 'draw') return addCycleCommand(snapshot, frameAt(drag.startX, view), frameAt(drag.x, view), this.#snapper(snapshot), drag.newId);
    const markerId = drag.markerId!;
    const snap = this.#snapper(snapshot, mods.noSnap, [markerId]);
    if (drag.kind === 'move') return moveMarkerCommand(snapshot, markerId, deltaFrames(drag.x - drag.startX, view), snap);
    const marker = snapshot.entities[`marker:${markerId}`] as MarkerEntity | undefined;
    if (!marker || marker.length === undefined) return null;
    const start = BigInt(marker.position);
    const at = drag.kind === 'left' ? start : start + BigInt(marker.length);
    return resizeCycleCommand(snapshot, markerId, drag.kind, at + deltaFrames(drag.x - drag.startX, view), snap);
  }

  // The markers to draw: the document's, with an open gesture's preview.
  #markersFor(snapshot: Snapshot): readonly MarkerEntity[] {
    const drag = this.#markerDrag;
    const command = drag?.moved ? this.#markerPlan(drag) : null;
    const c = command?.commands[0] as { op?: string; markerId?: string; position?: string; length?: string } | undefined;
    if (!c || typeof c.markerId !== 'string' || typeof c.position !== 'string') return snapshot.markers;
    if (c.op === 'marker.add') {
      const taken = new Set(snapshot.markers.filter((m) => m.length !== undefined).map((m) => m.number));
      let number = 1;
      while (taken.has(number)) number += 1;
      return [...snapshot.markers, { schema: 'siann.entity.marker.v1', id: c.markerId, number, name: '', position: c.position, ...(c.length ? { length: c.length } : {}) }];
    }
    return snapshot.markers.map((m) => (m.id === c.markerId ? { ...m, position: c.position!, ...(c.length ? { length: c.length } : {}) } : m));
  }

  // A double-click on a marker's name renames it in place; elsewhere on a
  // cycle marker it sets the locators to its range (one session.set_locators).
  #markerDoubleClick(snapshot: Snapshot, x: number, y: number): void {
    const hit = markerHit(this.#markerShapes, x, y);
    if (!hit || hit.part === 'empty') return;
    const marker = snapshot.entities[`marker:${hit.markerId}`] as MarkerEntity | undefined;
    if (!marker) return;
    if (hit.part === 'name') {
      this.#openRename(marker);
      return;
    }
    const range = locatorsOf(marker);
    const source = this.#options.locators;
    if (range && source && source.enabled()) source.setLocators(range);
  }

  // The rename field: an input over the marker's label (an app-only element,
  // shell.css .marker-rename). Enter sends one marker.rename; Escape and
  // leaving the field close it and send nothing.
  #openRename(marker: MarkerEntity): void {
    this.#closeRename();
    const shape = this.#markerShapes.find((s) => s.id === marker.id);
    const doc = (this.#container as { ownerDocument?: Document | null }).ownerDocument;
    if (!shape || !doc || typeof doc.createElement !== 'function' || !this.#allows('marker.rename')) return;
    const input = doc.createElement('input');
    input.type = 'text';
    input.classList.add('marker-rename');
    input.dataset.testid = 'marker-rename';
    input.value = marker.name;
    input.spellcheck = false;
    const words = this.#options.locale?.t() ?? translator('en');
    const named = marker.name === '' ? null : marker.name;
    const which =
      marker.length !== undefined
        ? named ? words('step.cycleMarkerNamed', { number: marker.number, name: named }) : words('step.cycleMarker', { number: marker.number })
        : named ? words('step.positionMarkerNamed', { number: marker.number, name: named }) : words('step.positionMarker', { number: marker.number });
    input.setAttribute('aria-label', words('markers.rename', { marker: which }));
    const left = Math.max(0, shape.label.x - RENAME_PAD);
    input.style.left = `${left}px`;
    input.style.width = `${Math.max(1, Math.min(this.#view.width - left, Math.max(shape.label.width + 2 * RENAME_PAD, RENAME_MIN_W)))}px`;
    const markerId = marker.id;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value;
      this.#closeRename();
      const snapshot = this.#options.model.getSnapshot();
      if (commit && snapshot) void this.#send(() => renameMarkerCommand(snapshot, markerId, name));
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(false));
    this.#container.appendChild(input);
    this.#rename = { markerId, input };
    input.focus();
    input.select();
  }

  #closeRename(): void {
    const open = this.#rename;
    if (!open) return;
    this.#rename = null;
    open.input.remove();
  }

  // draw()'s marker track: the --bg-info row, the divider at TOP - 1, then
  // each position marker (its 14 % tint, its 2 px bar, its label in its
  // colour mixed 25 % into --select), then each cycle marker (its range at
  // 14 %, a bar inside each end, its label); a selected marker's label in
  // --select; a moved or removed marker of the plan at 38 %, the plan's
  // marker steps over them in the agent violet with their step discs.
  #drawMarkers(ctx: CanvasRenderingContext2D, snapshot: Snapshot, palette: Palette, parts: SurfacePart[]): void {
    const view = this.#view;
    const ruler = view.rulerHeight;
    const top = lanesTopOf(view);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.bgInfo;
    ctx.fillRect(0, ruler, view.width, top - ruler);
    ctx.fillStyle = palette.divider;
    ctx.fillRect(0, top - 1, view.width, 1);
    ctx.beginPath();
    ctx.rect(0, ruler, view.width, top - ruler);
    ctx.clip();
    ctx.font = `${TOKENS['fw-strong']} ${TOKENS['fs-micro']} ${palette.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const measure = (text: string) => ctx.measureText(text).width;
    const shapes = markerShapes(this.#markersFor(snapshot), clipsEnd(snapshot), view, measure);
    this.#markerShapes = shapes;
    const ghosts = this.#ghosts.filter((g) => g.kind === 'marker-add' || g.kind === 'marker-move' || g.kind === 'marker-rename' || g.kind === 'marker-remove');
    const dimmed = new Set(ghosts.filter((g) => g.kind === 'marker-move' || g.kind === 'marker-remove').map((g) => (g as { markerId: string }).markerId));
    shapes.forEach((shape, index) => {
      const colour = palette.marker(shape.id);
      const alpha = dimmed.has(shape.id) ? MOVED_ORIGINAL_ALPHA : 1;
      const tint = shape.tint;
      if (tint) {
        ctx.globalAlpha = alpha * MARKER_TINT_ALPHA;
        ctx.fillStyle = colour;
        ctx.fillRect(tint.x, tint.y, tint.width, tint.height);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      const bars = shape.kind === 'position' ? [shape.bar] : [shape.left, shape.right];
      for (const bar of bars) ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      ctx.fillStyle = shape.id === this.#selectedMarker ? palette.select : mix(colour, palette.select, MARKER_LABEL_MIX);
      const room = shape.kind === 'cycle' ? Math.max(0, shape.x1 - shape.label.x) : undefined;
      if (room === undefined) ctx.fillText(shape.label.text, shape.label.x, shape.label.y);
      else if (room > 0) ctx.fillText(shape.label.text, shape.label.x, shape.label.y, room);
      const box = shape.kind === 'position' ? { ...shape.bar, width: shape.label.x + shape.label.width - shape.bar.x } : shape.tint;
      parts.push({ id: `marker-${index + 1}`, x: box.x, y: box.y, w: box.width, h: box.height });
    });
    ctx.globalAlpha = 1;
    this.#drawMarkerGhosts(ctx, ghosts, palette, parts);
    ctx.restore();
  }

  // The plan's marker steps (4.2): a flag (a position marker's bar at the
  // place it would get, its label after the step disc) or a range (a cycle
  // marker's, filled with the ghost body and outlined dashed), in the agent
  // violet, unbroken while the proposal is heard; a rename's new label; a
  // removed marker's flag struck through. Parts marker-ghost-add, -move,
  // -rename, -remove (numbered from the second of a kind).
  #drawMarkerGhosts(ctx: CanvasRenderingContext2D, ghosts: readonly Ghost[], palette: Palette, parts: SurfacePart[]): void {
    const view = this.#view;
    const counts = new Map<string, number>();
    const part = (name: string, box: Box) => {
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      parts.push({ id: n === 1 ? name : `${name}-${n}`, x: box.x, y: box.y, w: box.width, h: box.height });
    };
    const measure = (text: string) => ctx.measureText(text).width;
    for (const g of ghosts) {
      if (g.kind !== 'marker-add' && g.kind !== 'marker-move' && g.kind !== 'marker-rename' && g.kind !== 'marker-remove') continue;
      const place =
        g.kind === 'marker-add' ? { position: g.position, length: g.length }
        : g.kind === 'marker-move' ? g.after
        : { position: g.position, length: g.length };
      const name = g.kind === 'marker-rename' ? g.after : g.name;
      const x0 = frameToX(place.position, view);
      const stroke = ghostStroke(g.mode);
      let box: Box;
      if (place.length !== null) {
        const x1 = frameToX(BigInt(place.position) + BigInt(place.length), view);
        const shape = cycleBox(x0, x1);
        box = shape.tint;
        ctx.fillStyle = palette.aiBody;
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.fillStyle = palette.ai;
        ctx.fillRect(shape.left.x, shape.left.y, shape.left.width, shape.left.height);
        ctx.fillRect(shape.right.x, shape.right.y, shape.right.width, shape.right.height);
        ctx.setLineDash([...stroke.dash]);
        ctx.strokeStyle = palette.ai;
        ctx.lineWidth = GHOST_OUTLINE_W;
        ctx.strokeRect(box.x + OUTLINE_INSET, box.y + OUTLINE_INSET, box.width - 2 * OUTLINE_INSET, box.height - 2 * OUTLINE_INSET);
        ctx.setLineDash([]);
      } else {
        const { bar } = flagBox(x0, null);
        box = { ...bar, width: GHOST_LABEL_X + measure(markerLabel(g.number, name)) };
        ctx.fillStyle = palette.ai;
        ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      }
      // The step's disc right of the bar, then the label after it.
      if (g.step > 0) this.#drawStepDisc(ctx, { x: x0 + GHOST_DISC_X, y: box.y, width: 0, height: 0 }, g.step, palette);
      ctx.fillStyle = palette.ai;
      ctx.font = `${TOKENS['fw-strong']} ${TOKENS['fs-micro']} ${palette.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = labelBox(x0, markerLabel(g.number, name), measure);
      ctx.fillText(label.text, x0 + GHOST_LABEL_X, label.y);
      if (g.kind === 'marker-remove') {
        ctx.fillRect(box.x, box.y + box.height / 2, box.width, GHOST_OUTLINE_W);
      }
      this.#ghostBoxes.push({ step: g.step, box, pure: false, marker: true, ...(g.mode ? { mode: g.mode } : {}) });
      part(`marker-ghost-${g.kind.slice('marker-'.length)}`, box);
    }
  }

  // The range the band shows: an open drag's preview, else the document's.
  #bandRange(snapshot: Snapshot | null): LocatorRange | null {
    const drag = this.#locatorDrag;
    if (drag?.moved && drag.preview) return drag.preview;
    return rangeOf(snapshot?.locators);
  }

  #cancelDrag(): void {
    if (this.#locatorDrag?.moved || this.#markerDrag?.moved) this.#invalidateContent();
    this.#locatorDrag = null;
    this.#markerDrag = null;
    this.#drag = null;
    this.#band = null;
    this.#rulerDrag = null;
    this.#hideTooltip();
    this.#invalidateOverlay();
  }

  // One command.execute for a finished gesture or key command. already_exists
  // where new clip ids are placed is retried with new ids; anything else
  // refused is shown and the gesture discarded (never retried at a newer
  // revision). A command naming an op engine.capabilities does not list is
  // not sent.
  async #send(build: (clipId: () => string) => TimelineCommand | null, placesClips = false): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const command = build(newClipId);
      if (!command) return;
      if (!command.commands.every((c) => this.#allows(String((c as { op?: unknown }).op)))) return;
      try {
        await this.#options.execute(command.commands, command.expectedRevision);
        this.#update({ error: null });
        return;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (placesClips && code === 'already_exists' && attempt < PLACE_ATTEMPTS) continue;
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

  // A clip as the open drag shows it (a preview; the document is unchanged):
  // moved or copied by the plan's delta and lanes, or resized.
  #preview(rect: ClipRect, snapshot: Snapshot, plan: Plan, drag: Drag): ClipRect {
    const view = this.#view;
    if (plan.kind === 'move' || plan.kind === 'copy') {
      if (!drag.ids.includes(rect.clipId)) return rect;
      const lane = snapshot.trackOrder.indexOf(rect.trackId);
      const trackId = snapshot.trackOrder[lane + plan.lanes] ?? rect.trackId;
      const position = snapMove(rect.position, plan.delta);
      const laneIndex = Math.max(0, snapshot.trackOrder.indexOf(trackId));
      return {
        ...rect,
        trackId,
        position,
        x: frameToX(position, view),
        y: laneTops(snapshot.trackOrder, view)[laneIndex] ?? rect.y,
        height: laneHeightOf(trackId, view),
      };
    }
    if (plan.kind !== 'trim' || rect.clipId !== drag.rect.clipId) return rect;
    const clip = snapshot.entities[`clip:${rect.clipId}`];
    const media = snapshot.entities[`media:${rect.mediaId}`] as MediaEntity | undefined;
    if (!clip || clip.schema !== 'siann.entity.clip.v1' || !media) return rect;
    const trimmed = snapTrim(clip, media.frames, plan.edge, plan.delta);
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
      bg2: read('--bg-2'),
      bgWell: read('--bg-well'),
      laneEven: read('--lane-even'),
      laneOdd: read('--lane-odd'),
      beatLine: read('--white-a026'),
      barLine: read('--white-a060'),
      barLine4: read('--white-a110'),
      divider: read('--divider'),
      rulerUpper: read('--ruler-upper'),
      rulerLine: read('--white-a050'),
      rulerMajor: read('--ruler-major'),
      rulerMinor: read('--ruler-minor'),
      rulerQuarter: read('--button-line'),
      lit1: read('--lit-1'),
      tx1: read('--tx-1'),
      tx3: read('--tx-3'),
      select: read('--select'),
      clipOutline: read('--black-a550'),
      cursorGlow: read('--white-a070'),
      gainLine: read('--white-a700'),
      font: read('--font-ui') || 'sans-serif',
      bandFill: read('--tx-1-a200'),
      bandLine: read('--tx-1'),
      bandLabel: read('--lit-1'),
      bandOffFill: read('--white-a060'),
      bandOff: read('--tx-3'),
      bandTint: read('--white-a028'),
      rec: read('--rec'),
      recBody: read('--err-a140'),
      recWave: read('--rec-line'),
      ai: read('--ai'),
      aiBody: read('--ai-a100'),
      aiHatch: read('--ai-a160'),
      aiTitle: read('--ai-a300'),
      aiWaveOuter: read('--ai-2-a550'),
      aiWaveInner: read('--ai-wave-a900'),
      aiTitleText: read('--ai-title'),
      aiInk: read('--ai-ink'),
      aiLane: read('--ai-a070'),
      fadeShade: read('--bg-0-a550'),
      bgInfo: read('--bg-info'),
      marker: (markerId) => read(markerColourVar(markerId)),
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

  // draw(), in its order: the lanes, the locator range's tint, the beat and
  // bar lines, the lane dividers (all below the marker row, under which the
  // lanes scroll), the ruler's two halves, the marker row (empty with the
  // marker track off), the clips.
  #drawContent(): void {
    this.#contentDraws += 1;
    const snapshot = this.#options.model.getSnapshot();
    const order = snapshot?.trackOrder ?? [];
    // The plan's ghosts, as the source gives them now (m5b-ui-ghosts).
    const ghosts = snapshot ? (this.#options.ghosts?.ghosts() ?? []) : [];
    this.#ghosts = ghosts;
    const adds = ghosts.filter((g): g is Extract<Ghost, { kind: 'track-add' }> => g.kind === 'track-add');
    this.#ghostLanes = adds.length;
    // The scroll stays inside the lanes (the proposed ones too) when tracks go or shrink.
    const limit = maxScrollY(this.#view, lanesHeight(order, this.#view) + adds.length * this.#view.laneHeight);
    if ((this.#view.scrollY ?? 0) > limit) this.#view = { ...this.#view, scrollY: limit };
    const view = this.#view;
    for (const listener of [...this.#viewListeners]) listener();
    this.#rects = snapshot ? clipRects(snapshot, view) : [];
    const columns = new Map<string, PeakColumns>();
    const waves = new Map<string, number[]>();
    const titles = new Map<string, string>();
    const dimmed = dimmedTracks(snapshot?.tracks ?? []);
    this.#dimmed = order.filter((id) => dimmed.has(id));
    const words = this.#options.locale?.t() ?? translator('en');
    this.#guidance = snapshot && order.length === 0 ? words('timeline.empty') : null;
    const width = view.width;
    const height = view.height ?? 0;
    const top = lanesTopOf(view);
    const tops = laneTops(order, view);
    // The parts the fidelity run reads (window.__fidelity in the mockup).
    const parts: SurfacePart[] = [
      { id: 'ruler-upper', x: 0, y: 0, w: width, h: RULER_UPPER },
      { id: 'ruler-lower', x: 0, y: RULER_UPPER, w: width, h: view.rulerHeight - RULER_UPPER },
    ];
    // The marker track's row (m5b-ui-markers), as draw()'s fp('marker-track', 0, RULER, W, MK).
    const markersOn = snapshot !== null && this.#markersOn();
    if (markersOn) parts.push({ id: 'marker-track', x: 0, y: view.rulerHeight, w: width, h: top - view.rulerHeight });
    else this.#markerShapes = [];
    order.forEach((trackId, index) => parts.push({ id: `lane-${index + 1}`, x: 0, y: tops[index]!, w: width, h: laneHeightOf(trackId, view) }));
    const ghostLanes = ghostLaneRects(order, adds.map((g) => g.key), view);
    ghostLanes.forEach((lane) => parts.push({ id: `lane-${lane.key}`, x: lane.x, y: lane.y, w: lane.width, h: lane.height }));
    const lanesOf = new Map<string, { top: number; height: number }>(order.map((id, i) => [id, { top: tops[i]!, height: laneHeightOf(id, view) }]));
    adds.forEach((g, i) => lanesOf.set(g.trackId, { top: ghostLanes[i]!.y, height: ghostLanes[i]!.height }));
    const ghostDraw = snapshot ? this.#ghostShapes(ghosts, lanesOf, view, snapshot, parts) : { shapes: [], originals: new Map<string, number>(), outlined: new Set<string>(), removed: new Map<string, { step: number; mode?: 'solid' }>(), lanesRemoved: [], fades: [] as FadeGhostShape[] };
    const masks: Array<Omit<SurfacePart, 'id'>> = [];
    this.#rects.forEach((rect, index) => {
      const box = clipBox(rect);
      parts.push({ id: `clip-${index + 1}`, x: box.x, y: box.y, w: box.width, h: box.height });
      masks.push({ x: box.x, y: box.y + CLIP_TITLE_HEIGHT, w: box.width, h: Math.max(0, box.height - CLIP_TITLE_HEIGHT) });
      if (snapshot) titles.set(rect.clipId, clipTitle(snapshot, rect));
    });
    this.#contentParts = parts;
    this.#masks = masks;
    this.#titles = titles;
    const selected = new Set(this.#state.selectedClipIds);
    this.#outline = this.#rects.some((r) => selected.has(r.clipId) && r.x < width && r.x + r.width > 0) ? SELECTED_OUTLINE_W : 0;
    const ctx = this.#context(this.#content);
    if (!ctx) {
      this.#columns = columns;
      this.#waves = waves;
      this.#locatorBand = null;
      return;
    }
    const palette = this.#palette();
    ctx.globalAlpha = 1;
    if (snapshot) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, width, Math.max(0, height - top));
      ctx.clip();
      order.forEach((trackId, index) => {
        const laneTop = tops[index]!;
        const laneHeight = laneHeightOf(trackId, view);
        if (laneTop + laneHeight < top || laneTop > height) return;
        ctx.fillStyle = index % 2 ? palette.laneOdd : palette.laneEven;
        ctx.fillRect(0, laneTop, width, laneHeight);
      });
      ghostLanes.forEach((lane, i) => {
        ctx.fillStyle = (order.length + i) % 2 ? palette.laneOdd : palette.laneEven;
        ctx.fillRect(lane.x, lane.y, lane.width, lane.height);
      });
      const band = this.#bandEnabled() ? this.#bandRange(snapshot) : null;
      if (band) {
        // The locator range's tint over the lanes, under the clips.
        const x0 = frameToX(band.left, view);
        ctx.fillStyle = palette.bandTint;
        ctx.fillRect(x0, top, frameToX(band.right, view) - x0, height - top);
      }
      // The beat lines, then the bar lines over them (--white-a110 every fourth bar).
      const grid = gridMarks(view, snapshot.root?.tempo ?? [], snapshot.root?.sampleRate ?? 48000);
      ctx.fillStyle = palette.beatLine;
      for (const mark of grid) if (mark.kind !== 'bar') ctx.fillRect(Math.round(mark.x), top, 1, height - top);
      for (const mark of grid) {
        if (mark.kind !== 'bar') continue;
        ctx.fillStyle = (barOf(mark) - 1) % BARS_PER_MAJOR === 0 ? palette.barLine4 : palette.barLine;
        ctx.fillRect(Math.round(mark.x), top, 1, height - top);
      }
      ctx.fillStyle = palette.divider;
      order.forEach((trackId, index) => ctx.fillRect(0, tops[index]! + laneHeightOf(trackId, view) - 1, width, 1));
      this.#drawGhostLanes(ctx, ghostLanes, adds.map((g) => g.mode), palette);
      this.#drawRemovedLanes(ctx, ghostDraw.lanesRemoved, palette);
      ctx.restore();
    }
    this.#drawRuler(ctx, snapshot, palette);
    if (snapshot && markersOn) this.#drawMarkers(ctx, snapshot, palette, parts);
    if (snapshot) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, width, Math.max(0, height - top));
      ctx.clip();
      for (const rect of this.#rects) {
        if (rect.x > width || rect.x + rect.width < 0 || rect.y > height || rect.y + rect.height < top) continue;
        if (ghostDraw.outlined.has(rect.clipId)) {
          // Heard: the original of a moved or trimmed clip is main's place, as a faint outline.
          this.#drawReplacedClip(ctx, clipBox(rect), palette);
          columns.set(rect.clipId, { drawn: 0, nonZero: 0, outline: true });
          waves.set(rect.clipId, []);
          continue;
        }
        const ghostOriginal = ghostDraw.originals.has(rect.clipId) || ghostDraw.removed.has(rect.clipId);
        const drawn = this.#drawClip(ctx, snapshot, rect, palette, selected.has(rect.clipId), dimmed.has(rect.trackId), titles.get(rect.clipId) ?? rect.mediaId, ghostOriginal ? MOVED_ORIGINAL_ALPHA : undefined);
        columns.set(rect.clipId, { drawn: drawn.length, nonZero: drawn.filter((c) => c.amplitude > 0).length });
        waves.set(rect.clipId, drawn.map((c) => c.outer));
        const removal = ghostDraw.removed.get(rect.clipId);
        if (removal !== undefined) this.#drawRemoved(ctx, clipBox(rect), removal.step, removal.mode, palette);
      }
      for (const shape of ghostDraw.shapes) this.#drawGhostShape(ctx, snapshot, shape, palette);
      for (const shape of ghostDraw.fades) this.#drawFadeGhost(ctx, shape, palette);
      ctx.restore();
      ctx.globalAlpha = 1;
      if (this.#guidance) {
        ctx.fillStyle = palette.tx3;
        ctx.font = `${TOKENS['fs-body']} ${palette.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(this.#guidance, width / 2, top + Math.max(RULER_HEIGHT, (height - top) / 2));
        ctx.textAlign = 'left';
      }
    }
    this.#columns = columns;
    this.#waves = waves;
    // Cold start (UI redesign 5.6): the first frame that paints a session's clips.
    if (this.#rects.length > 0) frameMarks().sessionPainted();
  }

  // The ruler as draw() draws it: the upper half (the locators': the band),
  // a line, the lower half with a tick per bar (a tall one every fourth),
  // quarter ticks and the labels, and the divider under it. The marker track
  // row below is left empty.
  #drawRuler(ctx: CanvasRenderingContext2D, snapshot: Snapshot | null, palette: Palette): void {
    const view = this.#view;
    const ru = RULER_UPPER;
    const ruler = view.rulerHeight;
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.rulerUpper;
    ctx.fillRect(0, 0, view.width, ru);
    this.#locatorBand = null;
    if (snapshot) this.#drawBand(ctx, snapshot, palette);
    for (const shape of this.#ghostBoxes) if (shape.ruler) this.#drawGhostBand(ctx, shape, palette);
    ctx.fillStyle = palette.rulerLine;
    ctx.fillRect(0, ru, view.width, 1);
    ctx.fillStyle = palette.bg2;
    ctx.fillRect(0, ru + 1, view.width, ruler - ru - 1);
    const labels: string[] = [];
    if (snapshot) {
      const tempo = snapshot.root?.tempo ?? [];
      const rate = snapshot.root?.sampleRate ?? 48000;
      for (const mark of gridMarks(view, tempo, rate)) {
        const x = Math.round(mark.x);
        if (mark.kind === 'bar') {
          const major = (barOf(mark) - 1) % BARS_PER_MAJOR === 0;
          ctx.fillStyle = major ? palette.rulerMajor : palette.rulerMinor;
          ctx.fillRect(x, major ? ru + MAJOR_TICK_TOP : ruler - MINOR_TICK, 1, major ? ruler - ru - MAJOR_TICK_TOP : MINOR_TICK);
        } else {
          ctx.fillStyle = palette.rulerQuarter;
          ctx.fillRect(x, ruler - QUARTER_TICK, 1, QUARTER_TICK);
        }
      }
      ctx.font = `${TOKENS['fw-ui']} ${TOKENS['fs-micro']} ${palette.font}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (const mark of rulerMarks(view, tempo, rate)) {
        ctx.fillStyle = mark.kind === 'bar' && (barOf(mark) - 1) % BARS_PER_MAJOR === 0 ? palette.lit1 : palette.tx3;
        ctx.fillText(mark.label, Math.round(mark.x) + LABEL_X, ru + LABEL_Y);
        labels.push(mark.label);
      }
    }
    ctx.fillStyle = palette.divider;
    ctx.fillRect(0, ruler - 1, view.width, 1);
    this.#rulerLabels = labels;
  }

  // The locator band in the upper half, as the mockup draws it: the range
  // filled, a top line, the L and R flags and labels; light with cycle on,
  // grey with it off. Nothing without the source or without locators.
  #drawBand(ctx: CanvasRenderingContext2D, snapshot: Snapshot, palette: Palette): void {
    const source = this.#options.locators;
    const range = source && source.enabled() ? this.#bandRange(snapshot) : null;
    const rect = bandRect(range, this.#view);
    if (!source || !range || !rect) return;
    const cycle = source.cycle();
    const line = cycle ? palette.bandLine : palette.bandOff;
    const x0 = rect.x;
    const x1 = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    ctx.fillStyle = cycle ? palette.bandFill : palette.bandOffFill;
    ctx.fillRect(x0, rect.y, rect.width, rect.height);
    ctx.fillStyle = line;
    ctx.fillRect(x0, rect.y, rect.width, BAND_LINE);
    ctx.beginPath();
    ctx.moveTo(x0, rect.y);
    ctx.lineTo(x0 + FLAG_W, rect.y);
    ctx.lineTo(x0, bottom);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x1, rect.y);
    ctx.lineTo(x1 - FLAG_W, rect.y);
    ctx.lineTo(x1, bottom);
    ctx.fill();
    ctx.font = `${TOKENS['fw-bold']} ${TOKENS['fs-8h']} ${palette.font}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cycle ? palette.bandLabel : palette.bandOff;
    const middle = rect.y + rect.height / 2 + 1;
    ctx.fillText('L', x0 + LABEL_INSET, middle);
    ctx.textAlign = 'right';
    ctx.fillText('R', x1 - LABEL_INSET, middle);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    this.#locatorBand = { ...rect, cycle, left: range.left.toString(), right: range.right.toString() };
  }

  // draw()'s clip(): the rounded body, then inside it the title strip, the
  // waveform in two tones and the title, then the outline; a selected clip in
  // its selected palette with its two lower corner squares; a dimmed track's
  // clip at 50 %. Returns the waveform's columns.
  #drawClip(ctx: CanvasRenderingContext2D, snapshot: Snapshot, rect: ClipRect, palette: Palette, selected: boolean, dimmed: boolean, title: string, override?: number): WaveColumn[] {
    const box = clipBox(rect);
    const tones = clipPalette(palette.track(rect.trackId), { bgWell: palette.bgWell, select: palette.select, outline: palette.clipOutline }, selected);
    // The original of a moved, trimmed or removed clip: draw()'s 38 % (m5b-ui-ghosts).
    const alpha = override ?? (dimmed ? CLIP_DIMMED_ALPHA : 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
    ctx.fillStyle = tones.body;
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
    ctx.clip();
    const strip = titleStrip(box);
    ctx.fillStyle = tones.title;
    ctx.fillRect(strip.x, strip.y, strip.width, strip.height);
    const columns = this.#drawWaveform(ctx, snapshot, rect, box, tones, alpha);
    // The fades (m5b-ui-fades): draw()'s shade and curve, at the real length.
    for (const side of FADE_SIDES) {
      const fade = rect[side];
      if (fade) this.#drawFade(ctx, box, side, fadePx(fade.length, this.#view.framesPerPixel), fade.curve, palette);
    }
    ctx.font = `${TOKENS['fw-strong']} ${TOKENS['fs-micro']} ${palette.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = tones.titleText;
    if (box.width > TITLE_MIN_W) {
      // The title stays in view when the clip begins left of the canvas.
      const x = Math.max(box.x, 0) + TITLE_X;
      ctx.fillText(title, x, box.y + TITLE_Y, Math.max(0, box.x + box.width - x - TITLE_X));
    }
    ctx.restore();
    ctx.beginPath();
    const inset = selected ? SELECTED_OUTLINE_INSET : OUTLINE_INSET;
    ctx.roundRect(box.x + inset, box.y + inset, box.width - 2 * inset, box.height - 2 * inset, box.radius);
    ctx.strokeStyle = tones.outline;
    ctx.lineWidth = tones.outlineWidth;
    ctx.stroke();
    if (selected) {
      ctx.fillStyle = palette.select;
      for (const corner of cornerHandles(box)) ctx.fillRect(corner.x, corner.y, corner.width, corner.height);
      // draw()'s repeat handle: a disc on the right border (m5b-ui-edit-more).
      const handle = repeatHandle(box);
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, handle.radius, 0, 2 * Math.PI);
      ctx.fill();
      // draw()'s fade triangles at the fades' ends (m5b-ui-fades).
      if (this.#fadesOn()) this.#drawFadeHandles(ctx, box, rect, palette);
    }
    ctx.restore();
    return columns;
  }

  // One side's fade as draw() draws it: the --bg-0-a550 shade between the
  // curve and the top edge below the title strip, then the curve as a 1 px
  // --select line, at `px` (the real length) on the real gain curve.
  #drawFade(ctx: CanvasRenderingContext2D, box: Box, side: FadeSide, px: number, curve: FadeCurve, palette: Palette): void {
    if (!(px > 0)) return;
    const shade = fadeShadePoints(box, side, px, curve);
    ctx.fillStyle = palette.fadeShade;
    ctx.beginPath();
    shade.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = palette.select;
    ctx.lineWidth = 1;
    ctx.beginPath();
    fadeCurvePoints(box, side, px, curve).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }

  // The two handles of a clip: draw()'s 8 x 6 px --select triangles, the fades'
  // lengths given (a held drag's preview), else the clip's.
  #drawFadeHandles(ctx: CanvasRenderingContext2D, box: Box, fades: { readonly fadeIn?: ClipFade; readonly fadeOut?: ClipFade }, palette: Palette): void {
    const handles = fadeHandles(box, fades, this.#view.framesPerPixel);
    ctx.fillStyle = palette.select;
    for (const side of FADE_SIDES) {
      const [a, b, c] = handles[side].points;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Where each ghost of the frame goes (m5b-ui-ghosts): the shapes to draw
  // over the clips, the originals drawn at 38 % and the removed clips, by
  // clip id with their step; their boxes for the outline, the hit test and
  // reveal; their parts for the fidelity run.
  #ghostShapes(ghosts: readonly Ghost[], lanes: ReadonlyMap<string, { top: number; height: number }>, view: Viewport, snapshot: Snapshot, parts: SurfacePart[]) {
    const shapes: GhostShape[] = [];
    const originals = new Map<string, number>();
    // The originals drawn as main's faint outline while the proposal is heard.
    const outlined = new Set<string>();
    const removed = new Map<string, { step: number; mode?: 'solid' }>();
    const lanesRemoved: Array<{ step: number; box: Box; mode?: 'solid' }> = [];
    const fades: FadeGhostShape[] = [];
    const boxes: GhostBox[] = [];
    const rows: Array<{ step: number; top: number; height: number }> = [];
    const counts = new Map<string, number>();
    const part = (name: string, box: Box) => {
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      parts.push({ id: n === 1 ? name : `${name}-${n}`, x: box.x, y: box.y, w: box.width, h: box.height });
    };
    const original = (clipId: string) => this.#rects.find((r) => r.clipId === clipId);
    for (const g of ghosts) {
      switch (g.kind) {
        case 'track-add': {
          const lane = lanes.get(g.trackId);
          if (lane) boxes.push({ step: g.step, box: { x: 0, y: lane.top, width: view.width, height: lane.height }, pure: true });
          break;
        }
        case 'clip-place':
        case 'clip-move':
        case 'clip-trim': {
          const lane = lanes.get(g.trackId);
          if (!lane) break;
          const length = g.kind === 'clip-trim' ? g.to.length : g.length;
          const sourceStart = g.kind === 'clip-trim' ? g.to.sourceStart : g.sourceStart;
          const box = ghostClipBox(lane.top, lane.height, g.position, length, view);
          const rect: ClipRect = { clipId: g.clipId, trackId: g.trackId, mediaId: g.mediaId, position: g.position, sourceStart, length, x: box.x - 1, y: lane.top, width: box.width + 2, height: lane.height };
          const from = g.kind === 'clip-place' ? undefined : original(g.clipId);
          if (from) {
            originals.set(g.clipId, g.step);
            if (g.mode === 'solid') outlined.add(g.clipId);
            boxes.push({ step: g.step, box: clipBox(from), pure: false, clipId: g.clipId });
          }
          shapes.push({ step: g.step, box, rect, title: clipTitle(snapshot, g), arrow: g.kind === 'clip-move' && from ? arrowOf(clipBox(from), box) : null, ...(g.mode ? { mode: g.mode } : {}) });
          boxes.push({ step: g.step, box, pure: true });
          part(g.kind === 'clip-place' ? 'clip-ghost-new' : g.kind === 'clip-move' ? 'clip-ghost-move' : 'clip-ghost-trim', box);
          break;
        }
        case 'track-remove': {
          // The removed track's lane (4.2: "cross-hatched in violet"), under its clips.
          const lane = lanes.get(g.trackId);
          if (!lane) break;
          const box = { x: 0, y: lane.top, width: view.width, height: lane.height };
          lanesRemoved.push({ step: g.step, box, ...(g.mode ? { mode: g.mode } : {}) });
          boxes.push({ step: g.step, box, pure: false });
          part('lane-ghost-remove', box);
          break;
        }
        case 'clip-remove': {
          const from = original(g.clipId);
          if (!from) break;
          removed.set(g.clipId, { step: g.step, ...(g.mode ? { mode: g.mode } : {}) });
          const box = clipBox(from);
          boxes.push({ step: g.step, box, pure: false, clipId: g.clipId });
          part('clip-ghost-remove', box);
          break;
        }
        case 'locators': {
          const band = locatorGhostRect({ left: BigInt(g.after.left), right: BigInt(g.after.right) }, view);
          if (!band) break;
          boxes.push({ step: g.step, box: band, pure: false, ruler: true, ...(g.mode ? { mode: g.mode } : {}) });
          part('locator-band-ghost', band);
          break;
        }
        case 'fade': {
          // m5b-ui-fades (4.2): on the clip's box as the ticked steps before it leave it.
          const lane = lanes.get(g.trackId);
          if (!lane) break;
          const box = ghostClipBox(lane.top, lane.height, g.position, g.length, view);
          fades.push({ box, ghost: g });
          boxes.push({ step: g.step, box, pure: false });
          break;
        }
        case 'gain':
        case 'pan':
        case 'mute':
        case 'solo':
        case 'rename': {
          // Drawn on the header and the strip; the lane is where reveal scrolls.
          const lane = lanes.get(g.trackId);
          if (lane) rows.push({ step: g.step, top: lane.top, height: lane.height });
          break;
        }
        default:
          break;
      }
    }
    this.#ghostBoxes = boxes;
    this.#ghostRows = rows;
    return { shapes, originals, outlined, removed, lanesRemoved, fades };
  }

  // A fade ghost (m5b-ui-fades; UI redesign 4.2, 4.3): each side the step
  // changes, its proposed curve as a dashed --ai line at the proposed length
  // and curve; a side set to 0 shows its current curve's shade cross-hatched
  // in violet; the step's disc. While the proposal is heard (solid): the line
  // unbroken and the removed side's shade the ghost body, unhatched.
  #drawFadeGhost(ctx: CanvasRenderingContext2D, shape: FadeGhostShape, palette: Palette): void {
    const { box, ghost } = shape;
    const stroke = ghostStroke(ghost.mode);
    const fpp = this.#view.framesPerPixel;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
    ctx.clip();
    for (const side of FADE_SIDES) {
      const before = ghost.before[side];
      const after = ghost.after[side];
      if (before?.length === after?.length && before?.curve === after?.curve) continue;
      if (after) {
        ctx.setLineDash([...stroke.dash]);
        ctx.strokeStyle = palette.ai;
        ctx.lineWidth = GHOST_OUTLINE_W;
        ctx.beginPath();
        fadeCurvePoints(box, side, fadePx(after.length, fpp), after.curve).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (before) {
        ctx.save();
        ctx.beginPath();
        fadeShadePoints(box, side, fadePx(before.length, fpp), before.curve).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        if (!stroke.hatch) {
          ctx.fillStyle = palette.aiBody;
          ctx.fill();
        } else {
          ctx.clip();
          ctx.strokeStyle = palette.aiHatch;
          ctx.lineWidth = GHOST_HATCH_WIDTH;
          for (let k = -box.height; k < box.width + box.height; k += GHOST_HATCH_PITCH) {
            ctx.beginPath();
            ctx.moveTo(box.x + k, box.y + box.height);
            ctx.lineTo(box.x + k + box.height, box.y);
            ctx.moveTo(box.x + k, box.y);
            ctx.lineTo(box.x + k + box.height, box.y + box.height);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
    if (ghost.step > 0) this.#drawStepDisc(ctx, box, ghost.step, palette);
    ctx.restore();
  }

  // A removed track's lane: the proposed lane's hatch, crossed, and its step
  // disc at the lane's start (its clips are drawn over it, each dimmed and
  // cross-hatched with its own disc). While the proposal is heard (solid):
  // the ghost body over the lane, unhatched, with its disc.
  #drawRemovedLanes(ctx: CanvasRenderingContext2D, lanes: ReadonlyArray<{ step: number; box: Box; mode?: 'solid' }>, palette: Palette): void {
    for (const { step, box, mode } of lanes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.width, box.height - 1);
      ctx.clip();
      if (!ghostStroke(mode).hatch) {
        ctx.fillStyle = palette.aiBody;
        ctx.fillRect(box.x, box.y, box.width, box.height - 1);
        this.#drawStepDisc(ctx, box, step, palette);
        ctx.restore();
        continue;
      }
      ctx.strokeStyle = palette.aiLane;
      ctx.lineWidth = LANE_HATCH_WIDTH;
      for (let x = -box.height; x < box.width + box.height; x += LANE_HATCH_PITCH) {
        ctx.beginPath();
        ctx.moveTo(x, box.y + box.height);
        ctx.lineTo(x + box.height, box.y);
        ctx.moveTo(x, box.y);
        ctx.lineTo(x + box.height, box.y + box.height);
        ctx.stroke();
      }
      this.#drawStepDisc(ctx, box, step, palette);
      ctx.restore();
    }
  }

  // A proposed track's lane: draw()'s hatch over the lane, clipped to it;
  // while the proposal is heard (solid), the ghost body, unhatched.
  #drawGhostLanes(ctx: CanvasRenderingContext2D, lanes: readonly GhostLane[], modes: ReadonlyArray<'solid' | undefined>, palette: Palette): void {
    lanes.forEach((lane, index) => {
      ctx.fillStyle = palette.divider;
      ctx.fillRect(0, lane.y + lane.height - 1, lane.width, 1);
      if (!ghostStroke(modes[index]).hatch) {
        ctx.fillStyle = palette.aiBody;
        ctx.fillRect(lane.x, lane.y, lane.width, lane.height - 1);
        return;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(lane.x, lane.y, lane.width, lane.height - 1);
      ctx.clip();
      ctx.strokeStyle = palette.aiLane;
      ctx.lineWidth = LANE_HATCH_WIDTH;
      for (let x = -lane.height; x < lane.width; x += LANE_HATCH_PITCH) {
        ctx.beginPath();
        ctx.moveTo(x, lane.y + lane.height);
        ctx.lineTo(x + lane.height, lane.y);
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // draw()'s clip() for a ghost: the violet body hatched, the title strip,
  // the waveform from the media's peaks, the step disc and the title, the
  // dashed outline; and a moved clip's arrow from its original.
  #drawGhostShape(ctx: CanvasRenderingContext2D, snapshot: Snapshot, shape: GhostShape, palette: Palette): void {
    const { box } = shape;
    const stroke = ghostStroke(shape.mode);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
    ctx.fillStyle = palette.aiBody;
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
    ctx.clip();
    if (stroke.hatch) {
      ctx.strokeStyle = palette.aiHatch;
      ctx.lineWidth = GHOST_HATCH_WIDTH;
      for (let k = -box.height; k < box.width; k += GHOST_HATCH_PITCH) {
        ctx.beginPath();
        ctx.moveTo(box.x + k, box.y + box.height);
        ctx.lineTo(box.x + k + box.height, box.y);
        ctx.stroke();
      }
    }
    const strip = titleStrip(box);
    ctx.fillStyle = palette.aiTitle;
    ctx.fillRect(strip.x, strip.y, strip.width, strip.height);
    const tones: ClipPalette = { body: palette.aiBody, title: palette.aiTitle, titleText: palette.aiTitleText, waveOuter: palette.aiWaveOuter, waveOuterAlpha: 1, waveInner: palette.aiWaveInner, outline: palette.ai, outlineWidth: GHOST_OUTLINE_W };
    this.#drawWaveform(ctx, snapshot, shape.rect, box, tones, 1);
    if (shape.step > 0) this.#drawStepDisc(ctx, box, shape.step, palette);
    ctx.font = `${TOKENS['fw-strong']} ${TOKENS['fs-micro']} ${palette.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = palette.aiTitleText;
    if (box.width > TITLE_MIN_W) {
      const x = box.x + STEP_DISC.titleX;
      ctx.fillText(shape.title, x, box.y + TITLE_Y, Math.max(0, box.x + box.width - x - TITLE_X));
    }
    ctx.restore();
    ctx.setLineDash([...stroke.dash]);
    ctx.strokeStyle = palette.ai;
    ctx.lineWidth = GHOST_OUTLINE_W;
    ctx.beginPath();
    ctx.roundRect(box.x + OUTLINE_INSET, box.y + OUTLINE_INSET, box.width - 2 * OUTLINE_INSET, box.height - 2 * OUTLINE_INSET, box.radius);
    ctx.stroke();
    ctx.setLineDash([]);
    if (shape.arrow) {
      const { x0, y0, x1, y1 } = shape.arrow;
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const back = (d: number, side: number) => [x1 - d * Math.cos(angle) - side * Math.sin(angle), y1 - d * Math.sin(angle) + side * Math.cos(angle)] as const;
      ctx.strokeStyle = palette.ai;
      ctx.fillStyle = palette.ai;
      ctx.lineWidth = ARROW.width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(...back(ARROW.head - 2, 0));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(...back(ARROW.head, -ARROW.half));
      ctx.lineTo(...back(ARROW.head, ARROW.half));
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x0, y0, ARROW.dot, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  // A removed clip over its original at 38 %: cross-hatched in violet, dashed,
  // with its step; while the proposal is heard (solid), the ghost body,
  // unhatched, with an unbroken outline.
  #drawRemoved(ctx: CanvasRenderingContext2D, box: Box & { readonly radius: number }, step: number, mode: 'solid' | undefined, palette: Palette): void {
    const stroke = ghostStroke(mode);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
    if (!stroke.hatch) {
      ctx.fillStyle = palette.aiBody;
      ctx.fill();
    }
    ctx.clip();
    if (stroke.hatch) {
      ctx.strokeStyle = palette.aiHatch;
      ctx.lineWidth = GHOST_HATCH_WIDTH;
      for (let k = -box.height; k < box.width + box.height; k += GHOST_HATCH_PITCH) {
        ctx.beginPath();
        ctx.moveTo(box.x + k, box.y + box.height);
        ctx.lineTo(box.x + k + box.height, box.y);
        ctx.moveTo(box.x + k, box.y);
        ctx.lineTo(box.x + k + box.height, box.y + box.height);
        ctx.stroke();
      }
    }
    this.#drawStepDisc(ctx, box, step, palette);
    ctx.restore();
    ctx.save();
    ctx.setLineDash([...stroke.dash]);
    ctx.strokeStyle = palette.ai;
    ctx.lineWidth = GHOST_OUTLINE_W;
    ctx.beginPath();
    ctx.roundRect(box.x + OUTLINE_INSET, box.y + OUTLINE_INSET, box.width - 2 * OUTLINE_INSET, box.height - 2 * OUTLINE_INSET, box.radius);
    ctx.stroke();
    ctx.restore();
  }

  // Heard (m5b-ui-audition; UI redesign 4.3): the original of a moved or
  // trimmed clip is the value its ghost replaces, main's place, drawn as a
  // faint outline (--ai-a300, as the strip's replaced cap) with nothing in it.
  #drawReplacedClip(ctx: CanvasRenderingContext2D, box: Box & { readonly radius: number }, palette: Palette): void {
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = palette.aiTitle;
    ctx.lineWidth = GHOST_OUTLINE_W;
    ctx.beginPath();
    ctx.roundRect(box.x + OUTLINE_INSET, box.y + OUTLINE_INSET, box.width - 2 * OUTLINE_INSET, box.height - 2 * OUTLINE_INSET, box.radius);
    ctx.stroke();
    ctx.restore();
  }

  #drawStepDisc(ctx: CanvasRenderingContext2D, box: Box, step: number, palette: Palette): void {
    ctx.fillStyle = palette.ai;
    ctx.beginPath();
    ctx.arc(box.x + STEP_DISC.x, box.y + STEP_DISC.y, STEP_DISC.r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = palette.aiInk;
    ctx.font = `${TOKENS['fw-bold']} ${TOKENS['fs-8h']} ${palette.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(step), box.x + STEP_DISC.x, box.y + STEP_DISC.y + 0.5);
    ctx.textAlign = 'left';
  }

  // The locator ghost band in the ruler's upper half: the new range, violet
  // and dashed; unbroken while the proposal is heard (solid).
  #drawGhostBand(ctx: CanvasRenderingContext2D, shape: GhostBox, palette: Palette): void {
    const b = shape.box;
    ctx.save();
    ctx.fillStyle = palette.aiTitle;
    ctx.fillRect(b.x, b.y, b.width, b.height);
    ctx.setLineDash([...ghostStroke(shape.mode).dash]);
    ctx.strokeStyle = palette.ai;
    ctx.lineWidth = GHOST_OUTLINE_W;
    ctx.strokeRect(b.x + OUTLINE_INSET, b.y + OUTLINE_INSET, b.width - 2 * OUTLINE_INSET, b.height - 2 * OUTLINE_INSET);
    ctx.restore();
  }

  // The step of a ghost clip or a proposed lane under the point, or null.
  #ghostAt(x: number, y: number): number | null {
    for (let i = this.#ghostBoxes.length - 1; i >= 0; i -= 1) {
      const { box, pure, step } = this.#ghostBoxes[i]!;
      if (pure && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return step;
    }
    return null;
  }

  // The waveform from the clip's media's peak pyramid, one min/max column per
  // device pixel (waveform.ts): the outer layer fills between the min and the
  // max at half the clip's alpha, the inner layer the same range at 52 %.
  // Nothing before the peaks arrive.
  #drawWaveform(ctx: CanvasRenderingContext2D, snapshot: Snapshot, rect: ClipRect, box: Box, tones: ClipPalette, alpha: number): WaveColumn[] {
    const media = snapshot.entities[`media:${rect.mediaId}`] as MediaEntity | undefined;
    if (!media) return [];
    const pyramid = this.#options.peaks.get(media.contentHash);
    if (!pyramid) return [];
    const half = (box.height - CLIP_TITLE_HEIGHT) / 2 - WAVE_MARGIN;
    if (!(half > 0)) return [];
    const mid = box.y + CLIP_TITLE_HEIGHT + (box.height - CLIP_TITLE_HEIGHT) / 2;
    const { columns: unfaded } = waveformColumns(pyramid, {
      sourceStart: Number(rect.sourceStart),
      length: Number(rect.length),
      framesPerPixel: this.#view.framesPerPixel,
      ratio: this.#ratio,
      x: rect.x,
      clipLeft: Math.max(box.x, 0),
      clipRight: Math.min(box.x + box.width, this.#view.width),
      mid,
      half,
    });
    // m5b-ui-fades: each column scaled by the fade gain at its frame.
    const columns = fadeScaledColumns(unfaded, rect, this.#view.framesPerPixel) as WaveColumn[];
    ctx.globalAlpha = alpha * tones.waveOuterAlpha;
    ctx.fillStyle = tones.waveOuter;
    for (const c of columns) ctx.fillRect(c.x, mid - c.outerSpan.up, c.w, c.outerSpan.up + c.outerSpan.down);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tones.waveInner;
    for (const c of columns) ctx.fillRect(c.x, mid - c.innerSpan.up, c.w, c.innerSpan.up + c.innerSpan.down);
    return columns;
  }

  #drawOverlay(): void {
    this.#overlayDraws += 1;
    // The cursor at this animation frame: extrapolated while playing.
    const rate = this.#options.model.getSnapshot()?.root?.sampleRate ?? 48000;
    this.#playhead = this.#clock.position(rate);
    // Auto-scroll (page mode): a cursor that left the view while playing
    // turns the page here, so the content is redrawn only on a page turn;
    // never while a clip or ruler drag is held.
    const page = nextScroll({
      view: this.#view,
      cursor: this.#playhead,
      lead: Math.floor((MAX_LEAD_MS * rate) / 1000),
      playing: this.#playing,
      enabled: this.#autoScroll,
      dragging: this.#drag !== null || this.#rulerDrag !== null || this.#band !== null || this.#markerDrag !== null,
    });
    if (page !== null) {
      this.#view = { ...this.#view, scrollFrames: page };
      this.#invalidateContent();
    }
    const view = this.#view;
    const top = lanesTopOf(view);
    const height = view.height ?? 0;
    const snapshot = this.#options.model.getSnapshot();
    const ctx = this.#context(this.#overlay);
    const palette = ctx ? this.#palette() : null;
    const drag = this.#drag;
    const plan = drag && drag.kind === 'clip' && snapshot ? this.#plan(drag) : null;
    const repeats = drag && drag.kind === 'repeat' && snapshot ? this.#repeatPreviews(drag, snapshot) : [];
    this.#guideX = null;
    const selected = new Set(this.#state.selectedClipIds);
    // The previews of a drag, and the outline of a selected clip at its preview.
    const previews: Array<{ rect: ClipRect; outlined: boolean }> = [];
    for (const rect of this.#rects) {
      const preview = plan && drag && snapshot ? this.#preview(rect, snapshot, plan, drag) : rect;
      if (preview !== rect) previews.push({ rect: preview, outlined: selected.has(rect.clipId) });
    }
    // The hovered clip's handles; the volume control of the selected clips
    // and the hovered one (their corner squares are the content layer's).
    const hovered = this.#rects.filter((r) => !drag && r.clipId === this.#hoverClipId && !selected.has(r.clipId));
    const gains = this.#rects.filter((r) => !drag && (selected.has(r.clipId) || r.clipId === this.#hoverClipId));
    if (plan && (plan.kind === 'move' || plan.kind === 'copy' || plan.kind === 'trim') && plan.guide !== null) {
      this.#guideX = frameToX(plan.guide, view);
    }
    // A held fade drag (m5b-ui-fades): its side at the length so far, and the snap guide at its end.
    const fading = this.#fadePreview(drag);
    if (fading?.snapped !== null && fading?.snapped !== undefined) this.#guideX = frameToX(fading.snapped, view);
    // The hovered (or pinned) step's ghosts, outlined (m5b-ui-ghosts).
    this.#ghostOutline = this.#options.ghosts?.outlineStep() ?? null;
    if (ctx && palette && this.#ghostOutline !== null) {
      ctx.save();
      ctx.strokeStyle = palette.ai;
      ctx.lineWidth = HOT_OUTLINE_W;
      for (const shape of this.#ghostBoxes) {
        if (shape.step !== this.#ghostOutline) continue;
        const b = shape.box;
        ctx.beginPath();
        ctx.roundRect(b.x - HOT_OUTLINE_W / 2, b.y - HOT_OUTLINE_W / 2, b.width + HOT_OUTLINE_W, b.height + HOT_OUTLINE_W, CLIP_RADIUS);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (ctx && palette) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, view.width, Math.max(0, height - top));
      ctx.clip();
      for (const { rect, outlined } of [...previews, ...repeats.map((rect) => ({ rect, outlined: false }))]) {
        const box = clipBox(rect);
        ctx.globalAlpha = PREVIEW_ALPHA;
        ctx.fillStyle = palette.track(rect.trackId);
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (!outlined) continue;
        const inset = SELECTED_OUTLINE_INSET;
        ctx.beginPath();
        ctx.roundRect(box.x + inset, box.y + inset, box.width - 2 * inset, box.height - 2 * inset, box.radius);
        ctx.strokeStyle = palette.select;
        ctx.lineWidth = SELECTED_OUTLINE_W;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.select;
      for (const rect of hovered) for (const corner of cornerHandles(clipBox(rect))) ctx.fillRect(corner.x, corner.y, corner.width, corner.height);
      // The hovered clip's fade handles (m5b-ui-fades; the selected clips' are the content layer's).
      if (this.#fadesOn()) for (const rect of hovered) this.#drawFadeHandles(ctx, clipBox(rect), rect, palette);
      if (fading && drag) {
        const rect = this.#rects.find((r) => r.clipId === drag.rect.clipId);
        if (rect) {
          const box = clipBox(rect);
          const curve = fading.clip[fading.side]?.curve ?? 'linear';
          const fades = { ...rect, [fading.side]: fading.length > 0n ? { length: fading.length.toString(), curve } : undefined };
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
          ctx.clip();
          this.#drawFade(ctx, box, fading.side, fadePx(fading.length, view.framesPerPixel), curve, palette);
          ctx.restore();
          this.#drawFadeHandles(ctx, box, fades, palette);
        }
      }
      for (const rect of gains) this.#drawGain(ctx, snapshot, rect, palette);
      if (drag?.kind === 'gain') this.#drawGain(ctx, snapshot, drag.rect, palette, gainFromDrag(drag.gain, drag.dy, toolModifiers(drag.flags, this.#platform()).fine));
      if (this.#guideX !== null) {
        ctx.fillStyle = palette.select;
        ctx.fillRect(Math.round(this.#guideX), top, 1, height - top);
      }
      this.#drawSplitLine(ctx, snapshot, palette);
      this.#drawRubberBand(ctx, palette);
      ctx.restore();
    }
    this.#placeTooltip(snapshot, plan);
    this.#drawRecording(ctx, snapshot, palette);
    // The project cursor, from the realtime playhead, as draw() draws it: a
    // glow over the lanes, the line from the ruler's lower half to the top of
    // the scroll-zoom bar, and the head in the lower half.
    const playhead = this.#playhead;
    this.#cursorX = playhead === null ? null : frameToX(playhead, view);
    this.#cursorParts = [];
    if (this.#cursorX !== null && this.#cursorX >= 0 && this.#cursorX <= view.width) {
      const px = Math.round(this.#cursorX) + 0.5;
      const from = RULER_UPPER + CURSOR_TOP;
      this.#cursorParts = [
        { id: 'cursor', x: px - 0.5, y: from, w: 1, h: height - from },
        { id: 'cursor-head', x: px - CURSOR_HEAD_HALF, y: from, w: 2 * CURSOR_HEAD_HALF, h: 2 * CURSOR_HEAD_HALF },
      ];
      if (ctx && palette) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.cursorGlow;
        ctx.fillRect(px - CURSOR_GLOW / 2, top, CURSOR_GLOW, height - top);
        ctx.strokeStyle = palette.select;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, from);
        ctx.lineTo(px, height);
        ctx.stroke();
        ctx.fillStyle = palette.select;
        ctx.beginPath();
        ctx.moveTo(px - CURSOR_HEAD_HALF, from);
        ctx.lineTo(px + CURSOR_HEAD_HALF, from);
        ctx.lineTo(px + CURSOR_HEAD_HALF, RULER_UPPER + CURSOR_HEAD_SIDE);
        ctx.lineTo(px, RULER_UPPER + CURSOR_HEAD_POINT);
        ctx.lineTo(px - CURSOR_HEAD_HALF, RULER_UPPER + CURSOR_HEAD_SIDE);
        ctx.fill();
      }
    }
    // Display rate while playing: the next animation frame draws the cursor
    // again from the clock; stopped, the loop ends here.
    if (this.#clock.playing()) this.#invalidateOverlay();
  }

  // The takes being recorded (m5b-ui-recording; UI redesign 3.5): a red clip
  // per take on its lane from the take's start to the cursor, in the clip's
  // box (draw()'s insets and radius) filled with --err-a140 and outlined in
  // --rec, with its live waveform in --rec-line, mirrored about the box's
  // middle as draw() mirrors a waveform. Drawn on every overlay frame, which
  // runs at display rate while the transport plays; no React state.
  #drawRecording(ctx: CanvasRenderingContext2D | null, snapshot: Snapshot | null, palette: Palette | null): void {
    const source = this.#options.recording;
    this.#recordingDrawn = [];
    if (!source || !snapshot) return;
    const playhead = this.#playhead !== null && /^\d+$/.test(this.#playhead) ? BigInt(this.#playhead) : null;
    const clips = source.clips(playhead);
    if (clips.length === 0) return;
    const view = this.#view;
    const order = snapshot.trackOrder;
    const tops = laneTops(order, view);
    const top = lanesTopOf(view);
    const height = view.height ?? 0;
    const fpp = view.framesPerPixel;
    if (ctx && palette) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, view.width, Math.max(0, height - top));
      ctx.clip();
    }
    for (const clip of clips) {
      const lane = order.indexOf(clip.trackId);
      if (lane < 0) continue;
      const x0 = frameToX(clip.start, view);
      const x1 = frameToX(clip.end, view);
      const columns = source.columns(clip.takeId);
      this.#recordingDrawn.push({ takeId: clip.takeId, trackId: clip.trackId, start: clip.start.toString(), end: clip.end.toString(), x: x0, width: x1 - x0, columns: columns.length });
      if (!ctx || !palette) continue;
      const box = clipBox({ x: x0, y: tops[lane]!, width: Math.max(0, x1 - x0), height: laneHeightOf(clip.trackId, view) });
      if (box.width <= 0) continue;
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.recBody;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
      ctx.fill();
      ctx.strokeStyle = palette.rec;
      ctx.lineWidth = 1;
      ctx.stroke();
      // The waveform: one column per WAVE_FRAMES frames, at least a pixel wide.
      const middle = box.y + box.height / 2;
      const half = box.height / 2 - CLIP_INSET_TOP;
      const width = Math.max(1, WAVE_FRAMES / fpp);
      ctx.fillStyle = palette.recWave;
      for (let i = 0; i < columns.length; i += 1) {
        const peak = Math.min(1, columns[i]!);
        if (!(peak > 0)) continue;
        const x = frameToX(clip.start + BigInt(i * WAVE_FRAMES), view);
        if (x + width < box.x || x > box.x + box.width) continue;
        const h = Math.max(1, peak * half);
        ctx.fillRect(x, middle - h, Math.min(width, box.x + box.width - x), 2 * h);
      }
    }
    if (ctx && palette) ctx.restore();
  }

  // A clip's volume control as draw() draws it: its box in --bg-well with a
  // --white-a700 line and the gain in --select (the held value while dragged).
  #drawGain(ctx: CanvasRenderingContext2D, snapshot: Snapshot | null, rect: ClipRect, palette: Palette, held?: number): void {
    const gain = gainBox(rect);
    if (!gain) return;
    const clip = snapshot?.entities[`clip:${rect.clipId}`] as ClipEntity | undefined;
    const value = held ?? clip?.gainMilliDb ?? 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.bgWell;
    ctx.beginPath();
    ctx.roundRect(gain.x, gain.y, gain.width, gain.height, GAIN_RADIUS);
    ctx.fill();
    ctx.strokeStyle = palette.gainLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(gain.x + 0.5, gain.y + 0.5, gain.width - 1, gain.height - 1, GAIN_RADIUS);
    ctx.stroke();
    ctx.fillStyle = palette.select;
    ctx.font = `${TOKENS['fw-strong']} ${TOKENS['fs-8']} ${palette.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(formatDb(value), gain.x + GAIN_TEXT_X, gain.y + gain.height / 2 - 0.5, gain.width - 2 * GAIN_TEXT_X);
  }

  // The copies a held repeat-handle drag would place, as boxes at their lanes.
  #repeatPreviews(drag: Drag, snapshot: Snapshot): ClipRect[] {
    const count = this.#repeatCount(drag);
    if (count === 0) return [];
    const by = selectionLength(snapshot, drag.ids);
    const view = this.#view;
    const out: ClipRect[] = [];
    for (const rect of this.#rects) {
      if (!drag.ids.includes(rect.clipId)) continue;
      for (let k = 1; k <= count; k += 1) {
        const position = (BigInt(rect.position) + BigInt(k) * by).toString();
        out.push({ ...rect, position, x: frameToX(position, view) });
      }
    }
    return out;
  }

  // The rubber band (m5b-ui-edit-more): its box outlined in --select over a
  // light fill of the same colour, while the pointer is held past the threshold.
  #drawRubberBand(ctx: CanvasRenderingContext2D, palette: Palette): void {
    const band = this.#band;
    if (!band?.moved) return;
    const box = this.#bandBox(band);
    const x = Math.min(box.x, box.x + box.width);
    const y = Math.min(box.y, box.y + box.height);
    ctx.globalAlpha = BAND_FILL_ALPHA;
    ctx.fillStyle = palette.select;
    ctx.fillRect(x, y, Math.abs(box.width), Math.abs(box.height));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.select;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(box.width)), Math.round(Math.abs(box.height)));
  }

  // The Split tool's line: where a click would split the clip under the pointer.
  #drawSplitLine(ctx: CanvasRenderingContext2D, snapshot: Snapshot | null, palette: Palette): void {
    const pointer = this.#lastPointer;
    if (this.#state.tool !== 'split' || !pointer || !snapshot || this.#drag) return;
    const hit = hitTest(this.#rects, pointer.x, pointer.y);
    if (!hit) return;
    const x = frameToX(this.#snapper(snapshot, false, [hit.rect.clipId])(xToFrame(pointer.x, this.#view)), this.#view);
    const box = clipBox(hit.rect);
    ctx.fillStyle = palette.tx1;
    ctx.fillRect(Math.round(x), box.y, 1, box.height);
  }

  // The drag tooltip: for a clip the new position (start, or the resized
  // edge) and the delta in bars.beats.ticks, the same in every locale; for
  // the volume control the gain and, in brackets, the change.
  #placeTooltip(snapshot: Snapshot | null, plan: Plan | null): void {
    const tooltip = this.#options.tooltip;
    const drag = this.#drag;
    if (!tooltip) return;
    if (!snapshot || !drag || !this.#moved(drag)) {
      this.#hideTooltip();
      return;
    }
    let text: string;
    const fading = this.#fadePreview(drag);
    if (drag.kind === 'gain') {
      const gain = gainFromDrag(drag.gain, drag.dy, toolModifiers(drag.flags, this.#platform()).fine);
      text = `${formatDb(gain)}  (${formatDb(gain - drag.gain)})`;
    } else if (fading) {
      // A fade's length and its change in whole milliseconds, the same in every locale.
      const rate = snapshot.root?.sampleRate ?? 48000;
      const change = framesToMs(fading.length, rate) - framesToMs(fading.clip[fading.side]?.length ?? '0', rate);
      text = `${formatMs(fading.length, rate)}  (${change < 0n ? '-' : '+'}${change < 0n ? -change : change} ms)`;
    } else {
      if (!plan || (plan.kind !== 'move' && plan.kind !== 'copy' && plan.kind !== 'trim')) {
        this.#hideTooltip();
        return;
      }
      const tempo = snapshot.root?.tempo ?? [];
      const rate = snapshot.root?.sampleRate ?? 48000;
      const ticks = (frames: bigint) => framesToTicks(Number(frames), tempo, rate);
      const base = drag.rect;
      const preview = this.#preview(base, snapshot, plan, drag);
      const end = (r: ClipRect) => BigInt(r.position) + BigInt(r.length);
      const edge =
        plan.kind === 'trim' && plan.edge === 'right'
          ? [ticks(end(base)), ticks(end(preview))]
          : [ticks(BigInt(base.position)), ticks(BigInt(preview.position))];
      text = `${formatBbt(edge[1]!)}  ${formatBbtDelta(edge[1]! - edge[0]!)}`;
    }
    tooltip.textContent = text;
    const pointer = this.#lastPointer ?? { x: drag.startX, y: drag.startY };
    tooltip.style.transform = `translate(${Math.round(pointer.x + 12)}px, ${Math.round(pointer.y + 12)}px)`;
    tooltip.hidden = false;
  }

  #hideTooltip(): void {
    const tooltip = this.#options.tooltip;
    if (tooltip && !tooltip.hidden) tooltip.hidden = true;
  }
}
