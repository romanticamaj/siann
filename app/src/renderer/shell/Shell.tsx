// The window's zones (UI redesign spec 2.1-2.4; Cubase's project window): a
// top bar, the left zone, the project zone with the lower zone under it, the
// right zone, and the status bar. react-resizable-panels draws the boundaries
// and turns pointer drags into sizes; the reducer of layout.ts owns the
// layout. A drag that ends reports the zone's size to the reducer (below the
// minimum: collapsed), and every render brings the panels to the effective
// layout. Arrow keys on a focused boundary (8 px) and double-click (the
// default size) go to the reducer too; the library's own keyboard steps,
// double-click and persistence are not used, so the layout lives under one
// key (siann.layout.v1) and nowhere else.
//
// Keyboard focus is per zone: a click focuses its zone, Tab and Shift+Tab
// cycle the visible zones, and the one keydown listener on the window sends
// each key through the dispatcher to the focused zone's commands first, then
// to the window's. Under 1280 px the right zone is an overlay drawer.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { Group, Panel, Separator, usePanelRef, type LayoutChangedMeta, type PanelImperativeHandle } from 'react-resizable-panels';

import { useT } from '../i18n/t';
import type { CommandRegistry, ZoneScope } from '../keys/commands';
import { isTextField, resolveKey } from '../keys/dispatcher';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import {
  effectiveLayout,
  EVENT_MIN_HEIGHT,
  EVENT_MIN_WIDTH,
  limits,
  PROJECT_CHROME,
  ZONES,
  type EffectiveLayout,
  type ShellAction,
  type Viewport,
  type Zone,
} from './layout';
import { useShellState, type LayoutStore } from './layout-store';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

// The order Tab walks the zones in.
const FOCUS_ORDER: readonly ZoneScope[] = ['left', 'project', 'lower', 'right'];
// A drag this far below a zone's minimum collapses it.
const COLLAPSE_THRESHOLD = 4;

let viewportCache: Viewport = { width: 0, height: 0 };
function readViewport(): Viewport {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width !== viewportCache.width || height !== viewportCache.height) viewportCache = { width, height };
  return viewportCache;
}
function subscribeViewport(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribeViewport, readViewport);
}

export interface ShellProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  readonly store: LayoutStore;
  readonly commands: CommandRegistry;
  readonly platform: 'mac' | 'other';
  readonly left: ReactNode;
  readonly project: ReactNode;
  readonly lower: ReactNode;
  readonly right: ReactNode;
}

interface ZoneFrameProps {
  readonly zone: ZoneScope;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly drawer?: { readonly width: number } | null;
  readonly tabs?: ReactNode;
  readonly onFocus: (zone: ZoneScope) => void;
  readonly frameRef: (el: HTMLElement | null) => void;
  readonly children: ReactNode;
}

function ZoneFrame({ zone, visible, focused, drawer, tabs, onFocus, frameRef, children }: ZoneFrameProps) {
  const t = useT();
  return (
    <section
      ref={frameRef}
      className={`zone zone-${zone}`}
      data-testid={`zone-${zone}`}
      data-zone={zone}
      data-visible={String(visible)}
      data-focused={String(focused && visible)}
      data-drawer={drawer ? 'true' : undefined}
      style={drawer ? ({ '--drawer-width': `${drawer.width}px` } as CSSProperties) : undefined}
      hidden={!visible}
      tabIndex={-1}
      aria-label={t(`zone.${zone}`)}
      onPointerDownCapture={() => onFocus(zone)}
    >
      {tabs}
      <div className="zone-body" data-testid={`zone-${zone}-body`}>
        {children}
      </div>
    </section>
  );
}

// A boundary: the library's separator plus 8 px arrow steps and the double-click reset.
function ZoneSeparator({ zone, disabled, dispatch }: { zone: Zone; disabled?: boolean; dispatch: (action: (viewport: Viewport) => ShellAction) => void }) {
  const t = useT();
  const element = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return undefined;
    const grow = zone === 'left' ? 'ArrowRight' : zone === 'right' ? 'ArrowLeft' : 'ArrowUp';
    const shrink = zone === 'left' ? 'ArrowLeft' : zone === 'right' ? 'ArrowRight' : 'ArrowDown';
    // Capture, so the library's own 5 % step never runs.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === grow ? 1 : -1;
      dispatch((viewport) => ({ type: 'step', zone, direction, viewport }));
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [zone, dispatch]);
  return (
    <Separator
      id={`separator-${zone}`}
      data-testid={`separator-${zone}`}
      className={`divider divider-${zone}`}
      elementRef={element}
      disabled={disabled}
      disableDoubleClick
      aria-label={t('zone.resize', { zone: t(`zone.${zone}`) })}
      onDoubleClick={() => dispatch((viewport) => ({ type: 'reset', zone, viewport }))}
    />
  );
}

export function Shell({ client, plans, store, commands, platform, left, project, lower, right }: ShellProps) {
  const t = useT();
  const viewport = useViewport();
  const state = useShellState(store);
  const effective: EffectiveLayout = useMemo(() => effectiveLayout(state, viewport), [state, viewport]);
  const [focused, setFocused] = useState<ZoneScope>('project');

  const panels: Record<Zone, RefObject<PanelImperativeHandle | null>> = {
    left: usePanelRef(),
    lower: usePanelRef(),
    right: usePanelRef(),
  };
  const frames = useRef<Partial<Record<ZoneScope, HTMLElement | null>>>({});
  const groups = { horizontal: useRef<HTMLDivElement | null>(null), vertical: useRef<HTMLDivElement | null>(null) };
  // A panel's size from the library's layout, not from the DOM, which lags
  // behind it while a panel animates.
  const pixels = (zone: Zone): number => {
    const panel = panels[zone].current;
    const group = groups[zone === 'lower' ? 'vertical' : 'horizontal'].current;
    if (!panel || !group) return 0;
    const horizontal = zone !== 'lower';
    let axis = horizontal ? group.clientWidth : group.clientHeight;
    for (const child of Array.from(group.children)) {
      if (child instanceof HTMLElement && child.hasAttribute('data-separator')) axis -= horizontal ? child.offsetWidth : child.offsetHeight;
    }
    return (panel.getSize().asPercentage / 100) * axis;
  };
  const latest = useRef({ effective, focused });
  latest.current = { effective, focused };

  // Zones that open or close by a button or key animate (spec 1.6); drags,
  // arrow steps and the first layout do not.
  const [animate, setAnimate] = useState(false);
  const dispatch = useCallback(
    (make: (viewport: Viewport) => ShellAction) => {
      const action = make(readViewport());
      setAnimate(action.type !== 'step' && action.type !== 'resize');
      store.dispatch(action);
    },
    [store],
  );

  // The panels follow the effective layout.
  useLayoutEffect(() => {
    for (const zone of ZONES) {
      const panel = panels[zone].current;
      if (!panel) continue;
      const view = effective.zones[zone];
      if (!view.visible || view.drawer) {
        if (!panel.isCollapsed()) panel.collapse();
        continue;
      }
      if (panel.isCollapsed() || Math.abs(pixels(zone) - view.size) > 0.5) panel.resize(view.size);
    }
  });

  // A drag (or the library's Enter, Home or End) that ended: its sizes go to the reducer.
  const changed = useCallback(
    (zones: readonly Zone[]) => (_layout: unknown, meta?: LayoutChangedMeta) => {
      if (!meta?.isUserInteraction) return;
      const size = readViewport();
      const shown = effectiveLayout(store.getSnapshot(), size);
      for (const zone of zones) {
        const panel = panels[zone].current;
        const view = shown.zones[zone];
        if (!panel || view.drawer) continue;
        setAnimate(false);
        if (panel.isCollapsed()) {
          if (view.visible) store.dispatch({ type: 'resize', zone, size: 0, viewport: size });
          continue;
        }
        const px = Math.round(pixels(zone));
        if (!view.visible || Math.abs(px - view.size) > 0.5) store.dispatch({ type: 'resize', zone, size: px, viewport: size });
      }
    },
    // The panels' refs are stable objects.
    [store],
  );
  const horizontalChanged = useMemo(() => changed(['left', 'right']), [changed]);
  const verticalChanged = useMemo(() => changed(['lower']), [changed]);

  const isVisible = useCallback((zone: ZoneScope) => zone === 'project' || latest.current.effective.zones[zone].visible, []);
  const focusZone = useCallback((zone: ZoneScope, moveDom: boolean) => {
    setFocused(zone);
    if (moveDom) frames.current[zone]?.focus({ preventScroll: true });
  }, []);

  // A hidden zone hands the focus frame to the project zone.
  useEffect(() => {
    if (focused !== 'project' && !effective.zones[focused].visible) setFocused('project');
  }, [effective, focused]);

  // The window's commands.
  useEffect(() => {
    const cycle = (step: 1 | -1) => () => {
      const order = FOCUS_ORDER.filter(isVisible);
      const at = order.indexOf(latest.current.focused);
      const next = order[(at + step + order.length) % order.length] ?? 'project';
      focusZone(next, true);
    };
    const offs = [
      commands.register('window', 'zone.left.toggle', () => dispatch((viewport) => ({ type: 'toggle', zone: 'left', viewport }))),
      commands.register('window', 'zone.lower.toggle', () => dispatch((viewport) => ({ type: 'toggle', zone: 'lower', viewport }))),
      commands.register('window', 'zone.right.toggle', () => dispatch((viewport) => ({ type: 'toggle', zone: 'right', viewport }))),
      commands.register('window', 'zone.lower.mixconsole', () =>
        dispatch((viewport) => ({ type: 'showTab', zone: 'lower', tab: 'mixconsole', viewport })),
      ),
      commands.register('window', 'zone.right.plans', () =>
        dispatch((viewport) => ({ type: 'openTab', zone: 'right', tab: 'plans', viewport })),
      ),
      commands.register('window', 'focus.nextZone', cycle(1)),
      commands.register('window', 'focus.prevZone', cycle(-1)),
    ];
    return () => offs.forEach((off) => off());
  }, [commands, dispatch, focusZone, isVisible]);

  // The one keydown listener: preset table -> dispatcher -> the focused zone first, then the window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const binding = resolveKey(
        {
          code: event.code,
          key: event.key,
          modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey },
          targetIsTextField: isTextField(event.target),
          focusedZone: latest.current.focused,
          platform,
        },
        CUBASE_PRESET,
      );
      if (binding && commands.run(binding.scope, binding.commandId)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, platform]);

  const frameRef = (zone: ZoneScope) => (el: HTMLElement | null) => {
    frames.current[zone] = el;
  };
  const zones = effective.zones;
  const initial = useRef(effective).current.zones;
  const startSize = (zone: Zone) => (initial[zone].visible && !initial[zone].drawer ? initial[zone].size : 0);
  const lowerLimits = limits('lower', viewport);
  const tab = (zone: 'lower' | 'right', id: 'mixconsole' | 'plans') => (
    <div className="zone-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        data-testid={`tab-${zone}-${id}`}
        aria-selected={state.layout.tabs[zone] === id}
        onClick={() => store.dispatch({ type: 'tab', zone, tab: id })}
      >
        {t(`tab.${id}`)}
      </button>
    </div>
  );

  return (
    <div className="shell" data-testid="shell" data-viewport={`${viewport.width}x${viewport.height}`}>
      <TopBar
        client={client}
        plans={plans}
        zones={zones}
        onToggle={(zone) => dispatch((size) => ({ type: 'toggle', zone, viewport: size }))}
        onPlans={() => dispatch((size) => ({ type: 'openTab', zone: 'right', tab: 'plans', viewport: size }))}
      />
      <Group orientation="horizontal" id="zones" className="zones" data-animate={String(animate)} elementRef={groups.horizontal} onLayoutChanged={horizontalChanged}>
        <Panel
          id="panel-left"
          panelRef={panels.left}
          collapsible
          collapsedSize={0}
          collapsedThreshold={COLLAPSE_THRESHOLD}
          minSize={limits('left', viewport).min}
          maxSize={limits('left', viewport).max}
          defaultSize={startSize('left')}
          groupResizeBehavior="preserve-pixel-size"
          className="panel-inner"
        >
          <ZoneFrame zone="left" visible={zones.left.visible} focused={focused === 'left'} onFocus={(z) => focusZone(z, false)} frameRef={frameRef('left')}>
            {left}
          </ZoneFrame>
        </Panel>
        <ZoneSeparator zone="left" dispatch={dispatch} />
        <Panel id="panel-center" className="panel-inner" minSize={EVENT_MIN_WIDTH}>
          <Group
            orientation="vertical"
            id="zones-center"
            className="zones-center"
            elementRef={groups.vertical}
            onLayoutChanged={verticalChanged}
          >
            <Panel id="panel-project" className="panel-inner" minSize={PROJECT_CHROME + EVENT_MIN_HEIGHT}>
              <ZoneFrame zone="project" visible focused={focused === 'project'} onFocus={(z) => focusZone(z, false)} frameRef={frameRef('project')}>
                {project}
              </ZoneFrame>
            </Panel>
            <ZoneSeparator zone="lower" dispatch={dispatch} />
            <Panel
              id="panel-lower"
              panelRef={panels.lower}
              collapsible
              collapsedSize={0}
              collapsedThreshold={COLLAPSE_THRESHOLD}
              minSize={lowerLimits.min}
              maxSize={lowerLimits.max}
              defaultSize={startSize('lower')}
              groupResizeBehavior="preserve-pixel-size"
              className="panel-inner"
            >
              <ZoneFrame
                zone="lower"
                visible={zones.lower.visible}
                focused={focused === 'lower'}
                tabs={tab('lower', 'mixconsole')}
                onFocus={(z) => focusZone(z, false)}
                frameRef={frameRef('lower')}
              >
                {lower}
              </ZoneFrame>
            </Panel>
          </Group>
        </Panel>
        <ZoneSeparator zone="right" disabled={zones.right.drawer} dispatch={dispatch} />
        <Panel
          id="panel-right"
          panelRef={panels.right}
          collapsible
          collapsedSize={0}
          collapsedThreshold={COLLAPSE_THRESHOLD}
          minSize={limits('right', viewport).min}
          maxSize={limits('right', viewport).max}
          defaultSize={startSize('right')}
          groupResizeBehavior="preserve-pixel-size"
          className="panel-inner"
        >
          <ZoneFrame
            zone="right"
            visible={zones.right.visible}
            focused={focused === 'right'}
            drawer={zones.right.drawer ? { width: zones.right.size } : null}
            tabs={tab('right', 'plans')}
            onFocus={(z) => focusZone(z, false)}
            frameRef={frameRef('right')}
          >
            {right}
          </ZoneFrame>
        </Panel>
      </Group>
      <StatusBar client={client} />
    </div>
  );
}
