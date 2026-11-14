// The track list (UI redesign spec 3.3; Cubase's track list beside the event
// display): one header per track in root.trackOrder with its colour, number,
// name, M and S, gain in dB and pan as L/C/R, and a mini meter cell. The
// headers are DOM, keyed and memoized by track id, so a commit re-renders the
// headers whose track changed. They are not a DOM scroll: the column is
// translated by the event display's vertical scroll from the canvas's view
// listener, in the same animation frame the canvas draws. The mini meters are
// one canvas down the column (HeaderMeters), with no React commit.
//
// Double-click a name to rename it (Enter commits one track.rename; Escape
// and leaving the field cancel); the + button above the list and a
// double-click on the empty space below the last header add a track
// (track.add, as the T key does); a header's lower border drags its lane's
// height, with Ctrl every lane's, kept per session id in siann.layout.v1. A
// muted track, or one muted by another's solo, is dimmed. Every control that
// sends a command exists only when engine.capabilities lists it (spec 3.0).

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { formatDb, formatPan } from '../format';
import { useT, type T } from '../i18n/t';
import type { TrackEntity } from '../model/document';
import type { RealtimeClient } from '../model/realtime-client';
import type { Snapshot } from '../model/read-model';
import type { SessionClient } from '../model/session-client';
import { Capable, useCapabilities } from '../shell/Capable';
import type { LayoutStore } from '../shell/layout-store';
import { DIMMED_ALPHA, dimmedTracks } from './dimming';
import { DEFAULT_LANE_HEIGHT, clampLaneHeight, laneHeightOf, laneTops } from './geometry';
import { HeaderMeters, type MeterRow } from './HeaderMeters';
import { addTrackCommand, nextTrackName, renameTrackCommand } from './track-commands';
import { trackColourVar } from './track-colour';
import type { TimelineCanvas } from './TimelineCanvas';

// Adds a track named by the catalog's default name with the next free number.
export function addTrack(client: SessionClient, t: T): void {
  const snapshot = client.model.getSnapshot();
  if (!snapshot) return;
  const name = nextTrackName(snapshot, (n) => t('track.defaultName', { n: String(n) }));
  const command = addTrackCommand(snapshot, name);
  void client.execute(command.commands, command.expectedRevision).catch(() => undefined);
}

export interface TrackListProps {
  readonly client: SessionClient;
  readonly realtime: RealtimeClient | null;
  readonly timeline: TimelineCanvas | null;
  readonly layout: LayoutStore;
  // Whose lane heights these are (siann.layout.v1 keeps them per session id).
  readonly sessionId?: string | null;
  readonly selectedTrackId: string | null;
  readonly onSelectTrack: (trackId: string) => void;
}

const EMPTY_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({});

export function TrackList({ client, realtime, timeline, layout, sessionId = null, selectedTrackId, onSelectTrack }: TrackListProps) {
  const t = useT();
  const can = useCapabilities();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const heights = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => (sessionId !== null ? layout.getSnapshot().layout.trackHeights[sessionId] : undefined) ?? EMPTY_HEIGHTS,
    () => EMPTY_HEIGHTS,
  );
  const column = useRef<HTMLDivElement | null>(null);
  const meters = useRef<HTMLCanvasElement | null>(null);
  const order = snapshot?.trackOrder ?? [];
  const dimmed = dimmedTracks(snapshot?.tracks ?? []);

  // The column follows the event display's vertical scroll, in the canvas's frame.
  useEffect(() => {
    if (!timeline) return undefined;
    const follow = () => {
      const el = column.current;
      if (!el) return;
      const transform = `translateY(${-(timeline.getView().scrollY ?? 0)}px)`;
      if (el.style.transform !== transform) el.style.transform = transform;
    };
    follow();
    return timeline.subscribeView(follow);
  }, [timeline]);

  // The mini meters: one canvas, its rows from the canvas's view.
  useEffect(() => {
    const canvas = meters.current;
    if (!canvas || !realtime || !timeline) return undefined;
    const rows = (): MeterRow[] => {
      const current = client.model.getSnapshot();
      const view = timeline.getView();
      const trackOrder = current?.trackOrder ?? [];
      const tops = laneTops(trackOrder, view);
      return trackOrder.map((id, index) => ({ ref: `track:${id}`, top: tops[index]! - view.rulerHeight, height: laneHeightOf(id, view) }));
    };
    const surface = new HeaderMeters(canvas, realtime, rows);
    surface.start();
    return () => surface.stop();
  }, [client, realtime, timeline]);

  const orderRef = useRef(order);
  orderRef.current = order;
  // Stable, so a header re-renders only when its own track changes.
  const resizeLane = useCallback(
    (trackId: string, all: boolean, height: number) => {
      if (sessionId === null) return;
      if (all) layout.dispatch({ type: 'allTrackHeights', sessionId, trackIds: orderRef.current, height });
      else layout.dispatch({ type: 'trackHeight', sessionId, trackId, height });
    },
    [layout, sessionId],
  );

  // A double-click on the empty space below the last header adds a track
  // (spec 3.3); one on a header (its name renames) adds nothing.
  const canAdd = can.command('track.add');
  const addOnEmptySpace = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('.track-header')) return;
    addTrack(client, t);
  };

  return (
    <div className="track-list" data-testid="track-list" role="group" aria-label={t('tracklist.label')}>
      <div className="track-list-head">
        <Capable command="track.add">
          <button
            type="button"
            className="track-add"
            data-testid="track-add"
            aria-label={t('tracklist.add')}
            title={t('tracklist.add')}
            onClick={() => addTrack(client, t)}
          />
        </Capable>
      </div>
      <div
        className="track-list-body"
        data-testid="track-list-body"
        data-addable={canAdd ? 'true' : undefined}
        onDoubleClick={canAdd ? addOnEmptySpace : undefined}
      >
        <div className="track-list-column" ref={column}>
          {order.map((trackId, index) => {
            const track = snapshot?.entities[`track:${trackId}`] as TrackEntity | undefined;
            if (!track || !snapshot) return null;
            return (
              <TrackHeader
                key={trackId}
                track={track}
                number={index + 1}
                height={clampLaneHeight(heights[trackId] ?? DEFAULT_LANE_HEIGHT)}
                dimmed={dimmed.has(trackId)}
                selected={selectedTrackId === trackId}
                canRename={can.command('track.rename')}
                client={client}
                onSelect={onSelectTrack}
                onResize={resizeLane}
              />
            );
          })}
        </div>
        {realtime ? <canvas className="track-meters" data-testid="track-meters" ref={meters} /> : null}
      </div>
    </div>
  );
}

interface TrackHeaderProps {
  readonly track: TrackEntity;
  readonly number: number;
  readonly height: number;
  readonly dimmed: boolean;
  readonly selected: boolean;
  readonly canRename: boolean;
  readonly client: SessionClient;
  readonly onSelect: (trackId: string) => void;
  readonly onResize: (trackId: string, all: boolean, height: number) => void;
}

const TrackHeader = memo(function TrackHeader({ track, number, height, dimmed, selected, canRename, client, onSelect, onResize }: TrackHeaderProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const id = track.id;

  const commitName = (snapshot: Snapshot | null, name: string) => {
    setEditing(false);
    if (!snapshot) return;
    const command = renameTrackCommand(snapshot, id, name);
    if (command) void client.execute(command.commands, command.expectedRevision).catch(() => undefined);
  };

  const toggle = (op: 'track.set_mute' | 'track.set_solo') => {
    const field = op === 'track.set_mute' ? 'mute' : 'solo';
    const revision = client.model.getSnapshot()?.revision;
    void client.execute([{ op, trackId: id, [field]: !track[field] }], revision).catch(() => undefined);
  };

  // The lower border: a vertical drag sizes this lane, with Ctrl every lane.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    const all = event.ctrlKey || event.metaKey;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // a synthetic pointer without capture still delivers its events here
    }
    const move = (e: PointerEvent) => onResize(id, all, startHeight + (e.clientY - startY));
    const up = (e: PointerEvent) => {
      move(e);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <div
      className="track-header"
      data-testid={`track-header-${id}`}
      data-dimmed={dimmed ? 'true' : undefined}
      aria-selected={selected}
      style={{ height: `${height}px`, opacity: dimmed ? DIMMED_ALPHA : undefined }}
      onPointerDown={() => onSelect(id)}
    >
      <span className="track-colour" data-testid={`track-colour-${id}`} style={{ background: `var(${trackColourVar(id)})` }} />
      <span className="track-number" data-testid={`track-number-${id}`}>
        {number}
      </span>
      {editing ? (
        <input
          className="track-rename"
          data-testid={`track-rename-${id}`}
          aria-label={t('tracklist.rename', { track: track.name })}
          defaultValue={track.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitName(client.model.getSnapshot(), e.currentTarget.value);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <span
          className="track-name"
          data-testid={`track-name-${id}`}
          data-renamable={canRename ? 'true' : undefined}
          title={track.name}
          onDoubleClick={canRename ? () => setEditing(true) : undefined}
        >
          {track.name}
        </span>
      )}
      <span className="track-buttons">
        <Capable command="track.set_mute">
          <button
            type="button"
            className="track-mute"
            data-testid={`track-mute-${id}`}
            aria-pressed={track.mute}
            aria-label={t('tracklist.mute', { track: track.name })}
            onClick={() => toggle('track.set_mute')}
          >
            M
          </button>
        </Capable>
        <Capable command="track.set_solo">
          <button
            type="button"
            className="track-solo"
            data-testid={`track-solo-${id}`}
            aria-pressed={track.solo}
            aria-label={t('tracklist.solo', { track: track.name })}
            onClick={() => toggle('track.set_solo')}
          >
            S
          </button>
        </Capable>
      </span>
      <span className="track-readouts">
        <span className="track-gain" data-testid={`track-gain-${id}`}>
          {formatDb(track.gainMilliDb)}
        </span>
        <span className="track-pan" data-testid={`track-pan-${id}`}>
          {formatPan(track.pan)}
        </span>
      </span>
      <span className="track-meter" data-testid={`track-meter-${id}`} aria-label={t('tracklist.meter', { track: track.name })} />
      <div
        className="track-resize"
        data-testid={`track-resize-${id}`}
        aria-label={t('tracklist.height', { track: track.name })}
        onPointerDown={startResize}
      />
    </div>
  );
});
