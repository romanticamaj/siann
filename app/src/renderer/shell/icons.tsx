// The chrome's icons (m5-ui-alignment-chrome): the drawings of the mockup's
// `P` table (mockup.html, "icons (own drawings, 16px grid, stroke)"), copied
// path for path, in the mockup's markup: an `svg.i` (16 px) or `svg.i.s`
// (14 px) styled by ui/base.css (stroke currentColor, no fill). Decorative:
// hidden from assistive technology; the control names itself.

import type { ReactNode } from 'react';

const PATHS = {
  rtz: (
    <>
      <path d="M4 3.5v9" />
      <path d="M12.5 3.5 6.5 8l6 4.5z" fill="currentColor" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  play: <path d="M5 3.2v9.6L13 8z" fill="currentColor" stroke="none" />,
  loop: (
    <>
      <path d="M11 2.5 13 4.5 11 6.5" />
      <path d="M3 7.5V6a1.5 1.5 0 0 1 1.5-1.5H13" />
      <path d="M5 13.5 3 11.5 5 9.5" />
      <path d="M13 8.5V10a1.5 1.5 0 0 1-1.5 1.5H3" />
    </>
  ),
  metro: (
    <>
      <path d="M5.5 2.5h5l2.5 11h-10z" />
      <path d="M8 11 12.5 4" />
      <path d="M4.4 10.5h7.2" />
    </>
  ),
  undo: (
    <>
      <path d="M3.5 6.5h6a3 3 0 0 1 0 6H6" />
      <path d="M6 4 3.5 6.5 6 9" />
    </>
  ),
  redo: (
    <>
      <path d="M12.5 6.5h-6a3 3 0 0 0 0 6H10" />
      <path d="M10 4l2.5 2.5L10 9" />
    </>
  ),
  chev: <path d="M4.5 6.5 8 10l3.5-3.5" />,
  spark: (
    <>
      <path d="M7 2.5 8.2 6 11.5 7 8.2 8.2 7 11.5 5.8 8.2 2.5 7 5.8 6z" fill="currentColor" strokeWidth="1" />
      <path d="M12 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor" stroke="none" />
    </>
  ),
  phones: (
    <>
      <path d="M3 10.5V8a5 5 0 0 1 10 0v2.5" />
      <rect x="2.5" y="9.5" width="2.8" height="4" rx="1" />
      <rect x="10.7" y="9.5" width="2.8" height="4" rx="1" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />
    </>
  ),
  zLeft: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
      <rect x="3.3" y="3.8" width="2.6" height="8.4" fill="currentColor" stroke="none" opacity=".55" />
    </>
  ),
  zLow: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 9h11" />
      <rect x="3.3" y="9.6" width="9.4" height="2.6" fill="currentColor" stroke="none" opacity=".55" />
    </>
  ),
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  zRight: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M9.5 3v10" />
      <rect x="10.1" y="3.8" width="2.6" height="8.4" fill="currentColor" stroke="none" opacity=".55" />
    </>
  ),
  // The MixConsole tab (m5-ui-port-mixer-strip).
  sliders: (
    <>
      <path d="M4 2.5v11M8 2.5v11M12 2.5v11" />
      <rect x="2.6" y="8.5" width="2.8" height="2.4" rx=".6" fill="currentColor" />
      <rect x="6.6" y="4" width="2.8" height="2.4" rx=".6" fill="currentColor" />
      <rect x="10.6" y="7" width="2.8" height="2.4" rx=".6" fill="currentColor" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

// The mockup's ic(name, 's'): <svg class="i s" viewBox="0 0 16 16">.
export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
  return (
    <svg className={small ? 'i s' : 'i'} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
