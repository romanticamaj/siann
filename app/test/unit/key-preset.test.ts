// The "Cubase" key-command preset (m5-ui-shell; UI redesign spec 3.6 and
// research/cubase.md section 7): one table of {chord, commandId, scope}.
// Mod is Ctrl on Windows and Linux and Cmd on macOS, Alt is Opt; a chord
// names its modifiers in the order Mod, Ctrl, Alt, Shift and then the key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_IDS, SCOPES } from '../../src/renderer/keys/commands';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';

test('the preset is one table of chord, command id and scope', () => {
  assert.ok(Array.isArray(CUBASE_PRESET) && CUBASE_PRESET.length > 0);
  for (const binding of CUBASE_PRESET) {
    assert.deepEqual(Object.keys(binding).sort(), ['chord', 'commandId', 'scope']);
    assert.ok(SCOPES.includes(binding.scope), `${binding.chord}: scope ${binding.scope}`);
    assert.ok(COMMAND_IDS.includes(binding.commandId), `${binding.chord}: command ${binding.commandId}`);
    assert.match(binding.chord, /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?[A-Za-z0-9]+$/, binding.chord);
  }
  assert.deepEqual([...SCOPES].sort(), ['left', 'lower', 'project', 'right', 'window']);
});

test('no chord is bound twice within a scope', () => {
  for (const scope of SCOPES) {
    const chords = CUBASE_PRESET.filter((b) => b.scope === scope).map((b) => b.chord);
    const seen = new Set<string>();
    const duplicates = chords.filter((chord) => (seen.has(chord) ? true : (seen.add(chord), false)));
    assert.deepEqual(duplicates, [], `duplicate chords in ${scope}`);
  }
});

test('the zone keys of Cubase, the SIANN Plans key and the zone focus keys', () => {
  const expected: Array<[string, string]> = [
    ['Mod+Alt+L', 'zone.left.toggle'],
    ['Alt+I', 'zone.left.toggle'],
    ['Mod+Alt+E', 'zone.lower.toggle'],
    ['Mod+Alt+B', 'zone.lower.toggle'],
    ['Alt+F3', 'zone.lower.mixconsole'],
    ['F3', 'zone.lower.mixconsole'],
    ['Mod+Alt+R', 'zone.right.toggle'],
    ['Mod+Alt+P', 'zone.right.plans'],
    // Tab and Shift+Tab cycle the zones from a zone or the page, and move
    // between the controls of a zone from inside it; F6 and Shift+F6 always
    // cycle the zones; Enter on a zone enters it, Escape returns to it.
    ['Tab', 'focus.next'],
    ['Shift+Tab', 'focus.prev'],
    ['F6', 'focus.nextZone'],
    ['Shift+F6', 'focus.prevZone'],
    ['Enter', 'focus.enterZone'],
    ['Escape', 'focus.zoneRoot'],
  ];
  for (const [chord, commandId] of expected) {
    const found = CUBASE_PRESET.filter((b) => b.chord === chord && b.scope === 'window');
    assert.deepEqual(found.map((b) => b.commandId), [commandId], chord);
  }
  // Nothing hides the project zone.
  assert.ok(!COMMAND_IDS.some((id) => id.startsWith('zone.project')), 'no project zone command');
});
