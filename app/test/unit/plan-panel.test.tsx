// The Plans tab (m5-ui-plan-panel; UI redesign section 4 and P1-5), rendered
// to static markup as capabilities.test.tsx does: steps numbered from 1 and
// all ticked by default, Select all / Select none for a reviewable plan; with
// every disclosure closed no entity id, milli-dB field, raw pan value or
// branch id is anywhere in the markup, and a disclosure's content exists only
// while it is open; only the action set's buttons exist, one of them primary,
// a stale plan's primary disabled with its reason, and each button only when
// engine.capabilities lists what it sends; a rejection shows its reason and a
// split parent its split label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatMilliDb } from '../../src/renderer/format';
import { translator } from '../../src/renderer/i18n/t';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { PlanEntry } from '../../src/renderer/model/plan-store';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import type { PlanPreview } from '../../src/renderer/plans/diff';
import { PlanPanelView, type PlanPanelViewProps } from '../../src/renderer/plans/PlanPanel';
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
    onSelect: () => undefined,
    onTicked: () => undefined,
    onNote: () => undefined,
    onRun: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={caps}>
      <PlanPanelView {...props} />
    </CapabilitiesContext.Provider>,
  );
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

test('steps are numbered from 1, all ticked by default, with Select all and Select none', () => {
  const markup = view();
  for (const index of [0, 1, 2]) {
    assert.match(markup, new RegExp(`data-testid="step-${index}"`));
    assert.match(markup, new RegExp(`data-testid="step-number-${index}"[^>]*>${index + 1}<`));
  }
  assert.ok(!markup.includes('start="0"'));
  assert.equal(count(markup, 'type="checkbox"'), 3);
  assert.equal(count(markup, 'checked=""'), 3, 'every step ticked by default');
  assert.match(markup, /data-testid="steps-all"/);
  assert.match(markup, /data-testid="steps-none"/);
  // Unticked steps turn the primary into "Approve N of M".
  const partial = view({ ticked: new Set([0, 2]) });
  assert.equal(count(partial, 'checked=""'), 2);
  assert.ok(partial.includes('Approve 2 of 3'), 'the primary names the subset');
  // Not reviewable (approved), or no plan.approve: no checkboxes, no select controls.
  for (const markupOf of [view({ selected: CHILD }), view({}, REDUCED)]) {
    assert.ok(!markupOf.includes('type="checkbox"'));
    assert.ok(!markupOf.includes('data-testid="steps-all"'));
    assert.ok(!markupOf.includes('data-testid="steps-none"'));
  }
});

test('with every disclosure closed no entity id, milli-dB field, raw pan value or branch id is in the markup', () => {
  for (const selected of [FRESH, STALE, PROPOSED, REFUSED, PARENT]) {
    const markup = view({
      selected,
      staleReasons: selected === STALE ? [`Vox Lead: volume was ${formatMilliDb(1500)}, now ${formatMilliDb(500)}`] : [],
    });
    for (const id of ENTITY_IDS) assert.ok(!markup.includes(id), `${selected}: ${id} is shown`);
    assert.ok(!markup.includes('gainMilliDb'), selected);
    assert.ok(!markup.includes('-2000') && !markup.includes('-3000'), `${selected}: a raw value is shown`);
    assert.ok(!new RegExp(`\\b${BRANCH}\\b`).test(markup), `${selected}: the branch id is shown`);
    assert.ok(!markup.includes('root:root') && !markup.includes('trackOrder'), selected);
  }
  // The diff is in user units.
  const markup = view();
  assert.ok(markup.includes(formatMilliDb(-3000)), 'volume in dB');
  assert.ok(markup.includes('L20'), 'pan in L/C/R');
  assert.ok(markup.includes('Pad'), 'the new track by its name');
});

test('a disclosure renders its content only while open, for its row only', () => {
  const closed = view();
  assert.ok(!closed.includes('data-testid="step-raw-'), 'no raw step in the DOM');
  assert.ok(!closed.includes('data-testid="diff-raw-'), 'no raw row in the DOM');
  assert.match(closed, /data-testid="step-details-1"[^>]*aria-expanded="false"/);

  const step = view({ openSteps: new Set([1]) });
  assert.match(step, /data-testid="step-raw-1"/);
  assert.ok(step.includes('&quot;pan&quot;:-2000'), 'the raw step of row 1');
  assert.ok(!step.includes('&quot;gainMilliDb&quot;:-3000'), 'not the raw step of row 0');
  assert.match(step, /data-testid="step-details-1"[^>]*aria-expanded="true"/);

  const row = view({ openRows: new Set([1]) });
  assert.match(row, /data-testid="diff-raw-1"/);
  assert.ok(row.includes(`track:${KEYS}`), 'the ref of the open row');
  assert.ok(row.includes('gainMilliDb'), 'its raw before and after');
  assert.ok(!row.includes(`track:${PAD}`), 'not the ref of another row');
  assert.ok(!row.includes('root:root'));
});

const ACTION_IDS = ['approve-apply', 'apply', 'audition', 'reject', 'merge', 'hear-main', 'hear-proposal', 'discard'];

function buttons(markup: string): string[] {
  return ACTION_IDS.filter((id) => markup.includes(`data-testid="plan-${id}"`));
}

test('only the action set is rendered, with exactly one primary', () => {
  const cases: Array<[string, Partial<PlanPanelViewProps>, string[]]> = [
    ['validated', { selected: FRESH }, ['approve-apply', 'audition', 'reject']],
    ['approved', { selected: CHILD }, ['apply', 'audition', 'reject']],
    ['proposed and heard', { selected: PROPOSED }, ['merge', 'hear-main', 'discard']],
    ['proposed, main heard', { selected: PROPOSED, heard: 'main' }, ['merge', 'hear-proposal', 'discard']],
    ['rejected', { selected: REFUSED }, []],
  ];
  for (const [name, props, expected] of cases) {
    const markup = view(props);
    assert.deepEqual(buttons(markup).sort(), [...expected].sort(), name);
    assert.equal(count(markup, 'plan-action primary'), expected.length > 0 ? 1 : 0, name);
  }
  const t = translator('en');
  assert.ok(view().includes(`>${t('plans.approveApply')}<`));
  // The reason field is offered with Reject only.
  assert.match(view(), /data-testid="plan-note"/);
  assert.ok(!view({ selected: PROPOSED }).includes('data-testid="plan-note"'));
  assert.ok(view().includes(t('plans.reason')));
});

test("a stale plan's primary is disabled with its reason; capabilities remove what they do not list", () => {
  const markup = view({ selected: STALE, staleReasons: ['Vox Lead: volume was +1.50 dB, now +0.50 dB'] });
  const primary = /<button[^>]*class="plan-action primary"[^>]*>/.exec(markup)?.[0] ?? '';
  assert.match(primary, /disabled=""/);
  assert.ok(primary.includes(`title="${translator('en')('actionReason.stale')}"`), primary);
  assert.match(markup, /data-testid="plan-stale-reasons"/);
  assert.ok(markup.includes('Vox Lead: volume was +1.50 dB, now +0.50 dB'));
  assert.match(markup, /data-testid="plan-stale-22222222"/);

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

test('a rejection shows its reason and a split parent its split label', () => {
  const markup = view({ selected: null });
  assert.match(markup, /data-testid="plan-reason-44444444"[^>]*>Keep the vocal</);
  assert.match(markup, /data-testid="plan-split-55555555"[^>]*>Split, 2 of 3 approved</);
  assert.ok(!markup.includes('partially approved'), "the engine's own note is not shown");
  assert.match(markup, /data-testid="plan-state-11111111"[^>]*data-state="validated"/);
  assert.ok(markup.includes('Needs review'));
  assert.ok(markup.includes('Approved for audition'));
  assert.ok(markup.includes('1 minute ago'), 'the time since the plan was first seen');
  assert.ok(markup.includes('11111111'), 'the short hash');
});
