// The project zone's content (ADR-0019 point 3; UI redesign spec 2.1, 3.2,
// 3.3, 5.2): the toolbar (the media pool to place from, the delete button and
// the last refusal), the read-only info line, and below them the track list,
// its boundary and the event display, whose two canvases the imperative
// TimelineCanvas owns through refs. No drawing state passes through React:
// the track list follows the canvas's view through a listener, the meters
// and the cursor read the RealtimeClient on their own frames.
//
// The project zone's key commands (keys/preset-cubase.ts) are registered
// here: Delete and Backspace, Escape, H and G, Shift+H and Shift+G, Shift+F,
// and T. The capability rule (spec 3.0): the media pool's place buttons exist
// only when engine.capabilities lists clip.place, the delete button and key
// only with clip.remove, T only with track.add, and the canvas sends no
// gesture whose commands are not listed (it reads the latest capabilities
// through a ref). Lane heights are the layout store's, per session id.
// m5-ui-transport: a click in the ruler's lower half or a Shift+Alt-click in
// the event display locates through onLocate (only when engine.capabilities lists transport.locate), and the
// canvas follows the layout store's auto-scroll setting.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { refusalLine } from '../i18n/errors';
import { localeStore, translator, useLocale } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { PeaksCache } from '../model/peaks-cache';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { Capable, useCapabilities } from '../shell/Capable';
import { createLayoutStore, type LayoutStore } from '../shell/layout-store';
import { InfoLine } from './InfoLine';
import { TimelineCanvas, type TimelineState, type TimelineTestHooks } from './TimelineCanvas';
import { TrackList, addTrack } from './TrackList';
import { TrackListDivider } from './TrackListDivider';
import { MAX_FRAMES_PER_PIXEL } from './zoom';

const IDLE: TimelineState = { selectedClipId: null, placingMediaId: null, error: null };
const EMPTY_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({});

// The zoom slider's scale: log2 of the frames per pixel.
const ZOOM_MAX = Math.log2(MAX_FRAMES_PER_PIXEL);

export interface TimelineProps {
  readonly client: SessionClient;
  readonly peaks: PeaksCache;
  readonly commands: CommandRegistry;
  // The zone layout (the track list's width, the lane heights); a private one when absent.
  readonly layout?: LayoutStore;
  readonly realtime?: RealtimeClient | null;
  readonly selectedTrackId?: string | null;
  readonly onSelectTrack?: (trackId: string) => void;
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

export function Timeline({
  client,
  peaks,
  commands,
  layout: given,
  realtime = null,
  selectedTrackId = null,
  onSelectTrack,
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
  const can = useCapabilities();
  const canRef = useRef(can);
  canRef.current = can;
  const locateRef = useRef(onLocate);
  locateRef.current = onLocate;
  const canRemove = can.command('clip.remove');
  const canPlace = can.command('clip.place');
  const canAdd = can.command('track.add');
  const trackListWidth = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.trackList,
    () => layout.getSnapshot().layout.trackList,
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
      onLocate: (frames) => {
        if (canRef.current.has('transport.locate')) locateRef.current?.(frames);
      },
      autoScroll: layout.getSnapshot().layout.autoScroll,
    });
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
  }, [client, peaks, realtime, layout, sessionId, onHooks]);

  const state = useSyncExternalStore(
    (listener) => (timeline ? timeline.subscribe(listener) : () => {}),
    () => (timeline ? timeline.getState() : IDLE),
    () => (timeline ? timeline.getState() : IDLE),
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

  useEffect(() => {
    if (!timeline) return undefined;
    const offs = [
      commands.register('project', 'edit.cancel', () => timeline.setPlacing(null)),
      commands.register('project', 'view.zoomIn', () => timeline.zoomIn()),
      commands.register('project', 'view.zoomOut', () => timeline.zoomOut()),
      commands.register('project', 'view.tracksTaller', () => timeline.tracksTaller()),
      commands.register('project', 'view.tracksShorter', () => timeline.tracksShorter()),
      commands.register('project', 'view.zoomFull', () => timeline.zoomFull()),
    ];
    if (canRemove) offs.push(commands.register('project', 'edit.delete', () => void timeline.deleteSelected()));
    if (canAdd) offs.push(commands.register('project', 'track.add', () => addTrack(client, translator(localeStore().getSnapshot()))));
    return () => offs.forEach((off) => off());
  }, [timeline, commands, canRemove, canAdd, client]);

  useEffect(() => {
    onSelect?.(state.selectedClipId);
  }, [onSelect, state.selectedClipId]);

  // A reconnect clears the selection (UI redesign spec 4.5 C8).
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (!timeline || reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    timeline.clearSelection();
  }, [timeline, reconnects]);

  const selectTrack = useCallback((trackId: string) => onSelectTrack?.(trackId), [onSelectTrack]);

  return (
    <section className="timeline">
      <div className="timeline-bar" data-part="toolbar">
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
    </section>
  );
}
