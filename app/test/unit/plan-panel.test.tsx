// The Plans tab (m5-ui-plan-panel; UI redesign section 4 and P1-5; ported
// from the mockup by m5-ui-port-plans, 10.10 P1-13), rendered to static
// markup: one card for the selected plan (by default the newest plan that
// awaits a decision, a non-stale one first) and a history row for every
// other plan, newest first. Steps are numbered from 1 and all ticked by
// default, with one link (Select none, or Select all while some step is
// unticked) for a reviewable plan; with every disclosure closed no entity id,
// milli-dB field, raw pan value or branch id is anywhere in the markup, and a
// step's disclosure (its raw step and the preview entities it touches) exists
// only while it is open; only the action set's buttons exist, in the three
// cells of .acts, one of them primary, a stale plan's primary disabled with
// its reason, and each button only when engine.capabilities lists what it
// sends; the reason field opens with the first press of Reject; a rejection
// shows its reason and a split parent its split label in its history row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatDb } from '../../src/renderer/format';
import { LOCALES } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { PlanEntry } from '../../src/renderer/model/plan-store';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import type { PlanPreview } from '../../src/renderer/plans/diff';
import { isolateName as n } from '../../src/renderer/plans/isolate';
import { PlanPanelView, type PlanPanelViewProps } from '../../src/renderer/plans/PlanPanel';
import { RefusalLine, refusalSummary, type Refusal } from '../../src/renderer/plans/RefusalLine';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { BRANCH, CLIP, ENTITY_IDS, entry, hashOf, KEYS, MIX_STEPS, PAD, planSnapshot, VOX } from './support/plans';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

const FRESH = hashOf('1');
const STALE = hashOf('2');
const PROPOSED = hashOf('3');
const REFUSED = hashOf('4');
const PARENT = hashOf('5');
const CHILD = hashOf('6');

const track = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  schema: 'siann.entity.track.v1',
  id,
  name,
  kind: 'audio',
  channels: 2,
  gainMilliDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  ...extra,
});

const PLANS: PlanEntry[] = [
  entry(FRESH, 'validated'),
  entry(STALE, 'validated', [{ op: 'track.set_gain', trackId: VOX, gainMilliDb: -1000 }], {
    stale: [{ ref: `track:${VOX}`, change: 'modified' }],
  }),
  entry(PROPOSED, 'approved', [{ op: 'clip.move', clipId: CLIP, position: { domain: 'audio', value: '12000' } }], { proposalBranch: BRANCH }),
  entry(REFUSED, 'rejected', [{ op: 'track.remove', trackId: VOX }], { rejectionNote: 'Keep the vocal' }),
  entry(PARENT, 'rejected', MIX_STEPS, { rejectionNote: `partially approved as ${CHILD}` }),
  entry(CHILD, 'approved', MIX_STEPS.slice(0, 2), { parentPlan: PARENT }),
];

const PREVIEW: PlanPreview = {
  revision: 'r5',
  documentHash: 'sha256:' + 'd'.repeat(64),
  stale: [],
  entities: [
    {
      ref: 'root:root',
      before: { id: 'root', name: 'Song', trackOrder: [KEYS, VOX] },
      after: { id: 'root', name: 'Song', trackOrder: [KEYS, VOX, PAD] },
    },
    { ref: `track:${KEYS}`, before: track(KEYS, 'Keys'), after: track(KEYS, 'Keys', { gainMilliDb: -3000, pan: -2000 }) },
    { ref: `track:${PAD}`, before: null, after: track(PAD, 'Pad') },
  ],
};

const NAMES = namesFromSnapshot(planSnapshot());

function view(overrides: Partial<PlanPanelViewProps> = {}, caps: Capabilities | null = FULL): string {
  const props: PlanPanelViewProps = {
    plans: PLANS,
    heard: BRANCH,
    firstSeen: new Map([[FRESH, 1_000]]),
    nowMs: 61_000,
    names: NAMES,
    selected: FRESH,
    ticked: null,
    note: '',
    busy: false,
    error: null,
    preview: PREVIEW,
    previewError: null,
    staleReasons: [],
    rejecting: false,
    hotStep: null,
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
      <PlanPanelView {...props} />
    </CapabilitiesContext.Provider>,
  );
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const t = translator('en');

test('the card is the selected plan; with none selected, the newest plan awaiting a decision; the others are history rows', () => {
  const card = (markup: string) => /<div class="card"[^>]*data-plan="([0-9a-f]{8})"/.exec(markup)?.[1];
  assert.equal(card(view()), '11111111');
  // Nothing selected: CHILD (approved, the newest awaiting a decision).
  assert.equal(card(view({ selected: null })), '66666666');
  // Only landed or rejected plans: the newest one.
  assert.equal(card(view({ selected: null, plans: [PLANS[3]!, PLANS[4]!] })), '55555555');
  // Every other plan is a row, newest first, each a button that selects it.
  const markup = view();
  const rows = [...markup.matchAll(/<button[^>]*class="hrow"[^>]*data-testid="plan-([0-9a-f]{8})"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['66666666', '55555555', '44444444', '33333333', '22222222']);
  assert.match(markup, /data-part="plan-history-head"[^>]*>Earlier<span>5 plans<\/span>/);
  // No plan: "No plans yet", no card and no history head.
  const none = view({ plans: [], selected: null });
  assert.ok(none.includes(t('plans.none')));
  assert.ok(!none.includes('class="card"') && !none.includes('plan-history-head'));
  // One plan: the card and no history head.
  const one = view({ plans: [PLANS[0]!] });
  assert.ok(one.includes('class="card"') && !one.includes('plan-history-head'));
});

test('steps are numbered from 1, all ticked by default, with one link: Select none, or Select all', () => {
  const markup = view();
  for (const index of [0, 1, 2]) {
    assert.match(markup, new RegExp(`data-testid="step-${index}"`));
    assert.match(markup, new RegExp(`class="stepn" data-testid="step-number-${index}">${index + 1}<`));
  }
  assert.equal(count(markup, 'role="checkbox"'), 3);
  assert.equal(count(markup, 'aria-checked="true"'), 3, 'every step ticked by default');
  assert.match(markup, /<a[^>]*data-testid="steps-none"[^>]*>Select none<\/a>/);
  assert.ok(!markup.includes('data-testid="steps-all"'));
  assert.ok(markup.includes('Steps · 3 of 3 selected'));
  assert.ok(markup.includes('>Approve 3 of 3<'), 'the primary names every step');
  // Unticked steps lower N and the link selects all.
  const partial = view({ ticked: new Set([0, 2]) });
  assert.equal(count(partial, 'aria-checked="true"'), 2);
  assert.equal(count(partial, 'aria-checked="false"'), 1);
  assert.match(partial, /<a[^>]*data-testid="steps-all"[^>]*>Select all<\/a>/);
  assert.ok(partial.includes('Steps · 2 of 3 selected'));
  assert.ok(partial.includes('>Approve 2 of 3<'), 'the primary names the subset');
  // Not reviewable (approved), or no plan.approve: no checkbox and no link; the boxes stay, empty.
  for (const markupOf of [view({ selected: CHILD }), view({}, REDUCED)]) {
    assert.ok(!markupOf.includes('role="checkbox"'));
    assert.ok(!markupOf.includes('data-testid="steps-all"') && !markupOf.includes('data-testid="steps-none"'));
    assert.ok(count(markupOf, '<span class="cb" aria-hidden="true"></span>') >= 2, 'empty .cb boxes keep the column');
  }
});

test('with every disclosure closed no entity id, milli-dB field, raw pan value or branch id is in the markup', () => {
  for (const selected of [FRESH, STALE, PROPOSED, REFUSED, PARENT, CHILD]) {
    const markup = view({
      selected,
      staleReasons: selected === STALE ? ['Vox Lead: volume was +1.50 dB, now +0.50 dB'] : [],
    });
    for (const id of ENTITY_IDS) assert.ok(!markup.includes(id), `${selected}: ${id} is shown`);
    assert.ok(!markup.includes('gainMilliDb'), selected);
    assert.ok(!markup.includes('-2000') && !markup.includes('-3000'), `${selected}: a raw value is shown`);
    assert.ok(!new RegExp(`\\b${BRANCH}\\b`).test(markup), `${selected}: the branch id is shown`);
    assert.ok(!markup.includes('root:root') && !markup.includes('trackOrder'), selected);
  }
  // The step rows are in user units: the old value struck, the new one emphasised.
  const markup = view();
  assert.ok(markup.includes(`<s>${formatDb(0)}</s> → <em>${formatDb(-3000)}</em>`), 'volume in dB');
  assert.ok(markup.includes('<s>C</s> → <em>L20</em>'), 'pan in L/C/R');
  assert.ok(markup.includes(`<b>${n('Pad')}</b>`), 'the new track by its name');
});

// The engine's refusals name ids: staleMessage() writes "track:<id>
// (modified)" and already_exists names the id it found.
const STALE_REFUSAL: Refusal = {
  code: 'plan_stale',
  message: `the plan is stale: track:${VOX} (modified), clip:${CLIP} (removed)`,
  changedEntities: [`track:${VOX}`, `clip:${CLIP}`],
};
const EXISTS_REFUSAL: Refusal = { code: 'already_exists', message: `a track with id ${PAD} already exists`, changedEntities: [] };

test('refusalSummary: the code and the catalog text in every locale, changed entities by name, never an id', () => {
  for (const locale of LOCALES) {
    const tl = translator(locale);
    const stale = refusalSummary(STALE_REFUSAL, locale, NAMES);
    assert.equal(stale, `plan_stale: ${tl('error.plan_stale')} (${n('Vox Lead')}, ${tl('step.clipOn', { track: n('Keys') })})`, locale);
    assert.equal(refusalSummary(EXISTS_REFUSAL, locale, NAMES), `already_exists: ${tl('error.already_exists')}`, locale);
    // An unknown code or none: the generic text, not the engine's message.
    assert.equal(refusalSummary({ code: 'x_new', message: `x ${PAD}`, changedEntities: [] }, locale, NAMES), `x_new: ${tl('plans.refused')}`);
    assert.equal(refusalSummary({ code: null, message: `Error: ${PAD}`, changedEntities: [] }, locale, NAMES), tl('plans.refused'));
    // Refs nothing names: by kind, never by id.
    const unnamed = refusalSummary({ code: 'plan_stale', message: '', changedEntities: ['track:trk_gone', 'marker:m1'] }, locale, NAMES);
    assert.ok(!unnamed.includes('trk_gone') && !unnamed.includes('m1'), unnamed);
    assert.ok(unnamed.includes(tl('step.aTrack')) && unnamed.includes(tl('step.anEntity')), unnamed);
  }
});

test('the banner refusal line: no id while closed, the engine text and refs once open', () => {
  const line = (open: boolean) =>
    renderToStaticMarkup(
      <RefusalLine refusal={STALE_REFUSAL} locale="en" names={NAMES} testId="banner-error" className="audition-banner-error" open={open} />,
    );
  const closed = line(false);
  for (const id of ENTITY_IDS) assert.ok(!closed.includes(id), id);
  assert.ok(closed.includes('Vox Lead'));
  assert.match(closed, /data-testid="banner-error-details"[^>]*aria-expanded="false"/);
  const open = line(true);
  assert.ok(open.includes(`track:${VOX}`) && open.includes(`clip:${CLIP}`) && open.includes('the plan is stale'));
});

test('a refusal is a row between the steps and the actions, and names no entity id until its disclosure is opened', () => {
  for (const selected of [FRESH, CHILD]) {
    const markup = view({ selected, error: STALE_REFUSAL, previewError: EXISTS_REFUSAL, preview: null });
    for (const id of ENTITY_IDS) assert.ok(!markup.includes(id), `${selected}: ${id} is shown`);
    assert.ok(!markup.includes('track:'), `${selected}: a ref is shown`);
    assert.match(markup, /data-testid="plan-error"[^>]*data-code="plan_stale"/);
    assert.ok(markup.indexOf('data-testid="plan-error"') > markup.indexOf('data-part="plan-steps"'), 'after the steps');
    assert.ok(markup.indexOf('data-testid="plan-error"') < markup.indexOf('data-part="plan-actions"'), 'before the actions');
    assert.ok(markup.includes('plan_stale'), 'the code stays in front');
    assert.ok(markup.includes('Vox Lead'), 'the changed track by its name');
    assert.ok(markup.includes(t('error.plan_stale')), 'the catalog text');
    assert.ok(markup.includes('already_exists') && markup.includes(t('error.already_exists')), 'the preview refusal');
    assert.match(markup, /data-testid="plan-error-details"[^>]*aria-expanded="false"/);
    assert.ok(!markup.includes('data-testid="plan-error-raw"'), 'no raw refusal in the DOM');
  }
  // Nothing to say: no row.
  assert.ok(!view().includes('data-testid="plan-error"'));
  // The disclosure holds the engine's own message and the changed refs.
  const open = view({ error: STALE_REFUSAL, openError: true });
  assert.match(open, /data-testid="plan-error-raw"/);
  assert.ok(open.includes(`track:${VOX}`), 'the raw ref');
  assert.ok(open.includes('the plan is stale'), "the engine's message");
});

test("a step's disclosure holds its raw step and the preview entities it touches, only while open", () => {
  const closed = view();
  assert.ok(!closed.includes('data-testid="step-raw-'), 'no raw step in the DOM');
  assert.ok(!closed.includes('data-testid="diff-'), 'no entity row in the DOM');
  assert.match(closed, /<button[^>]*class="t"[^>]*data-testid="step-text-1"[^>]*aria-expanded="false"/);

  const step = view({ openSteps: new Set([1]) });
  assert.match(step, /data-testid="step-text-1"[^>]*aria-expanded="true"/);
  assert.match(step, /data-testid="step-raw-1"/);
  assert.ok(step.includes('&quot;pan&quot;:-2000'), 'the raw step of row 1');
  assert.ok(!step.includes('&quot;gainMilliDb&quot;:-3000,&quot;op'), 'not the raw step of row 0');
  // Step 2 (pan Keys) touches track:KEYS, the preview's second entity.
  assert.match(step, /data-testid="diff-1"[^>]*data-kind="modified"/);
  assert.ok(step.includes(`track:${KEYS}`), 'the ref of the entity');
  assert.ok(step.includes('gainMilliDb'), 'its raw before and after');
  assert.match(step, /data-testid="diff-raw-1"/);
  assert.ok(!step.includes(`track:${PAD}`) && !step.includes('root:root'), 'not the entities of other steps');
  // The track the plan adds: its entity and the root's track order.
  const add = view({ openSteps: new Set([2]) });
  assert.ok(add.includes(`track:${PAD}`) && add.includes('root:root'));
  assert.match(add, /data-testid="diff-2"[^>]*data-kind="added"/);
});

test('every preview entity stays on the card: a cascade under the step that causes it, the rest in an "Other changes" row', () => {
  const REMOVE = hashOf('7');
  const plans = [entry(REMOVE, 'validated', [{ op: 'track.remove', trackId: VOX }], { stale: [{ ref: 'tempo:tempo', change: 'modified' }] })];
  const preview: PlanPreview = {
    revision: 'r5',
    documentHash: 'sha256:' + 'e'.repeat(64),
    stale: [],
    entities: [
      { ref: `track:${VOX}`, before: track(VOX, 'Vox Lead'), after: null },
      { ref: 'root:root', before: { id: 'root', name: 'Song', trackOrder: [KEYS, VOX] }, after: { id: 'root', name: 'Song', trackOrder: [KEYS] } },
      // Removed by track.remove's cascade (command.list cascades): named by no step.
      { ref: `clip:${CLIP}`, before: { id: CLIP, trackId: VOX, mediaId: 'med_keys' }, after: null },
      // Changed by nothing a step names.
      { ref: 'tempo:tempo', before: { id: 'tempo', bpm: 120 }, after: { id: 'tempo', bpm: 128 } },
    ],
  };
  const base = { plans, selected: REMOVE, preview };
  // Closed, nothing of the diff is in the DOM, but the other row is there to open.
  const closed = view(base);
  assert.ok(!closed.includes('data-testid="diff-'), 'no entity row while closed');
  assert.match(closed, /data-testid="plan-other"/);
  assert.match(closed, /<button[^>]*data-testid="plan-other-toggle"[^>]*aria-expanded="false"[^>]*>Other changes \(1\)</);
  // The step's disclosure: its own entity, the root and the cascaded clip.
  const step = view({ ...base, openSteps: new Set([0]) });
  for (const at of [0, 1, 2]) assert.match(step, new RegExp(`data-testid="diff-${at}"`));
  assert.match(step, /data-testid="diff-2"[^>]*data-kind="removed"/);
  assert.ok(step.includes(`clip:${CLIP}`), 'the cascaded clip under the step');
  assert.ok(!step.includes('data-testid="diff-3"'), 'the tempo is not the step\'s');
  // The other row holds the rest, with its stale mark.
  const other = view({ ...base, openOther: true });
  assert.match(other, /data-testid="plan-other-toggle"[^>]*aria-expanded="true"/);
  assert.match(other, /data-testid="diff-3"[^>]*data-stale="true"/);
  assert.ok(other.includes('tempo:tempo'));
  assert.ok(other.indexOf('data-testid="plan-other"') < other.indexOf('data-part="plan-actions"'), 'before the actions');
  // Every entity named by a step: no other row (the resting card keeps the mockup's height).
  assert.ok(!view().includes('data-testid="plan-other"'));
});

const ACTION_IDS = ['approve-apply', 'apply', 'audition', 'reject', 'merge', 'hear-main', 'hear-proposal', 'discard'];

function buttons(markup: string): string[] {
  return ACTION_IDS.filter((id) => markup.includes(`data-testid="plan-${id}"`));
}

// The three cells of .acts, in order: a button's test id, or "" for an empty cell.
function cells(markup: string): string[] {
  const acts = /<div class="acts" data-part="plan-actions">(.*?)<\/div>/.exec(markup)?.[1];
  if (acts === undefined) return [];
  return [...acts.matchAll(/<(button|span)([^>]*)>/g)]
    .filter((m) => /class="(btn[^"]*|acts-empty)"/.test(m[2]!))
    .map((m) => /data-testid="plan-([a-z-]+)"/.exec(m[2]!)?.[1] ?? '');
}

test('only the action set is rendered, in the three cells of .acts, with exactly one primary', () => {
  const cases: Array<[string, Partial<PlanPanelViewProps>, string[]]> = [
    ['validated', { selected: FRESH }, ['audition', 'approve-apply', 'reject']],
    ['validated, heard unknown', { selected: FRESH, heard: null }, ['', 'approve-apply', 'reject']],
    ['approved', { selected: CHILD }, ['audition', 'apply', 'reject']],
    ['proposed and heard', { selected: PROPOSED }, ['hear-main', 'merge', 'discard']],
    ['proposed, main heard', { selected: PROPOSED, heard: 'main' }, ['hear-proposal', 'merge', 'discard']],
    ['rejected', { selected: REFUSED }, []],
  ];
  for (const [name, props, expected] of cases) {
    const markup = view(props);
    assert.deepEqual(cells(markup), expected, name);
    assert.deepEqual(buttons(markup).sort(), expected.filter(Boolean).sort(), name);
    assert.equal(count(markup, 'class="btn primary"'), expected.length > 0 ? 1 : 0, name);
  }
  // The ids of the mockup's three actions are on those actions only.
  assert.match(view(), /data-part="plan-audition"[^>]*data-testid="plan-audition"|data-testid="plan-audition"[^>]*data-part="plan-audition"/);
  assert.ok(!view({ selected: PROPOSED }).includes('data-part="plan-audition"'));
  assert.ok(!view({ selected: PROPOSED }).includes('data-part="plan-reject"'));
  // The danger button is icon-only, named by the catalog.
  const reject = /<button[^>]*data-testid="plan-reject"[^>]*>/.exec(view())![0];
  assert.match(reject, new RegExp(`aria-label="${t('plans.reject')}"`));
  assert.match(reject, new RegExp(`title="${t('plans.reject')}"`));
  const discard = /<button[^>]*data-testid="plan-discard"[^>]*>/.exec(view({ selected: PROPOSED }))![0];
  assert.match(discard, new RegExp(`aria-label="${t('plans.discard')}"`));
});

test('the reason field opens with the first press of Reject, as a row above the actions', () => {
  assert.ok(!view().includes('data-testid="plan-note"'), 'a resting card has no reason row');
  const open = view({ rejecting: true, note: 'Keep it' });
  assert.match(open, /data-testid="plan-note"[^>]*value="Keep it"|value="Keep it"[^>]*data-testid="plan-note"/);
  assert.ok(open.includes(t('plans.reason')));
  assert.ok(open.indexOf('data-testid="plan-note"') < open.indexOf('data-part="plan-actions"'), 'above the actions');
  // A plan with no Reject has no reason row.
  assert.ok(!view({ selected: PROPOSED, rejecting: true }).includes('data-testid="plan-note"'));
});

test("a stale plan's primary is disabled with its reason; capabilities remove what they do not list", () => {
  const markup = view({ selected: STALE, staleReasons: ['Vox Lead: volume was +1.50 dB, now +0.50 dB'] });
  const primary = /<button[^>]*class="btn primary"[^>]*>/.exec(markup)?.[0] ?? '';
  assert.match(primary, /disabled=""/);
  assert.ok(primary.includes(`title="${t('actionReason.stale')}"`), primary);
  assert.match(markup, /data-testid="plan-stale-reasons"/);
  assert.ok(markup.indexOf('data-testid="plan-stale-reasons"') < markup.indexOf('data-part="plan-actions"'));
  assert.ok(markup.includes('Vox Lead: volume was +1.50 dB, now +0.50 dB'));
  // The card keeps both badges (4.5 C6).
  assert.match(markup, /data-testid="plan-stale-22222222"/);
  assert.match(markup, /data-testid="plan-state-22222222"/);
  assert.ok(!view().includes('data-testid="plan-stale-reasons"'), 'nothing to say: no row');

  // The reduced fixture lists plan.reject but not plan.approve, plan.apply,
  // plan.propose, audition.hear or proposal.*.
  assert.deepEqual(buttons(view({}, REDUCED)), ['reject']);
  assert.deepEqual(buttons(view({ selected: PROPOSED }, REDUCED)), []);
  // Audition needs plan.approve, plan.propose and audition.hear.
  for (const missing of ['plan.approve', 'plan.propose', 'audition.hear']) {
    const caps = { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== missing) };
    assert.ok(!buttons(view({}, caps)).includes('audition'), `without ${missing}`);
  }
  assert.deepEqual(buttons(view({}, null)), [], 'nothing while the capabilities are unknown');
});

test('a rejection shows its reason and a split parent its split label, in their history rows', () => {
  const markup = view({ selected: null });
  assert.match(markup, /<small data-testid="plan-reason-44444444"[^>]*>“⁨Keep the vocal⁩” · sent to agent</);
  assert.match(markup, /<small data-testid="plan-split-55555555"[^>]*>Split, 2 of 3 approved</);
  assert.ok(!markup.includes('partially approved'), "the engine's own note is not shown");
  assert.match(markup, /data-testid="plan-state-11111111"[^>]*data-state="validated"/);
  assert.ok(markup.includes('Needs review'));
  assert.ok(markup.includes('Approved for audition'));
  assert.ok(markup.includes('3 steps · 1 minute ago'), 'the time since the plan was first seen');
  // The card (CHILD) names its parent in a row under .top, and shows its short hash.
  assert.match(markup, /data-testid="plan-part-of"[^>]*>\(part of 55555555\)</);
  assert.ok(markup.includes('>66666666<'), 'the short hash');
  // On the card, a rejection's reason is a row of its head.
  assert.match(view({ selected: REFUSED }), /data-testid="plan-reason-44444444"[^>]*>“⁨Keep the vocal⁩” · sent to agent</);
});
