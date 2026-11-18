// The track list (UI redesign spec 3.3; Cubase's track list beside the event
// display), ported from the mockup (m5-ui-port-track-list; spec 10.9, 10.10
// P1-15): the app.innerHTML template's div.headers with its head (.corner:
// the add button .add and the count .cnt), the marker row's box, and one
// header per track in root.trackOrder as th() returns it (.th with --c, .col,
// .idx, and .body with .r1: the name, M and S; and .r2: gain, pan and the
// .hmeter well), styled by ui/project-zone.css. The headers are keyed and
// memoized by track id, so a commit re-renders the headers whose track
// changed. They are not a DOM scroll: the column is translated by the event
// display's vertical scroll from the canvas's view listener, in the same
// animation frame the canvas draws. The mini meters are one canvas over the
// column (HeaderMeters) that paints inside each .hmeter well, with no React
// commit.
//
// Absent parts keep their space empty (spec 3.0): the marker row's box until
// m5b-ui-markers, the boxes of record, read and write in .r1 (m5b-ui-recording,
// m6a-ui-automation), and M, S and the add button when engine.capabilities
// does not list their commands.
//
// The plan under review (m5b-ui-ghosts; UI redesign 4.2): a proposed track is
// th() for the mockup's ghost track (GhostHeader: .th.ghost, "+", its step
// badge, its name and "proposed track", the summary in .r2) after the last
// header, at the height of a lane; a header carries its track's ghosts: the
// dashed ring on M or S (th()'s .msr.ghost), and, as elements the mockup has
// no markup for, the gain readout with both values without their unit
// (4.2's "-9.0 → -6.0", .ghost-to; shell.css lets its cell grow so it clears
// the pan readout), both names of a rename (plans/RenameGhost.tsx), and for a
// removed track the dimming its strip has (.ghost-removed) and its step badge
// before the name. A click on a proposed header pins its step.
//
// Double-click a name to rename it (Enter commits one track.rename; Escape
// and leaving the field cancel); the add button above the list and a
// double-click on the empty space below the last header add a track
// (track.add, as the T key does); a header's lower border drags its lane's
// height, with Ctrl every lane's, kept per session id in siann.layout.v1. A
// muted track, or one muted by another's solo, takes .muted (spec 1.2: the
// shared rule dims its name and second row to 45 %). A click on a header
// selects its track, Ctrl-click (Cmd on macOS) adds or removes it, Shift-click
// selects the range from the primary track (m5-ui-edit-basics); the selection
// is the app's.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';

import { formatDb, formatPan } from '../format';
import { useT, type T } from '../i18n/t';
import type { TrackEntity } from '../model/document';
import type { RealtimeClient } from '../model/realtime-client';
import type { Snapshot } from '../model/read-model';
import type { SessionClient } from '../model/session-client';
import { ghostAttrs, NO_GHOSTS, useGhostView, type GhostView } from '../plans/ghost-context';
import { trackGhosts, type Ghost, type TrackGhosts } from '../plans/ghosts';
import { ISOLATE } from '../plans/isolate';
import { useEditGuard } from '../plans/heard-context';
import { RenameGhost, renameTitle } from '../plans/RenameGhost';
import { Capable, useCapabilities } from '../shell/Capable';
import { Hold } from '../shell/Hold';
import { Icon } from '../shell/icons';
import type { LayoutStore } from '../shell/layout-store';
import { dimmedTracks } from './dimming';
import { DEFAULT_LANE_HEIGHT, clampLaneHeight } from './geometry';
import { HeaderMeters, type SlotRect } from './HeaderMeters';
import type { TrackSelectMode } from './selection';
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
  // Every selected track (the primary alone when absent).
  readonly selectedTrackIds?: readonly string[];
  readonly onSelectTrack: (trackId: string, mode: TrackSelectMode) => void;
}

// Registers a header's .hmeter well with the meter surface; returns its removal.
type RegisterMeter = (ref: string, well: HTMLElement) => () => void;

const EMPTY_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({});
// A gain as the header's ghost readout writes it: the value without its unit.
const bareDb = (milliDb: number) => formatDb(milliDb).replace(/ dB$/, '');
const NO_TRACK_GHOSTS: TrackGhosts = Object.freeze({ gain: [], pan: [], mute: [], solo: [], rename: [], remove: null, steps: [] });
const NOTHING = () => undefined;

// A well's inside (within its border) in the canvas's CSS px.
function wellIn(well: HTMLElement, canvas: HTMLCanvasElement | null): SlotRect | null {
  if (!canvas || !well.isConnected || well.getClientRects().length === 0) return null;
  const box = well.getBoundingClientRect();
  const origin = canvas.getBoundingClientRect();
  return { x: box.left - origin.left + well.clientLeft, y: box.top - origin.top + well.clientTop, width: well.clientWidth, height: well.clientHeight };
}

export function TrackList({ client, realtime, timeline, layout, sessionId = null, selectedTrackId, selectedTrackIds, onSelectTrack }: TrackListProps) {
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
  const body = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);
  const meters = useRef<HTMLCanvasElement | null>(null);
  const [surface, setSurface] = useState<HeaderMeters | null>(null);
  const order = snapshot?.trackOrder ?? [];
  const dimmed = dimmedTracks(snapshot?.tracks ?? []);
  const selected = new Set(selectedTrackIds ?? (selectedTrackId ? [selectedTrackId] : []));
  const view = useGhostView();

  // The column follows the event display's vertical scroll, in the canvas's
  // frame; the meter wells move with it.
  useEffect(() => {
    if (!timeline) return undefined;
    const follow = () => {
      const el = column.current;
      if (!el) return;
      const transform = `translateY(${-(timeline.getView().scrollY ?? 0)}px)`;
      if (el.style.transform !== transform) el.style.transform = transform;
      surface?.remeasure();
    };
    follow();
    return timeline.subscribeView(follow);
  }, [timeline, surface]);

  // The mini meters: one canvas over the column, painting in each header's well.
  useEffect(() => {
    const canvas = meters.current;
    if (!canvas || !realtime) return undefined;
    const next = new HeaderMeters({ canvas, realtime, size: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }) });
    next.start();
    setSurface(next);
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => next.remeasure()) : null;
    if (body.current) resized?.observe(body.current);
    if (column.current) resized?.observe(column.current);
    return () => {
      resized?.disconnect();
      next.stop();
      setSurface(null);
    };
  }, [realtime]);

  // A commit can move the wells (a header added above, a lane height, a rename).
  useLayoutEffect(() => {
    surface?.remeasure();
  });

  const registerMeter = useCallback<RegisterMeter>(
    (ref, well) => (surface ? surface.addSlot({ ref, measure: () => wellIn(well, meters.current) }) : NOTHING),
    [surface],
  );

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
  const guard = useEditGuard();
  const canAdd = can.command('track.add') && guard === null;
  const addOnEmptySpace = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('.th')) return;
    addTrack(client, t);
  };

  return (
    <div className="headers" data-testid="track-list" data-part="track-list" role="group" aria-label={t('tracklist.label')}>
      <div className="corner" data-part="track-list-head">
        <Capable command="track.add">
          <button
            type="button"
            className="add"
            data-testid="track-add" data-part="track-add"
            aria-label={t('tracklist.add')}
            title={guard ?? t('tracklist.add')}
            disabled={guard !== null}
            onClick={() => addTrack(client, t)}
          >
            <Icon name="plus" small />
            {t('tracklist.addLabel')}
          </button>
        </Capable>
        <span className="cnt" data-testid="track-count" data-part="track-count">
          {t('tracklist.count', { tracks: order.length, clips: snapshot?.clips.length ?? 0 })}
        </span>
      </div>
      {/* The marker track row beside the event display's (--marker-h): empty
          until m5b-ui-markers, so headers and lanes stay level (UI redesign 3.0).
          Not .mk, which draws the marker row. */}
      <div aria-hidden="true" />
      <div
        className="track-list-body"
        data-testid="track-list-body"
        data-addable={canAdd ? 'true' : undefined}
        onDoubleClick={canAdd ? addOnEmptySpace : undefined}
        ref={body}
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
                selected={selected.has(trackId)}
                canRename={can.command('track.rename') && guard === null}
                guard={guard}
                client={client}
                registerMeter={registerMeter}
                onSelect={onSelectTrack}
                onResize={resizeLane}
                ghosts={view.ghosts.length > 0 ? trackGhosts(view.ghosts, trackId) : NO_TRACK_GHOSTS}
                view={view}
              />
            );
          })}
          {view.ghosts.map((g) => (g.kind === 'track-add' ? <GhostHeader key={`ghost-${g.trackId}`} ghost={g} view={view} /> : null))}
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
  // Muted, or muted by another track's solo (spec 1.2).
  readonly dimmed: boolean;
  readonly selected: boolean;
  readonly canRename: boolean;
  // The edit guard's reason while a proposal is heard (m5b-ui-audition): M and S are disabled with it.
  readonly guard?: string | null;
  readonly client: SessionClient;
  readonly registerMeter: RegisterMeter;
  readonly onSelect: (trackId: string, mode: TrackSelectMode) => void;
  readonly onResize: (trackId: string, all: boolean, height: number) => void;
  // The plan under review's ghosts on this track (m5b-ui-ghosts); none when absent.
  readonly ghosts?: TrackGhosts;
  readonly view?: GhostView;
}

const TrackHeader = memo(function TrackHeader({ registerMeter, ...props }: TrackHeaderProps) {
  const [editing, setEditing] = useState(false);
  const well = useRef<HTMLSpanElement | null>(null);
  const id = props.track.id;
  useEffect(() => {
    const el = well.current;
    return el ? registerMeter(`track:${id}`, el) : undefined;
  }, [registerMeter, id]);
  return <TrackHeaderView {...props} editing={editing} onEditing={setEditing} meterRef={well} />;
});

export interface TrackHeaderViewProps extends Omit<TrackHeaderProps, 'registerMeter'> {
  // The name gives way to the rename field.
  readonly editing: boolean;
  readonly onEditing: (editing: boolean) => void;
  readonly meterRef?: Ref<HTMLSpanElement>;
}

// th() for one track: what the header shows for a given editing state.
export function TrackHeaderView({ track, number, height, dimmed, selected, canRename, guard = null, client, editing, onEditing, meterRef, onSelect, onResize, ghosts = NO_TRACK_GHOSTS, view }: TrackHeaderViewProps) {
  const t = useT();
  const can = useCapabilities();
  const id = track.id;

  const commitName = (snapshot: Snapshot | null, name: string) => {
    onEditing(false);
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

  const classes = ['th', dimmed ? 'muted' : '', selected ? 'sel' : '', ghosts.remove ? 'ghost-removed' : ''].filter(Boolean).join(' ');
  const style = { '--c': `var(${trackColourVar(id)})`, height: `${height}px` } as CSSProperties;
  const gain = ghosts.gain.at(-1);
  const rename = ghosts.rename.at(-1);
  const attrs = view && ghosts.steps.length > 0 ? ghostAttrs(view, ghosts.steps) : {};
  return (
    <div
      className={classes}
      data-testid={`track-header-${id}`} data-part-item="track"
      data-dimmed={dimmed ? 'true' : undefined}
      aria-selected={selected}
      style={style}
      {...attrs}
      onPointerDown={(e) => onSelect(id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace')}
    >
      <div className="col" data-testid={`track-colour-${id}`} data-part-of="colour" />
      <div className="idx" data-testid={`track-number-${id}`} data-part-of="number">
        {number}
      </div>
      <div className="body">
        <div className="r1">
          {ghosts.remove ? (
            <span className="stepn" style={{ marginRight: 'var(--space-3q)' }}>
              {String(ghosts.remove.step)}
            </span>
          ) : null}
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
                  onEditing(false);
                }
              }}
              onBlur={() => onEditing(false)}
            />
          ) : (
            <span
              className="name"
              {...ISOLATE}
              data-testid={`track-name-${id}`} data-part-of="name"
              data-renamable={canRename ? 'true' : undefined}
              title={renameTitle(track.name, rename?.after)}
              onDoubleClick={canRename ? () => onEditing(true) : undefined}
            >
              {rename ? <RenameGhost before={track.name} after={rename.after} step={rename.step} view={view ?? NO_GHOSTS} /> : track.name}
            </span>
          )}
          {can.command('track.set_mute') ? (
            <button
              type="button"
              className={`msr m${track.mute ? ' on' : ''}${ghosts.mute.length > 0 ? ' ghost' : ''}`}
              data-testid={`track-mute-${id}`} data-part-of="mute"
              {...(ghosts.mute.at(-1)?.mode ? { 'data-ghost-mode': 'solid' } : {})}
              disabled={guard !== null}
              title={guard ?? undefined}
              aria-pressed={track.mute}
              aria-label={t('tracklist.mute', { track: track.name })}
              onClick={() => toggle('track.set_mute')}
            >
              M
            </button>
          ) : (
            <Hold className="msr-box" />
          )}
          {can.command('track.set_solo') ? (
            <button
              type="button"
              className={`msr s${track.solo ? ' on' : ''}${ghosts.solo.length > 0 ? ' ghost' : ''}`}
              data-testid={`track-solo-${id}`} data-part-of="solo"
              {...(ghosts.solo.at(-1)?.mode ? { 'data-ghost-mode': 'solid' } : {})}
              disabled={guard !== null}
              title={guard ?? undefined}
              aria-pressed={track.solo}
              aria-label={t('tracklist.solo', { track: track.name })}
              onClick={() => toggle('track.set_solo')}
            >
              S
            </button>
          ) : (
            <Hold className="msr-box" />
          )}
          {/* Record (m5b-ui-recording), read and write (m6a-ui-automation): empty boxes. */}
          <Hold className="msr-box" />
          <Hold className="msr-box" />
          <Hold className="msr-box" />
        </div>
        <div className="r2">
          <span className="db num" data-testid={`track-gain-${id}`} data-part-of="gain">
            {gain ? `${bareDb(gain.mode === 'solid' ? track.gainMilliDb : (gain.before ?? track.gainMilliDb))} ` : formatDb(track.gainMilliDb)}
            {gain ? <span className="ghost-to">{`→ ${bareDb(gain.after)}`}</span> : null}
          </span>
          <span className="pan num" data-testid={`track-pan-${id}`} data-part-of="pan">
            {formatPan(track.pan)}
          </span>
          <span
            className="hmeter"
            ref={meterRef}
            data-testid={`track-meter-${id}`} data-part-of="meter"
            aria-label={t('tracklist.meter', { track: track.name })}
          />
        </div>
      </div>
      <div
        className="track-resize"
        data-testid={`track-resize-${id}`}
        aria-label={t('tracklist.height', { track: track.name })}
        onPointerDown={startResize}
      />
    </div>
  );
}

// th() for a proposed track (m5b-ui-ghosts; mockup.html's ghost track): .th.ghost
// on the AI colour, "+" for its number, its step badge before its name, the
// mockup's "proposed track" and its summary; the ids of the mockup's
// track-ghost (or track-ghost-2 for a later proposed track). A press pins its step.
function GhostHeader({ ghost, view }: { ghost: Extract<Ghost, { kind: 'track-add' }>; view: GhostView }) {
  const t = useT();
  const style = { '--c': 'var(--ai)', height: `${DEFAULT_LANE_HEIGHT}px` } as CSSProperties;
  const channels = t(ghost.channels === 1 ? 'row.mono' : 'row.stereo');
  return (
    <div className="th ghost" data-testid={`track-header-${ghost.key}`} data-part-item="track" data-part-key={ghost.key} style={style} {...ghostAttrs(view, [ghost.step])} onPointerDown={() => view.pin(ghost.step)}>
      <div className="col" data-part-of="colour" />
      <div className="idx" data-part-of="number">
        +
      </div>
      <div className="body">
        <div className="r1">
          <span className="stepn" style={{ marginRight: 'var(--space-3q)' }}>
            {String(ghost.step)}
          </span>
          <span className="name" data-part-of="name" {...ISOLATE} title={ghost.name}>
            {ghost.name}
          </span>
          <span style={{ color: 'var(--ai-2)', fontSize: 'var(--fs-10h)', whiteSpace: 'nowrap' }}>{t('ghost.proposed')}</span>
        </div>
        <div className="r2">
          <span>{t('ghost.trackSummary', { channels, gain: formatDb(0), pan: formatPan(0) })}</span>
        </div>
      </div>
    </div>
  );
}
