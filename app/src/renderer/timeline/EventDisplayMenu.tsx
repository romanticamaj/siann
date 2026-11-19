// The event display's context menu (right-click; the time format menu's
// pattern): one item, Open Media, which shows the right zone on the Media tab
// (m5b-ui-media; UR-5, UI redesign 10.8, 1: the tab replaced the Pool, whose
// item this was). Escape or a press outside closes it. Rendered only while
// the engine has a Media tab.

import { useEffect, useRef } from 'react';

import { useT } from '../i18n/t';

export interface EventDisplayMenuProps {
  // Where it opened (client coordinates).
  readonly x: number;
  readonly y: number;
  readonly onOpenMedia: () => void;
  readonly onClose: () => void;
}

export function EventDisplayMenu({ x, y, onOpenMedia, onClose }: EventDisplayMenuProps) {
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
    <div className="event-display-menu" data-testid="event-display-menu" role="menu" aria-label={t('media.menu')} style={{ left: x, top: y }} ref={ref}>
      <button type="button" role="menuitem" className="time-format-item" data-testid="menu-open-media" onClick={onOpenMedia}>
        {t('media.open')}
      </button>
    </div>
  );
}
