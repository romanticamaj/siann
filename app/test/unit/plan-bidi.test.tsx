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
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { ISOLATE } from '../../src/renderer/plans/isolate';
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
