// The project zone's content (ADR-0019 point 3; UI redesign spec 2.1, 3.2,
// 3.3, 5.2, 10.8): the toolbar (Toolbar.tsx, the mockup's: the Object
// Selection and Split tools, snap and the grid type, auto-scroll, and the
// last refusal), the info line (InfoLine.tsx, editable since m5b-ui-edit-more), and below them the
// track list, its boundary and the event display, whose two canvases the
// imperative TimelineCanvas owns through refs. The Pool (Pool.tsx, Ctrl+P or
// the event display's context menu) lists the media to place from. No drawing state passes through React:
// the track list follows the canvas's view through a listener, the meters
// and the cursor read the RealtimeClient on their own frames.
//
// The project zone's key commands (keys/preset-cubase.ts) are registered
// here: Delete and Backspace, Escape, H and G, Shift+H and Shift+G, Shift+F,
// T, and the editing keys of m5-ui-edit-basics (1, 3, Alt+X, Ctrl+D, J,
// Ctrl+A, L, N, B, Alt+S, Shift+E, M, S, Shift+Delete), and F (auto-scroll,
// m5-ui-transport); Ctrl+P (pool.open, a window command) opens the Pool. The capability rule (spec 3.0) is editGates: a key,
// button or control exists only when engine.capabilities lists the commands
// (or the method) it ends in, and the canvas sends no gesture whose commands
// are not listed (it reads the latest capabilities through a ref). Lane
// heights, the snap state and auto-scroll are the layout store's
// (siann.layout.v1). The track selection is the app's: M, S, N, B and
// Shift+Delete act on its tracks; Shift+Delete asks first.
// m5-ui-transport: a click in the ruler's lower half or a Shift+Alt-click in
// the event display locates through onLocate (only when engine.capabilities
// lists transport.locate), and the canvas follows the layout store's
// auto-scroll setting. m5-ui-loop-click: the canvas's upper ruler half edits
// the locators through the LoopClickController (only when the engine lists
// session.set_locators and the locators feature), and P and Alt+P take the
// canvas's selection from here.
// m5b-ui-edit-more: 4 and 5 (Glue, Erase), edit.glue (no key), Ctrl+X, Ctrl+C,
// Ctrl+V, Alt+V, Ctrl+K (RepeatDialog asks for the count), the nudges, and
// Ctrl+Shift+A; the toolbar's snap type menu; the info line's typed values
// (infoLineEditCommand, one command list through the canvas); a refused glue
// is a toast (the `toasts` store) worded in the locale.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { localeStore, translator, useLocale, type MessageKey } from '../i18n/t';
import type { CommandId, CommandRegistry } from '../keys/commands';
import type { CapabilitySelector } from '../model/capabilities';
import { loopClickGates, type LoopClickController } from '../model/loop-click';
import type { PeaksCache } from '../model/peaks-cache';
import type { Snapshot } from '../model/read-model';
import type { Viewport } from './geometry';
import type { RealtimeClient } from '../model/realtime-client';
import type { ReviewStore } from '../model/review-store';
import type { SessionClient } from '../model/session-client';
import { useStepNames } from '../plans/hooks';
import { planNameParts } from '../plans/plan-name';
import { useCapabilities } from '../shell/Capable';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { createLayoutStore, type LayoutStore } from '../shell/layout-store';
import type { ToastStore } from '../shell/toast-store';
import type { TimelineCommand } from './commands';
import { removeTracksCommand, trackMuteCommand, trackSoloCommand, type GlueRefusal } from './edit-commands';
import { infoLineEditCommand, type InfoField } from './info-line';
import { InfoLine } from './InfoLine';
import { RepeatDialog } from './RepeatDialog';
import { EventDisplayMenu, Pool } from './Pool';
import type { TrackSelectMode } from './selection';
import { IDLE_STATE, TimelineCanvas, type TimelineTestHooks } from './TimelineCanvas';
import { Toolbar } from './Toolbar';
import { TrackList, addTrack } from './TrackList';
import { TrackListDivider } from './TrackListDivider';
import { MAX_FRAMES_PER_PIXEL } from './zoom';

const EMPTY_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({});
const NO_IDS: readonly string[] = Object.freeze([]);

// The zoom slider's scale: log2 of the frames per pixel.
const ZOOM_MAX = Math.log2(MAX_FRAMES_PER_PIXEL);

// The zoom slider's value for a zoom: 0 all the way out, ZOOM_MAX at one frame per pixel.
export function zoomValue(framesPerPixel: number): number {
  return ZOOM_MAX - Math.log2(Math.min(MAX_FRAMES_PER_PIXEL, Math.max(1, framesPerPixel)));
}

// Where the zoom's visible handle (the mockup's u::after) sits: the slider's
// value as a fraction, 0 to 1, set on u as --zoom-at. shell.css places the
// handle where the range input's (transparent) thumb is, so what is shown is
// what a drag moves.
export function zoomAt(framesPerPixel: number): number {
  return zoomValue(framesPerPixel) / ZOOM_MAX;
}

export type EditCommand = Extract<
  CommandId,
  | 'tool.select'
  | 'tool.split'
  | 'edit.splitAtCursor'
  | 'edit.duplicate'
  | 'edit.snapToggle'
  | 'edit.selectAll'
  | 'edit.delete'
  | 'transport.locateSelection'
  | 'transport.locateNextClip'
  | 'transport.locatePreviousClip'
  | 'view.zoomSelection'
  | 'view.zoomEvent'
  | 'track.muteSelected'
  | 'track.soloSelected'
  | 'track.removeSelected'
  | 'tool.glue'
  | 'tool.erase'
  | 'edit.glue'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.pasteAtOrigin'
  | 'edit.repeat'
  | 'edit.nudgeLeft'
  | 'edit.nudgeRight'
  | 'edit.nudgeStartLeft'
  | 'edit.nudgeStartRight'
  | 'edit.nudgeEndLeft'
  | 'edit.nudgeEndRight'
  | 'edit.selectNone'
>;

// A refused glue's toast, by reason (UI redesign 3.2, "Tools").
const GLUE_REFUSED: Readonly<Record<GlueRefusal | 'selection', MessageKey>> = {
  no_next: 'glue.refused.no_next',
  gap: 'glue.refused.gap',
  other_media: 'glue.refused.other_media',
  source_not_continuous: 'glue.refused.source_not_continuous',
  other_track: 'glue.refused.other_track',
  selection: 'glue.refused.selection',
};

// The info line's fields and the commands each edit sends.
const INFO_EDIT_OPS: Readonly<Record<InfoField, string>> = { start: 'clip.move', length: 'clip.trim', offset: 'clip.trim', volume: 'clip.set_gain' };

// Which editing commands (keys, buttons) exist with these capabilities (UI
// redesign spec 3.0): each needs the commands it ends in (or, for L, N and
// B, the transport.locate method); selecting and zooming send nothing.
export function editGates(can: CapabilitySelector): Record<EditCommand, boolean> {
  const split = can.command('clip.trim') && can.command('clip.place');
  const locate = can.has('transport.locate');
  const glue = can.command('clip.remove') && can.command('clip.trim');
  const place = can.command('clip.place');
  const start = can.command('clip.trim') && can.command('clip.move');
  return {
    'tool.select': can.command('clip.move') || can.command('clip.trim') || can.command('clip.place'),
    'tool.split': split,
    'edit.splitAtCursor': split,
    'edit.duplicate': can.command('clip.place'),
    'edit.snapToggle': can.command('clip.move') || can.command('clip.trim') || can.command('clip.place'),
    'edit.selectAll': true,
    'edit.delete': can.command('clip.remove'),
    'transport.locateSelection': locate,
    'transport.locateNextClip': locate,
    'transport.locatePreviousClip': locate,
    'view.zoomSelection': true,
    'view.zoomEvent': true,
    'track.muteSelected': can.command('track.set_mute'),
    'track.soloSelected': can.command('track.set_solo'),
    'track.removeSelected': can.command('track.remove'),
    // m5b-ui-edit-more: each on the commands it sends; copy and Select None send nothing.
    'tool.glue': glue,
    'tool.erase': can.command('clip.remove'),
    'edit.glue': glue,
    'edit.cut': can.command('clip.remove'),
    'edit.copy': true,
    'edit.paste': place,
    'edit.pasteAtOrigin': place,
    'edit.repeat': place,
    'edit.nudgeLeft': can.command('clip.move'),
    'edit.nudgeRight': can.command('clip.move'),
    'edit.nudgeStartLeft': start,
    'edit.nudgeStartRight': start,
    'edit.nudgeEndLeft': can.command('clip.trim'),
    'edit.nudgeEndRight': can.command('clip.trim'),
    'edit.selectNone': true,
  };
}

export interface TimelineProps {
  readonly client: SessionClient;
  readonly peaks: PeaksCache;
  readonly commands: CommandRegistry;
  // The zone layout (the track list's width, the lane heights, snap); a private one when absent.
  readonly layout?: LayoutStore;
  readonly realtime?: RealtimeClient | null;
  // The primary selected track and every selected track (the app's).
  readonly selectedTrackId?: string | null;
  readonly selectedTrackIds?: readonly string[];
  readonly onSelectTrack?: (trackId: string, mode: TrackSelectMode) => void;
  // Which key is Mod for the tool modifiers.
  readonly platform?: 'mac' | 'other';
  // The reconnects so far (model/connection-phase.ts); each one clears the selection.
  readonly reconnects?: number;
  // The selected clip, for the left zone.
  readonly onSelect?: (clipId: string | null) => void;
  // A click in the ruler's lower half or a Shift+Alt-click in the event
  // display: locate the project cursor (frames).
  readonly onLocate?: (frames: string) => void;
  // Test-only (SIANN_SHELL_TEST=1): the canvas's hooks once it is mounted.
  readonly onHooks?: (hooks: TimelineTestHooks | null) => void;
  // Locators, cycle and metronome (m5-ui-loop-click); no band when absent.
  readonly loopClick?: LoopClickController;
  // The plan review (m5b-ui-ghosts): the canvas's ghosts and the toolbar's pill; none when absent.
  readonly review?: ReviewStore;
  // Where a refused glue's toast goes (m5b-ui-edit-more); none when absent.
  readonly toasts?: ToastStore;
}

function useSessionId(client: SessionClient): string | null {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().sessionId,
    () => client.getState().sessionId,
  );
}

// The scroll-zoom bar's thumb (`<i>`): left and width in percent of the
// session's extent (the last clip's end, or the view's end when that is
// further). Set from the canvas's view listener, never through React, so a
// page turn while playing commits nothing.
export function scrollThumb(view: Pick<Viewport, 'scrollFrames' | 'framesPerPixel' | 'width'>, snapshot: Snapshot | null): { left: string; width: string } | null {
  const scroll = Number(view.scrollFrames);
  if (!(view.framesPerPixel > 0) || !(view.width > 0)) return null;
  const visible = view.framesPerPixel * view.width;
  let end = scroll + visible;
  for (const clip of snapshot?.clips ?? []) {
    if (clip.position.domain === 'audio') end = Math.max(end, Number(clip.position.value) + Number(clip.length));
  }
  const percent = (frames: number) => `${Math.min(100, Math.max(0, (frames / end) * 100))}%`;
  return { left: percent(scroll), width: percent(visible) };
}

function send(client: SessionClient, command: TimelineCommand | null): boolean {
  if (!command) return false;
  void client.execute(command.commands, command.expectedRevision).catch(() => undefined);
  return true;
}

export function Timeline({
  client,
  peaks,
  commands,
  layout: given,
  realtime = null,
  selectedTrackId = null,
  selectedTrackIds,
  onSelectTrack,
  platform = 'other',
  onSelect,
  onHooks,
  onLocate,
  loopClick,
  reconnects = 0,
  review,
  toasts,
}: TimelineProps) {
  const contentRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const displayRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const locale = useLocale();
  const t = translator(locale);
  const [own] = useState(() => (given ? null : createLayoutStore({ storage: null })));
  const layout = given ?? own!;
  const sessionId = useSessionId(client);
  const [timeline, setTimeline] = useState<TimelineCanvas | null>(null);
  const [removing, setRemoving] = useState<readonly string[] | null>(null);
  // Ctrl+K's count dialog (m5b-ui-edit-more).
  const [repeating, setRepeating] = useState(false);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  // The Pool (Ctrl+P) and the event display's context menu (where it opened).
  const [poolOpen, setPoolOpen] = useState(false);
  const [displayMenu, setDisplayMenu] = useState<{ x: number; y: number } | null>(null);
  const can = useCapabilities();
  const canRef = useRef(can);
  canRef.current = can;
  const locateRef = useRef(onLocate);
  locateRef.current = onLocate;
  const gates = editGates(can);
  const canPlace = can.command('clip.place');
  const canAdd = can.command('track.add');
  const trackIds = selectedTrackIds ?? (selectedTrackId ? [selectedTrackId] : NO_IDS);
  const tracksRef = useRef(trackIds);
  tracksRef.current = trackIds;
  // M and S follow the primary's state, which need not be trackIds[0].
  const primaryRef = useRef(selectedTrackId);
  primaryRef.current = selectedTrackId;
  const trackListWidth = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.trackList,
    () => layout.getSnapshot().layout.trackList,
  );
  // Auto-scroll (F; m5-ui-transport): a per-viewer setting of the layout store.
  const autoScroll = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.autoScroll,
    () => layout.getSnapshot().layout.autoScroll,
  );
  const snap = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.snap,
    () => layout.getSnapshot().layout.snap,
  );

  useEffect(() => {
    const content = contentRef.current;
    const overlay = overlayRef.current;
    const container = displayRef.current;
    if (!content || !overlay || !container) return undefined;
    const heights = () => (sessionId !== null ? layout.getSnapshot().layout.trackHeights[sessionId] : undefined) ?? EMPTY_HEIGHTS;
    const surface = new TimelineCanvas({
      content,
      overlay,
      container,
      model: client.model,
      peaks,
      execute: (commands, expectedRevision) => client.execute(commands, expectedRevision),
      locale: {
        t: () => translator(localeStore().getSnapshot()),
        subscribe: (listener) => localeStore().subscribe(listener),
      },
      allows: (op) => canRef.current.command(op),
      playhead: realtime ?? undefined,
      laneHeights: {
        get: heights,
        subscribe: (listener) => {
          let last = heights();
          return layout.subscribe(() => {
            const next = heights();
            if (next !== last) {
              last = next;
              listener();
            }
          });
        },
      },
      tooltip: tooltipRef.current,
      platform,
      locate: (frame) => (canRef.current.has('transport.locate') ? client.request('transport.locate', { frames: frame.toString() }) : undefined),
      onLocate: (frames) => {
        if (canRef.current.has('transport.locate')) locateRef.current?.(frames);
      },
      autoScroll: layout.getSnapshot().layout.autoScroll,
      locators: loopClick
        ? {
            enabled: () => loopClickGates(canRef.current).locators,
            cycle: () => loopClick.state.getSnapshot()?.cycle ?? false,
            subscribe: (listener) => loopClick.state.subscribe(listener),
            setLocators: (range) => void loopClick.setLocators(range),
            toggleCycle: () => loopClick.toggleCycle(),
          }
        : undefined,
      ghosts: review
        ? {
            ghosts: () => review.ghosts(),
            outlineStep: () => review.outlineStep(),
            subscribe: (listener) => review.subscribe(listener),
            pin: (step) => review.pinGhost(step),
            onReveal: (listener) => review.onReveal((request) => listener(request.step)),
          }
        : undefined,
      onRefuse: (reason) => {
        const key = GLUE_REFUSED[reason];
        toastsRef.current?.push(translator(localeStore().getSnapshot())(key), (locale) => translator(locale)(key));
      },
    });
    surface.setSnap(layout.getSnapshot().layout.snap);
    const offAutoScroll = layout.subscribe(() => surface.setAutoScroll(layout.getSnapshot().layout.autoScroll));
    const offHeights = surface.onLaneHeights((trackIds, height) => {
      if (sessionId !== null) layout.dispatch({ type: 'allTrackHeights', sessionId, trackIds, height });
    });
    setTimeline(surface);
    onHooks?.(surface.testHooks());
    return () => {
      onHooks?.(null);
      offHeights();
      offAutoScroll();
      surface.destroy();
      setTimeline(null);
    };
  }, [client, peaks, realtime, layout, sessionId, onHooks, platform, loopClick, review]);

  useEffect(() => {
    timeline?.setSnap(snap);
  }, [timeline, snap]);

  // The band follows the capabilities; P and Alt+P take this canvas's selection.
  const bandGate = loopClickGates(can).locators;
  useEffect(() => {
    timeline?.invalidate();
  }, [timeline, bandGate]);
  useEffect(() => (timeline && loopClick ? loopClick.useSelection(() => timeline.selectionSpan()) : undefined), [timeline, loopClick]);

  const state = useSyncExternalStore(
    (listener) => (timeline ? timeline.subscribe(listener) : () => {}),
    () => (timeline ? timeline.getState() : IDLE_STATE),
    () => (timeline ? timeline.getState() : IDLE_STATE),
  );
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const framesPerPixel = useSyncExternalStore(
    (listener) => (timeline ? timeline.subscribeView(listener) : () => {}),
    () => (timeline ? timeline.getView().framesPerPixel : 0),
    () => 0,
  );

  // The scroll thumb follows the canvas's view in the canvas's frame, as the track list does.
  const thumbRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!timeline) return undefined;
    const follow = () => {
      const el = thumbRef.current;
      const thumb = scrollThumb(timeline.getView(), client.model.getSnapshot());
      if (!el || !thumb) return;
      if (el.style.left !== thumb.left) el.style.left = thumb.left;
      if (el.style.width !== thumb.width) el.style.width = thumb.width;
    };
    follow();
    return timeline.subscribeView(follow);
  }, [timeline, client]);

  const gateKey = JSON.stringify(gates);
  useEffect(() => {
    if (!timeline) return undefined;
    const allowed = editGates(canRef.current);
    const offs = [
      commands.register('project', 'edit.cancel', () => timeline.setPlacing(null)),
      commands.register('project', 'view.zoomIn', () => timeline.zoomIn()),
      commands.register('project', 'view.zoomOut', () => timeline.zoomOut()),
      commands.register('project', 'view.tracksTaller', () => timeline.tracksTaller()),
      commands.register('project', 'view.tracksShorter', () => timeline.tracksShorter()),
      commands.register('project', 'view.zoomFull', () => timeline.zoomFull()),
    ];
    const edit = (id: EditCommand, handler: () => boolean | void) => {
      if (allowed[id]) offs.push(commands.register('project', id, handler));
    };
    const tracks = () => tracksRef.current;
    const selection = () => ({ primary: primaryRef.current, ids: tracksRef.current });
    edit('edit.delete', () => void timeline.deleteSelected());
    edit('tool.select', () => timeline.setTool('select'));
    edit('tool.split', () => timeline.setTool('split'));
    edit('tool.glue', () => timeline.setTool('glue'));
    edit('tool.erase', () => timeline.setTool('erase'));
    edit('edit.glue', () => void timeline.glueSelection());
    edit('edit.cut', () => void timeline.cut());
    edit('edit.copy', () => timeline.copy());
    edit('edit.paste', () => void timeline.paste(false));
    edit('edit.pasteAtOrigin', () => void timeline.paste(true));
    edit('edit.repeat', () => {
      if (timeline.getState().selectedClipIds.length === 0) return false;
      setRepeating(true);
      return true;
    });
    edit('edit.nudgeLeft', () => void timeline.nudge('position', -1));
    edit('edit.nudgeRight', () => void timeline.nudge('position', 1));
    edit('edit.nudgeStartLeft', () => void timeline.nudge('startLeft'));
    edit('edit.nudgeStartRight', () => void timeline.nudge('startRight'));
    edit('edit.nudgeEndLeft', () => void timeline.nudge('endLeft'));
    edit('edit.nudgeEndRight', () => void timeline.nudge('endRight'));
    edit('edit.selectNone', () => timeline.selectNone());
    edit('edit.splitAtCursor', () => void timeline.splitAtCursor());
    edit('edit.duplicate', () => void timeline.duplicate());
    edit('edit.snapToggle', () => layout.dispatch({ type: 'snapToggle' }));
    edit('edit.selectAll', () => timeline.selectAll());
    edit('transport.locateSelection', () => void timeline.locateSelection());
    edit('transport.locateNextClip', () => void timeline.locateNextClip(tracks()));
    edit('transport.locatePreviousClip', () => void timeline.locatePreviousClip(tracks()));
    edit('view.zoomSelection', () => timeline.zoomToSelection());
    edit('view.zoomEvent', () => timeline.zoomToEvent());
    edit('track.muteSelected', () => {
      const current = client.model.getSnapshot();
      return current ? send(client, trackMuteCommand(current, selection())) : false;
    });
    edit('track.soloSelected', () => {
      const current = client.model.getSnapshot();
      return current ? send(client, trackSoloCommand(current, selection())) : false;
    });
    edit('track.removeSelected', () => {
      const current = client.model.getSnapshot();
      const ids = tracks().filter((id) => current?.entities[`track:${id}`]);
      if (ids.length === 0) return false;
      setRemoving(ids);
      return true;
    });
    if (canAdd) offs.push(commands.register('project', 'track.add', () => addTrack(client, translator(localeStore().getSnapshot()))));
    return () => offs.forEach((off) => off());
  }, [timeline, commands, gateKey, canAdd, client, layout]);

  // Ctrl+P (Cmd+P) opens the Pool, or closes it when it is open, as Cubase's Open Pool does.
  useEffect(() => commands.register('window', 'pool.open', () => setPoolOpen((open) => !open)), [commands]);

  const confirmRemove = () => {
    const ids = removing;
    setRemoving(null);
    const current = client.model.getSnapshot();
    if (ids && current) send(client, removeTracksCommand(current, ids));
  };

  useEffect(() => {
    onSelect?.(state.selectedClipId);
  }, [onSelect, state.selectedClipId]);

  // A reconnect clears the selection (UI redesign spec 4.5 C8).
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (!timeline || reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    timeline.clearSelection();
    setRemoving(null);
  }, [timeline, reconnects]);

  const selectTrack = useCallback((trackId: string, mode: TrackSelectMode) => onSelectTrack?.(trackId, mode), [onSelectTrack]);

  // The proposal pill (m5b-ui-ghosts): the reviewable plan's name and the ghosts toggle.
  const names = useStepNames(client);
  const reviewSubscribe = (listener: () => void) => (review ? review.subscribe(listener) : () => undefined);
  const reviewed = useSyncExternalStore(reviewSubscribe, () => (review?.reviewable() ? review.plan() : undefined), () => undefined);
  const ghostsOn = useSyncExternalStore(reviewSubscribe, () => review?.getSnapshot().ghostsOn ?? true, () => true);
  const name = planNameParts(reviewed, t, names, can);
  const pill = review && name ? { lead: name.lead, steps: name.steps, on: ghostsOn, onToggle: () => review.toggleGhosts() } : null;

  return (
    <section className="timeline">
      <Toolbar
        tool={state.tool}
        snap={snap}
        autoScroll={autoScroll}
        gates={{ select: gates['tool.select'], split: gates['tool.split'], glue: gates['tool.glue'], erase: gates['tool.erase'], snap: gates['edit.snapToggle'], autoScroll: can.has('transport.play') }}
        error={state.error}
        onTool={(tool) => timeline?.setTool(tool)}
        onSnapToggle={() => layout.dispatch({ type: 'snapToggle' })}
        onGrid={(grid) => layout.dispatch({ type: 'setGrid', grid })}
        onSnapType={(snapType) => layout.dispatch({ type: 'setSnapType', snapType })}
        onAutoScroll={() => layout.dispatch({ type: 'autoScroll' })}
        pill={pill}
      />
      <InfoLine
        client={client}
        clipId={state.selectedClipId}
        selection={state.selectedClipIds}
        onEdit={
          timeline && (can.command('clip.move') || can.command('clip.trim') || can.command('clip.set_gain'))
            ? (field, text, absolute) => {
                const current = client.model.getSnapshot();
                const primary = state.selectedClipId;
                if (!current || !primary || !can.command(INFO_EDIT_OPS[field])) return;
                void timeline.sendCommand(infoLineEditCommand(current, state.selectedClipIds, primary, field, text, absolute));
              }
            : undefined
        }
      />
      <div className="arr-body" data-part="arrange" style={{ gridTemplateColumns: `${trackListWidth}px var(--divider-w) minmax(0, 1fr)` }}>
        <TrackList
          client={client}
          realtime={realtime}
          timeline={timeline}
          layout={layout}
          sessionId={sessionId}
          selectedTrackId={selectedTrackId}
          selectedTrackIds={trackIds}
          onSelectTrack={selectTrack}
        />
        <TrackListDivider layout={layout} />
        {/* The mockup's event display (mockup.html line 287): .lanes with the
            canvas #tl and the scroll-zoom bar. The overlay canvas, the drag
            tooltip and the zoom's range input are the app's own. */}
        <div
          className="lanes"
          data-testid="event-display"
          data-part="event-display"
          ref={displayRef}
          onContextMenu={(event) => {
            event.preventDefault();
            setDisplayMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <canvas ref={contentRef} id="tl" data-testid="timeline-content" />
          <canvas ref={overlayRef} className="timeline-layer timeline-overlay" data-testid="timeline-canvas" />
          <div ref={tooltipRef} className="drag-tooltip" data-testid="drag-tooltip" role="status" hidden />
          <div className="hscroll" data-part="scroll-zoom">
            <i ref={thumbRef} />
            <u style={{ '--zoom-at': String(zoomAt(framesPerPixel)) } as CSSProperties}>
              {timeline ? (
                <input
                  type="range"
                  data-testid="zoom-slider"
                  aria-label={t('timeline.zoom')}
                  min={0}
                  max={ZOOM_MAX}
                  step={0.25}
                  value={zoomValue(framesPerPixel)}
                  onChange={(e) => timeline.setFramesPerPixel(Math.round(Math.pow(2, ZOOM_MAX - Number(e.target.value))))}
                />
              ) : null}
            </u>
          </div>
        </div>
      </div>
      <Pool
        open={poolOpen}
        media={snapshot?.media ?? []}
        placingMediaId={state.placingMediaId}
        canPlace={canPlace}
        onPlace={(mediaId) => timeline?.setPlacing(mediaId)}
        onClose={() => setPoolOpen(false)}
      />
      {displayMenu ? (
        <EventDisplayMenu
          x={displayMenu.x}
          y={displayMenu.y}
          onOpenPool={() => {
            setDisplayMenu(null);
            setPoolOpen(true);
          }}
          onClose={() => setDisplayMenu(null)}
        />
      ) : null}
      <RepeatDialog
        open={repeating}
        onConfirm={(count) => {
          setRepeating(false);
          void timeline?.repeat(count);
        }}
        onCancel={() => setRepeating(false)}
      />
      <ConfirmDialog
        open={removing !== null}
        message={t('confirm.removeTracks', { count: removing?.length ?? 0 })}
        confirmLabel={t('confirm.remove')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
