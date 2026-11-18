// The Plans tab ported from the mockup (m5-ui-port-plans; mockup.html, the
// right zone's block of the app.innerHTML template and step(); UI redesign
// 10.9 and 10.10, P1-13; docs/harness/agent-rules.md, "UI fidelity"): the
// rendered right zone has the mockup's DOM structure, class names and
// data-part ids, so ui/right-zone.css draws it.
//
//   aside.plans
//     .p-head[right-tabs]   .tab.on[tab-plans] (spark), .tab[tab-media] (folder;
//                           m5b-ui-media), .tab[tab-meter] (bars; m5b-ui-meter),
//                           .ab[hearing-switch] > svg + .seg > 2 .b
//     .agent[agent-row]     .av (spark) + span(b name, " · MCP") + .live(i + text)
//     .p-scroll             .card[plan-card] > .card-h[plan-head] (.top[plan-meta]:
//                           the badge, time and base, the hash; h3[plan-title]
//                           and p[plan-intent]; .sum[plan-summary]), .steps[plan-steps]
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
import { PlanStore } from '../../src/renderer/model/plan-store';
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
import type { Agent } from '../../src/renderer/model/agents';
import { planEntry, type PlanEntry } from '../../src/renderer/model/plan-store';
import { find, findAll, INTENT, MOCKUP, mockupPlans, mockupPreview, mockupRightZone, mockupSnapshot, parse, PENDING, sig, textOf, TITLE, type Node } from './support/mockup-plan';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const REDUCED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-reduced.json'), 'utf8')) as Capabilities;

// The parts of the right zone whose feature has not landed (manifest.json).
// The Media and Meter tabs landed with m5b-ui-media and m5b-ui-meter: the full
// capabilities list media.import and features.loudness.
const PENDING_PARTS = ['composer'];

// The mockup's agent: connected, no tool call yet (lastAction null).
const MOCKUP_AGENT: Agent = { id: 'agt_1', name: 'mix-assistant', transport: 'mcp', connected: true, lastAction: null, lastActionAt: null };

function render(overrides: Partial<PlanPanelViewProps> = {}, caps: Capabilities = FULL): string {
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
    capabilities: () => capabilitySelector(caps),
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
    agent: MOCKUP_AGENT,
    onSelect: () => undefined,
    onTicked: () => undefined,
    onNote: () => undefined,
    onRun: () => undefined,
    onRejecting: () => undefined,
    onHotStep: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={caps}>
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
// clip-naming title's wrapper (plan-step-N-title, m5b-ui-media) is carried as
// the mockup has it and the step's .go holds the target icon (m5b-ui-ghosts).
// The primary's kbd is drawn since m5b-ui-audition binds Ctrl+Return (UI
// redesign 3.6).
function mockChildren(node: Node): Node[] {
  let out = node.children;
  if (node.classes.includes('t') || node.classes.includes('d')) {
    out = out.filter((c) => !['b', 's', 'em'].includes(c.tag));
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
    'agent-row',
    'plan-title',
    'plan-intent',
  ]) {
    assert.equal(parts.filter((p) => p === id).length, 1, `${id} once`);
  }
  const items = (name: string) => findAll(zone, (n) => n.attrs['data-part-item'] === name);
  assert.equal(items('plan-step').length, 6);
  assert.equal(items('plan-history').length, 3);
  for (const id of PENDING_PARTS) assert.ok(!markup.includes(`"${id}"`), `no ${id} id`);
  // m5b-ui-media: the tab, and the titles of the two steps that name a clip.
  assert.equal(parts.filter((p) => p === 'tab-media').length, 1, 'tab-media once');
  assert.deepEqual([...markup.matchAll(/data-part="(plan-step-\d+-title)"/g)].map((m) => m[1]), ['plan-step-2-title', 'plan-step-6-title']);
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
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-approve')!), 'Approve 6 of 6 ⏎');
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

// ---- m5b-ui-plan-metadata: the agent row, the plan's title and intent (UI redesign 4.4, 4.3, 3.0)

// The mockup's markup of a part, evaluated from mockup.html (lines 306, 311, 312).
function mockPart(id: string): Node {
  const node = find(mockRightZone(), (n) => partOf(n) === id);
  assert.ok(node, `the mockup has ${id}`);
  assert.ok(MOCKUP.includes(`dp('${id}')`), `${id} is in mockup.html`);
  return node;
}

const tree = (n: Node): unknown => ({ sig: sig(n), children: n.tag === 'svg' ? [] : n.children.map(tree) });

test("the agent row, the title and the intent are the mockup's markup with real data", () => {
  const zone = appRightZone(render());
  for (const id of ['agent-row', 'plan-title', 'plan-intent']) {
    const app = find(zone, (n) => partOf(n) === id);
    assert.ok(app, `${id} is rendered`);
    assert.deepEqual(tree(app), tree(mockPart(id)), id);
  }
  const row = find(zone, (n) => partOf(n) === 'agent-row')!;
  assert.equal(row.tag, 'div');
  assert.deepEqual(row.children.map(sig), ['span.av', 'span', 'span.live']);
  assert.equal(row.children[0]!.children[0]!.tag, 'svg', 'the spark icon');
  assert.deepEqual(row.children[0]!.children[0]!.classes, mockPart('agent-row').children[0]!.children[0]!.classes, 'the small icon');
  assert.equal(textOf(row.children[1]!), 'mix-assistant · MCP');
  assert.equal(textOf(row.children[1]!.children[0]!), 'mix-assistant');
  assert.equal(textOf(row.children[2]!), 'connected · idle');
  assert.equal(row.children[2]!.children[0]!.tag, 'i');
  // In .card-h: after .top, before .sum.
  const head = find(zone, (n) => partOf(n) === 'plan-head')!;
  const order = head.children.map((n) => partOf(n));
  assert.ok(order.indexOf('plan-meta') < order.indexOf('plan-title'));
  assert.equal(order.indexOf('plan-intent'), order.indexOf('plan-title') + 1);
  assert.equal(order.indexOf('plan-summary'), order.indexOf('plan-intent') + 1);
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-title')!), TITLE);
  assert.equal(textOf(find(zone, (n) => partOf(n) === 'plan-intent')!), INTENT);
  // The history rows read the mockup's titles.
  assert.deepEqual(
    findAll(zone, (n) => n.classes.includes('hrow')).map((r) => textOf(r.children[0]!)),
    ['Tame the low end', 'Double the lead vocal', 'Trim silence on drums'],
  );
});

function assertEmptyBox(app: Node | undefined, cls: string) {
  assert.ok(app, `.${cls} is there`);
  assert.deepEqual(app.classes, [cls], cls);
  assert.equal(app.attrs['aria-hidden'], 'true', `${cls}: hidden from assistive technology`);
  for (const attr of ['role', 'tabindex', 'data-part', 'data-part-item']) assert.ok(!(attr in app.attrs), `${cls} has no ${attr}`);
  assert.equal(app.children.length, 0, `${cls} is empty`);
  assert.equal(textOf(app), '', `${cls} has no text`);
}

test('against capabilities without planMetadata and agents the three parts are absent and their boxes stay empty', () => {
  const markup = render({}, REDUCED);
  const zone = appRightZone(markup);
  for (const id of ['agent-row', 'plan-title', 'plan-intent']) assert.ok(!markup.includes(`"${id}"`), `no ${id} id`);
  assertEmptyBox(find(zone, (n) => n.classes.includes('agent-row-empty')), 'agent-row-empty');
  assertEmptyBox(find(zone, (n) => n.classes.includes('plan-title-empty')), 'plan-title-empty');
  assertEmptyBox(find(zone, (n) => n.classes.includes('plan-intent-empty')), 'plan-intent-empty');
  // In the places of the parts: the row's box after the tab row, the boxes after .top.
  const kids = appChildren(zone);
  assert.ok(kids[1]!.classes.includes('agent-row-empty'), "the agent row's box follows the tab row");
  const head = find(zone, (n) => partOf(n) === 'plan-head')!;
  const at = head.children.findIndex((n) => n.classes.includes('plan-title-empty'));
  assert.ok(at > 0);
  assert.ok(head.children[at + 1]!.classes.includes('plan-intent-empty'));
  assert.equal(partOf(head.children[at + 2]!), 'plan-summary');
  assert.ok(!markup.includes(TITLE) && !markup.includes('mix-assistant'), 'nothing of the metadata is shown');
  // The history rows name the plans as in M5.
  const titles = findAll(zone, (n) => n.classes.includes('hrow')).map((r) => textOf(r.children[0]!));
  assert.ok(!titles.includes('Tame the low end'), JSON.stringify(titles));
});

function untitled(): PlanEntry[] {
  const plans = mockupPlans();
  const raw: Record<string, unknown> = { ...plans[3]!.raw };
  delete raw.title;
  delete raw.intent;
  plans[3] = planEntry(raw)!;
  return plans;
}

test('a plan without a title shows its first step in the h3, and its intent box stays empty', () => {
  const zone = appRightZone(render({ plans: untitled() }));
  const title = find(zone, (n) => partOf(n) === 'plan-title')!;
  assert.equal(title.tag, 'h3');
  assert.match(textOf(title), /Add track/);
  assert.ok(!find(zone, (n) => partOf(n) === 'plan-intent'), 'no intent');
  assert.equal(findAll(zone, (n) => n.tag === 'p' && n.attrs['data-part'] === 'plan-intent').length, 0);
  assertEmptyBox(find(zone, (n) => n.classes.includes('plan-intent-empty')), 'plan-intent-empty');
});

test('with features.agents and no agent the row reads "No agent connected"', () => {
  const zone = appRightZone(render({ agent: null }));
  const row = find(zone, (n) => partOf(n) === 'agent-row')!;
  assert.ok(row, 'the row is there');
  assert.ok(row.classes.includes('agent'));
  assert.match(textOf(row), /No agent connected/);
  assert.ok(!find(row, (n) => n.tag === 'b'), 'no name');
  // A disconnected agent: the row says so, with the app's modifier on .live.
  const gone = appRightZone(render({ agent: { ...MOCKUP_AGENT, connected: false } }));
  const live = find(find(gone, (n) => partOf(n) === 'agent-row')!, (n) => n.classes.includes('live'))!;
  assert.deepEqual(live.classes, ['live', 'off']);
  assert.equal(textOf(live), 'disconnected · idle');
});

// ---- m5b-ui-media: the Media tab and the clip-naming step titles

test("the Media tab is the mockup's span.tab with the folder icon and its label, after the Plans tab", () => {
  const zone = appRightZone(render());
  const head = find(zone, (n) => partOf(n) === 'right-tabs')!;
  assert.deepEqual(head.children.slice(0, 2).map((n) => partOf(n)), ['tab-plans', 'tab-media']);
  const tab = head.children[1]!;
  assert.equal(tab.tag, 'button');
  assert.deepEqual(tab.classes, ['tab'], 'not .on while Plans shows');
  assert.equal(tab.attrs.role, 'tab');
  assert.equal(tab.attrs['aria-selected'], 'false');
  assert.equal(tab.attrs['data-testid'], 'tab-right-media');
  const mock = find(mockRightZone(), (n) => partOf(n) === 'tab-media')!;
  assert.equal(tab.children[0]!.tag, 'svg');
  assert.deepEqual(tab.children[0]!.classes, mock.children[0]!.classes, "the mockup's ic('folder','s')");
  assert.equal(textOf(tab), textOf(mock));
  assert.equal(textOf(tab), 'Media');
  assert.equal(textOf(find(mockRightZone('zh-TW'), (n) => partOf(n) === 'tab-media')!), '媒體');
  // The Meter tab (m5b-ui-meter) follows it.
  assert.equal(partOf(head.children[2]!), 'tab-meter');
});

test('a step that names a clip wraps its title in plan-step-N-title, as step() does', () => {
  const zone = appRightZone(render());
  const steps = findAll(zone, (n) => n.attrs['data-part-item'] === 'plan-step');
  steps.forEach((step, index) => {
    const t = step.children.find((c) => c.classes.includes('t'))!;
    const title = t.children.find((c) => /^plan-step-\d+-title$/.test(partOf(c) ?? ''));
    if (index === 1 || index === 5) {
      assert.ok(title, `step ${index + 1} names a clip`);
      assert.equal(title.tag, 'span');
      assert.equal(partOf(title), `plan-step-${index + 1}-title`);
      assert.deepEqual(title.classes, []);
      // Between the dot and the detail line, as the mockup has it.
      assert.deepEqual(t.children.map((c) => c.classes[0] ?? partOf(c)), ['tdot', `plan-step-${index + 1}-title`, 'd']);
    } else assert.equal(title, undefined, `step ${index + 1} names no clip`);
  });
  const two = find(zone, (n) => partOf(n) === 'plan-step-2-title')!;
  assert.equal(textOf(two).replace(/[\u2068\u2069]/g, ''), 'Place pad_swell.wav on Pad');
  const six = find(zone, (n) => partOf(n) === 'plan-step-6-title')!;
  assert.equal(textOf(six).replace(/[\u2068\u2069]/g, ''), 'Move Riser on FX');
  assert.equal(six.children[0]!.tag, 'b');
});

test('against capabilities without media.import the Media tab is absent and its box stays empty', () => {
  const markup = render({}, REDUCED);
  const zone = appRightZone(markup);
  assert.ok(!markup.includes('"tab-media"'), 'no tab-media id');
  assert.ok(!markup.includes('tab-right-media'), 'no Media tab');
  const head = find(zone, (n) => partOf(n) === 'right-tabs')!;
  assert.equal(partOf(head.children[0]!), 'tab-plans');
  assertEmptyBox(head.children[1], 'tab-media-empty');
  assert.deepEqual(head.children[2]!.classes, ['tab-meter-empty'], "the Meter tab's box follows (these capabilities have no features.loudness)");
});
