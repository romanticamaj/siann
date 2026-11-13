// The zone layout (UI redesign spec 2.3 and 2.4), as pure functions.
// Placeholder: the reducer arrives with the feature commit.

export type Zone = 'left' | 'lower' | 'right';
export const ZONES: readonly Zone[] = ['left', 'lower', 'right'];

export interface ZoneTabs {
  readonly left: 'track';
  readonly lower: 'mixconsole';
  readonly right: 'plans';
}
export type StripWidth = 'normal' | 'narrow';

export interface Layout {
  readonly sizes: Readonly<Record<Zone, number>>;
  readonly collapsed: Readonly<Record<Zone, boolean>>;
  readonly tabs: ZoneTabs;
  readonly stripWidth: StripWidth;
  readonly trackHeights: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ShellState {
  readonly layout: Layout;
  readonly opened: readonly Zone[];
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export type ShellAction =
  | { readonly type: 'resize'; readonly zone: Zone; readonly size: number; readonly viewport: Viewport }
  | { readonly type: 'step'; readonly zone: Zone; readonly direction: 1 | -1; readonly viewport: Viewport }
  | { readonly type: 'reset'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'toggle'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'show'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'hide'; readonly zone: Zone; readonly viewport: Viewport }
  | { readonly type: 'tab'; readonly zone: Zone; readonly tab: string }
  | { readonly type: 'showTab'; readonly zone: Zone; readonly tab: string; readonly viewport: Viewport };

export interface ZoneView {
  readonly visible: boolean;
  readonly size: number;
  readonly drawer: boolean;
}
export interface EffectiveLayout {
  readonly zones: Readonly<Record<Zone, ZoneView>>;
}

export const LAYOUT_KEY = 'siann.layout.v1';
export const DEFAULT_SIZES: Readonly<Record<Zone, number>> = { left: 0, lower: 0, right: 0 };
export const ARROW_STEP = 0;
export const TOP_BAR = 0;
export const STATUS_BAR = 0;
export const PROJECT_CHROME = 0;
export const EVENT_MIN_WIDTH = 0;
export const EVENT_MIN_HEIGHT = 0;
export const DEFAULT_LAYOUT: Layout = {
  sizes: DEFAULT_SIZES,
  collapsed: { left: false, lower: false, right: false },
  tabs: { left: 'track', lower: 'mixconsole', right: 'plans' },
  stripWidth: 'normal',
  trackHeights: {},
};

const todo = (): never => {
  throw new Error('not implemented');
};

export function limits(_zone: Zone, _viewport: Viewport): { min: number; max: number } {
  return todo();
}
export function initialShellState(layout: Layout): ShellState {
  return { layout, opened: [] };
}
export function reduce(_state: ShellState, _action: ShellAction): ShellState {
  return todo();
}
export function effectiveLayout(_state: ShellState, _viewport: Viewport): EffectiveLayout {
  return todo();
}
export function serializeLayout(_layout: Layout): string {
  return todo();
}
export function parseLayout(_text: string | null): Layout {
  return todo();
}
export function viewFor(_layout: Layout, _sessionId: string | null): Omit<Layout, 'trackHeights'> & {
  readonly trackHeights: Readonly<Record<string, number>>;
} {
  return todo();
}
