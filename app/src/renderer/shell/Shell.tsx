// The window's zones (UI redesign spec 2.1-2.4; Cubase's project window): a
// top bar, the left zone, the project zone with the lower zone under it, the
// right zone, and the status bar, on the mockup's .app grid (ui/layout.css;
// m5-ui-alignment-chrome): the regions are the grid's children, and the zone
// sizes reach it as custom properties from the layout store (--left-zone-w,
// --right-zone-w, --lower-zone-h; 0 for a hidden zone or the drawer). The
// reducer of layout.ts owns the layout. A boundary is an absolutely placed
// line over its zone's edge (it adds no grid item): a pointer drag reports
// the zone's size to the reducer as it moves (past the minimum by
// COLLAPSE_THRESHOLD: collapsed), and its keys (arrows 8 px, Shift+arrows
// 32 px, Home and End the minimum and maximum, Enter the default) and
// double-click go to the reducer too, so the layout lives under one key
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
//
// The transport (m5-ui-transport; spec 3.1, 3.6): the window's transport
// keys, undo and redo are registered here over the TransportController
// (model/transport.ts), and run only while the engine lists them and, for
// the transport, while a device runs; the period key exchanges the position
// display's formats and F (project zone) toggles auto-scroll, both view
// settings of the layout store. Shift+P belongs to the transport bar, which
// owns the position field. The locator, cycle and metronome keys
// (m5-ui-loop-click: Num / and /, C, P, Alt+P, Num 1 / 2, Shift+1 / 2,
// Ctrl+Num 1 / 2) are registered here over the LoopClickController, which
// declines what would send nothing (no device, no locators, no capability).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { useT } from '../i18n/t';
import type { CommandId, CommandRegistry, ZoneScope } from '../keys/commands';
import { isTextField, resolveKey } from '../keys/dispatcher';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import { capabilitySelector } from '../model/capabilities';
import { FOCUS_COMMANDS, focusMove, ringStep, type FocusPlace } from '../keys/zone-focus';
import type { Phase } from '../model/connection-phase';
import type { EngineStatusSource } from '../model/engine-status';
import type { PlanStore } from '../model/plan-store';
import type { ReviewStore } from '../model/review-store';
import type { SessionClient } from '../model/session-client';
import { bindLoopClickCommands, type LoopClickController } from '../model/loop-click';
import { bindTransportCommands, type TransportController } from '../model/transport';
import type { UndoHistory } from '../model/undo-history';
import {
  effectiveLayout,
  limits,
  type EffectiveLayout,
  type ShellAction,
  type Viewport,
  type Zone,
} from './layout';
import { useShellState, type LayoutStore } from './layout-store';
import { Hold } from './Hold';
import { useCapabilities } from './Capable';
import { pluginsListed } from '../mixer/inserts';
import { Icon } from './icons';
import { StatusBar } from './StatusBar';
import type { ToastStore } from './toast-store';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { transportEnabled, type TransportPlayhead } from './Transport';

// The order Tab walks the zones in.
const FOCUS_ORDER: readonly ZoneScope[] = ['left', 'project', 'lower', 'right'];
// The frame's classes per zone: the mockup's element class (aside.leftzone,
// section.arrange, section.lower, aside.plans), .zone and .zone-<zone>. The
// dividers' likewise. Literal tables, so every class the renderer emits is
// spelled out (m5-ui-port-cleanup).
const ZONE_CLASSES: Readonly<Record<ZoneScope, string>> = {
  left: 'leftzone zone zone-left',
  project: 'arrange zone zone-project',
  lower: 'lower zone zone-lower',
  right: 'plans zone zone-right',
};
const DIVIDER_CLASSES: Readonly<Record<Zone, string>> = {
  left: 'divider divider-left',
  lower: 'divider divider-lower',
  right: 'divider divider-right',
};
// A drag this far below a zone's minimum collapses it.
const COLLAPSE_THRESHOLD = 4;
// The focus keys run before any element's handler; the rest after.
const FOCUS_PRESET = CUBASE_PRESET.filter((b) => FOCUS_COMMANDS.has(b.commandId));
const COMMAND_PRESET = CUBASE_PRESET.filter((b) => !FOCUS_COMMANDS.has(b.commandId));
// The MixConsole tab's key, as the mockup writes it (the preset's first chord for it).
const MIXCONSOLE_KEY = CUBASE_PRESET.find((b) => b.commandId === 'zone.lower.mixconsole')?.chord ?? '';
const TRANSPORT_METHODS = ['transport.play', 'transport.stop', 'transport.locate'];
const TABBABLE ='a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

function isZoneScope(value: string | undefined): value is ZoneScope {
  return value === 'left' || value === 'project' || value === 'lower' || value === 'right';
}

// Where the focus is: a zone itself, a control inside one (its boundary
// included), the page, a modal dialog, or elsewhere (top bar, status bar).
function placeOf(target: EventTarget | null): FocusPlace {
  // A control can be an svg (the MixConsole's pan knob).
  if (!(target instanceof HTMLElement || target instanceof SVGElement) || target === document.body || target === document.documentElement) return { kind: 'page' };
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

// Where there is no window (a static render): the mockup's window.
const SERVER_VIEWPORT: Viewport = { width: 1440, height: 900 };
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
  return useSyncExternalStore(subscribeViewport, readViewport, () => SERVER_VIEWPORT);
}

export interface ShellProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  // The plan review (m5b-ui-ghosts): Ctrl+Alt+G toggles its ghosts, and a
  // located step or a clicked ghost shows the MixConsole or the Plans tab.
  readonly review?: ReviewStore;
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
  // The realtime playhead and the transport (m5-ui-transport).
  readonly realtime: TransportPlayhead | null;
  readonly transport: TransportController;
  // Locators, cycle and metronome (m5-ui-loop-click).
  readonly loopClick: LoopClickController;
  // What undo and redo can do now (the top bar).
  readonly history: Pick<UndoHistory, 'getSnapshot' | 'subscribe'>;
  readonly left: ReactNode;
  readonly project: ReactNode;
  readonly lower: ReactNode;
  readonly right: ReactNode;
  // The end of the right zone's tab row (the hearing switch, m5-ui-port-plans).
  readonly rightHead?: ReactNode;
}

interface ZoneFrameProps {
  readonly zone: ZoneScope;
  // The mockup's element (aside.leftzone, aside.plans), or a section; its class is ZONE_CLASSES'.
  readonly as?: 'aside' | 'section';
  readonly visible: boolean;
  readonly focused: boolean;
  readonly offline: boolean;
  readonly drawer?: { readonly width: number } | null;
  readonly tabs?: ReactNode;
  // The content is the frame's direct children, as in the mockup's
  // section.arrange, with no zone body (the app's scroll wrapper) between them.
  readonly bare?: boolean;
  readonly onFocus: (zone: ZoneScope) => void;
  readonly frameRef: (el: HTMLElement | null) => void;
  readonly children: ReactNode;
}

function ZoneFrame({ zone, as = 'section', visible, focused, offline, drawer, tabs, bare = false, onFocus, frameRef, children }: ZoneFrameProps) {
  const t = useT();
  const Tag = as;
  return (
    <Tag
      ref={frameRef}
      className={ZONE_CLASSES[zone]}
      data-testid={`zone-${zone}`}
      data-region={`${zone}-zone`}
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
      {bare ? (
        children
      ) : (
        <div className="zone-body" data-testid={`zone-${zone}-body`}>
          {children}
        </div>
      )}
    </Tag>
  );
}

interface SeparatorValues {
  // The zone's size as shown (0 while hidden), its minimum and maximum, in px.
  readonly now: number;
  readonly min: number;
  readonly max: number;
}

// A boundary: a 1 px line with a 7 px hit area, positioned over the edge of
// its zone's grid cell (shell.css), so it adds no grid item. A pointer drag
// sizes the zone live: past the minimum by COLLAPSE_THRESHOLD it collapses,
// and dragged back out it shows again at its minimum or more. The arrows
// step 8 px (Shift: 32 px), Home and End go to the minimum and the maximum,
// Enter and double-click restore the default. Its aria values are the zone's
// size and range in px.
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
  const drag = useRef<{ readonly pointer: number; readonly at: number; readonly size: number } | null>(null);
  const [active, setActive] = useState(false);
  const axis = (event: { clientX: number; clientY: number }) => (zone === 'lower' ? event.clientY : event.clientX);
  // The left zone grows to the right, the right zone to the left, the lower zone upwards.
  const sign = zone === 'left' ? 1 : -1;
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const grow = zone === 'left' ? 'ArrowRight' : zone === 'right' ? 'ArrowLeft' : 'ArrowUp';
    const shrink = zone === 'left' ? 'ArrowLeft' : zone === 'right' ? 'ArrowRight' : 'ArrowDown';
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
    if (!make || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch(make);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { pointer: event.pointerId, at: axis(event), size: values.now };
    setActive(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.pointer !== event.pointerId) return;
    const wanted = from.size + sign * (axis(event) - from.at);
    const size = wanted < values.min - COLLAPSE_THRESHOLD ? 0 : Math.max(wanted, values.min);
    dispatch((viewport) => ({ type: 'resize', zone, size: Math.round(size), viewport }));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    drag.current = null;
    setActive(false);
  };
  return (
    <div
      id={`separator-${zone}`}
      data-testid={`separator-${zone}`}
      data-divider-zone={zone}
      data-active={active ? 'true' : undefined}
      className={DIVIDER_CLASSES[zone]}
      role="separator"
      aria-orientation={zone === 'lower' ? 'horizontal' : 'vertical'}
      aria-label={t('zone.resize', { zone: t(`zone.${zone}`) })}
      aria-valuenow={Math.round(values.now)}
      aria-valuemin={Math.round(values.min)}
      aria-valuemax={Math.round(values.max)}
      aria-disabled={disabled ? 'true' : undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKey}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => {
        if (!disabled) dispatch((viewport) => ({ type: 'reset', zone, viewport }));
      }}
    />
  );
}

export function Shell({
  client,
  plans,
  review,
  engineStatus,
  store,
  commands,
  platform,
  banner,
  phase,
  toasts,
  realtime,
  transport,
  loopClick,
  history,
  left,
  project,
  lower,
  right,
  rightHead,
}: ShellProps) {
  const t = useT();
  const can = useCapabilities();
  const viewport = useViewport();
  const state = useShellState(store);
  const effective: EffectiveLayout = useMemo(() => effectiveLayout(state, viewport), [state, viewport]);
  const [focused, setFocused] = useState<ZoneScope>('project');

  const frames = useRef<Partial<Record<ZoneScope, HTMLElement | null>>>({});
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
          ringStep(ring, active instanceof HTMLElement || active instanceof SVGElement ? (active as HTMLElement) : null, step.step)?.focus();
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

  // The plan review (m5b-ui-ghosts; UI redesign 4.2): Ctrl+Alt+G, and the zones a reveal asks for.
  useEffect(() => {
    if (!review) return undefined;
    const offToggle = commands.register('window', 'plans.toggleGhosts', () => review.toggleGhosts());
    const offReveal = review.onReveal(({ mixer, plans: toPlans }) => {
      if (mixer) dispatch((viewport) => ({ type: 'openTab', zone: 'lower', tab: 'mixconsole', viewport }));
      if (toPlans) dispatch((viewport) => ({ type: 'openTab', zone: 'right', tab: 'plans', viewport }));
    });
    return () => {
      offToggle();
      offReveal();
    };
  }, [commands, dispatch, review]);

  // The transport, undo and redo; the position display's formats and auto-scroll.
  useEffect(() => {
    const can = () => capabilitySelector(client.getState().capabilities);
    const capable = () => TRANSPORT_METHODS.every((method) => can().has(method));
    const offs = [
      bindTransportCommands(commands, transport, {
        transportReady: () => capable() && transportEnabled(engineStatus.getSnapshot(), client.getState().status === 'connected'),
        canUndo: () => can().has('session.undo') && can().has('session.redo'),
      }),
      commands.register('window', 'transport.exchangeFormats', () => {
        if (!capable()) return false;
        store.dispatch({ type: 'exchangeFormats' });
        return true;
      }),
      commands.register('project', 'view.autoScroll', () => store.dispatch({ type: 'autoScroll' })),
      bindLoopClickCommands(commands, loopClick, { cursor: () => realtime?.latest()?.playheadSamples ?? null }),
    ];
    return () => offs.forEach((off) => off());
  }, [client, commands, engineStatus, store, transport, loopClick, realtime]);

  // The keydown listeners: preset table -> dispatcher -> the focused zone
  // first, then the window. The focus keys in the capture phase, before any
  // element's handler (a boundary's, the library's); the rest bubbling, so an
  // element (the About dialog) can keep its keys.
  useEffect(() => {
    // Diagnostic, under the test hooks only (PR #120's macOS e2e): the raw
    // keydown each listener saw, what it resolved and whether it ran.
    const note = (preset: typeof CUBASE_PRESET, event: KeyboardEvent, binding: { scope: string; commandId: string } | null, ran: boolean, prevented: boolean) => {
      const probe = window as unknown as { siannTest?: unknown; __siannKeys?: Record<string, unknown> };
      if (!probe.siannTest || ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return;
      probe.__siannKeys = {
        ...(probe.__siannKeys ?? {}),
        [preset === FOCUS_PRESET ? 'focus' : 'command']: {
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          zone: latest.current.focused,
          platform,
          binding: binding ? `${binding.scope}:${binding.commandId}` : null,
          ran,
          prevented,
        },
      };
    };
    const listener = (preset: typeof CUBASE_PRESET) => (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        note(preset, event, null, false, true);
        return;
      }
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
      const ran = binding ? commands.run(binding.scope, binding.commandId) : false;
      if (ran) event.preventDefault();
      note(preset, event, binding, ran, false);
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
  const separatorValues = (zone: Zone): SeparatorValues => {
    const { min, max } = limits(zone, viewport);
    return { now: zones[zone].visible ? zones[zone].size : 0, min, max };
  };
  // The zone sizes the grid of ui/layout.css takes (0 for a hidden zone or the drawer).
  const cell = (zone: Zone) => (zones[zone].visible && !zones[zone].drawer ? zones[zone].size : 0);
  const grid = {
    '--left-zone-w': `${cell('left')}px`,
    '--right-zone-w': `${cell('right')}px`,
    '--lower-zone-h': `${cell('lower')}px`,
  } as CSSProperties;
  // The lower zone's tab row is the mockup's .tabs (m5-ui-port-mixer-strip):
  // the MixConsole tab with its icon and key, the spacer, and the rack
  // switches (mixer-racks; m5b-ui-inserts-master, UI redesign 3.4) at the
  // row's end with one switch, Inserts, which shows and hides the strips'
  // insert racks and is kept in siann.layout.v1. Routing and Sends join it
  // with m5b-ui-sends-buses; Narrow and the menu the mockup draws there have
  // no behaviour and are not rendered. On an engine without plugins the
  // switches are not in the DOM and nothing replaces them: the row ends at its
  // spacer (3.0). The Editor tab is m5b-ui-editor-channel's and absent; it
  // sits after the MixConsole tab, so nothing moves.
  const racksShown = pluginsListed(can);
  const lowerTabs = (
    <div className="tabs" role="tablist" data-part="lower-tabs">
      <button
        type="button"
        role="tab"
        className={`tab${state.layout.tabs.lower === 'mixconsole' ? ' on' : ''}`}
        data-testid="tab-lower-mixconsole"
        data-part="tab-mixconsole"
        aria-selected={state.layout.tabs.lower === 'mixconsole'}
        onClick={() => store.dispatch({ type: 'tab', zone: 'lower', tab: 'mixconsole' })}
      >
        <Icon name="sliders" small />
        {t('tab.mixconsole')} <kbd>{MIXCONSOLE_KEY}</kbd>
      </button>
      <span className="spacer" />
      {racksShown ? (
        <span className="mixer-racks" data-part="mixer-racks" role="group" aria-label={t('racks.label')}>
          <button
            type="button"
            className={`rack-switch${state.layout.racks.inserts ? ' on' : ''}`}
            data-testid="rack-inserts"
            aria-pressed={state.layout.racks.inserts}
            onClick={() => store.dispatch({ type: 'rack', rack: 'inserts' })}
          >
            {t('racks.inserts')}
          </button>
        </span>
      ) : null}
    </div>
  );
  // The right zone's tab row, the mockup's .p-head (m5-ui-port-plans;
  // ui/right-zone.css): the Plans tab, the boxes of the Media and Meter tabs
  // (pending: m5b-ui-media, m5b-ui-meter; UI redesign 3.0) and the hearing switch.
  const rightTabs = (
    <div className="p-head" role="tablist" data-part="right-tabs">
      <button
        type="button"
        role="tab"
        className="tab on"
        data-testid="tab-right-plans"
        data-part="tab-plans"
        aria-selected={state.layout.tabs.right === 'plans'}
        onClick={() => store.dispatch({ type: 'tab', zone: 'right', tab: 'plans' })}
      >
        <Icon name="spark" small />
        {t('tab.plans')}
      </button>
      <Hold className="hold-tab-media" />
      <Hold className="hold-tab-meter" />
      {rightHead}
    </div>
  );

  return (
    <div
      className="app"
      data-testid="shell"
      data-viewport={`${viewport.width}x${viewport.height}`}
      data-offline={offline ? 'true' : undefined}
      data-animate={String(animate)}
      style={grid}
    >
      <TopBar
        client={client}
        plans={plans}
        zones={zones}
        onToggle={(zone) => dispatch((size) => ({ type: 'toggle', zone, viewport: size }))}
        onPlans={() => dispatch((size) => ({ type: 'openTab', zone: 'right', tab: 'plans', viewport: size }))}
        realtime={realtime}
        engineStatus={engineStatus}
        layout={store}
        commands={commands}
        transport={transport}
        loopClick={loopClick}
        history={history}
      />
      <div className="shell-banner">
        {offline ? (
          <div className="connection-banner" data-testid="connection-banner" role="status">
            {t('connection.banner')}
          </div>
        ) : null}
        {banner}
      </div>
      <ZoneFrame
        as="aside"
        offline={offline}
        zone="left"
        visible={zones.left.visible}
        focused={focused === 'left'}
        onFocus={(z) => focusZone(z, false)}
        frameRef={frameRef('left')}
      >
        {left}
      </ZoneFrame>
      <ZoneSeparator zone="left" values={separatorValues('left')} dispatch={dispatch} />
      <main className="center">
        <ZoneFrame offline={offline} zone="project" bare visible focused={focused === 'project'} onFocus={(z) => focusZone(z, false)} frameRef={frameRef('project')}>
          {project}
        </ZoneFrame>
        <ZoneSeparator zone="lower" values={separatorValues('lower')} dispatch={dispatch} />
        <ZoneFrame
          offline={offline}
          zone="lower"
          visible={zones.lower.visible}
          focused={focused === 'lower'}
          tabs={lowerTabs}
          onFocus={(z) => focusZone(z, false)}
          frameRef={frameRef('lower')}
        >
          {lower}
        </ZoneFrame>
      </main>
      <ZoneSeparator zone="right" disabled={zones.right.drawer} values={separatorValues('right')} dispatch={dispatch} />
      <ZoneFrame
        as="aside"
        offline={offline}
        zone="right"
        visible={zones.right.visible}
        focused={focused === 'right'}
        drawer={zones.right.drawer ? { width: zones.right.size } : null}
        tabs={rightTabs}
        onFocus={(z) => focusZone(z, false)}
        frameRef={frameRef('right')}
      >
        {right}
      </ZoneFrame>
      <StatusBar client={client} plans={plans} engineStatus={engineStatus} />
      <Toasts store={toasts} />
    </div>
  );
}
