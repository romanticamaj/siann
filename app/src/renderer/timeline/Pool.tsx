// The Pool (m5-ui-port-toolbar; UI redesign 10.8, 1): Cubase's Pool, an
// app-only window over the project zone that the resting window does not
// show. Ctrl+P (Cmd+P on macOS; pool.open, a window command of the Cubase
// preset) and the event display's context menu open it, Escape closes it. It
// lists the session's media by name (the media id when there is none); with
// clip.place a click on one arms placing, as the toolbar's media buttons did
// (a second click on the armed one disarms it), and the Pool steps aside so
// the next click lands in the event display. The mockup has no Pool, so its
// styles are shell.css's, from tokens (spec 10.7, 4). m5b-ui-media's Media
// tab replaces it and keeps Ctrl+P opening it.

import { useEffect, useRef } from 'react';

import { useT, type T } from '../i18n/t';
import type { MediaEntity } from '../model/document';

export interface PoolViewProps {
  readonly media: readonly MediaEntity[];
  // The media a click on a lane places (the armed one), or null.
  readonly placingMediaId: string | null;
  // Whether the engine lists clip.place: without it the names are plain text.
  readonly canPlace: boolean;
  readonly onPlace: (mediaId: string | null) => void;
  readonly onClose: () => void;
  readonly t: T;
}

const nameOf = (media: MediaEntity) => (media.name ? media.name : media.id);

// The Pool's content, without effects.
export function PoolView({ media, placingMediaId, canPlace, onPlace, onClose, t }: PoolViewProps) {
  return (
    <div className="pool" role="dialog" aria-label={t('pool.title')} data-testid="media-pool">
      <div className="pool-head">{t('pool.title')}</div>
      {media.length === 0 ? <p className="pool-empty">{t('pool.empty')}</p> : null}
      <ul className="pool-list">
        {media.map((row) => (
          <li key={row.id}>
            {canPlace ? (
              <button
                type="button"
                className="pool-item"
                data-testid={`pool-${row.id}`}
                aria-pressed={placingMediaId === row.id}
                dir="auto"
                onClick={() => {
                  onPlace(placingMediaId === row.id ? null : row.id);
                  onClose();
                }}
              >
                {nameOf(row)}
              </button>
            ) : (
              <span className="pool-item" dir="auto">
                {nameOf(row)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Escape closes the Pool.
export function poolKeyHandler(onClose: () => void): (event: { key: string; preventDefault(): void }) => void {
  return (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };
}

export interface PoolProps extends Omit<PoolViewProps, 't'> {
  readonly open: boolean;
}

export function Pool({ open, ...props }: PoolProps) {
  const t = useT();
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = poolKeyHandler(() => close.current());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!open) return null;
  return <PoolView {...props} t={t} />;
}

export interface EventDisplayMenuProps {
  // Where it opened (client coordinates).
  readonly x: number;
  readonly y: number;
  readonly onOpenPool: () => void;
  readonly onClose: () => void;
}

// The event display's context menu (right-click; the time format menu's
// pattern): one item, Open Pool. Escape or a press outside closes it.
export function EventDisplayMenu({ x, y, onOpenPool, onClose }: EventDisplayMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close.current();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
  return (
    <div className="event-display-menu" data-testid="event-display-menu" role="menu" aria-label={t('pool.menu')} style={{ left: x, top: y }} ref={ref}>
      <button type="button" role="menuitem" className="time-format-item" data-testid="menu-open-pool" onClick={onOpenPool}>
        {t('pool.open')}
      </button>
    </div>
  );
}
