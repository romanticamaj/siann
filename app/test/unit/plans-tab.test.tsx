// The Plans tab ported from the mockup (m5-ui-port-plans; mockup.html, the
// right zone's block of the app.innerHTML template and step(); UI redesign
// 10.9 and 10.10, P1-13; docs/harness/agent-rules.md, "UI fidelity"): the
// rendered right zone has the mockup's DOM structure, class names and
// data-part ids, so ui/right-zone.css draws it.
//
//   aside.plans
//     .p-head[right-tabs]   .tab.on[tab-plans] (spark), the Media and Meter
//                           tabs' holds, .ab[hearing-switch] > svg + .seg > 2 .b
//     the agent row's hold
//     .p-scroll             .card[plan-card] > .card-h[plan-head] (.top[plan-meta]:
//                           the badge, time and base, the hash; the title and
//                           intent holds; .sum[plan-summary]), .steps[plan-steps]
//                           (.steps-h + one .step per step, as step() returns
//                           it), .acts[plan-actions] (three .btn); .hist-h and
//                           one .hrow per earlier plan
//     the composer's hold
//
// The mockup's plan is the fidelity session's: six steps, three earlier plans,
// the pointer on step 3. The app's .zone-body wrapper is the zone frame's and
// is looked through. An absent part (UI redesign 3.0) is an element with no
// role, no tabindex, no data-part and no text, hidden from assistive
// technology. Read from mockup.html, not retyped: the expected tree is the
// mockup's own template evaluated with structural stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import { planEntry, PlanStore } from '../../src/renderer/model/plan-store';
import type { ReadModel } from '../../src/renderer/model/read-model';
import { SessionClient } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { UndoHistory } from '../../src/renderer/model/undo-history';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { HearingSwitch } from '../../src/renderer/plans/HearingSwitch';
import { PlanPanelView, type PlanPanelViewProps } from '../../src/renderer/plans/PlanPanel';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { Shell } from '../../src/renderer/shell/Shell';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { find, findAll, mockupPlans, mockupPreview, mockupRightZone, mockupSnapshot, parse, PENDING, sig, textOf, type Node } from './support/mockup-plan';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;

// The parts of the right zone whose feature has not landed (manifest.json).
const PENDING_PARTS = ['agent-row', 'plan-title', 'plan-intent', 'composer', 'tab-media', 'tab-meter'];

function render(overrides: Partial<PlanPanelViewProps> = {}): string {
  const snapshot = mockupSnapshot();
  const model = { getSnapshot: () => snapshot, subscribe: () => () => undefined, select: (ref: string) => snapshot.entities[ref] } as unknown as ReadModel;
  const client = new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
    model,
  });
  const plans = new PlanStore();
  plans.setHeard('main');
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const loopClick = new LoopClickController({
    client,
    model,
    state: new TransportStateStore(client),
    deviceReady: () => false,
    capabilities: () => capabilitySelector(FULL),
    toasts,
    locale: () => 'en',
  });
  const props: PlanPanelViewProps = {
    plans: mockupPlans(),
    heard: 'main',
    firstSeen: new Map([[PENDING, 0]]),
    nowMs: 2 * 60_000,
    names: namesFromSnapshot(snapshot),
    selected: null,
    ticked: null,
    note: '',
    busy: false,
    error: null,
    preview: mockupPreview(),
    previewError: null,
    staleReasons: [],
    rejecting: false,
    hotStep: 2,
    onSelect: () => undefined,
    onTicked: () => undefined,
    onNote: () => undefined,
    onRun: () => undefined,
    onRejecting: () => undefined,
    onHotStep: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <Shell
        client={client}
        plans={plans}
        engineStatus={{ getSnapshot: () => null, subscribe: () => () => undefined }}
        store={createLayoutStore({ storage: null })}
        commands={new CommandRegistry()}
        platform="other"
        phase="online"
        toasts={toasts}
        realtime={null}
        transport={new TransportController({ client, playing: () => false, toasts, locale: () => 'en' })}
        loopClick={loopClick}
        history={new UndoHistory(client)}
        left={<p>left</p>}
        project={<p>project</p>}
        lower={<p>lower</p>}
        right={<PlanPanelView {...props} />}
        rightHead={<HearingSwitch client={client} plans={plans} />}
      />
    </CapabilitiesContext.Provider>,
  );
}

function appRightZone(markup: string): Node {
  const zone = find(parse(markup), (n) => n.attrs['data-region'] === 'right-zone');
  assert.ok(zone, 'the app has the right zone');
  return zone;
}

function mockRightZone(lang: 'en' | 'zh-TW' = 'en'): Node {
  const zone = find(parse(mockupRightZone(lang)), (n) => n.attrs['data-region'] === 'right-zone');
  assert.ok(zone, 'the mockup has the right zone');
  return zone;
}

const partOf = (n: Node) => n.attrs['data-part'];

// The mockup's children as the app must render them: inline text elements of
// a step's text (b, s, em) are the wording's (plan-step-rows.test.ts), a
// clip-naming title's wrapper (plan-step-N-title) is a pending part the app
// does not carry and the step's .go holds the target icon (m5b-ui-ghosts).
// The primary's kbd is drawn since m5b-ui-audition binds Ctrl+Return (UI
// redesign 3.6).
function mockChildren(node: Node): Node[] {
  let out = node.children;
  if (node.classes.includes('t') || node.classes.includes('d')) {
    out = out.flatMap((c) => (/^plan-step-\d+-title$/.test(partOf(c) ?? '') ? c.children : [c])).filter((c) => !['b', 's', 'em'].includes(c.tag));
  }
  return out;
}

function appChildren(node: Node): Node[] {
  let out = node.children.flatMap((c) => (c.classes.includes('zone-body') ? c.children : [c]));
  if (node.classes.includes('t') || node.classes.includes('d')) out = out.filter((c) => !['b', 's', 'em'].includes(c.tag));
  return out;
}

// The mockup's numbered ids are the app's repeated items (UI redesign 10.3).
function expectedPart(mock: Node): Record<string, string> {
  const part = partOf(mock);
  if (part === undefined) return {};
  const item = /^(plan-step|plan-history)-\d+$/.exec(part);
  return item ? { 'data-part-item': item[1]! } : { 'data-part': part };
}

function assertHold(app: Node, part: string, where: string) {
  assert.equal(app.tag, 'span', `${where}: the hold of ${part} is a span`);
  assert.deepEqual(app.classes, [`hold-${part}`], `${where}: the hold of ${part}`);
  assert.equal(app.attrs['aria-hidden'], 'true', `${where}: hidden from assistive technology`);
  for (const attr of ['role', 'tabindex', 'data-part', 'data-part-item']) assert.ok(!(attr in app.attrs), `${where}: the hold of ${part} has no ${attr}`);
  assert.equal(app.children.length, 0, `${where}: the hold of ${part} is empty`);
  assert.equal(app.text, '', `${where}: the hold of ${part} has no text`);
}

function compare(mock: Node, app: Node, where: string) {
  const part = partOf(mock);
  if (part !== undefined && PENDING_PARTS.includes(part)) return assertHold(app, part, where);
  // A control the mockup draws as a span or a div is a button in the app.
  const tagOk = app.tag === mock.tag || (app.tag === 'button' && (mock.tag === 'span' || mock.tag === 'div'));
  assert.ok(tagOk, `${where}: <${app.tag}> for the mockup's <${mock.tag}>`);
  if (mock.tag !== 'aside') assert.deepEqual(app.classes, mock.classes, `${where}: the classes of ${sig(mock)}`);
  for (const [attr, value] of Object.entries(expectedPart(mock))) assert.equal(app.attrs[attr], value, `${where}: ${attr} of ${sig(mock)}`);
  if (mock.tag === 'svg') return;
  const want = mockChildren(mock);
  const got = appChildren(app);
  assert.deepEqual(
    got.map((c) => c.tag + c.classes.map((k) => `.${k}`).join('')).length,
    want.length,
    `${where} > ${sig(mock)}: children ${JSON.stringify(got.map(sig))} for the mockup's ${JSON.stringify(want.map(sig))}`,
  );
  want.forEach((child, index) => compare(child, got[index]!, `${where} > ${sig(mock)}`));
}

test("the right zone has the mockup's structure, classes and ids for the mockup's plan", () => {
  compare(mockRightZone(), appRightZone(render()), 'right zone');
});

test('the mockup tree read from mockup.html is the one the port follows', () => {
  // A guard on the reader: the block has the parts this feature ports.
  const mock = mockRightZone();
  const head = find(mock, (n) => partOf(n) === 'right-tabs')!;
  assert.deepEqual(head.children.map(sig), ['span.tab.on[tab-plans]', 'span.tab[tab-media]', 'span.tab[tab-meter]', 'div.ab[hearing-switch]']);
  const steps = findAll(mock, (n) => /^plan-step-\d+$/.test(partOf(n) ?? ''));
  assert.equal(steps.length, 6);
  assert.deepEqual(findAll(steps[2]!, () => true).filter((n) => n.classes.includes('hot')).length, 1, 'the mockup draws step 3 hot');
  assert.equal(findAll(mock, (n) => n.classes.includes('hrow')).length, 3);
});

test('every id of the Plans tab is in the markup, and no id of a pending part', () => {
  const markup = render();
  const zone = appRightZone(markup);
  const parts = findAll(zone, (n) => 'data-part' in n.attrs).map(partOf);
  for (const id of [
    'right-tabs',
    'tab-plans',
    'hearing-switch',
    'plan-card',
    'plan-head',
    'plan-meta',
    'plan-badge',
    'plan-summary',
    'plan-steps',
    'plan-steps-head',
    'plan-actions',
    'plan-audition',
    'plan-approve',
    'plan-reject',
    'plan-history-head',
  ]) {
    assert.equal(parts.filter((p) => p === id).length, 1, `${id} once`);
  }
  const items = (name: string) => findAll(zone, (n) => n.attrs['data-part-item'] === name);
  assert.equal(items('plan-step').length, 6);
  assert.equal(items('plan-history').length, 3);
  for (const id of PENDING_PARTS) assert.ok(!markup.includes(`"${id}"`), `no ${id} id`);
  assert.ok(!/plan-step-\d+-title/.test(markup), 'no plan-step-N-title id');
});

// m5b-ui-audition (UI redesign 3.6, 4.5 C4): Ctrl+Return runs the primary,
// so the primary button ends with the mockup's kbd, for Approve N of M,
// Apply and Merge; no other button carries one.
test('the primary button ends with the mockup\'s kbd for Approve N of M, Apply and Merge, and no other button has one', () => {
  const mockKbd = findAll(mockRightZone(), (n) => n.tag === 'kbd');
  assert.equal(mockKbd.length, 1);
  const withState = (state: string, extra: Record<string, unknown> = {}) =>
    mockupPlans().map((p) => (p.hash === PENDING ? planEntry({ ...p.raw, state, ...extra })! : p));
  const cases: Array<[string, Partial<PlanPanelViewProps>]> = [
    ['approveApply', {}],
    ['apply', { plans: withState('approved') }],
    ['merge', { plans: withState('approved', { proposalBranch: 'p4' }), heard: 'p4' }],
  ];
  for (const [what, overrides] of cases) {
    const zone = appRightZone(render(overrides));
    const primary = find(zone, (n) => n.tag === 'button' && n.classes.includes('primary'))!;
    assert.ok(primary, what);
    const last = primary.children.at(-1)!;
    assert.equal(last.tag, 'kbd', what);
    assert.equal(textOf(last), textOf(mockKbd[0]!), what);
    assert.deepEqual(last.classes, mockKbd[0]!.classes, what);
    const kbds = findAll(zone, (n) => n.tag === 'kbd');
    assert.equal(kbds.length, 1, `${what}: only the primary's`);
  }
});

test('the holds carry nothing, the .go cells are target buttons, the steps head one link', () => {
  const zone = appRightZone(render());
  const holds = findAll(zone, (n) => n.classes.some((c) => c.startsWith('hold-')));
  assert.deepEqual(holds.map((h) => h.classes[0]).sort(), PENDING_PARTS.map((p) => `hold-${p}`).sort());
  for (const hold of holds) assertHold(hold, hold.classes[0]!.slice('hold-'.length), 'hold');
  // m5b-ui-ghosts: .go is the keyboard path to a step's ghosts, a button with the mockup's target icon and a name.
  const go = findAll(zone, (n) => n.classes.includes('go'));
  assert.equal(go.length, 6);
  go.forEach((cell, index) => {
    assert.equal(cell.tag, 'button');
    assert.equal(cell.attrs.type, 'button');
    assert.ok(cell.attrs['aria-label']?.includes(String(index + 1)), 'named with its step');
    const icon = cell.children[0]!;
    assert.equal(icon.tag, 'svg');
    assert.deepEqual(icon.classes, ['i', 's']);
  });
  const head = find(zone, (n) => partOf(n) === 'plan-steps-head')!;
  assert.equal(head.children.filter((n) => n.tag === 'a').length, 1, 'one link');
  // The row under the pointer is hot, and only that one.
  const steps = findAll(zone, (n) => n.attrs['data-part-item'] === 'plan-step');
  assert.deepEqual(steps.map((s) => s.classes.includes('hot')), [false, false, true, false, false, false]);
  assert.ok(steps.every((s) => !('aria-current' in s.attrs)), 'no row pinned');
});

test("a pinned step's row is .hot with aria-current, also with the pointer elsewhere", () => {
  const zone = appRightZone(render({ hotStep: null, pinnedStep: 4 }));
  const steps = findAll(zone, (n) => n.attrs['data-part-item'] === 'plan-step');
  assert.deepEqual(steps.map((s) => s.classes.includes('hot')), [false, false, false, false, true, false]);
  assert.deepEqual(steps.map((s) => s.attrs['aria-current'] ?? null), [null, null, null, null, 'step', null]);
  const both = findAll(appRightZone(render({ hotStep: 1, pinnedStep: 4 })), (n) => n.attrs['data-part-item'] === 'plan-step');
  assert.deepEqual(both.map((s) => s.classes.includes('hot')), [false, true, false, false, true, false]);
});

test('the old Plans markup is gone', () => {
  const markup = render();
  for (const cls of ['plan-card', 'plan-detail', 'plan-steps-block', 'hearing-label', 'plan-list', 'plan-diff', 'zone-tabs" role="tablist" data-part="right-tabs']) {
    assert.ok(!markup.includes(`class="${cls}"`) && !markup.includes(`class="${cls} `), `no .${cls}`);
  }
  assert.ok(!markup.includes('data-part="right-tabs" class="zone-tabs'), 'the right zone has no .zone-tabs');
  const zone = appRightZone(markup);
  assert.equal(findAll(zone, (n) => n.classes.includes('zone-tabs')).length, 0, 'no .zone-tabs in the right zone');
  assert.equal(findAll(zone, (n) => n.tag === 'table').length, 0, 'no diff table');
  // The lower zone's tab row is its own (.tabs, m5-ui-port-mixer-strip).
  assert.ok(markup.includes('data-part="lower-tabs"'));
});

test('the tab row is the Plans tab with its spark icon, and the hearing switch is its .ab', () => {
  const zone = appRightZone(render());
  const tab = find(zone, (n) => partOf(n) === 'tab-plans')!;
  assert.equal(tab.attrs['data-testid'], 'tab-right-plans');
  // The tab semantics stay on the ported row (10.9 item 1), as in the lower zone.
  assert.equal(tab.attrs.role, 'tab');
  assert.equal(tab.attrs['aria-selected'], 'true');
  assert.equal(find(zone, (n) => partOf(n) === 'right-tabs')!.attrs.role, 'tablist');
  assert.equal(tab.children[0]!.tag, 'svg');
  assert.match(textOf(tab), /Plans/);
  const ab = find(zone, (n) => partOf(n) === 'hearing-switch')!;
  assert.equal(ab.attrs['data-testid'], 'plan-heard');
  assert.equal(ab.attrs['aria-label'], 'Hearing');
  const seg = ab.children.find((c) => c.classes.includes('seg'))!;
  assert.deepEqual(seg.children.map((b) => [b.attrs['data-testid'], b.classes.includes('on'), textOf(b)]), [
    ['hear-main', true, 'Main'],
    ['hear-proposal', false, 'Proposal'],
  ]);
  assert.ok(!textOf(ab).includes('Hearing'), 'the label is the aria-label only');
});

test('the card shows the mockup text M5 derives', () => {
  const zone = appRightZone(render());
  const sum = find(zone, (n) => partOf(n) === 'plan-summary')!;
  assert.deepEqual(sum.children.map(textOf), ['+1 track', '+1 clip', '1 move', '3 mix']);
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-badge')!), 'Needs review');
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-steps-head')!), 'Steps · 6 of 6 selectedSelect none');
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-approve')!), 'Approve 6 of 6');
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-history-head')!), 'Earlier3 plans');
  const meta = find(zone, (n) => partOf(n) === 'plan-meta')!;
  assert.equal(textOf(meta.children[1]!), '2 minutes ago · base r39');
  assert.equal(textOf(meta.children[2]!), '88888888');
  const badges = findAll(zone, (n) => n.classes.includes('hrow')).map((row) => row.children[1]!);
  assert.deepEqual(badges.map((b) => [b.classes.join('.'), textOf(b)]), [
    ['badge.applied', 'Applied · r31'],
    ['badge.rejected', 'Rejected'],
    ['badge.stale', 'Stale'],
  ]);
  // The reject button is icon-only, named by the catalog.
  const reject = find(zone, (n) => partOf(n) === 'plan-reject')!;
  assert.equal(reject.attrs['aria-label'], 'Reject');
  assert.equal(textOf(reject), '');
});
