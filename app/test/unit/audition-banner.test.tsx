// The audition banner and the hearing switch (m5-ui-plan-panel; UI redesign
// 4.3 as corrected for P1-5): while audition.changed reports a branch, a
// banner under the top bar names the plan as its card does (first step and
// step count) and offers Hear main, Merge and Discard under the capability
// rule; a branch no plan holds gets the generic banner; main or unknown, no
// banner. The hearing switch marks the side heard from the store only (never
// a guess), is disabled while the side is unknown, and does not exist without
// audition.hear. Neither shows the branch id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatMilliDb } from '../../src/renderer/format';
import { translator } from '../../src/renderer/i18n/t';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { AuditionBanner } from '../../src/renderer/plans/AuditionBanner';
import { HearingSwitch } from '../../src/renderer/plans/HearingSwitch';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { BRANCH, fakePlanClient, hashOf, MIX_STEPS, planObject } from './support/plans';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

function storeHearing(heard: string | null): PlanStore {
  const store = new PlanStore({ now: () => 0 });
  store.fromList({
    plans: [planObject(hashOf('1'), 'validated', MIX_STEPS), planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH })],
  });
  store.setHeard(heard);
  return store;
}

function within(caps: Capabilities | null, node: ReactNode): string {
  return renderToStaticMarkup(<CapabilitiesContext.Provider value={caps}>{node}</CapabilitiesContext.Provider>);
}

const banner = (heard: string | null, caps: Capabilities | null = FULL) =>
  within(caps, <AuditionBanner client={fakePlanClient().client} plans={storeHearing(heard)} />);

test('a heard branch shows a banner naming its plan, with Hear main, Merge and Discard', () => {
  const markup = banner(BRANCH);
  assert.match(markup, /data-testid="audition-banner"/);
  assert.ok(markup.includes(`Set Keys volume to ${formatMilliDb(-3000)}`), markup);
  assert.ok(markup.includes(translator('en')('plans.steps', { count: 3 })), markup);
  for (const id of ['banner-hear-main', 'banner-merge', 'banner-discard']) assert.match(markup, new RegExp(`data-testid="${id}"`), id);
  assert.ok(!new RegExp(`\\b${BRANCH}\\b`).test(markup), 'no branch id');
  // The capability rule: the reduced fixture lists none of the three methods.
  const reduced = banner(BRANCH, REDUCED);
  assert.match(reduced, /data-testid="audition-banner"/);
  for (const id of ['banner-hear-main', 'banner-merge', 'banner-discard']) assert.ok(!reduced.includes(id), id);
});

test('main or an unknown side: no banner; a branch no plan holds: the generic banner', () => {
  assert.equal(banner('main'), '');
  assert.equal(banner(null), '');
  const generic = banner('p9');
  assert.match(generic, /data-testid="audition-banner"/);
  assert.ok(generic.includes(translator('en')('banner.generic')), generic);
  assert.ok(!generic.includes('Keys'), 'no plan named');
});

const switcher = (heard: string | null, caps: Capabilities | null = FULL) =>
  within(caps, <HearingSwitch client={fakePlanClient().client} plans={storeHearing(heard)} />);

function pressed(markup: string, id: string): string | undefined {
  const button = new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(markup)?.[0] ?? '';
  return /aria-pressed="(true|false)"/.exec(button)?.[1];
}

test('the hearing switch marks the side heard from the store, is disabled while unknown, absent without audition.hear', () => {
  const proposal = switcher(BRANCH);
  assert.equal(pressed(proposal, 'hear-proposal'), 'true');
  assert.equal(pressed(proposal, 'hear-main'), 'false');
  assert.match(proposal, /data-testid="plan-heard"[^>]*data-heard="proposal"/);
  assert.ok(!new RegExp(`\\b${BRANCH}\\b`).test(proposal), 'no branch id');

  const main = switcher('main');
  assert.equal(pressed(main, 'hear-main'), 'true');
  assert.equal(pressed(main, 'hear-proposal'), 'false');
  assert.match(main, /data-heard="main"/);

  const unknown = switcher(null);
  assert.equal(pressed(unknown, 'hear-main'), 'false');
  assert.equal(pressed(unknown, 'hear-proposal'), 'false');
  assert.equal(count(unknown, 'disabled=""'), 2);

  assert.equal(switcher(BRANCH, REDUCED), '');
  assert.equal(switcher(BRANCH, null), '');
});
