// The edit guard (m5b-ui-audition; UI redesign 4.5 C5): one predicate in the
// renderer. While a proposal is heard, structural edits are disabled until
// command.execute can target the branch: clip, marker and import commands,
// record, and track mute, solo, rename, pan, add and remove sent as track.*
// commands. The locators, the tempo, undo and redo, and fader gestures (which
// the engine commits onto the side heard) stay enabled. The reason is one
// catalog key, in every locale.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { en } from '../../src/renderer/i18n/en';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import { GUARD_REASON, isStructural, structuralBlocked } from '../../src/renderer/model/edit-guard';

test('structural edits are blocked only while a branch is heard', () => {
  assert.equal(structuralBlocked('p1'), true);
  assert.equal(structuralBlocked('main'), false);
  assert.equal(structuralBlocked(null), false, 'an unknown side (no engine, no auditioner) blocks nothing');
});

test('the table of structural ops', () => {
  const structural = [
    'clip.place',
    'clip.move',
    'clip.trim',
    'clip.remove',
    'clip.set_gain',
    'clip.set_fade',
    'track.add',
    'track.remove',
    'track.rename',
    'track.set_mute',
    'track.set_solo',
    'track.set_pan',
    'marker.add',
    'marker.move',
    'marker.remove',
    'media.import',
    'transport.record',
    // m5b-ui-inserts-master: an insert, its removal and its bypass commit onto main.
    'plugin.instantiate',
    'plugin.insert',
    'plugin.remove',
    'plugin.set_bypass',
  ];
  // A plugin's editor window, the registry and an approval change no session.
  for (const op of ['plugin.open_editor', 'plugin.close_editor', 'plugin.registry', 'plugin.approve', 'master.set_gain']) assert.equal(isStructural(op), false, op);
  for (const op of structural) assert.equal(isStructural(op), true, op);
  const free = ['session.set_locators', 'session.set_tempo', 'tempo.set', 'session.undo', 'session.redo', 'gesture.begin', 'gesture.update', 'gesture.end', 'gesture.cancel', 'transport.locate', 'transport.play', 'audition.hear', 'proposal.merge'];
  for (const op of free) assert.equal(isStructural(op), false, op);
});

test('the reason is one catalog key with a text in every locale', () => {
  assert.equal(GUARD_REASON, 'guard.structural');
  for (const catalog of [en, zhHant, zhHans] as const) {
    const text = (catalog as Record<string, unknown>)[GUARD_REASON];
    assert.equal(typeof text, 'string');
    assert.ok((text as string).length > 0);
  }
  assert.notEqual(zhHant[GUARD_REASON], en[GUARD_REASON]);
});
