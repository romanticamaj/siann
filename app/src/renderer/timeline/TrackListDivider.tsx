// The track list / event display boundary (UI redesign spec 2.3): drags
// left-right within 140-420 px and never collapses; a role="separator" whose
// aria values are the list's width and range in px, in the project zone's Tab
// order (a stop of zoneRing, like the zone boundaries), with the boundary
// keys of m5-ui-shell: arrows 8 px, Shift+arrows 32 px, Home and End the
// minimum and maximum, Enter and double-click the default 216 px. Its keys run
// in a capture listener on the element and stop there, so none reaches the
// key-command preset. The width lives in siann.layout.v1 (the layout store).

import { useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';

import { useT } from '../i18n/t';
import { TRACK_LIST_MAX, TRACK_LIST_MIN, type TrackListAction } from '../shell/layout';
import type { LayoutStore } from '../shell/layout-store';

export function TrackListDivider({ layout }: { layout: LayoutStore }) {
  const t = useT();
  const width = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.trackList,
    () => layout.getSnapshot().layout.trackList,
  );
  const element = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = element.current;
    if (!el) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      let action: TrackListAction | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        action = { type: 'trackListStep', direction: event.key === 'ArrowRight' ? 1 : -1, large: event.shiftKey };
      } else if (event.shiftKey) {
        return;
      } else if (event.key === 'Home' || event.key === 'End') {
        action = { type: 'trackListEdge', edge: event.key === 'Home' ? 'min' : 'max' };
      } else if (event.key === 'Enter') {
        action = { type: 'trackListReset' };
      }
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      layout.dispatch(action);
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [layout]);

  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    const startX = event.clientX;
    const start = layout.getSnapshot().layout.trackList;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // a synthetic pointer without capture still delivers its events here
    }
    target.dataset.active = 'true';
    const move = (e: PointerEvent) => layout.dispatch({ type: 'trackListResize', size: start + (e.clientX - startX) });
    const up = (e: PointerEvent) => {
      move(e);
      delete target.dataset.active;
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
      ref={element}
      className="divider divider-tracklist"
      data-testid="separator-tracklist"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={TRACK_LIST_MIN}
      aria-valuemax={TRACK_LIST_MAX}
      aria-label={t('tracklist.resize')}
      tabIndex={0}
      onPointerDown={drag}
      onDoubleClick={() => layout.dispatch({ type: 'trackListReset' })}
    />
  );
}
