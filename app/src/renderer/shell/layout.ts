// The zone layout (UI redesign spec 2.3 and 2.4) as pure functions: the
// stored layout under siann.layout.v1 (sizes, collapsed states, active tabs,
// strip width, and the per-session track heights reserved for m5-ui-arrange),
// a reducer over it, and the effective layout a window of a given size shows.
//
// The stored layout is what the user chose and is per user, never per
// session. The effective layout applies the rules that depend on the window:
// the event display keeps 360x320 px (the lower zone gives way first, then
// the right zone, then the left: each shrinks to its minimum, then hides),
// the right zone becomes an overlay drawer under 1280 px wide, the left zone
// starts collapsed under 1100 px and the lower zone under 760 px high. Those
// rules never rewrite the stored layout; showing such a zone by its button or
// key is remembered for this window only (`opened`).
//
// The project zone is not a Zone: it has no size, no collapse and no action.

export type Zone = 'left' | 'lower' | 'right';
export const ZONES: readonly Zone[] = ['left', 'lower', 'right'];

// One tab per zone in phase 1; Editor, Media and Meter arrive in phase 3 (3.0).
export interface ZoneTabs {
  readonly left: 'track';
  readonly lower: 'mixconsole';
  readonly right: 'plans';
}
const TABS: { readonly [Z in Zone]: readonly ZoneTabs[Z][] } = {
  left: ['track'],
  lower: ['mixconsole'],
  right: ['plans'],
};

export type StripWidth = 'normal' | 'narrow';

export interface Layout {
  readonly sizes: Readonly<Record<Zone, number>>;
  readonly collapsed: Readonly<Record<Zone, boolean>>;
  readonly tabs: ZoneTabs;
  readonly stripWidth: StripWidth;
  // Session id -> track id -> px (m5-ui-arrange); the zones are the same for every session.
  readonly trackHeights: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ShellState {
  readonly layout: Layout;
  // Zones a small-window rule hides that the user showed in this window.
  readonly opened: readonly Zone[];
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export type ShellAction =
  // A drag ended at `size` px (0 or below the minimum: collapsed).
  | { readonly type: 'resize'; readonly zone: Zone; readonly size: number; readonly viewport: Viewport }
  // An arrow key on the focused boundary: +1 grows the zone by ARROW_STEP
  // (ARROW_STEP_LARGE with Shift).
  | { readonly type: 'step'; readonly zone: Zone; readonly direction: 1 | -1; readonly large?: boolean; readonly viewport: Viewport }
  // Home and End on the focused boundary: the zone's minimum or maximum, shown.
  | { readonly type: 'edge'; readonly zone: Zone; readonly edge: 'min' | 'max'; readonly viewport: Viewport }
  // Double-click on the boundary: the default size, shown.
  | { readonly type: 'reset'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'toggle'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'show'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'hide'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'tab'; readonly zone: Zone; readonly tab: string }
  // Show the zone on `tab`, or hide it when it already shows that tab (Alt+F3, F3).
  | { readonly type: 'showTab'; readonly zone: Zone; readonly tab: string; readonly viewport: Viewport }
  // Show the zone on `tab` and leave it shown (Ctrl+Alt+P, the Plans button).
  | { readonly type: 'openTab'; readonly zone: Zone; readonly tab: string; readonly viewport: Viewport };

export interface ZoneView {
  readonly visible: boolean;
  readonly size: number;
  // The right zone under 1280 px: an overlay over the project zone.
  readonly drawer: boolean;
}

export interface EffectiveLayout {
  readonly zones: Readonly<Record<Zone, ZoneView>>;
}

export const LAYOUT_KEY = 'siann.layout.v1';
export const DEFAULT_SIZES: Readonly<Record<Zone, number>> = Object.freeze({ left: 216, lower: 280, right: 348 });
export const ARROW_STEP = 8;
export const ARROW_STEP_LARGE = 32;
export const TOP_BAR = 48;
export const STATUS_BAR = 24;
// The project zone above its event display: the toolbar and the info line.
export const PROJECT_CHROME = 56;
export const DIVIDER = 1;
export const EVENT_MIN_WIDTH = 360;
export const EVENT_MIN_HEIGHT = 320;
export const DRAWER_BELOW_WIDTH = 1280;
export const LEFT_COLLAPSED_BELOW_WIDTH = 1100;
export const LOWER_COLLAPSED_BELOW_HEIGHT = 760;

const STATIC_LIMITS: Readonly<Record<Zone, { readonly min: number; readonly max: number }>> = {
  left: { min: 180, max: 420 },
  lower: { min: 160, max: Number.POSITIVE_INFINITY },
  right: { min: 300, max: 560 },
};

export const DEFAULT_LAYOUT: Layout = Object.freeze({
  sizes: DEFAULT_SIZES,
  collapsed: Object.freeze({ left: false, lower: false, right: false }),
  tabs: Object.freeze({ left: 'track', lower: 'mixconsole', right: 'plans' } as const),
  stripWidth: 'normal',
  trackHeights: Object.freeze({}),
});

function isZone(zone: unknown): zone is Zone {
  return zone === 'left' || zone === 'lower' || zone === 'right';
}

// The lower zone's top: what leaves the event display EVENT_MIN_HEIGHT high.
function lowerMax(viewport: Viewport): number {
  const room = viewport.height - TOP_BAR - STATUS_BAR - PROJECT_CHROME - EVENT_MIN_HEIGHT - DIVIDER;
  return Math.max(STATIC_LIMITS.lower.min, Math.floor(room));
}

export function limits(zone: Zone, viewport: Viewport): { min: number; max: number } {
  const { min, max } = STATIC_LIMITS[zone];
  return { min, max: zone === 'lower' ? lowerMax(viewport) : max };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function initialShellState(layout: Layout): ShellState {
  return { layout, opened: [] };
}

// The small-window rule that hides `zone` at this size, if any.
function smallRule(zone: Zone, viewport: Viewport): boolean {
  switch (zone) {
    case 'left':
      return viewport.width < LEFT_COLLAPSED_BELOW_WIDTH;
    case 'lower':
      return viewport.height < LOWER_COLLAPSED_BELOW_HEIGHT;
    case 'right':
      return viewport.width < DRAWER_BELOW_WIDTH;
  }
}

function withLayout(state: ShellState, patch: Partial<Layout>): ShellState {
  return { ...state, layout: { ...state.layout, ...patch } };
}

function setSize(state: ShellState, zone: Zone, size: number): ShellState {
  if (state.layout.sizes[zone] === size) return state;
  return withLayout(state, { sizes: { ...state.layout.sizes, [zone]: size } });
}

function setCollapsed(state: ShellState, zone: Zone, collapsed: boolean): ShellState {
  if (state.layout.collapsed[zone] === collapsed) return state;
  return withLayout(state, { collapsed: { ...state.layout.collapsed, [zone]: collapsed } });
}

function setOpened(state: ShellState, zone: Zone, opened: boolean): ShellState {
  if (state.opened.includes(zone) === opened) return state;
  return { ...state, opened: opened ? [...state.opened, zone] : state.opened.filter((z) => z !== zone) };
}

function show(state: ShellState, zone: Zone, viewport: Viewport): ShellState {
  const next = setCollapsed(state, zone, false);
  return smallRule(zone, viewport) ? setOpened(next, zone, true) : next;
}

function hide(state: ShellState, zone: Zone, viewport: Viewport): ShellState {
  // Hidden by the window's size and shown by the user: closing it forgets
  // that, and leaves the stored choice alone.
  if (smallRule(zone, viewport) && state.opened.includes(zone)) return setOpened(state, zone, false);
  return setCollapsed(state, zone, true);
}

function setTab(state: ShellState, zone: Zone, tab: string): ShellState {
  if (!(TABS[zone] as readonly string[]).includes(tab) || state.layout.tabs[zone] === tab) return state;
  return withLayout(state, { tabs: { ...state.layout.tabs, [zone]: tab } as ZoneTabs });
}

export function reduce(state: ShellState, action: ShellAction): ShellState {
  if (!isZone(action.zone)) return state;
  const zone = action.zone;
  switch (action.type) {
    case 'resize': {
      const { min, max } = limits(zone, action.viewport);
      if (!Number.isFinite(action.size)) return state;
      if (action.size < min) return hide(state, zone, action.viewport);
      return show(setSize(state, zone, Math.round(clamp(action.size, min, max))), zone, action.viewport);
    }
    case 'step': {
      if (state.layout.collapsed[zone]) return state;
      const { min, max } = limits(zone, action.viewport);
      const step = action.large ? ARROW_STEP_LARGE : ARROW_STEP;
      const size = clamp(state.layout.sizes[zone] + action.direction * step, min, max);
      return setSize(state, zone, size);
    }
    case 'edge': {
      const { min, max } = limits(zone, action.viewport);
      return show(setSize(state, zone, action.edge === 'min' ? min : max), zone, action.viewport);
    }
    case 'reset':
      return show(setSize(state, zone, DEFAULT_SIZES[zone]), zone, action.viewport);
    case 'toggle':
      return effectiveLayout(state, action.viewport).zones[zone].visible
        ? hide(state, zone, action.viewport)
        : show(state, zone, action.viewport);
    case 'show':
      return show(state, zone, action.viewport);
    case 'hide':
      return hide(state, zone, action.viewport);
    case 'tab':
      return setTab(state, zone, action.tab);
    case 'showTab': {
      const visible = effectiveLayout(state, action.viewport).zones[zone].visible;
      if (visible && state.layout.tabs[zone] === action.tab) return hide(state, zone, action.viewport);
      return setTab(show(state, zone, action.viewport), zone, action.tab);
    }
    case 'openTab':
      return setTab(show(state, zone, action.viewport), zone, action.tab);
  }
}

export function effectiveLayout(state: ShellState, viewport: Viewport): EffectiveLayout {
  const { layout } = state;
  const view = {} as Record<Zone, { visible: boolean; size: number; drawer: boolean }>;
  for (const zone of ZONES) {
    const hiddenBySize = smallRule(zone, viewport) && !state.opened.includes(zone);
    view[zone] = {
      visible: !layout.collapsed[zone] && !hiddenBySize,
      size: layout.sizes[zone],
      drawer: zone === 'right' && viewport.width < DRAWER_BELOW_WIDTH,
    };
  }
  // The lower zone gives way to keep the event display EVENT_MIN_HEIGHT high.
  const giveWay = (zone: Zone, room: () => number, floor: number) => {
    const z = view[zone];
    if (!z.visible || z.drawer) return;
    const deficit = floor - room();
    if (deficit <= 0) return;
    const { min } = STATIC_LIMITS[zone];
    z.size = Math.max(min, z.size - deficit);
    if (room() < floor) z.visible = false;
  };
  const height = () =>
    viewport.height - TOP_BAR - STATUS_BAR - PROJECT_CHROME - (view.lower.visible ? view.lower.size + DIVIDER : 0);
  giveWay('lower', height, EVENT_MIN_HEIGHT);
  // Then the right zone and the left zone, to keep it EVENT_MIN_WIDTH wide.
  const width = () =>
    viewport.width -
    (view.left.visible ? view.left.size + DIVIDER : 0) -
    (view.right.visible && !view.right.drawer ? view.right.size + DIVIDER : 0);
  giveWay('right', width, EVENT_MIN_WIDTH);
  giveWay('left', width, EVENT_MIN_WIDTH);
  return { zones: view };
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify({
    sizes: layout.sizes,
    collapsed: layout.collapsed,
    tabs: layout.tabs,
    stripWidth: layout.stripWidth,
    trackHeights: layout.trackHeights,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Field by field: whatever is missing, of the wrong type or unknown falls
// back to the default, and the rest is kept.
export function parseLayout(text: string | null): Layout {
  if (text === null) return DEFAULT_LAYOUT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DEFAULT_LAYOUT;
  }
  const object = record(parsed);
  if (!object) return DEFAULT_LAYOUT;
  const sizes = record(object.sizes) ?? {};
  const collapsed = record(object.collapsed) ?? {};
  const tabs = record(object.tabs) ?? {};
  const size = (zone: Zone): number => {
    const value = sizes[zone];
    return typeof value === 'number' && Number.isFinite(value) && value >= STATIC_LIMITS[zone].min
      ? Math.min(value, STATIC_LIMITS[zone].max)
      : DEFAULT_SIZES[zone];
  };
  const flag = (zone: Zone): boolean => (typeof collapsed[zone] === 'boolean' ? (collapsed[zone] as boolean) : false);
  const tab = <Z extends Zone>(zone: Z): ZoneTabs[Z] =>
    (TABS[zone] as readonly unknown[]).includes(tabs[zone]) ? (tabs[zone] as ZoneTabs[Z]) : DEFAULT_LAYOUT.tabs[zone];
  const trackHeights: Record<string, Record<string, number>> = {};
  for (const [sessionId, heights] of Object.entries(record(object.trackHeights) ?? {})) {
    const kept: Record<string, number> = {};
    for (const [trackId, height] of Object.entries(record(heights) ?? {})) {
      if (typeof height === 'number' && Number.isFinite(height) && height > 0) kept[trackId] = height;
    }
    trackHeights[sessionId] = kept;
  }
  return {
    sizes: { left: size('left'), lower: size('lower'), right: size('right') },
    collapsed: { left: flag('left'), lower: flag('lower'), right: flag('right') },
    tabs: { left: tab('left'), lower: tab('lower'), right: tab('right') },
    stripWidth: object.stripWidth === 'narrow' ? 'narrow' : 'normal',
    trackHeights,
  };
}

// What a session sees: the same zones for every session, and its own track heights.
export function viewFor(
  layout: Layout,
  sessionId: string | null,
): Omit<Layout, 'trackHeights'> & { readonly trackHeights: Readonly<Record<string, number>> } {
  return {
    sizes: layout.sizes,
    collapsed: layout.collapsed,
    tabs: layout.tabs,
    stripWidth: layout.stripWidth,
    trackHeights: (sessionId !== null ? layout.trackHeights[sessionId] : undefined) ?? {},
  };
}
