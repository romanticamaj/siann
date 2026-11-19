// The "ask the agent" box at the foot of the Plans tab (m5b-ui-composer; UI
// redesign 4.4, 3.0; mockup.html line 335, ui/right-zone.css's .composer):
//
//   div.composer[composer]  svg.i (spark), span (the text: the app's textarea,
//                           the one added element), span.send > svg.i.s (send)
//
// Ported from the mockup's markup, read from mockup.html (not retyped). With
// an agent connected the textarea's placeholder names it; with none the
// textarea is disabled and the wrapper's title gives the reason (3.0: a
// control that works in this build but not in this state). On an engine
// without features.agentRequests (or agent.request) the part is absent and
// its box empty. Above the box, app-only rows: every open request with its
// state and a cancel control, the most recently closed one with its
// message, and a refusal line for agent_busy, agent_not_connected and
// invalid_request_text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import type { Agent } from '../../src/renderer/model/agents';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { AgentRequest, AgentRequestState } from '../../src/renderer/model/session-client';
import { ComposerView, RequestRows, type ComposerViewProps } from '../../src/renderer/plans/Composer';
import { PlanPanelView, type PlanPanelViewProps } from '../../src/renderer/plans/PlanPanel';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { find, findAll, MOCKUP, mockupRightZone, mockupSnapshot, mockupZh, parse, sig, textOf, type Node } from './support/mockup-plan';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const t = translator('en');

const AGENT: Agent = { id: 'agt_1', name: 'mix-assistant', transport: 'mcp', connected: true, lastAction: null, lastActionAt: null };

function req(id: string, state: AgentRequestState, extra: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id,
    agentId: AGENT.id,
    text: `Text of ${id}`,
    context: { selection: { tracks: [], clips: [] }, locators: null, cursor: '0', headRevision: 'r3' },
    state,
    createdAt: '2026-11-18T10:00:00Z',
    ...extra,
  };
}

const partOf = (n: Node) => n.attrs['data-part'];

function box(props: Partial<ComposerViewProps> = {}): Node {
  const markup = renderToStaticMarkup(
    <ComposerView agent={AGENT} text="" refusal={null} onText={() => undefined} onSend={() => undefined} {...props} />,
  );
  const node = find(parse(markup), (n) => n.classes.includes('composer'));
  assert.ok(node, 'the box is rendered');
  return node;
}

function mockComposer(lang: 'en' | 'zh-TW' = 'en'): Node {
  const node = find(parse(mockupRightZone(lang)), (n) => partOf(n) === 'composer');
  assert.ok(node, 'the mockup has the composer');
  assert.ok(MOCKUP.includes(`dp('composer')`), 'composer is in mockup.html');
  return node;
}

// The structure with the textarea taken out: the mockup's.
const tree = (n: Node): unknown => ({ sig: sig(n), children: n.tag === 'svg' ? [] : n.children.filter((c) => c.tag !== 'textarea').map(tree) });

test("the box is the mockup's markup, the textarea the one added element inside its first span", () => {
  const app = box();
  const mock = mockComposer();
  assert.deepEqual(tree(app), tree(mock));
  assert.equal(app.tag, 'div');
  assert.equal(partOf(app), 'composer');
  assert.deepEqual(app.children.map(sig), ['svg.i', 'span', 'span.send']);
  assert.deepEqual(mock.children.map(sig), ['svg.i', 'span', 'span.send']);
  assert.deepEqual(app.children[0]!.classes, mock.children[0]!.classes, 'the spark icon, full size');
  assert.deepEqual(app.children[2]!.children.map(sig), ['svg.i.s'], 'the send icon, small');
  assert.deepEqual(app.children[2]!.children[0]!.classes, mock.children[2]!.children[0]!.classes);
  const field = app.children[1]!.children;
  assert.equal(field.length, 1);
  assert.equal(field[0]!.tag, 'textarea', 'the textarea is inside the first span');
  assert.equal(textOf(app.children[1]!), '', 'no text beside the field');
  assert.equal(findAll(app, (n) => n.tag === 'textarea').length, 1, 'one added element');
  // The placeholder is the catalog's with the agent's name: the mockup's text.
  assert.equal(field[0]!.attrs.placeholder, t('composer.placeholder', { agent: 'mix-assistant' }));
  assert.equal(field[0]!.attrs.placeholder, textOf(mock.children[1]!));
  assert.ok(!('disabled' in field[0]!.attrs), 'enabled');
  assert.ok(!('title' in app.attrs), 'no reason while enabled');
  // The send control is the span itself, named.
  const send = app.children[2]!;
  assert.equal(send.attrs.role, 'button');
  assert.equal(send.attrs['aria-label'], t('composer.send'));
});

test("in zh-TW the placeholder is the mockup's wording", () => {
  const zh = translator('zh-Hant');
  assert.equal(zh('composer.placeholder', { agent: 'mix-assistant' }), mockupZh()['Ask mix-assistant for a change…']);
  assert.equal(zh('composer.placeholder', { agent: 'mix-assistant' }), textOf(mockComposer('zh-TW').children[1]!));
});

test('with no agent connected the textarea is disabled and the wrapper gives the reason', () => {
  for (const agent of [null, { ...AGENT, connected: false }]) {
    const app = box({ agent });
    const field = find(app, (n) => n.tag === 'textarea')!;
    assert.ok('disabled' in field.attrs, 'disabled');
    assert.equal(app.attrs.title, t('composer.noAgent'), 'the reason on the wrapper');
    assert.equal(app.children[2]!.attrs['aria-disabled'], 'true', 'send disabled');
    assert.equal(partOf(app), 'composer', 'still the part');
  }
  // A disconnected agent keeps its name in the placeholder; none: the generic one.
  assert.equal(find(box({ agent: null }), (n) => n.tag === 'textarea')!.attrs.placeholder, t('composer.placeholderNone'));
});

test('the typed text is the field\'s value, and a refusal keeps it', () => {
  const app = box({ text: 'Lower the drums', refusal: { code: 'agent_busy', message: '16 open requests', changedEntities: [] } });
  assert.equal(textOf(find(app, (n) => n.tag === 'textarea')!), 'Lower the drums');
});

function rows(props: Partial<Parameters<typeof RequestRows>[0]> = {}): Node {
  const markup = renderToStaticMarkup(
    <RequestRows open={[]} closed={null} refusal={null} onCancel={() => undefined} onDismiss={() => undefined} {...props} />,
  );
  return parse(markup);
}

test('one row per open request with its state and a cancel control, then the closed one with its message', () => {
  const root = rows({
    open: [req('arq_1', 'pending'), req('arq_2', 'taken')],
    closed: req('arq_3', 'declined', { message: 'Not on the master bus' }),
  });
  const list = find(root, (n) => n.classes.includes('requests'))!;
  assert.ok(list, 'the list');
  assert.equal(list.attrs.role, 'list');
  assert.equal(list.attrs['aria-label'], t('composer.requests'));
  assert.ok(!('data-part' in list.attrs), 'app-only: no mockup id');
  const items = findAll(list, (n) => n.classes.includes('request'));
  assert.deepEqual(items.map((r) => r.attrs['data-state']), ['pending', 'taken', 'declined']);
  assert.deepEqual(items.map((r) => r.attrs['data-testid']), ['request-arq_1', 'request-arq_2', 'request-arq_3']);
  const state = (r: Node) => textOf(find(r, (n) => n.classes.includes('request-state'))!);
  assert.deepEqual(items.map(state), ['sent', 'taken', 'declined']);
  assert.equal(textOf(find(items[0]!, (n) => n.classes.includes('request-text'))!), 'Text of arq_1');
  assert.equal(find(items[0]!, (n) => n.classes.includes('request-text'))!.attrs.dir, 'auto', 'the text is isolated');
  for (const open of items.slice(0, 2)) {
    const cancel = find(open, (n) => n.attrs['data-testid'] === 'request-cancel')!;
    assert.equal(cancel.tag, 'button');
    assert.equal(cancel.attrs['aria-label'], t('composer.cancel'));
    assert.ok(!find(open, (n) => n.attrs['data-testid'] === 'request-dismiss'), 'an open request is not dismissed');
  }
  const closed = items[2]!;
  assert.ok(!find(closed, (n) => n.attrs['data-testid'] === 'request-cancel'), 'a closed request cannot be cancelled');
  assert.equal(find(closed, (n) => n.attrs['data-testid'] === 'request-dismiss')!.attrs['aria-label'], t('composer.dismiss'));
  assert.equal(textOf(find(closed, (n) => n.classes.includes('request-message'))!), 'Not on the master bus');
});

test('an answered request shows its message; a decline without one and an answer with a plan show none', () => {
  const answered = rows({ closed: req('arq_1', 'answered', { message: 'Lowered the drums by 3 dB' }) });
  assert.equal(textOf(find(answered, (n) => n.classes.includes('request-message'))!), 'Lowered the drums by 3 dB');
  assert.equal(textOf(find(answered, (n) => n.classes.includes('request-state'))!), 'answered');
  for (const closed of [req('arq_2', 'declined'), req('arq_3', 'answered', { plan: 'sha256:' + 'a'.repeat(64) }), req('arq_4', 'cancelled'), req('arq_5', 'expired')]) {
    const root = rows({ closed });
    assert.ok(!find(root, (n) => n.classes.includes('request-message')), closed.state);
    assert.equal(textOf(find(root, (n) => n.classes.includes('request-state'))!), t(`composer.state.${closed.state}` as 'composer.state.answered'));
  }
});

test('nothing to show renders nothing; a refusal line for agent_busy, agent_not_connected and invalid_request_text', () => {
  assert.deepEqual(rows().children, [], 'no request, no refusal: no element');
  for (const code of ['agent_busy', 'agent_not_connected', 'invalid_request_text']) {
    const root = rows({ refusal: { code, message: 'engine text', changedEntities: [] } });
    const line = find(root, (n) => n.attrs['data-testid'] === 'composer-refusal')!;
    assert.ok(line, code);
    assert.equal(line.attrs.role, 'status');
    assert.equal(line.attrs['data-code'], code);
    assert.equal(textOf(line), `${code}: ${t(`error.${code}` as 'error.agent_busy')}`);
    assert.ok(!find(root, (n) => n.classes.includes('requests')), 'no list without requests');
  }
});

// ---- the part in the tab, by the capabilities (UI redesign 3.0)

function tab(caps: Capabilities, overrides: Partial<PlanPanelViewProps> = {}): Node {
  const snapshot = mockupSnapshot();
  const props: PlanPanelViewProps = {
    plans: [],
    heard: 'main',
    firstSeen: new Map(),
    nowMs: 0,
    names: namesFromSnapshot(snapshot),
    selected: null,
    ticked: null,
    note: '',
    busy: false,
    error: null,
    preview: null,
    previewError: null,
    staleReasons: [],
    rejecting: false,
    hotStep: null,
    agent: AGENT,
    onSelect: () => undefined,
    onTicked: () => undefined,
    onNote: () => undefined,
    onRun: () => undefined,
    onRejecting: () => undefined,
    onHotStep: () => undefined,
    ...overrides,
  };
  return parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={caps}>
        <PlanPanelView {...props} />
      </CapabilitiesContext.Provider>,
    ),
  );
}

const without = (caps: Capabilities, drop: { methods?: string[]; features?: string[] }): Capabilities => ({
  ...caps,
  methods: (caps.methods ?? []).filter((m) => !(drop.methods ?? []).includes(m)),
  features: Object.fromEntries(Object.entries(caps.features ?? {}).filter(([name]) => !(drop.features ?? []).includes(name))),
});

const AGENT_METHODS = ['agent.request', 'agent.cancel_request', 'agent.requests', 'agent.next_request', 'agent.answer_request'];

test('with features.agentRequests and agent.request the box is the last element of the tab, after the request rows', () => {
  const root = tab(FULL, { requests: { open: [req('arq_1', 'pending')], closed: null }, composerText: '' });
  const kids = root.children;
  assert.equal(partOf(kids[kids.length - 1]!), 'composer');
  assert.ok(kids[kids.length - 2]!.classes.includes('requests'), 'the rows above the box');
  assert.ok(kids[kids.length - 3]!.classes.includes('p-scroll'));
  assert.equal(findAll(root, (n) => n.classes.includes('composer-empty')).length, 0);
});

test('without the feature or the method there is no part and no textarea, only an empty box', () => {
  for (const caps of [without(FULL, { features: ['agentRequests'] }), without(FULL, { methods: AGENT_METHODS }), without(FULL, { methods: ['agent.request'] })]) {
    const root = tab(caps, { requests: { open: [req('arq_1', 'pending')], closed: null } });
    assert.ok(!find(root, (n) => partOf(n) === 'composer'), 'no [data-part=composer]');
    assert.equal(findAll(root, (n) => n.tag === 'textarea').length, 0, 'no textarea');
    assert.ok(!find(root, (n) => n.classes.includes('requests')), 'no request rows');
    const kids = root.children;
    const empty = kids[kids.length - 1]!;
    assert.deepEqual(empty.classes, ['composer-empty']);
    assert.equal(empty.attrs['aria-hidden'], 'true');
    for (const attr of ['role', 'tabindex', 'data-part', 'data-part-item', 'title']) assert.ok(!(attr in empty.attrs), `no ${attr}`);
    assert.equal(empty.children.length, 0);
    assert.equal(textOf(empty), '');
  }
});
