// The project zone's content (ADR-0019 point 3; UI redesign spec 2.1, 3.2,
// 3.3, 5.2): the toolbar (the media pool to place from, the Object Selection
// and Split tools, snap and the grid type, the delete button and the last
// refusal), the read-only info line, and below them the track list, its
// boundary and the event display, whose two canvases the imperative
// TimelineCanvas owns through refs. No drawing state passes through React:
// the track list follows the canvas's view through a listener, the meters
// and the cursor read the RealtimeClient on their own frames.
//
// The project zone's key commands (keys/preset-cubase.ts) are registered
// here: Delete and Backspace, Escape, H and G, Shift+H and Shift+G, Shift+F,
// T, and the editing keys of m5-ui-edit-basics (1, 3, Alt+X, Ctrl+D, J,
// Ctrl+A, L, N, B, Alt+S, Shift+E, M, S, Shift+Delete), and F (auto-scroll,
// m5-ui-transport). The capability rule (spec 3.0) is editGates: a key,
// button or control exists only when engine.capabilities lists the commands
// (or the method) it ends in, and the canvas sends no gesture whose commands
// are not listed (it reads the latest capabilities through a ref). Lane
// heights, the snap state and auto-scroll are the layout store's
// (siann.layout.v1). The track selection is the app's: M, S, N, B and
// Shift+Delete act on its tracks; Shift+Delete asks first.
// m5-ui-transport: a click in the ruler's lower half or a Shift+Alt-click in
// the event display locates through onLocate (only when engine.capabilities
// lists transport.locate), and the canvas follows the layout store's
// auto-scroll setting.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { refusalLine } from '../i18n/errors';
import { localeStore, translator, useLocale, type MessageKey } from '../i18n/t';
import type { CommandId, CommandRegistry } from '../keys/commands';
import type { CapabilitySelector } from '../model/capabilities';
import type { PeaksCache } from '../model/peaks-cache';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { Capable, useCapabilities } from '../shell/Capable';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { createLayoutStore, type LayoutStore } from '../shell/layout-store';
import type { TimelineCommand } from './commands';
import { removeTracksCommand, trackMuteCommand, trackSoloCommand } from './edit-commands';
import { InfoLine } from './InfoLine';
import type { TrackSelectMode } from './selection';
import { GRID_TYPES, type GridType } from './snap';
import { IDLE_STATE, TimelineCanvas, type TimelineTestHooks } from './TimelineCanvas';
import { TrackList, addTrack } from './TrackList';
import { TrackListDivider } from './TrackListDivider';
import { MAX_FRAMES_PER_PIXEL } from './zoom';

const EMPTY_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({});
const NO_IDS: readonly string[] = Object.freeze([]);

// Grid types Bar, Beat and Adapt to Zoom (snap type Grid only, spec 3.0).
const GRID_LABELS: Readonly<Record<GridType, MessageKey>> = { bar: 'grid.bar', beat: 'grid.beat', adapt: 'grid.adapt' };

// The zoom slider's scale: log2 of the frames per pixel.
const ZOOM_MAX = Math.log2(MAX_FRAMES_PER_PIXEL);

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
>;

// Which editing commands (keys, buttons) exist with these capabilities (UI
// redesign spec 3.0): each needs the commands it ends in (or, for L, N and
// B, the transport.locate method); selecting and zooming send nothing.
export function editGates(can: CapabilitySelector): Record<EditCommand, boolean> {
  const split = can.command('clip.trim') && can.command('clip.place');
  const locate = can.has('transport.locate');
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
}

function useSessionId(client: SessionClient): string | null {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().sessionId,
    () => client.getState().sessionId,
  );
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
  reconnects = 0,
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
  }, [client, peaks, realtime, layout, sessionId, onHooks, platform]);

  useEffect(() => {
    timeline?.setSnap(snap);
  }, [timeline, snap]);

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

  return (
    <section className="timeline">
      <div className="timeline-bar" data-part="toolbar">
        {gates['tool.select'] || gates['tool.split'] ? (
          <div className="tool-buttons" data-part="tools" role="group" aria-label={t('tool.label')}>
            {gates['tool.select'] ? (
              <button
                type="button"
                className="tool tool-select"
                data-testid="tool-select"
                data-part="tool-1"
                aria-pressed={state.tool === 'select'}
                title={t('tool.select')}
                onClick={() => timeline?.setTool('select')}
              >
                {t('tool.select')}
              </button>
            ) : null}
            {gates['tool.split'] ? (
              <button
                type="button"
                className="tool tool-split"
                data-testid="tool-split"
                data-part="tool-3"
                aria-pressed={state.tool === 'split'}
                title={t('tool.split')}
                onClick={() => timeline?.setTool('split')}
              >
                {t('tool.split')}
              </button>
            ) : null}
          </div>
        ) : null}
        {gates['edit.snapToggle'] ? (
          <div className="snap-controls">
            <button
              type="button"
              className="snap-toggle"
              data-testid="snap-toggle"
              data-part="snap"
              aria-pressed={snap.on}
              title={t('snap.toggle')}
              onClick={() => layout.dispatch({ type: 'snapToggle' })}
            >
              {t('snap.toggle')}
            </button>
            <select
              className="grid-type"
              data-testid="grid-type"
              data-part="grid-type"
              aria-label={t('snap.grid')}
              title={t('snap.grid')}
              value={snap.grid}
              onChange={(e) => layout.dispatch({ type: 'setGrid', grid: e.target.value as GridType })}
            >
              {GRID_TYPES.map((grid) => (
                <option key={grid} value={grid}>
                  {t(GRID_LABELS[grid])}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <ul className="media-pool" data-testid="media-pool" aria-label={t('timeline.mediaPool')}>
          {(snapshot?.media ?? []).map((media) => (
            <li key={media.id}>
              {canPlace ? (
                <button
                  type="button"
                  data-testid={`pool-${media.id}`}
                  aria-pressed={state.placingMediaId === media.id}
                  onClick={() => timeline?.setPlacing(state.placingMediaId === media.id ? null : media.id)}
                >
                  {media.id}
                </button>
              ) : (
                <span className="media-name">{media.id}</span>
              )}
            </li>
          ))}
        </ul>
        <Capable command="clip.remove">
          <button type="button" data-testid="delete-clip" disabled={!state.selectedClipId} onClick={() => void timeline?.deleteSelected()}>
            {t('timeline.deleteClip')}
          </button>
        </Capable>
        <Capable method="transport.play">
          <button
            type="button"
            className="auto-scroll"
            data-testid="auto-scroll"
            data-part="auto-scroll"
            aria-pressed={autoScroll}
            title={t('transport.autoScroll')}
            aria-label={t('transport.autoScroll')}
            onClick={() => layout.dispatch({ type: 'autoScroll' })}
          >
            <svg className="transport-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M2.5 8h7M7 5l3 3-3 3M13 3v10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Capable>
        <output className="timeline-error" data-testid="timeline-error" data-code={state.error?.code ?? undefined} title={t('timeline.lastError')}>
          {state.error ? refusalLine(state.error.code, state.error.message, locale) : ''}
        </output>
      </div>
      <InfoLine client={client} clipId={state.selectedClipId} />
      <div className="arrange" data-part="arrange" style={{ gridTemplateColumns: `${trackListWidth}px var(--divider-w) minmax(0, 1fr)` }}>
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
        <div className="event-display" data-testid="event-display" data-part="event-display" ref={displayRef}>
          <canvas ref={contentRef} data-testid="timeline-content" className="timeline-layer" />
          <canvas ref={overlayRef} data-testid="timeline-canvas" className="timeline-layer timeline-overlay" />
          <div ref={tooltipRef} className="drag-tooltip" data-testid="drag-tooltip" role="status" hidden />
          {timeline ? (
            <input
              type="range"
              className="zoom-slider"
              data-testid="zoom-slider" data-part="scroll-zoom"
              aria-label={t('timeline.zoom')}
              min={0}
              max={ZOOM_MAX}
              step={0.25}
              value={ZOOM_MAX - Math.log2(Math.max(1, framesPerPixel))}
              onChange={(e) => timeline.setFramesPerPixel(Math.round(Math.pow(2, ZOOM_MAX - Number(e.target.value))))}
            />
          ) : null}
        </div>
      </div>
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
