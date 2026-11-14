// The window's zones (UI redesign spec 2.1-2.4; Cubase's project window): a
// top bar, the left zone, the project zone with the lower zone under it, the
// right zone, and the status bar. react-resizable-panels draws the boundaries
// and turns pointer drags into sizes; the reducer of layout.ts owns the
// layout. A drag that ends reports the zone's size to the reducer (below the
// minimum: collapsed), and every render brings the panels to the effective
// layout. A focused boundary's keys (arrows 8 px, Shift+arrows 32 px, Home
// and End the minimum and maximum, Enter the default) and double-click go to
// the reducer too; the library's own keyboard steps, double-click and
// persistence are not used, so the layout lives under one key
// (siann.layout.v1) and nowhere else. A boundary is a role="separator" whose
// aria values are its zone's size, minimum and maximum in px.
//
// Keyboard focus is per zone (zone-focus.ts): a click focuses its zone; Tab
// and Shift+Tab cycle the visible zones from a zone or the page and walk the
// controls of a zone, its boundary among them, from inside it; F6 and
// Shift+F6 cycle the zones from anywhere; Enter enters a zone, Escape returns
// to it. The focus keys run in a capture listener on the window, before any
// element's own handler; every other key goes through the dispatcher in one
// bubbling listener on the window, to the focused zone's commands first, then
// to the window's. Under 1280 px the right zone is an overlay drawer.
//
// While the engine is disconnected (m5-ui-connection; UI redesign spec 7
// P1-6): a full-width banner under the top bar says so, the four zones are
// inert and dimmed (no pointer, focus or key reaches their controls), and
// the key dispatcher runs only the window's layout and focus commands, since
// its window-level listener is not stopped by inert. The top bar's zone
// buttons and the status bar send nothing and stay live. The toasts sit
// outside the zones.

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
import type { CommandId, CommandRegistry, ZoneScope } from '../keys/commands';
import { isTextField, resolveKey } from '../keys/dispatcher';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import { FOCUS_COMMANDS, focusMove, ringStep, type FocusPlace } from '../keys/zone-focus';
import type { Phase } from '../model/connection-phase';
import type { EngineStatusSource } from '../model/engine-status';
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
import type { ToastStore } from './toast-store';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';

// The order Tab walks the zones in.
const FOCUS_ORDER: readonly ZoneScope[] = ['left', 'project', 'lower', 'right'];
// A drag this far below a zone's minimum collapses it.
const COLLAPSE_THRESHOLD = 4;
// The focus keys run before any element's handler; the rest after.
const FOCUS_PRESET = CUBASE_PRESET.filter((b) => FOCUS_COMMANDS.has(b.commandId));
const COMMAND_PRESET = CUBASE_PRESET.filter((b) => !FOCUS_COMMANDS.has(b.commandId));
const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

function isZoneScope(value: string | undefined): value is ZoneScope {
  return value === 'left' || value === 'project' || value === 'lower' || value === 'right';
}

// Where the focus is: a zone itself, a control inside one (its boundary
// included), the page, a modal dialog, or elsewhere (top bar, status bar).
function placeOf(target: EventTarget | null): FocusPlace {
  if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) return { kind: 'page' };
  if (target.closest('dialog[open]')) return { kind: 'dialog' };
  const divider = target.dataset.dividerZone;
  if (isZoneScope(divider)) return { kind: 'control', zone: divider };
  const section = target.closest<HTMLElement>('[data-zone]');
  const zone = section?.dataset.zone;
  if (!section || !isZoneScope(zone)) return { kind: 'outside' };
  return section === target ? { kind: 'zone', zone } : { kind: 'control', zone };
}

function tabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || el.closest('[hidden], [inert]')) return false;
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
  return el.getClientRects().length > 0;
}

// The Tab order inside a zone: its controls and its boundary, in document order.
function zoneRing(section: HTMLElement | null | undefined, zone: ZoneScope): HTMLElement[] {
  if (!section) return [];
  const items = Array.from(section.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => tabbable(el));
  const divider = document.querySelector<HTMLElement>(`[data-divider-zone="${zone}"]`);
  if (divider && tabbable(divider)) items.push(divider);
  return items.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

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
  // engine.status as last polled, for the status bar.
  readonly engineStatus: EngineStatusSource;
  readonly store: LayoutStore;
  readonly commands: CommandRegistry;
  readonly platform: 'mac' | 'other';
  // A row under the top bar, outside the zones (the audition banner): visible
  // whichever zones are open.
  readonly banner?: ReactNode;
  // The connection phase (model/connection-phase.ts): 'offline' shows the
  // banner and makes the zones inert.
  readonly phase: Phase;
  readonly toasts: ToastStore;
  readonly left: ReactNode;
  readonly project: ReactNode;
  readonly lower: ReactNode;
  readonly right: ReactNode;
}

interface ZoneFrameProps {
  readonly zone: ZoneScope;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly offline: boolean;
  readonly drawer?: { readonly width: number } | null;
  readonly tabs?: ReactNode;
  readonly onFocus: (zone: ZoneScope) => void;
  readonly frameRef: (el: HTMLElement | null) => void;
  readonly children: ReactNode;
}

function ZoneFrame({ zone, visible, focused, offline, drawer, tabs, onFocus, frameRef, children }: ZoneFrameProps) {
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
      data-offline={offline ? 'true' : undefined}
      inert={offline}
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

interface SeparatorValues {
  readonly now: number;
  readonly min: number;
  readonly max: number;
}

// A boundary: the library's separator (pointer drags) with SIANN's keys: the
// arrows step 8 px (Shift: 32 px), Home and End go to the minimum and the
// maximum, Enter and double-click restore the default. Its aria values are
// the zone's size and range in px; the library writes its own (percentages
// of the panel before it) on every layout, so they are put back.
function ZoneSeparator({
  zone,
  disabled,
  values,
  dispatch,
}: {
  zone: Zone;
  disabled?: boolean;
  values: SeparatorValues;
  dispatch: (action: (viewport: Viewport) => ShellAction) => void;
}) {
  const t = useT();
  const element = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = element.current;
    if (!el) return undefined;
    const grow = zone === 'left' ? 'ArrowRight' : zone === 'right' ? 'ArrowLeft' : 'ArrowUp';
    const shrink = zone === 'left' ? 'ArrowLeft' : zone === 'right' ? 'ArrowRight' : 'ArrowDown';
    // Capture, so the library's own 5 % steps, Home, End and Enter never run.
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      let make: ((viewport: Viewport) => ShellAction) | null = null;
      if (event.key === grow || event.key === shrink) {
        const direction = event.key === grow ? 1 : -1;
        const large = event.shiftKey;
        make = (viewport) => ({ type: 'step', zone, direction, large, viewport });
      } else if (event.shiftKey) {
        return;
      } else if (event.key === 'Home' || event.key === 'End') {
        const edge = event.key === 'Home' ? 'min' : 'max';
        make = (viewport) => ({ type: 'edge', zone, edge, viewport });
      } else if (event.key === 'Enter') {
        make = (viewport) => ({ type: 'reset', zone, viewport });
      }
      if (!make) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch(make);
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [zone, dispatch]);
  const latest = useRef(values);
  latest.current = values;
  const apply = useCallback(() => {
    const el = element.current;
    if (!el) return;
    const { now, min, max } = latest.current;
    const wanted: ReadonlyArray<readonly [string, number]> = [
      ['aria-valuenow', now],
      ['aria-valuemin', min],
      ['aria-valuemax', max],
    ];
    for (const [name, value] of wanted) {
      const text = String(Math.round(value));
      if (el.getAttribute(name) !== text) el.setAttribute(name, text);
    }
  }, []);
  useLayoutEffect(apply);
  useEffect(() => {
    const el = element.current;
    if (!el) return undefined;
    const observer = new MutationObserver(apply);
    observer.observe(el, { attributes: true, attributeFilter: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'] });
    return () => observer.disconnect();
  }, [apply]);
  return (
    <Separator
      id={`separator-${zone}`}
      data-testid={`separator-${zone}`}
      data-divider-zone={zone}
      className={`divider divider-${zone}`}
      elementRef={element}
      disabled={disabled}
      disableDoubleClick
      aria-label={t('zone.resize', { zone: t(`zone.${zone}`) })}
      onDoubleClick={() => dispatch((viewport) => ({ type: 'reset', zone, viewport }))}
    />
  );
}

export function Shell({ client, plans, engineStatus, store, commands, platform, banner, phase, toasts, left, project, lower, right }: ShellProps) {
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
  const offline = phase === 'offline';
  const latest = useRef({ effective, focused, offline });
  latest.current = { effective, focused, offline };

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

  // The DOM focus entering a zone (by Tab, a click or a script) moves the focus frame there.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const place = placeOf(event.target);
      if (place.kind === 'zone' || place.kind === 'control') setFocused(place.zone);
    };
    window.addEventListener('focusin', onFocusIn);
    return () => window.removeEventListener('focusin', onFocusIn);
  }, []);

  // The window's commands.
  useEffect(() => {
    const cycle = (step: 1 | -1) => {
      const order = FOCUS_ORDER.filter(isVisible);
      const at = order.indexOf(latest.current.focused);
      const next = order[(at + step + order.length) % order.length] ?? 'project';
      focusZone(next, true);
    };
    // A focus command; false (the key keeps its default) where it does not apply.
    const move = (commandId: CommandId) => (): boolean => {
      const active = document.activeElement;
      const step = focusMove(commandId, placeOf(active));
      if (!step) return false;
      switch (step.type) {
        case 'zone':
          cycle(step.step);
          return true;
        case 'control': {
          const ring = zoneRing(frames.current[step.zone], step.zone);
          ringStep(ring, active instanceof HTMLElement ? active : null, step.step)?.focus();
          return true;
        }
        case 'enter':
          zoneRing(frames.current[step.zone], step.zone)[0]?.focus();
          return true;
        case 'root':
          // The key goes on: the zone's own Escape (edit.cancel) still runs.
          focusZone(step.zone, true);
          return false;
      }
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
      ...[...FOCUS_COMMANDS].map((id) => commands.register('window', id, move(id))),
    ];
    return () => offs.forEach((off) => off());
  }, [commands, dispatch, focusZone, isVisible]);

  // The keydown listeners: preset table -> dispatcher -> the focused zone
  // first, then the window. The focus keys in the capture phase, before any
  // element's handler (a boundary's, the library's); the rest bubbling, so an
  // element (the About dialog) can keep its keys.
  useEffect(() => {
    const listener = (preset: typeof CUBASE_PRESET) => (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const binding = resolveKey(
        {
          code: event.code,
          key: event.key,
          modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey },
          targetIsTextField: isTextField(event.target),
          focusedZone: latest.current.focused,
          platform,
          offline: latest.current.offline,
        },
        preset,
      );
      if (binding && commands.run(binding.scope, binding.commandId)) event.preventDefault();
    };
    const onFocusKey = listener(FOCUS_PRESET);
    const onKey = listener(COMMAND_PRESET);
    window.addEventListener('keydown', onFocusKey, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onFocusKey, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [commands, platform]);

  const frameRef = (zone: ZoneScope) => (el: HTMLElement | null) => {
    frames.current[zone] = el;
  };
  const zones = effective.zones;
  const initial = useRef(effective).current.zones;
  const startSize = (zone: Zone) => (initial[zone].visible && !initial[zone].drawer ? initial[zone].size : 0);
  const lowerLimits = limits('lower', viewport);
  const separatorValues = (zone: Zone): SeparatorValues => {
    const { min, max } = limits(zone, viewport);
    return { now: zones[zone].visible ? zones[zone].size : 0, min, max };
  };
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
    <div className="shell" data-testid="shell" data-viewport={`${viewport.width}x${viewport.height}`} data-offline={offline ? 'true' : undefined}>
      <TopBar
        client={client}
        plans={plans}
        zones={zones}
        onToggle={(zone) => dispatch((size) => ({ type: 'toggle', zone, viewport: size }))}
        onPlans={() => dispatch((size) => ({ type: 'openTab', zone: 'right', tab: 'plans', viewport: size }))}
      />
      <div className="shell-banner">
        {offline ? (
          <div className="connection-banner" data-testid="connection-banner" role="status">
            {t('connection.banner')}
          </div>
        ) : null}
        {banner}
      </div>
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
          <ZoneFrame offline={offline} zone="left" visible={zones.left.visible} focused={focused === 'left'} onFocus={(z) => focusZone(z, false)} frameRef={frameRef('left')}>
            {left}
          </ZoneFrame>
        </Panel>
        <ZoneSeparator zone="left" values={separatorValues('left')} dispatch={dispatch} />
        <Panel id="panel-center" className="panel-inner" minSize={EVENT_MIN_WIDTH}>
          <Group
            orientation="vertical"
            id="zones-center"
            className="zones-center"
            elementRef={groups.vertical}
            onLayoutChanged={verticalChanged}
          >
            <Panel id="panel-project" className="panel-inner" minSize={PROJECT_CHROME + EVENT_MIN_HEIGHT}>
              <ZoneFrame offline={offline} zone="project" visible focused={focused === 'project'} onFocus={(z) => focusZone(z, false)} frameRef={frameRef('project')}>
                {project}
              </ZoneFrame>
            </Panel>
            <ZoneSeparator zone="lower" values={separatorValues('lower')} dispatch={dispatch} />
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
              <ZoneFrame offline={offline}
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
        <ZoneSeparator zone="right" disabled={zones.right.drawer} values={separatorValues('right')} dispatch={dispatch} />
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
          <ZoneFrame offline={offline}
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
      <StatusBar client={client} plans={plans} engineStatus={engineStatus} />
      <Toasts store={toasts} />
    </div>
  );
}
