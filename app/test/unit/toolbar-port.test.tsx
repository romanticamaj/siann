// The project zone toolbar port (m5-ui-port-toolbar; UI redesign 10.9, 10.10
// P1-16, 3.0, 3.2, 10.8): the toolbar renders what the mockup's app.innerHTML
// template writes in div.arr-toolbar, with tool() for each tool, on the
// timeline's own state. The expectations come from the mockup's script
// (support/mockup.ts) and from app/test/fidelity/manifest.json (which parts are
// pending), not from the code under test:
//
// - the children in the template's order: .seg (the tools), the snap, grid
//   type and auto-scroll .field, the .spacer, then the box of the proposal
//   pill (m5b-ui-ghosts);
// - tools 1 and 3 as tool() returns them: .b with the small icon and its kbd,
//   .on on the active one; the boxes of tools 2 and 4 to 9 (m5b-ui-edit-more)
//   stay where tool() would put them, empty;
// - the snap field: magnet, label, the snap type in <em>, chevron, .on when
//   snap is on; the grid type field: grid, the grid type's label, chevron;
//   auto-scroll: the follow icon alone, .on when it follows;
// - the labels per locale are the mockup's L() (en and zh-TW);
// - the ids are the mockup's minus the pending parts'; the test ids of
//   m5-ui-edit-basics stay; no media button and no Delete clip button.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore } from '../../src/renderer/i18n/t';
import type { GridType } from '../../src/renderer/timeline/snap';
import { Toolbar, type ToolbarProps } from '../../src/renderer/timeline/Toolbar';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';

const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'test', 'fidelity', 'manifest.json'), 'utf8')) as {
  gates: Record<string, string>;
  rules: Array<{ match: string[]; gate: string }>;
};

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const pending = (id: string) => {
  const rule = MANIFEST.rules.find((r) => r.match.some((p) => glob(p).test(id)));
  assert.ok(rule, `no manifest rule owns ${id}`);
  return MANIFEST.gates[rule.gate] === 'pending';
};

const noop = () => undefined;
const ALL = { select: true, split: true, snap: true, autoScroll: true };

function props(over: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    tool: 'select',
    snap: { on: true, grid: 'adapt' as GridType },
    autoScroll: false,
    gates: ALL,
    error: null,
    onTool: noop,
    onSnapToggle: noop,
    onGrid: noop,
    onAutoScroll: noop,
    ...over,
  };
}

function render(over: Partial<ToolbarProps> = {}, locale?: Locale): Element {
  const before = localeStore();
  if (locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return find(parse(renderToStaticMarkup(<Toolbar {...props(over)} />)), byClass('arr-toolbar'));
  } finally {
    installLocaleStore(before);
  }
}

const mockupToolbar = (lang = 'en') => find(parse(loadMockup(lang).projectHead), byClass('arr-toolbar'));
const part = (root: Element, id: string) => find(root, byAttr('data-part', id));
// The app-only refusal line is not the mockup's; it draws nothing when empty.
const ported = (root: Element) => elements(root).filter((el) => el.attrs['data-testid'] !== 'timeline-error');

// An empty box (UI redesign 3.0): no child, no text, no role, no focus, no id, hidden from assistive technology.
function assertEmptyBox(el: Element, what: string): void {
  assert.deepEqual(el.children, [], `${what}: nothing in it`);
  assert.equal(el.attrs['aria-hidden'], 'true', `${what}: aria-hidden`);
  for (const name of ['role', 'tabindex', 'data-part', 'data-testid', 'title', 'aria-label']) assert.ok(!(name in el.attrs), `${what}: no ${name}`);
}

// An icon as ic(name, 's') writes it: svg.i.s, the 16 px viewBox and the P table's drawing.
function assertIcon(app: Element, mockup: Element, what: string): void {
  assert.equal(app.tag, 'svg', what);
  assert.deepEqual(classes(app).sort(), classes(mockup).sort(), `${what}: class`);
  assert.equal(app.attrs.viewBox ?? app.attrs.viewbox, mockup.attrs.viewBox ?? mockup.attrs.viewbox, `${what}: viewBox`);
  assert.deepEqual(
    elements(app).map((el) => ({ tag: el.tag, attrs: el.attrs })),
    elements(mockup).map((el) => ({ tag: el.tag, attrs: el.attrs })),
    `${what}: the drawing`,
  );
}

test('the toolbar has the template\'s children in its order and classes; without a reviewable plan nothing follows the refusal line', () => {
  const app = render();
  const mockup = mockupToolbar();
  assert.equal(app.tag, 'div');
  assert.equal(app.attrs['data-part'], 'toolbar');
  const mine = ported(app);
  const theirs = elements(mockup);
  // No reviewable plan: the pill is not in the DOM, and no box replaces it (UI redesign 3.0, m5b-ui-ghosts).
  assert.equal(mine.length, theirs.length - 1);
  const strip = (el: Element) => sig(el).replace(/\.on\b/, '');
  assert.deepEqual(mine.map((el) => strip(el).replace(/^button/, 'span')), theirs.slice(0, -1).map(strip));
  assert.deepEqual(mine.slice(0, 5).map((el) => el.attrs['data-part'] ?? (classes(el).includes('spacer') ? 'spacer' : '?')), ['tools', 'snap', 'grid-type', 'auto-scroll', 'spacer']);
  assert.equal(sig(theirs.at(-1)!), 'span.overlaypill');
  const all = elements(app);
  assert.equal(all.at(-1)!.attrs['data-testid'], 'timeline-error', 'the refusal line ends the toolbar');
  assert.ok(!findAll(app, byAttr('data-part', 'proposal-pill')).length);
  assert.ok(!findAll(app, (el) => classes(el).some((c) => /proposal|pill/.test(c))).length, 'no hold');
});

// m5b-ui-ghosts (UI redesign 4.2): the pill names the overlaid plan and toggles its ghosts.
test('with a reviewable plan the pill ends the toolbar: span.overlaypill, the spark icon, <b>lead</b> · steps, .tog as a button with aria-pressed', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const app = render({ pill: { lead: 'Add track Pad', steps: '6 steps', on: true, onToggle: noop } }, locale);
    const mockup = mockupToolbar(lang);
    const pill = elements(app).at(-1)!;
    const mPill = elements(mockup).at(-1)!;
    assert.equal(sig(pill), sig(mPill));
    assert.equal(pill.attrs['data-part'], 'proposal-pill');
    assert.deepEqual(elements(pill).map(sig).map((s) => s.replace(/^button/, 'span')), elements(mPill).map(sig));
    const [icon, name, tog] = elements(pill);
    assertIcon(icon!, elements(mPill)[0]!, 'the spark');
    assert.equal(text(find(name!, (el) => el.tag === 'b')), 'Add track Pad');
    assert.equal(text(name!), 'Add track Pad · 6 steps');
    assert.equal(tog!.tag, 'button');
    assert.equal(tog!.attrs['aria-pressed'], 'true');
    assert.ok(tog!.attrs['aria-label']);
    assert.equal(text(tog!), text(elements(mPill)[2]!), locale);
    assertIcon(elements(tog!)[0]!, elements(elements(mPill)[2]!)[0]!, 'the check');
    // The refusal line stays before the pill.
    const all = elements(app);
    assert.ok(all.findIndex((el) => el.attrs['data-testid'] === 'timeline-error') < all.length - 1);
  }
  const off = elements(render({ pill: { lead: 'x', steps: '1 step', on: false, onToggle: noop } })).at(-1)!;
  assert.equal(find(off, byClass('tog')).attrs['aria-pressed'], 'false');
});

test('the tools: 1 and 3 as tool() returns them, the boxes of 2 and 4 to 9 empty in their places', () => {
  for (const [tool, active] of [['select', 'tool-1'], ['split', 'tool-3']] as const) {
    const app = part(render({ tool }), 'tools');
    const mockup = part(mockupToolbar(), 'tools');
    assert.equal(sig(app), 'div.seg');
    const mine = elements(app);
    const theirs = elements(mockup);
    assert.equal(mine.length, 9);
    assert.equal(theirs.length, 9);
    for (let i = 0; i < 9; i += 1) {
      const id = theirs[i]!.attrs['data-part']!;
      if (id === 'tool-1' || id === 'tool-3') {
        const el = mine[i]!;
        assert.equal(el.attrs['data-part'], id);
        assert.ok(classes(el).includes('b'), `${id}: .b`);
        assert.equal(classes(el).includes('on'), id === active, `${id}: .on`);
        assert.equal(el.attrs['aria-pressed'], String(id === active), `${id}: aria-pressed`);
        const [icon, kbd, ...rest] = elements(el);
        const [mIcon, mKbd] = elements(theirs[i]!);
        assertIcon(icon!, mIcon!, id);
        assert.equal(kbd!.tag, 'kbd');
        assert.equal(text(kbd!), text(mKbd!));
        assert.deepEqual(rest, [], `${id}: the icon and the kbd only`);
      } else {
        assert.ok(pending(id), `${id} is pending`);
        assertEmptyBox(mine[i]!, id);
      }
    }
  }
  // tool() with the mockup's arguments writes the same as the template.
  const mockup = loadMockup();
  assert.equal(sig(find(parse(mockup.tool('cut', 3)), byClass('b'))), 'span.b');
  assert.equal(sig(find(parse(mockup.tool('ptr', 1, true)), byClass('b'))), 'span.b.on');
  // The test ids of m5-ui-edit-basics stay.
  const app = render();
  assert.equal(part(app, 'tool-1').attrs['data-testid'], 'tool-select');
  assert.equal(part(app, 'tool-3').attrs['data-testid'], 'tool-split');
});

test('the snap field: magnet, label, the snap type, chevron; .on and pressed with snap', () => {
  for (const on of [true, false]) {
    const field = part(render({ snap: { on, grid: 'adapt' } }), 'snap');
    const mField = part(mockupToolbar(), 'snap');
    assert.equal(sig(field).replace(/^button/, 'span').replace(/\.on\b/, ''), 'span.field');
    assert.equal(classes(field).includes('on'), on);
    assert.equal(field.attrs['aria-pressed'], String(on));
    assert.equal(field.attrs['data-testid'], 'snap-toggle');
    assert.deepEqual(elements(field).map((el) => el.tag), elements(mField).map((el) => el.tag));
    const [magnet, em, chev] = elements(field);
    const [mMagnet, mEm, mChev] = elements(mField);
    assertIcon(magnet!, mMagnet!, 'magnet');
    assert.equal(em!.tag, 'em');
    assert.equal(text(em!), text(mEm!));
    assertIcon(chev!, mChev!, 'chev');
  }
});

test('the grid type field: grid icon, the grid type\'s label, chevron, for Bar, Beat and Adapt to Zoom', () => {
  const mField = part(mockupToolbar(), 'grid-type');
  const labels: Record<GridType, string> = { bar: 'Bar', beat: 'Beat', adapt: 'Adapt to Zoom' };
  for (const grid of ['bar', 'beat', 'adapt'] as const) {
    const field = part(render({ snap: { on: true, grid } }), 'grid-type');
    assert.equal(sig(field).replace(/^button/, 'span'), 'span.field');
    assert.equal(field.attrs['data-testid'], 'grid-type');
    assert.equal(field.attrs['aria-haspopup'], 'menu');
    const [grid1, chev] = elements(field);
    const [mGrid, mChev] = elements(mField);
    assertIcon(grid1!, mGrid!, 'grid');
    assertIcon(chev!, mChev!, 'chev');
    assert.equal(elements(field).length, 2);
    assert.equal(text(field), labels[grid]);
  }
  // The mockup's own grid type is Adapt to Zoom.
  assert.equal(text(part(render({ snap: { on: true, grid: 'adapt' } }), 'grid-type')), text(mField));
});

test('auto-scroll: the follow icon alone, the mockup\'s inline padding, .on and pressed when it follows', () => {
  const mField = part(mockupToolbar(), 'auto-scroll');
  for (const autoScroll of [true, false]) {
    const field = part(render({ autoScroll }), 'auto-scroll');
    assert.equal(sig(field).replace(/^button/, 'span').replace(/\.on\b/, ''), 'span.field');
    assert.equal(classes(field).includes('on'), autoScroll);
    assert.equal(field.attrs['aria-pressed'], String(autoScroll));
    assert.equal(field.attrs['data-testid'], 'auto-scroll');
    assert.equal(styleOf(field, 'padding'), styleOf(mField, 'padding'));
    assert.equal(elements(field).length, 1);
    assertIcon(elements(field)[0]!, elements(mField)[0]!, 'follow');
    assert.equal(text(field), '');
    assert.ok(field.attrs['aria-label'], 'named for assistive technology');
  }
});

test('the labels are the mockup\'s in en and zh-TW', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const app = render({ snap: { on: true, grid: 'adapt' } }, locale);
    const mockup = mockupToolbar(lang);
    for (const id of ['snap', 'grid-type']) assert.equal(text(part(app, id)), text(part(mockup, id)), `${locale}: ${id}`);
    assert.equal(text(part(app, 'tool-1')), text(part(mockup, 'tool-1')));
  }
});

test('the ids are the mockup\'s minus the pending parts\'; no media button, no Delete clip button', () => {
  const app = render();
  const ids = (root: Element) => findAll(root, byAttr('data-part')).map((el) => el.attrs['data-part']!).sort();
  // The pill (m5b-ui-ghosts) is there only with a reviewable plan.
  assert.deepEqual(ids(app), ids(mockupToolbar()).filter((id) => !pending(id) && id !== 'proposal-pill'));
  assert.deepEqual(ids(render({ pill: { lead: 'x', steps: '1 step', on: true, onToggle: noop } })), ids(mockupToolbar()).filter((id) => !pending(id)));
  assert.deepEqual(ids(app), ['auto-scroll', 'grid-type', 'snap', 'tool-1', 'tool-3', 'toolbar', 'tools'].sort());
  const testids = findAll(app, byAttr('data-testid')).map((el) => el.attrs['data-testid']!);
  for (const id of ['tool-select', 'tool-split', 'snap-toggle', 'grid-type', 'auto-scroll', 'timeline-error']) assert.ok(testids.includes(id), id);
  assert.ok(!testids.some((id) => id === 'media-pool' || id.startsWith('pool-') || id === 'delete-clip'), testids.join(' '));
  // No refusal: the line is there, empty.
  assert.equal(text(find(app, byAttr('data-testid', 'timeline-error'))), '');
  const refused = render({ error: { code: 'revision_mismatch', message: 'stale' } });
  assert.match(text(find(refused, byAttr('data-testid', 'timeline-error'))), /revision_mismatch|stale|\S/);
  assert.equal(find(refused, byAttr('data-testid', 'timeline-error')).attrs['data-code'], 'revision_mismatch');
});

test('an engine without the tools, snap or the transport keeps their boxes, empty (UI redesign 3.0)', () => {
  const app = render({ gates: { select: false, split: false, snap: false, autoScroll: false } });
  const ids = findAll(app, byAttr('data-part')).map((el) => el.attrs['data-part']);
  assert.deepEqual(ids.sort(), ['toolbar', 'tools']);
  const tools = elements(part(app, 'tools'));
  assert.equal(tools.length, 9, 'every tool keeps its box');
  tools.forEach((box, i) => assertEmptyBox(box, `tool ${i + 1}`));
  const row = ported(app);
  // Every box but the pill's, which is not in the DOM without a reviewable plan (UI redesign 3.0).
  assert.equal(row.length, elements(mockupToolbar()).length - 1, 'no field collapses');
  for (const box of row.slice(1, 4)) assertEmptyBox(box, 'a field');
  for (const id of ['tool-select', 'tool-split', 'snap-toggle', 'grid-type', 'auto-scroll']) assert.ok(!findAll(app, byAttr('data-testid', id)).length, id);
});
