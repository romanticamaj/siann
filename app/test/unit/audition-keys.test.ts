// The audition's keys (m5b-ui-audition; UI redesign 3.6, 4.3, 4.5 C4):
// Shift+A (audition.flip, window scope) hears the other side while a plan is
// auditioned and declines otherwise, so the key keeps its default; Ctrl+Return
// (Mod+Enter in the preset: Cmd+Return on macOS) with the right zone focused
// (plans.primary) runs the selected plan's primary action, Approve N of M,
// Apply or Merge, when it can run. Neither fires while a text field has the
// focus, and neither takes a key Cubase gives to another command.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_IDS, CommandRegistry } from '../../src/renderer/keys/commands';
import { chordOf, resolveKey, type KeyInput } from '../../src/renderer/keys/dispatcher';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { actionSet, primaryAction } from '../../src/renderer/plans/actions';
import { selection } from '../../src/renderer/plans/diff';
import { flipTarget } from '../../src/renderer/plans/hearing';
import { BRANCH, entry, hashOf, MIX_STEPS, planObject } from './support/plans';

const NONE = { ctrl: false, alt: false, shift: false, meta: false };
const input = (patch: Partial<KeyInput>): KeyInput => ({ code: 'KeyA', key: 'a', modifiers: NONE, targetIsTextField: false, focusedZone: 'project', platform: 'other', ...patch });

test('the command ids and the preset rows', () => {
  assert.ok(COMMAND_IDS.includes('audition.flip'));
  assert.ok(COMMAND_IDS.includes('plans.primary'));
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'audition.flip'), [{ chord: 'Shift+A', commandId: 'audition.flip', scope: 'window' }]);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'plans.primary'), [{ chord: 'Mod+Enter', commandId: 'plans.primary', scope: 'right' }]);
  // No other row takes these chords; Enter and NumpadEnter keep theirs.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Shift+A').map((b) => b.commandId), ['audition.flip']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+Enter').map((b) => b.commandId), ['plans.primary']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Enter').map((b) => b.commandId), ['focus.enterZone']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'NumpadEnter').map((b) => b.commandId), ['transport.start']);
  // Cubase's Select None is Ctrl+Shift+A (research 7.2): not taken.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+Shift+A'), []);
});

test('Shift+A resolves from every zone, and not in a text field', () => {
  const press = input({ code: 'KeyA', key: 'A', modifiers: { ...NONE, shift: true } });
  assert.equal(chordOf(press), 'Shift+A');
  for (const focusedZone of ['project', 'left', 'lower', 'right'] as const) {
    assert.equal(resolveKey({ ...press, focusedZone }, CUBASE_PRESET)?.commandId, 'audition.flip', focusedZone);
  }
  assert.equal(resolveKey({ ...press, targetIsTextField: true }, CUBASE_PRESET), null);
  // A bare A is nothing.
  assert.equal(resolveKey(input({}), CUBASE_PRESET), null);
});

test('Ctrl+Return (Cmd+Return on macOS) runs the primary from the right zone only, and not in a text field', () => {
  const win = input({ code: 'Enter', key: 'Enter', modifiers: { ...NONE, ctrl: true }, focusedZone: 'right' });
  const mac = input({ code: 'Enter', key: 'Enter', modifiers: { ...NONE, meta: true }, focusedZone: 'right', platform: 'mac' });
  for (const key of [win, mac]) {
    assert.equal(chordOf(key), 'Mod+Enter');
    assert.equal(resolveKey(key, CUBASE_PRESET)?.commandId, 'plans.primary');
    for (const focusedZone of ['project', 'left', 'lower'] as const) assert.equal(resolveKey({ ...key, focusedZone }, CUBASE_PRESET), null, focusedZone);
    assert.equal(resolveKey({ ...key, targetIsTextField: true }, CUBASE_PRESET), null);
  }
  // The numpad's Enter with Ctrl is not the chord.
  assert.notEqual(resolveKey({ ...win, code: 'NumpadEnter' }, CUBASE_PRESET)?.commandId, 'plans.primary');
});

function heardStore(heard: string | null, proposed = true): PlanStore {
  const store = new PlanStore({ now: () => 0 });
  store.fromList({
    plans: [planObject(hashOf('1'), 'validated', MIX_STEPS), ...(proposed ? [planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH })] : [])],
  });
  store.setHeard(heard);
  return store;
}

test('flipTarget: a heard branch flips to main, main to the open proposal; nothing without one or with the side unknown', () => {
  assert.equal(flipTarget(heardStore(BRANCH).getSnapshot()), 'main');
  assert.equal(flipTarget(heardStore('main').getSnapshot()), BRANCH);
  assert.equal(flipTarget(heardStore('main', false).getSnapshot()), null);
  assert.equal(flipTarget(heardStore(null).getSnapshot()), null);
  // A heard branch no held plan owns still flips to main.
  assert.equal(flipTarget(heardStore('p9', false).getSnapshot()), 'main');
});

test('a registered handler that declines leaves the key to its default', () => {
  const registry = new CommandRegistry();
  registry.register('window', 'audition.flip', () => false);
  assert.equal(registry.run('window', 'audition.flip'), false);
});

test('primaryAction: the primary when it can run, else nothing', () => {
  const all = selection(null, MIX_STEPS.length);
  const validated = actionSet(entry(hashOf('1'), 'validated'), 'main', all);
  assert.equal(primaryAction(validated, () => true)?.id, 'approveApply');
  assert.equal(primaryAction(validated, () => false), null, 'the engine lacks its methods');
  const none = actionSet(entry(hashOf('1'), 'validated'), 'main', selection(new Set(), MIX_STEPS.length));
  assert.equal(primaryAction(none, () => true), null, 'nothing ticked');
  const stale = actionSet(entry(hashOf('1'), 'validated', MIX_STEPS, { stale: [{ ref: 'track:trk_keys', change: 'modified' }] }), 'main', all);
  assert.equal(primaryAction(stale, () => true), null, 'stale');
  assert.equal(primaryAction(actionSet(entry(hashOf('2'), 'approved'), 'main', all), () => true)?.id, 'apply');
  assert.equal(primaryAction(actionSet(entry(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH }), BRANCH, all), () => true)?.id, 'merge');
  assert.equal(primaryAction(actionSet(entry(hashOf('3'), 'applied'), 'main', all), () => true), null);
});
