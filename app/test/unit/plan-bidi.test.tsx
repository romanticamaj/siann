// Bidi isolation in the plan review (security fix, plan metadata bidi): every
// string an agent can influence that the Plans tab and the audition banner
// show (the card's lead, built from step names; the rejection note; each
// step's text; the stale reasons; the banner's text) is rendered with
// dir="auto" and unicode-bidi: isolate, so an RLO (U+202E) or an isolate the
// engine let through cannot reorder the text around its box. The engine
// already refuses these characters in plan titles and intents and strips them
// from agent names; this is the renderer's second line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Capabilities } from '../../src/renderer/model/capabilities';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { AuditionBanner } from '../../src/renderer/plans/AuditionBanner';
import { describePlan, describeRef, describeStep, namesFromSnapshot, type StepNames } from '../../src/renderer/plans/describe';
import { staleReasons } from '../../src/renderer/plans/card';
import { diffRows, rowChanges, rowLabel } from '../../src/renderer/plans/diff';
import { formatMilliDb } from '../../src/renderer/format';
import { translator } from '../../src/renderer/i18n/t';
import { LOCALES } from '../../src/renderer/i18n/locale';
import { FSI, ISOLATE, isolateName, PDI } from '../../src/renderer/plans/isolate';
import { PlanPanelView, type PlanPanelViewProps } from '../../src/renderer/plans/PlanPanel';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { BRANCH, entry, fakePlanClient, hashOf, MIX_STEPS, planObject, planSnapshot, VOX } from './support/plans';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;

const RLO = '‮';
const PDF = '‬';
const NOTE = `Keep ${RLO}lacov eht${PDF} please`;
const REJECTED = hashOf('4');
const FRESH = hashOf('1');

// The opening tag of the element with this class, or '' when there is none.
function openingTags(markup: string, className: string): string[] {
  return [...markup.matchAll(new RegExp(`<[a-z]+[^>]*class="${className}"[^>]*>`, 'g'))].map((match) => match[0]);
}

function assertIsolated(markup: string, className: string) {
  const tags = openingTags(markup, className);
  assert.ok(tags.length > 0, `no element with class ${className}`);
  for (const tag of tags) {
    assert.match(tag, /\sdir="auto"/, `${className}: ${tag}`);
    assert.match(tag, /style="[^"]*unicode-bidi:isolate/, `${className}: ${tag}`);
  }
}

function panel(overrides: Partial<PlanPanelViewProps> = {}): string {
  const props: PlanPanelViewProps = {
    plans: [entry(FRESH, 'validated'), entry(REJECTED, 'rejected', [{ op: 'track.remove', trackId: VOX }], { rejectionNote: NOTE })],
    heard: null,
    firstSeen: new Map(),
    nowMs: 0,
    names: namesFromSnapshot(planSnapshot()),
    selected: FRESH,
    ticked: null,
    note: '',
    busy: false,
    error: null,
    preview: null,
    previewError: null,
    staleReasons: [`Vox ${RLO}emulov${PDF} changed`],
    onSelect: () => undefined,
    onTicked: () => undefined,
    onNote: () => undefined,
    onRun: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <PlanPanelView {...props} />
    </CapabilitiesContext.Provider>,
  );
}

test('ISOLATE is dir="auto" with unicode-bidi: isolate', () => {
  assert.equal(ISOLATE.dir, 'auto');
  assert.equal(ISOLATE.style.unicodeBidi, 'isolate');
});

test("the card's lead and rejection note, each step and the stale reasons are bidi-isolated", () => {
  const markup = panel();
  assert.ok(markup.includes(NOTE), 'the note is shown as sent');
  assertIsolated(markup, 'plan-card-lead');
  assertIsolated(markup, 'plan-card-reason');
  assertIsolated(markup, 'step-text');
  assertIsolated(markup, 'plan-stale-reason');
});

test("the audition banner's text is bidi-isolated", () => {
  const store = new PlanStore({ now: () => 0 });
  store.fromList({ plans: [planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH })] });
  store.setHeard(BRANCH);
  const markup = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <AuditionBanner client={fakePlanClient().client} plans={store} />
    </CapabilitiesContext.Provider>,
  );
  assertIsolated(markup, 'audition-banner-text');
});

// Follow-up to #123: the step text is isolated as a whole, but a name inside
// it is the agent's or the user's, so each interpolated name is its own
// isolate (U+2068 FSI ... U+2069 PDI) and an RLO or an unclosed LRI in a track,
// plugin, media or session name cannot reorder the words of the sentence
// around it ("Set <name> volume to -6.0 dB" stays in that order).

const LRI = '\u2066';
const EVIL = `Vox ${RLO}Bd 0.0 ot`;
const NAMES: StepNames = {
  track: (id) => ({ trk_e: EVIL, trk_l: `Lead${LRI}` } as Record<string, string>)[id],
  clip: (id) => (id === 'clp_e' ? { trackId: 'trk_e', position: '0' } : undefined),
  slot: (id) => (id === 'slt_e' ? { trackId: 'trk_e', name: `EQ${RLO}` } : undefined),
  sampleRate: 48000,
};

// The text with every isolate's content replaced by "<>": what the sentence
// reads around its names, whatever they hold.
function outside(text: string): string {
  return text.replace(/\u2068[^\u2068\u2069]*\u2069/g, '<>');
}

test('isolateName wraps a name in FSI and PDI and drops the isolate controls inside it', () => {
  assert.equal(FSI, '\u2068');
  assert.equal(PDI, '\u2069');
  assert.equal(isolateName('Keys'), '\u2068Keys\u2069');
  assert.equal(isolateName(EVIL), `\u2068${EVIL}\u2069`);
  // An LRI, RLI, FSI or PDI inside could close the isolate early or leave one open.
  assert.equal(isolateName(`a${LRI}b\u2069c\u2067d\u2068e`), '\u2068abcde\u2069');
});

test('every name in a step sentence is its own isolate, in every locale', () => {
  const steps: Record<string, unknown>[] = [
    { op: 'track.set_gain', trackId: 'trk_e', gainMilliDb: -6000 },
    { op: 'track.rename', trackId: 'trk_l', name: `Kit${RLO}` },
    { op: 'track.add', trackId: 'trk_n', name: `New${RLO}`, channels: 2 },
    { op: 'clip.remove', clipId: 'clp_e' },
    { op: 'plugin.set_bypass', slotId: 'slt_e', bypass: true },
    { op: 'plugin.insert', trackId: 'trk_e', index: 0, slotId: 'slt_n', descriptor: { format: 'clap', uid: 'u', name: `Verb${RLO}` }, stateBlob: null },
    { op: 'media.rename', mediaId: 'med_1', name: `kick${RLO}vaw.exe` },
    { op: 'session.rename', name: `Night${RLO}` },
  ];
  for (const locale of LOCALES) {
    const t = translator(locale);
    const texts = describePlan(steps, t, NAMES);
    for (const text of texts) {
      // No unsafe character outside an isolate: the sentence's own words keep their order.
      assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(outside(text)), `${locale}: ${JSON.stringify(text)}`);
    }
    assert.ok(texts[0]!.includes(`\u2068${EVIL}\u2069`), `${locale}: ${texts[0]}`);
    assert.ok(texts[1]!.includes(`\u2068Lead\u2069`) && texts[1]!.includes(`\u2068Kit${RLO}\u2069`), `${locale}: ${texts[1]}`);
    assert.ok(texts[6]!.includes(`\u2068kick${RLO}vaw.exe\u2069`), `${locale}: ${texts[6]}`);
  }
  const en = translator('en');
  assert.equal(describeStep(steps[0]!, en, NAMES), `Set \u2068${EVIL}\u2069 volume to ${formatMilliDb(-6000)}`);
  assert.equal(outside(describeStep(steps[0]!, en, NAMES)), `Set <> volume to ${formatMilliDb(-6000)}`);
  assert.equal(outside(describeStep(steps[4]!, en, NAMES)), 'Bypass <> on <>');
  assert.equal(outside(describeRef('track:trk_e', en, NAMES)), '<>');
  // Catalog words for an unknown entity are not names and are not wrapped.
  assert.equal(describeRef('track:trk_x', en, NAMES), 'a track');
});

test('stale reasons and the diff table isolate each name', () => {
  const plan = { stale: [{ ref: 'track:trk_e', change: 'modified' }, { ref: 'clip:clp_e', change: 'removed' }] } as never;
  const before = { name: `Old${RLO}`, gainMilliDb: 0, pan: 0, mute: false, solo: false };
  const after = { name: EVIL, gainMilliDb: -300, pan: 0, mute: false, solo: false };
  const reasons = staleReasons(
    plan,
    new Map<string, Record<string, unknown> | null>([['track:trk_e', after], ['clip:clp_e', { trackId: 'trk_e' }]]),
    new Map<string, Record<string, unknown> | null>([['track:trk_e', before], ['clip:clp_e', { trackId: 'trk_e' }]]),
    'en',
    NAMES,
  );
  assert.ok(reasons.length >= 3, JSON.stringify(reasons));
  for (const reason of reasons) assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(outside(reason)), JSON.stringify(reason));
  assert.ok(reasons.some((r) => r.includes(`\u2068Old${RLO}\u2069`)), JSON.stringify(reasons));

  const rows = diffRows({
    revision: 'r2',
    documentHash: hashOf('9'),
    stale: [],
    entities: [
      { ref: 'track:trk_e', before, after },
      { ref: 'plugin_slot:slt_e', before: null, after: { name: `EQ${RLO}`, trackId: 'trk_e' } },
      { ref: 'clip:clp_e', before: null, after: { trackId: 'trk_e' } },
    ],
  });
  const en = translator('en');
  assert.equal(rowLabel(rows[0]!, NAMES, en), `\u2068${EVIL}\u2069`);
  assert.equal(rowLabel(rows[1]!, NAMES, en), `\u2068EQ${RLO}\u2069`);
  assert.equal(outside(rowLabel(rows[2]!, NAMES, en)), 'a clip on <>');
  for (const line of rowChanges(rows[0]!, NAMES, en)) assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(outside(line)), JSON.stringify(line));
});

test('the track list, inspector, mixer strip and session name isolate the names they show', () => {
  const sources = ['timeline/TrackList.tsx', 'shell/Inspector.tsx', 'mixer/Strip.tsx', 'shell/TopBar.tsx'];
  const classes: Record<string, string> = {
    'timeline/TrackList.tsx': 'track-name',
    'shell/Inspector.tsx': 'inspector-track',
    'mixer/Strip.tsx': 'strip-name',
    'shell/TopBar.tsx': 'session-name',
  };
  for (const source of sources) {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', source), 'utf8');
    const at = text.indexOf(`className="${classes[source]}"`);
    assert.ok(at >= 0, source);
    // The element's opening tag and the start of its children.
    assert.match(text.slice(at, at + 300), /\{\.\.\.ISOLATE\}|\.\.\.ISOLATE\.style/, source);
  }
});
