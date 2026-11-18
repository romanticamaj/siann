// The project zone toolbar (m5-ui-port-toolbar; UI redesign spec 3.2, 10.8,
// 10.9, 10.10 P1-16), ported from the mockup's app.innerHTML template
// (mockup.html, div.arr-toolbar) and its tool(): the tool group (.seg, each
// tool a .b with its icon and kbd, .on for the active one), the snap field
// (magnet, Snap, the snap type in <em>, chevron; m5b-ui-edit-more: a click on
// the chevron, a right-click or Down opens the snap type menu of Grid, Grid
// Relative, Events and Magnetic Cursor, a click elsewhere turns snap on and
// off), the grid type field (grid,
// the grid type, chevron; a click opens its menu of Bar, Beat and Adapt to
// Zoom), the auto-scroll field (the follow icon, the mockup's inline
// padding) and the .spacer, styled by ui/project-zone.css. The controls are
// buttons carrying the mockup's classes (shell.css's button reset leaves them
// to the shared rules, as for .tbtn and .msr), with aria-pressed and a name.
//
// Absent parts keep their space empty (spec 3.0): tools 2 and 6 to 9 until
// their features land (M6a), each box sized by its --hold-*-w token
// (shell.css); Glue (4) and Erase (5) landed with m5b-ui-edit-more. A tool, snap, the grid type or
// auto-scroll on an engine that does not list its commands leaves an empty
// box where it was. No empty box has a role, focus, a name or a part id.
//
// The refusal line (timeline-error) is the app's own, after the spacer: it
// draws nothing unless a refusal is shown.
//
// The proposal pill (m5b-ui-ghosts; UI redesign 4.2) ends the toolbar while a
// reviewable plan is selected: the mockup's span.overlaypill with the spark
// icon, the plan's name (<b>its first step</b> · N steps, plans/plan-name.ts
// until E-7) and the Ghosts toggle (.tog, a button with aria-pressed; Ctrl+Alt+G
// does the same). Without one it is not in the DOM and no box replaces it:
// nothing follows it in the row (spec 3.0).

import { useEffect, useRef, useState } from 'react';

import { refusalLine } from '../i18n/errors';
import { useLocale, useT, type MessageKey } from '../i18n/t';
import { Icon, type IconName } from '../shell/icons';
import { ISOLATE } from '../plans/isolate';
import { GRID_TYPES, SNAP_TYPES, type GridType, type SnapSettings, type SnapType } from './snap';
import type { TimelineRefusal, Tool } from './TimelineCanvas';

// Grid types Bar, Beat and Adapt to Zoom (snap type Grid only, spec 3.0).
export const GRID_LABELS: Readonly<Record<GridType, MessageKey>> = { bar: 'grid.bar', beat: 'grid.beat', adapt: 'grid.adapt' };
// The snap types (m5b-ui-edit-more; spec 3.2, "Snap types").
export const SNAP_LABELS: Readonly<Record<SnapType, MessageKey>> = {
  grid: 'snap.typeGrid',
  gridRelative: 'snap.typeGridRelative',
  events: 'snap.typeEvents',
  cursor: 'snap.typeCursor',
};

// Which of the toolbar's controls the engine's capabilities allow (Timeline's editGates).
export interface ToolbarGates {
  readonly select: boolean;
  readonly split: boolean;
  readonly glue: boolean;
  readonly erase: boolean;
  readonly snap: boolean;
  readonly autoScroll: boolean;
}

export interface ToolbarProps {
  readonly tool: Tool;
  readonly snap: SnapSettings;
  readonly autoScroll: boolean;
  readonly gates: ToolbarGates;
  readonly error: TimelineRefusal | null;
  readonly onTool: (tool: Tool) => void;
  readonly onSnapToggle: () => void;
  readonly onGrid: (grid: GridType) => void;
  // The snap type menu's choice (m5b-ui-edit-more).
  readonly onSnapType: (type: SnapType) => void;
  readonly onAutoScroll: () => void;
  // The proposal pill (m5b-ui-ghosts): the overlaid plan's name and its ghosts toggle; null without a reviewable plan.
  readonly pill?: ProposalPillProps | null;
}

export interface ProposalPillProps {
  readonly lead: string;
  readonly steps: string;
  readonly on: boolean;
  readonly onToggle: () => void;
}

// The mockup's nine tools in tool()'s order; the ones SIANN has carry their tool.
const TOOLS: ReadonlyArray<{ readonly key: number; readonly landed?: { readonly icon: IconName; readonly tool: Tool; readonly testid: string; readonly label: MessageKey } }> = [
  { key: 1, landed: { icon: 'ptr', tool: 'select', testid: 'tool-select', label: 'tool.select' } },
  { key: 2 },
  { key: 3, landed: { icon: 'cut', tool: 'split', testid: 'tool-split', label: 'tool.split' } },
  { key: 4, landed: { icon: 'glue', tool: 'glue', testid: 'tool-glue', label: 'tool.glue' } },
  { key: 5, landed: { icon: 'erase', tool: 'erase', testid: 'tool-erase', label: 'tool.erase' } },
  { key: 6 },
  { key: 7 },
  { key: 8 },
  { key: 9 },
];
// The empty boxes of the tools SIANN has not built (spec 3.0; --hold-tool-<n>-w),
// by tool() number: a literal table, so every class is spelled out.
const TOOL_HOLDS: Readonly<Record<number, string>> = {
  2: 'hold-tool-2',
  6: 'hold-tool-6',
  7: 'hold-tool-7',
  8: 'hold-tool-8',
  9: 'hold-tool-9',
};

export function Toolbar({ tool, snap, autoScroll, gates, error, onTool, onSnapToggle, onGrid, onSnapType, onAutoScroll, pill = null }: ToolbarProps) {
  const t = useT();
  const locale = useLocale();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [snapMenu, setSnapMenu] = useState<{ x: number; y: number } | null>(null);
  const allowed = (which: Tool) => gates[which];
  const snapType = snap.type ?? 'grid';
  const openSnapMenu = (field: HTMLElement) => {
    const box = field.getBoundingClientRect();
    setSnapMenu((open) => (open ? null : { x: box.left, y: box.bottom }));
  };
  return (
    <>
      <div className="arr-toolbar" data-part="toolbar">
        <div className="seg" data-part="tools" role="group" aria-label={t('tool.label')}>
          {TOOLS.map(({ key, landed }) => {
            if (!landed) return <span key={key} className={TOOL_HOLDS[key]} aria-hidden="true" />;
            if (!allowed(landed.tool)) return <span key={key} className="tool-empty" aria-hidden="true" />;
            const on = tool === landed.tool;
            return (
              <button
                key={key}
                type="button"
                className={`b${on ? ' on' : ''}`}
                data-part={`tool-${key}`}
                data-testid={landed.testid}
                aria-pressed={on}
                aria-label={t(landed.label)}
                title={t(landed.label)}
                onClick={() => onTool(landed.tool)}
              >
                <Icon name={landed.icon} small />
                <kbd>{key}</kbd>
              </button>
            );
          })}
        </div>
        {gates.snap ? (
          <button
            type="button"
            className={`field${snap.on ? ' on' : ''}`}
            data-part="snap"
            data-testid="snap-toggle"
            data-snap-type={snapType}
            aria-pressed={snap.on}
            aria-haspopup="menu"
            aria-expanded={snapMenu !== null}
            title={t('snap.toggle')}
            onClick={(event) => {
              // The chevron opens the snap type menu; the rest of the field turns snap on and off.
              const target = event.target as Element | null;
              const chevron = event.currentTarget.lastElementChild;
              if (chevron && target && (target === chevron || chevron.contains(target))) openSnapMenu(event.currentTarget);
              else onSnapToggle();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openSnapMenu(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return;
              event.preventDefault();
              openSnapMenu(event.currentTarget);
            }}
          >
            <Icon name="magnet" small />
            {t('snap.toggle')}
            <em>{t(SNAP_LABELS[snapType])}</em>
            <Icon name="chev" small />
          </button>
        ) : (
          <span className="field-empty" aria-hidden="true" />
        )}
        {gates.snap ? (
          <button
            type="button"
            className="field"
            data-part="grid-type"
            data-testid="grid-type"
            data-grid={snap.grid}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            title={t('snap.grid')}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenu((open) => (open ? null : { x: box.left, y: box.bottom }));
            }}
          >
            <Icon name="grid" small />
            {t(GRID_LABELS[snap.grid])}
            <Icon name="chev" small />
          </button>
        ) : (
          <span className="field-empty" aria-hidden="true" />
        )}
        {gates.autoScroll ? (
          <button
            type="button"
            className={`field${autoScroll ? ' on' : ''}`}
            data-part="auto-scroll"
            data-testid="auto-scroll"
            aria-pressed={autoScroll}
            aria-label={t('transport.autoScroll')}
            title={t('toolbar.autoScrollTitle')}
            style={{ padding: '0 var(--space-1h)' }}
            onClick={onAutoScroll}
          >
            <Icon name="follow" small />
          </button>
        ) : (
          <span className="field-empty auto-scroll-empty" aria-hidden="true" />
        )}
        <span className="spacer" />
        <output className="timeline-error" data-testid="timeline-error" data-code={error?.code ?? undefined} title={t('timeline.lastError')}>
          {error ? refusalLine(error.code, error.message, locale) : ''}
        </output>
        {pill ? <ProposalPill {...pill} /> : null}
      </div>
      {menu && gates.snap ? (
        <GridTypeMenu
          grid={snap.grid}
          x={menu.x}
          y={menu.y}
          onChoose={(grid) => {
            setMenu(null);
            onGrid(grid);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {snapMenu && gates.snap ? (
        <SnapTypeMenu
          type={snapType}
          x={snapMenu.x}
          y={snapMenu.y}
          onChoose={(type) => {
            setSnapMenu(null);
            onSnapType(type);
          }}
          onClose={() => setSnapMenu(null)}
        />
      ) : null}
    </>
  );
}

// The mockup's span.overlaypill: the overlaid plan's name and its ghosts toggle.
function ProposalPill({ lead, steps, on, onToggle }: ProposalPillProps) {
  const t = useT();
  return (
    <span className="overlaypill" data-part="proposal-pill" data-testid="proposal-pill" title={t('pill.label')}>
      <Icon name="spark" small />
      <span {...ISOLATE}>
        <b>{lead}</b>
        {` · ${steps}`}
      </span>
      <button type="button" className="tog" data-testid="proposal-pill-toggle" aria-pressed={on} aria-label={t('pill.toggle')} title={t('pill.toggle')} onClick={onToggle}>
        <Icon name="check" small />
        {t('pill.ghosts')}
      </button>
    </span>
  );
}

// The grid type menu (spec 3.2; the time format menu's pattern): Bar, Beat and
// Adapt to Zoom, the current one checked. Escape or a press outside closes it.
function GridTypeMenu({ grid, x, y, onChoose, onClose }: { grid: GridType; x: number; y: number; onChoose: (grid: GridType) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The field toggles the menu itself.
      if (ref.current?.contains(target) || target?.closest?.('[data-testid="grid-type"]')) return;
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
  return (
    <div className="grid-type-menu" data-testid="grid-type-menu" role="menu" aria-label={t('snap.grid')} style={{ left: x, top: y }} ref={ref}>
      {GRID_TYPES.map((type) => (
        <button key={type} type="button" role="menuitemradio" className="time-format-item" data-testid={`grid-type-${type}`} aria-checked={grid === type} onClick={() => onChoose(type)}>
          {t(GRID_LABELS[type])}
        </button>
      ))}
    </div>
  );
}

// The snap type menu (m5b-ui-edit-more; spec 3.2, "Snap types"; the grid type
// menu's pattern and look): Grid, Grid Relative, Events and Magnetic Cursor,
// the current one checked. Escape or a press outside closes it.
export function SnapTypeMenu({ type, x, y, onChoose, onClose }: { type: SnapType; x: number; y: number; onChoose: (type: SnapType) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The field toggles the menu itself.
      if (ref.current?.contains(target) || target?.closest?.('[data-testid="snap-toggle"]')) return;
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
  return (
    <div className="grid-type-menu" data-testid="snap-type-menu" role="menu" aria-label={t('snap.type')} style={{ left: x, top: y }} ref={ref}>
      {SNAP_TYPES.map((value) => (
        <button key={value} type="button" role="menuitemradio" className="time-format-item" data-testid={`snap-type-${value}`} aria-checked={type === value} onClick={() => onChoose(value)}>
          {t(SNAP_LABELS[value])}
        </button>
      ))}
    </div>
  );
}
