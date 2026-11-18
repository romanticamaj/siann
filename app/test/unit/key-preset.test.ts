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

test('the editing keys of Cubase (m5-ui-edit-basics; UI redesign spec 3.1, 3.2, 3.3)', () => {
  const expected: Array<[string, string]> = [
    ['1', 'tool.select'],
    ['3', 'tool.split'],
    ['Alt+X', 'edit.splitAtCursor'],
    ['Mod+D', 'edit.duplicate'],
    ['J', 'edit.snapToggle'],
    ['Mod+A', 'edit.selectAll'],
    ['L', 'transport.locateSelection'],
    ['N', 'transport.locateNextClip'],
    ['B', 'transport.locatePreviousClip'],
    ['Alt+S', 'view.zoomSelection'],
    ['Shift+E', 'view.zoomEvent'],
    ['M', 'track.muteSelected'],
    ['S', 'track.soloSelected'],
    ['Shift+Delete', 'track.removeSelected'],
  ];
  for (const [chord, commandId] of expected) {
    const found = CUBASE_PRESET.filter((b) => b.chord === chord);
    assert.deepEqual(found.map((b) => [b.scope, b.commandId]), [['project', commandId]], chord);
  }
});

test('the project zone\'s zoom keys of Cubase and T to add a track (m5-ui-arrange)', () => {
  const expected: Array<[string, string]> = [
    ['H', 'view.zoomIn'],
    ['G', 'view.zoomOut'],
    ['Shift+H', 'view.tracksTaller'],
    ['Shift+G', 'view.tracksShorter'],
    ['Shift+F', 'view.zoomFull'],
    ['T', 'track.add'],
  ];
  for (const [chord, commandId] of expected) {
    const found = CUBASE_PRESET.filter((b) => b.chord === chord);
    assert.deepEqual(found.map((b) => [b.scope, b.commandId]), [['project', commandId]], chord);
  }
});

test('the transport keys of Cubase with the laptop fallback, the position display\'s keys, undo and redo, and F for auto-scroll (m5-ui-transport)', () => {
  const windowRows: Array<[string, string]> = [
    ['Space', 'transport.toggle'],
    ['NumpadEnter', 'transport.start'],
    ['Numpad0', 'transport.stop'],
    ['NumpadDecimal', 'transport.toStart'],
    // SIANN addition: the laptop fallback for Num . (UI redesign spec 3.6).
    ['Comma', 'transport.toStart'],
    ['Period', 'transport.exchangeFormats'],
    ['Shift+P', 'transport.enterPosition'],
    ['Mod+Z', 'edit.undo'],
    ['Mod+Shift+Z', 'edit.redo'],
  ];
  for (const [chord, commandId] of windowRows) {
    const found = CUBASE_PRESET.filter((b) => b.chord === chord);
    assert.deepEqual(found.map((b) => [b.scope, b.commandId]), [['window', commandId]], chord);
  }
  const autoScroll = CUBASE_PRESET.filter((b) => b.chord === 'F');
  assert.deepEqual(autoScroll.map((b) => [b.scope, b.commandId]), [['project', 'view.autoScroll']]);
  // The chords beside them keep their commands.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Shift+F').map((b) => b.commandId), ['view.zoomFull']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Enter').map((b) => b.commandId), ['focus.enterZone']);
});

test('the locator, cycle and metronome keys (m5-ui-loop-click; UI redesign spec 3.1, 3.2, 3.6)', () => {
  const windowRows: Array<[string, string]> = [
    ['P', 'transport.locatorsToSelection'],
    ['Alt+P', 'transport.loopSelection'],
    ['C', 'transport.metronomeToggle'],
    // Num / toggles cycle; the slash key is its laptop fallback.
    ['NumpadDivide', 'transport.cycleToggle'],
    ['Slash', 'transport.cycleToggle'],
    // Num 1 / Num 2 go to the locators; Shift+1 / Shift+2 are their laptop fallback.
    ['Numpad1', 'transport.toLeftLocator'],
    ['Numpad2', 'transport.toRightLocator'],
    ['Shift+1', 'transport.toLeftLocator'],
    ['Shift+2', 'transport.toRightLocator'],
    // Ctrl+Num 1 / Ctrl+Num 2 (Mod) set them to the project cursor.
    ['Mod+Numpad1', 'transport.setLeftLocator'],
    ['Mod+Numpad2', 'transport.setRightLocator'],
  ];
  for (const [chord, commandId] of windowRows) {
    const found = CUBASE_PRESET.filter((b) => b.chord === chord);
    assert.deepEqual(found.map((b) => [b.scope, b.commandId]), [['window', commandId]], chord);
  }
  // No collision: 1 stays the Object Selection tool, Shift+P the position field.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === '1').map((b) => [b.scope, b.commandId]), [['project', 'tool.select']]);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Shift+P').map((b) => [b.scope, b.commandId]), [['window', 'transport.enterPosition']]);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+Alt+P').map((b) => b.commandId), ['zone.right.plans']);
  // No zone binds these chords (the window's would then lose to it).
  for (const [chord] of windowRows) assert.equal(CUBASE_PRESET.filter((b) => b.chord === chord && b.scope !== 'window').length, 0, chord);
});

test('Ctrl+Alt+G (Cmd+Alt+G on macOS) toggles the ghosts of the overlaid plan, in the window (m5b-ui-ghosts; UI redesign 4.2, 3.6)', () => {
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'plans.toggleGhosts'), [{ chord: 'Mod+Alt+G', commandId: 'plans.toggleGhosts', scope: 'window' }]);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+Alt+G').map((b) => b.commandId), ['plans.toggleGhosts']);
  // G and Shift+G keep the zoom.
  assert.ok(CUBASE_PRESET.some((b) => b.chord === 'G' && b.commandId !== 'plans.toggleGhosts'));
});

test('Ctrl+P (Cmd+P on macOS) opens the Pool, Cubase\'s Open Pool key (m5-ui-port-toolbar; UI redesign 10.8, 1)', () => {
  const found = CUBASE_PRESET.filter((b) => b.commandId === 'pool.open');
  assert.deepEqual(found, [{ chord: 'Mod+P', commandId: 'pool.open', scope: 'window' }]);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+P').map((b) => [b.scope, b.commandId]), [['window', 'pool.open']]);
  // The other P keys keep their commands.
  const others: Array<[string, string]> = [
    ['P', 'transport.locatorsToSelection'],
    ['Alt+P', 'transport.loopSelection'],
    ['Shift+P', 'transport.enterPosition'],
    ['Mod+Alt+P', 'zone.right.plans'],
  ];
  for (const [chord, commandId] of others) assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord).map((b) => b.commandId), [commandId], chord);
});

// m5b-ui-signature (UI redesign UR-15): the Sig cell is a readout. Shift+C,
// Cubase's signature key, stays unbound until the meter map (E-10), and no
// command edits the signature.
test('Shift+C is unbound and no command edits the time signature (m5b-ui-signature)', () => {
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Shift+C'), []);
  assert.deepEqual(COMMAND_IDS.filter((id) => /signature|metre/i.test(id)), []);
});

// m5b-ui-project (UI redesign 3.6, UR-4): Cubase's own keys for New Project,
// Open and Save, in the window scope; Studio Setup and the ten Open Recent
// entries are commands without a key, reached from the application menu.
test('New, Open and Save are Cubase\'s keys; Studio Setup and Open Recent are unbound commands (m5b-ui-project)', () => {
  const rows: Array<[string, string]> = [
    ['Mod+N', 'project.new'],
    ['Mod+O', 'project.open'],
    ['Mod+S', 'project.save'],
  ];
  for (const [chord, commandId] of rows) {
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord), [{ chord, commandId, scope: 'window' }], chord);
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === commandId).map((b) => b.chord), [chord], commandId);
  }
  const unbound = ['studio.setup', ...Array.from({ length: 10 }, (_, i) => `project.openRecent.${i + 1}`)];
  for (const id of unbound) {
    assert.ok((COMMAND_IDS as readonly string[]).includes(id), `${id} is a command`);
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === id), [], `${id} has no key`);
  }
  assert.ok(!(COMMAND_IDS as readonly string[]).includes('project.openRecent.11'), 'ten recent entries, no more');
});

// m5b-ui-edit-more (UI redesign spec 3.2, 3.6): Glue and Erase on 4 and 5,
// cut, copy and paste at the cursor and at the origin, Repeat, the nudges of
// the key-command table, Select None; edit.glue has no key, as in Cubase.
test('the editing keys of m5b-ui-edit-more, all in the project zone; edit.glue is unbound', () => {
  const expected: Array<[string, string]> = [
    ['4', 'tool.glue'],
    ['5', 'tool.erase'],
    ['Mod+X', 'edit.cut'],
    ['Mod+C', 'edit.copy'],
    ['Mod+V', 'edit.paste'],
    ['Alt+V', 'edit.pasteAtOrigin'],
    ['Mod+K', 'edit.repeat'],
    ['Mod+ArrowLeft', 'edit.nudgeLeft'],
    ['Mod+ArrowRight', 'edit.nudgeRight'],
    ['Alt+ArrowLeft', 'edit.nudgeStartLeft'],
    ['Alt+Shift+ArrowRight', 'edit.nudgeStartRight'],
    ['Alt+Shift+ArrowLeft', 'edit.nudgeEndLeft'],
    ['Alt+ArrowRight', 'edit.nudgeEndRight'],
    ['Mod+Shift+A', 'edit.selectNone'],
  ];
  for (const [chord, commandId] of expected) {
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord).map((b) => [b.scope, b.commandId]), [['project', commandId]], chord);
    assert.ok(COMMAND_IDS.includes(commandId as (typeof COMMAND_IDS)[number]), commandId);
  }
  assert.ok(COMMAND_IDS.includes('edit.glue'));
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'edit.glue'), [], 'edit.glue has no binding');
  // C stays the metronome and Mod+A Select All.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'C').map((b) => b.commandId), ['transport.metronomeToggle']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+A').map((b) => b.commandId), ['edit.selectAll']);
});
