// The zone layout reducer (m5-ui-shell; UI redesign spec 2.3 and 2.4): pure
// functions over the stored layout (siann.layout.v1) and the window size.
// The stored layout is what the user chose; the effective layout is what a
// window of this size shows (the event display keeps 360x320 px, small
// windows start with zones collapsed, the right zone becomes a drawer) and
// never rewrites the stored one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARROW_STEP,
  ARROW_STEP_LARGE,
  DEFAULT_LAYOUT,
  DEFAULT_SIZES,
  EVENT_MIN_HEIGHT,
  EVENT_MIN_WIDTH,
  LAYOUT_KEY,
  PROJECT_CHROME,
  STATUS_BAR,
  TOP_BAR,
  TRACK_LIST_DEFAULT,
  TRACK_LIST_MAX,
  TRACK_LIST_MIN,
  effectiveLayout,
  initialShellState,
  limits,
  parseLayout,
  reduce,
  serializeLayout,
  viewFor,
  type Layout,
  type ShellAction,
  type ShellState,
  type Viewport,
  type Zone,
} from '../../src/renderer/shell/layout';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';

const WIDE: Viewport = { width: 1440, height: 900 };

function run(state: ShellState, ...actions: ShellAction[]): ShellState {
  return actions.reduce(reduce, state);
}

const start = () => initialShellState(DEFAULT_LAYOUT);

test('the defaults are 216, 280 and 348 px, nothing collapsed, under siann.layout.v1', () => {
  assert.equal(LAYOUT_KEY, 'siann.layout.v1');
  assert.deepEqual(DEFAULT_SIZES, { left: 216, lower: 280, right: 348 });
  assert.deepEqual(DEFAULT_LAYOUT.sizes, DEFAULT_SIZES);
  assert.deepEqual(DEFAULT_LAYOUT.collapsed, { left: false, lower: false, right: false });
  assert.deepEqual(DEFAULT_LAYOUT.tabs, { left: 'track', lower: 'mixconsole', right: 'plans' });
  assert.equal(DEFAULT_LAYOUT.stripWidth, 'normal');
  assert.deepEqual(DEFAULT_LAYOUT.trackHeights, {});
  const shown = effectiveLayout(start(), WIDE);
  for (const zone of ['left', 'lower', 'right'] as const) {
    assert.equal(shown.zones[zone].visible, true, zone);
    assert.equal(shown.zones[zone].size, DEFAULT_SIZES[zone], zone);
  }
  assert.equal(shown.zones.right.drawer, false);
});

test('the ranges: left 180-420, right 300-560, lower 160 up to what leaves the event display 320 px high', () => {
  assert.deepEqual(limits('left', WIDE), { min: 180, max: 420 });
  assert.deepEqual(limits('right', WIDE), { min: 300, max: 560 });
  const lower = limits('lower', WIDE);
  assert.equal(lower.min, 160);
  // Top bar, status bar, the project zone's toolbar and info line, one divider.
  assert.equal(lower.max, WIDE.height - TOP_BAR - STATUS_BAR - PROJECT_CHROME - EVENT_MIN_HEIGHT - 1);
  assert.equal(TOP_BAR, 48);
  assert.equal(STATUS_BAR, 24);
  assert.equal(EVENT_MIN_HEIGHT, 320);
  assert.equal(EVENT_MIN_WIDTH, 360);
  // Never below its minimum, however small the window.
  assert.equal(limits('lower', { width: 960, height: 600 }).max, 160);
});

test('a drag clamps to the range of each zone', () => {
  const cases: Array<[Zone, number, number]> = [
    ['left', 300, 300],
    ['left', 900, 420],
    ['left', 180, 180],
    ['right', 400, 400],
    ['right', 1000, 560],
    ['right', 300, 300],
    ['lower', 200, 200],
    ['lower', 2000, limits('lower', WIDE).max],
    ['lower', 160, 160],
  ];
  for (const [zone, size, expected] of cases) {
    const next = reduce(start(), { type: 'resize', zone, size, viewport: WIDE });
    assert.equal(next.layout.sizes[zone], expected, `${zone} ${size}`);
    assert.equal(next.layout.collapsed[zone], false, `${zone} ${size}`);
  }
});

test('a drag below the minimum collapses; restore returns the last size', () => {
  for (const zone of ['left', 'lower', 'right'] as const) {
    const sized = reduce(start(), { type: 'resize', zone, size: limits(zone, WIDE).min + 24, viewport: WIDE });
    const collapsed = reduce(sized, { type: 'resize', zone, size: limits(zone, WIDE).min - 1, viewport: WIDE });
    assert.equal(collapsed.layout.collapsed[zone], true, zone);
    assert.equal(effectiveLayout(collapsed, WIDE).zones[zone].visible, false, zone);
    const restored = reduce(collapsed, { type: 'show', zone, viewport: WIDE });
    assert.equal(restored.layout.collapsed[zone], false, zone);
    assert.equal(restored.layout.sizes[zone], limits(zone, WIDE).min + 24, `${zone} keeps its last size`);
    // A toggle twice is the same round trip.
    const toggled = run(sized, { type: 'toggle', zone, viewport: WIDE }, { type: 'toggle', zone, viewport: WIDE });
    assert.deepEqual(toggled.layout, sized.layout, zone);
  }
});

test('an arrow step moves a boundary by 8 px inside the range', () => {
  assert.equal(ARROW_STEP, 8);
  const grown = reduce(start(), { type: 'step', zone: 'left', direction: 1, viewport: WIDE });
  assert.equal(grown.layout.sizes.left, 224);
  const shrunk = reduce(start(), { type: 'step', zone: 'right', direction: -1, viewport: WIDE });
  assert.equal(shrunk.layout.sizes.right, 340);
  const atMax = reduce(
    reduce(start(), { type: 'resize', zone: 'left', size: 418, viewport: WIDE }),
    { type: 'step', zone: 'left', direction: 1, viewport: WIDE },
  );
  assert.equal(atMax.layout.sizes.left, 420);
  const atMin = reduce(
    reduce(start(), { type: 'resize', zone: 'lower', size: 164, viewport: WIDE }),
    { type: 'step', zone: 'lower', direction: -1, viewport: WIDE },
  );
  assert.equal(atMin.layout.sizes.lower, 160);
  assert.equal(atMin.layout.collapsed.lower, false, 'a key step never collapses');
});

test('Shift+arrow moves a boundary by 32 px; Home and End take it to its minimum and maximum', () => {
  assert.equal(ARROW_STEP_LARGE, 32);
  const grown = reduce(start(), { type: 'step', zone: 'left', direction: 1, large: true, viewport: WIDE });
  assert.equal(grown.layout.sizes.left, 248);
  const shrunk = reduce(start(), { type: 'step', zone: 'lower', direction: -1, large: true, viewport: WIDE });
  assert.equal(shrunk.layout.sizes.lower, 248);
  for (const zone of ['left', 'lower', 'right'] as const) {
    const { min, max } = limits(zone, WIDE);
    const low = reduce(start(), { type: 'edge', zone, edge: 'min', viewport: WIDE });
    assert.equal(low.layout.sizes[zone], min, `${zone} Home`);
    assert.equal(low.layout.collapsed[zone], false, `${zone} Home never collapses`);
    const high = reduce(start(), { type: 'edge', zone, edge: 'max', viewport: WIDE });
    assert.equal(high.layout.sizes[zone], max, `${zone} End`);
    // A hidden zone is shown at the edge.
    const hidden = reduce(start(), { type: 'hide', zone, viewport: WIDE });
    assert.equal(reduce(hidden, { type: 'edge', zone, edge: 'min', viewport: WIDE }).layout.collapsed[zone], false, zone);
  }
});

test('reset returns the default size and shows the zone', () => {
  for (const zone of ['left', 'lower', 'right'] as const) {
    const moved = run(
      start(),
      { type: 'resize', zone, size: limits(zone, WIDE).min + 40, viewport: WIDE },
      { type: 'hide', zone, viewport: WIDE },
    );
    const reset = reduce(moved, { type: 'reset', zone, viewport: WIDE });
    assert.equal(reset.layout.sizes[zone], DEFAULT_SIZES[zone], zone);
    assert.equal(reset.layout.collapsed[zone], false, zone);
  }
});

test('the project zone has no collapse action', () => {
  const state = start();
  const project = 'project' as unknown as Zone;
  for (const type of ['toggle', 'hide', 'resize', 'step', 'reset'] as const) {
    const action = { type, zone: project, size: 0, direction: -1, viewport: WIDE } as unknown as ShellAction;
    assert.equal(reduce(state, action), state, type);
  }
  assert.equal('project' in effectiveLayout(state, WIDE).zones, false);
});

test('tabs: showTab shows a zone on a tab, and hides it when it already shows that tab', () => {
  const hidden = reduce(start(), { type: 'hide', zone: 'lower', viewport: WIDE });
  const shown = reduce(hidden, { type: 'showTab', zone: 'lower', tab: 'mixconsole', viewport: WIDE });
  assert.equal(effectiveLayout(shown, WIDE).zones.lower.visible, true);
  assert.equal(shown.layout.tabs.lower, 'mixconsole');
  const again = reduce(shown, { type: 'showTab', zone: 'lower', tab: 'mixconsole', viewport: WIDE });
  assert.equal(effectiveLayout(again, WIDE).zones.lower.visible, false);
});

// Ctrl+Alt+P and the Plans button only show the right zone on the Plans tab
// (UI redesign spec 2.1 and 3.6): pressed again they leave it shown, unlike
// Ctrl+Alt+R (a toggle) and Alt+F3 / F3 (show, then hide).
test('tabs: openTab shows a zone on a tab and leaves it shown when it already shows that tab', () => {
  const right = reduce(reduce(start(), { type: 'hide', zone: 'right', viewport: WIDE }), {
    type: 'openTab',
    zone: 'right',
    tab: 'plans',
    viewport: WIDE,
  });
  assert.equal(effectiveLayout(right, WIDE).zones.right.visible, true);
  assert.equal(right.layout.tabs.right, 'plans');
  const again = reduce(right, { type: 'openTab', zone: 'right', tab: 'plans', viewport: WIDE });
  assert.equal(effectiveLayout(again, WIDE).zones.right.visible, true);
  assert.deepEqual(again, right);
});

test('the event display keeps 360x320: the lower zone, then the right, then the left give way, the stored layout untouched', () => {
  const big = run(
    start(),
    { type: 'resize', zone: 'left', size: 420, viewport: WIDE },
    { type: 'resize', zone: 'right', size: 560, viewport: WIDE },
    { type: 'resize', zone: 'lower', size: limits('lower', WIDE).max, viewport: WIDE },
  );
  // 1300 wide: 1300 - 420 - 560 - 2 = 318 < 216 + 1 + 360 (the track list,
  // its divider and the event display). The right zone gives way first.
  const narrow: Viewport = { width: 1300, height: 900 };
  const shown = effectiveLayout(big, narrow);
  const width = (s: typeof shown) =>
    narrow.width -
    (s.zones.left.visible ? s.zones.left.size + 1 : 0) -
    (s.zones.right.visible && !s.zones.right.drawer ? s.zones.right.size + 1 : 0);
  assert.ok(width(shown) >= TRACK_LIST_DEFAULT + 1 + EVENT_MIN_WIDTH, `project zone ${width(shown)} px wide`);
  assert.equal(shown.zones.left.size, 420, 'the left zone gives way last');
  assert.ok(shown.zones.right.size < 560);
  assert.equal(big.layout.sizes.right, 560, 'the stored layout is not rewritten');
  // Vertically: a shorter window shrinks the lower zone first, then hides it.
  const short: Viewport = { width: 1440, height: 800 };
  const v = effectiveLayout(big, short);
  const eventHeight = short.height - TOP_BAR - STATUS_BAR - PROJECT_CHROME - (v.zones.lower.visible ? v.zones.lower.size + 1 : 0);
  assert.ok(eventHeight >= EVENT_MIN_HEIGHT, `event display ${eventHeight} px high`);
  assert.equal(v.zones.lower.visible, true);
  assert.equal(big.layout.sizes.lower, limits('lower', WIDE).max);
  // 600 high: at its minimum the lower zone still leaves too little; it hides.
  const opened = reduce(start(), { type: 'show', zone: 'lower', viewport: { width: 1440, height: 600 } });
  assert.equal(effectiveLayout(opened, { width: 1440, height: 600 }).zones.lower.visible, false);
  // The left zone gives way last, in a window narrower than the shell allows
  // (a browser tab): it shrinks to what leaves the track list and 360 px, then hides.
  const tab: Viewport = { width: 900, height: 900 };
  const left = reduce(big, { type: 'show', zone: 'left', viewport: tab });
  assert.equal(effectiveLayout(left, tab).zones.left.visible, true);
  assert.equal(effectiveLayout(left, tab).zones.left.size, 900 - (TRACK_LIST_DEFAULT + 1 + EVENT_MIN_WIDTH) - 1);
  const tiny: Viewport = { width: 700, height: 900 };
  assert.equal(effectiveLayout(reduce(big, { type: 'show', zone: 'left', viewport: tiny }), tiny).zones.left.visible, false);
  assert.equal(big.layout.sizes.left, 420);
});

test('small windows: the right zone is a drawer under 1280, the left starts collapsed under 1100, the lower under 760 high', () => {
  const at = (width: number, height: number) => effectiveLayout(start(), { width, height });
  assert.equal(at(1280, 900).zones.right.drawer, false);
  assert.equal(at(1279, 900).zones.right.drawer, true);
  assert.equal(at(1279, 900).zones.right.visible, false, 'the drawer starts closed');
  assert.equal(at(1100, 900).zones.left.visible, true);
  assert.equal(at(1099, 900).zones.left.visible, false);
  assert.equal(at(1440, 760).zones.lower.visible, true);
  assert.equal(at(1440, 759).zones.lower.visible, false);
  // The keys and buttons still open them, without touching the stored layout.
  const small: Viewport = { width: 1024, height: 700 };
  const opened = run(
    start(),
    { type: 'toggle', zone: 'left', viewport: small },
    { type: 'toggle', zone: 'right', viewport: small },
  );
  assert.equal(effectiveLayout(opened, small).zones.left.visible, true);
  assert.equal(effectiveLayout(opened, small).zones.right.visible, true);
  assert.equal(effectiveLayout(opened, small).zones.right.drawer, true);
  assert.deepEqual(opened.layout, DEFAULT_LAYOUT);
  const closed = reduce(opened, { type: 'toggle', zone: 'right', viewport: small });
  assert.equal(effectiveLayout(closed, small).zones.right.visible, false);
  assert.deepEqual(closed.layout, DEFAULT_LAYOUT);
});

test('serialize and parse one object; unknown or corrupt JSON falls back to the defaults', () => {
  const changed = run(
    start(),
    { type: 'resize', zone: 'left', size: 300, viewport: WIDE },
    { type: 'hide', zone: 'right', viewport: WIDE },
    { type: 'tab', zone: 'lower', tab: 'mixconsole' },
  ).layout;
  const withHeights: Layout = { ...changed, stripWidth: 'narrow', trackHeights: { ses_a: { trk_1: 96 } } };
  const text = serializeLayout(withHeights);
  const object = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(object).sort(), ['autoScroll', 'collapsed', 'sizes', 'stripWidth', 'tabs', 'timeFormat', 'trackHeights', 'trackList']);
  assert.deepEqual(parseLayout(text), withHeights);
  for (const bad of [null, '', '{', 'null', '42', '[]', '"x"']) assert.deepEqual(parseLayout(bad), DEFAULT_LAYOUT, String(bad));
  // Field by field: a bad field falls back, the rest is kept.
  const partial = parseLayout(
    JSON.stringify({ sizes: { left: 'wide', lower: 200, right: -5 }, collapsed: { left: 'yes', right: true }, tabs: { lower: 'nope' }, stripWidth: 3, trackHeights: { s: { t: 'x' } } }),
  );
  assert.deepEqual(partial.sizes, { left: 216, lower: 200, right: 348 });
  assert.deepEqual(partial.collapsed, { left: false, lower: false, right: true });
  assert.deepEqual(partial.tabs, DEFAULT_LAYOUT.tabs);
  assert.equal(partial.stripWidth, 'normal');
  assert.deepEqual(partial.trackHeights, { s: {} });
});

test('the same stored layout serves every session; only the reserved track heights are per session id', () => {
  const layout: Layout = { ...DEFAULT_LAYOUT, sizes: { left: 250, lower: 200, right: 400 }, trackHeights: { ses_a: { trk_1: 96 } } };
  const a = viewFor(layout, 'ses_a');
  const b = viewFor(layout, 'ses_b');
  assert.deepEqual({ ...a, trackHeights: null }, { ...b, trackHeights: null });
  assert.deepEqual(a.sizes, layout.sizes);
  assert.deepEqual(a.trackHeights, { trk_1: 96 });
  assert.deepEqual(b.trackHeights, {});
});

test('the layout store reads and writes one key and survives storage that throws', () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
  saved.set(LAYOUT_KEY, serializeLayout({ ...DEFAULT_LAYOUT, sizes: { left: 300, lower: 200, right: 400 } }));
  const store = createLayoutStore({ storage });
  assert.equal(store.getSnapshot().layout.sizes.left, 300);
  let calls = 0;
  const off = store.subscribe(() => (calls += 1));
  store.dispatch({ type: 'hide', zone: 'right', viewport: WIDE });
  assert.equal(calls, 1);
  assert.deepEqual([...saved.keys()], [LAYOUT_KEY]);
  assert.equal(parseLayout(saved.get(LAYOUT_KEY)!).collapsed.right, true);
  // An action that changes nothing writes nothing and notifies nobody.
  store.dispatch({ type: 'hide', zone: 'right', viewport: WIDE });
  assert.equal(calls, 1);
  off();
  const blocked = () => {
    throw new Error('blocked');
  };
  const broken = createLayoutStore({ storage: { getItem: blocked, setItem: blocked } });
  assert.deepEqual(broken.getSnapshot().layout, DEFAULT_LAYOUT);
  broken.dispatch({ type: 'hide', zone: 'left', viewport: WIDE });
  assert.equal(broken.getSnapshot().layout.collapsed.left, true);
  assert.deepEqual(createLayoutStore({ storage: null }).getSnapshot().layout, DEFAULT_LAYOUT);
});

// m5-ui-arrange: the track list / event display boundary (spec 2.3: 216 px,
// 140-420 px, never collapses) and the per-session track heights.
test('the track list is 216 px by default, drags within 140-420 and never collapses', () => {
  assert.equal(TRACK_LIST_DEFAULT, 216);
  assert.equal(TRACK_LIST_MIN, 140);
  assert.equal(TRACK_LIST_MAX, 420);
  assert.equal(DEFAULT_LAYOUT.trackList, 216);
  const at = (size: number) => reduce(start(), { type: 'trackListResize', size }).layout.trackList;
  assert.equal(at(300), 300);
  assert.equal(at(900), 420);
  assert.equal(at(100), 140, 'below the minimum it stops there');
  assert.equal(at(0), 140, 'and never collapses');
  assert.equal(at(Number.NaN), 216, 'a bad size changes nothing');
  assert.equal(at(250.6), 251);
});

test('the track list boundary keys: arrows 8 px, Shift 32 px, Home and End, Enter resets', () => {
  const step = (direction: 1 | -1, large = false, from = start()) =>
    reduce(from, { type: 'trackListStep', direction, large }).layout.trackList;
  assert.equal(step(1), 224);
  assert.equal(step(-1), 208);
  assert.equal(step(1, true), 248);
  assert.equal(step(-1, true), 184);
  const nearMin = reduce(start(), { type: 'trackListResize', size: 144 });
  assert.equal(step(-1, false, nearMin), 140);
  assert.equal(reduce(start(), { type: 'trackListEdge', edge: 'min' }).layout.trackList, 140);
  assert.equal(reduce(start(), { type: 'trackListEdge', edge: 'max' }).layout.trackList, 420);
  const moved = reduce(start(), { type: 'trackListResize', size: 333 });
  assert.equal(reduce(moved, { type: 'trackListReset' }).layout.trackList, 216);
  // The zone guard does not swallow it, and it leaves the zones alone.
  assert.deepEqual(reduce(moved, { type: 'trackListReset' }).layout.sizes, DEFAULT_SIZES);
});

test('track heights: one track or all, per session id, clamped to 24-240', () => {
  const one = reduce(start(), { type: 'trackHeight', sessionId: 'ses_a', trackId: 'trk_1', height: 96 });
  assert.deepEqual(one.layout.trackHeights, { ses_a: { trk_1: 96 } });
  const clamped = reduce(one, { type: 'trackHeight', sessionId: 'ses_a', trackId: 'trk_2', height: 5 });
  assert.deepEqual(clamped.layout.trackHeights, { ses_a: { trk_1: 96, trk_2: 24 } });
  const all = reduce(clamped, { type: 'allTrackHeights', sessionId: 'ses_a', trackIds: ['trk_1', 'trk_2', 'trk_3'], height: 500 });
  assert.deepEqual(all.layout.trackHeights, { ses_a: { trk_1: 240, trk_2: 240, trk_3: 240 } });
  const other = reduce(all, { type: 'trackHeight', sessionId: 'ses_b', trackId: 'trk_1', height: 64 });
  assert.deepEqual(other.layout.trackHeights.ses_a, { trk_1: 240, trk_2: 240, trk_3: 240 });
  assert.deepEqual(other.layout.trackHeights.ses_b, { trk_1: 64 });
  assert.deepEqual(viewFor(other.layout, 'ses_b').trackHeights, { trk_1: 64 });
  // An unchanged height is the same state (nothing to store).
  assert.equal(reduce(one, { type: 'trackHeight', sessionId: 'ses_a', trackId: 'trk_1', height: 96 }), one);
  assert.equal(reduce(start(), { type: 'trackHeight', sessionId: '', trackId: 'trk_1', height: 96 }).layout, DEFAULT_LAYOUT, 'no session, nothing stored');
});

test('the track list width and heights round-trip through siann.layout.v1; bad values fall back', () => {
  const layout: Layout = { ...DEFAULT_LAYOUT, trackList: 300, trackHeights: { ses_a: { trk_1: 96 } } };
  assert.deepEqual(parseLayout(serializeLayout(layout)), layout);
  for (const bad of ['wide', -5, 0, 1000, null]) {
    const parsed = parseLayout(JSON.stringify({ trackList: bad }));
    assert.equal(parsed.trackList, bad === 1000 ? 420 : 216, String(bad));
  }
  assert.equal(parseLayout(JSON.stringify({ trackList: 100 })).trackList, 216, 'below the minimum: the default');
  const heights = parseLayout(JSON.stringify({ trackHeights: { s: { a: 500, b: 10, c: 'x' } } })).trackHeights;
  assert.deepEqual(heights, { s: { a: 240, b: 24 } });
});

test('the zone rule reserves the track list and 360 px for the event display', () => {
  // 1440 wide, left 420, right 560: 1440 - 421 - 561 = 458 < 216 + 1 + 360.
  const big = run(
    start(),
    { type: 'resize', zone: 'left', size: 420, viewport: WIDE },
    { type: 'resize', zone: 'right', size: 560, viewport: WIDE },
  );
  const shown = effectiveLayout(big, WIDE);
  assert.equal(shown.trackList, 216);
  assert.equal(shown.zones.right.size, 1440 - 421 - (216 + 1 + 360) - 1, 'the right zone gives way');
  // A narrower track list leaves the right zone more.
  const narrowList = reduce(big, { type: 'trackListResize', size: 140 });
  assert.equal(effectiveLayout(narrowList, WIDE).zones.right.size, 1440 - 421 - (140 + 1 + 360) - 1);
});

// m5-ui-transport (UI redesign spec 3.1): auto-scroll (on by default, as in
// Cubase) and the position display's primary format (Bars+Beats by default,
// Seconds secondary) are per-viewer view state in siann.layout.v1; neither
// reaches the engine.
test('auto-scroll and the primary time format: defaults, F and the period key, kept in siann.layout.v1', () => {
  assert.equal(DEFAULT_LAYOUT.autoScroll, true);
  assert.equal(DEFAULT_LAYOUT.timeFormat, 'bars');
  const off = reduce(start(), { type: 'autoScroll' });
  assert.equal(off.layout.autoScroll, false);
  assert.equal(reduce(off, { type: 'autoScroll' }).layout.autoScroll, true);
  assert.equal(reduce(off, { type: 'autoScroll', enabled: false }), off, 'unchanged: the same state');
  const seconds = reduce(start(), { type: 'exchangeFormats' });
  assert.equal(seconds.layout.timeFormat, 'seconds');
  assert.equal(reduce(seconds, { type: 'exchangeFormats' }).layout.timeFormat, 'bars');
  // The zones are untouched.
  assert.deepEqual(seconds.layout.sizes, DEFAULT_LAYOUT.sizes);

  const layout: Layout = { ...DEFAULT_LAYOUT, autoScroll: false, timeFormat: 'seconds' };
  assert.deepEqual(parseLayout(serializeLayout(layout)), layout);
  for (const bad of ['yes', 1, null]) assert.equal(parseLayout(JSON.stringify({ autoScroll: bad })).autoScroll, true, String(bad));
  for (const bad of ['beats', 1, null]) assert.equal(parseLayout(JSON.stringify({ timeFormat: bad })).timeFormat, 'bars', String(bad));
  // A layout stored before this ticket gets the defaults.
  const older = parseLayout(JSON.stringify({ trackList: 300 }));
  assert.equal(older.autoScroll, true);
  assert.equal(older.timeFormat, 'bars');

  const saved = new Map<string, string>();
  const store = createLayoutStore({ storage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => void saved.set(k, v) } });
  store.dispatch({ type: 'autoScroll' });
  store.dispatch({ type: 'exchangeFormats' });
  assert.deepEqual([...saved.keys()], [LAYOUT_KEY]);
  const stored = JSON.parse(saved.get(LAYOUT_KEY)!) as { autoScroll: unknown; timeFormat: unknown };
  assert.equal(stored.autoScroll, false);
  assert.equal(stored.timeFormat, 'seconds');
});
