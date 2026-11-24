// The "Cubase" key-command preset (m5-ui-shell; UI redesign spec 3.6 and
// research/cubase.md section 7): one table of {chord, commandId, scope}.
// Mod is Ctrl on Windows and Linux and Cmd on macOS, Alt is Opt; a chord
// names its modifiers in the order Mod, Ctrl, Alt, Shift and then the key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { formatChord } from '../../src/renderer/keys/chord-label';
import { COMMAND_IDS, SCOPES } from '../../src/renderer/keys/commands';
import { CUBASE_REFERENCE } from '../../src/renderer/keys/cubase-reference';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';

test('the preset is one table of chord, command id and scope', () => {
  assert.ok(Array.isArray(CUBASE_PRESET) && CUBASE_PRESET.length > 0);
  for (const binding of CUBASE_PRESET) {
    assert.deepEqual(Object.keys(binding).sort(), ['chord', 'commandId', 'scope']);
    assert.ok(SCOPES.includes(binding.scope), `${binding.chord}: scope ${binding.scope}`);
    assert.ok(COMMAND_IDS.includes(binding.commandId), `${binding.chord}: command ${binding.commandId}`);
    assert.match(binding.chord, /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?[A-Za-z0-9]+$/, binding.chord);
  }
  assert.deepEqual([...SCOPES].sort(), ['channel', 'left', 'lower', 'project', 'right', 'window']);
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
    const found = CUBASE_PRESET.filter((b) => b.chord === chord && b.scope !== 'lower');
    assert.deepEqual(found.map((b) => [b.scope, b.commandId]), [['project', commandId]], chord);
  }
});

// m5b-ui-editor-channel (UI redesign 2.1, 3.6, 5.2): Ctrl+Alt+C shows and hides
// the Channel zone, Ctrl+Alt+Left and Right step the focused zone's tabs, and
// H and G zoom the sample editor while the lower zone has the focus.
// editor.open has no chord of its own: Return reaches it through the focus key.
test('the Channel zone key, the tab keys and the editor\'s zoom keys (m5b-ui-editor-channel)', () => {
  const rows: Array<[string, string, string]> = [
    ['Mod+Alt+C', 'window', 'zone.channel.toggle'],
    ['Mod+Alt+ArrowRight', 'window', 'zone.tab.next'],
    ['Mod+Alt+ArrowLeft', 'window', 'zone.tab.prev'],
  ];
  for (const [chord, scope, commandId] of rows) {
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord), [{ chord, commandId, scope }], chord);
    assert.ok((COMMAND_IDS as readonly string[]).includes(commandId), commandId);
  }
  for (const [chord, commandId] of [['H', 'view.zoomIn'], ['G', 'view.zoomOut']] as const) {
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord).map((b) => [b.scope, b.commandId]).sort(), [['lower', commandId], ['project', commandId]], chord);
  }
  assert.ok((COMMAND_IDS as readonly string[]).includes('editor.open'));
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'editor.open'), [], 'editor.open has no chord');
  // Enter stays the focus key and Num Enter the transport's start.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Enter').map((b) => b.commandId), ['focus.enterZone']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'NumpadEnter').map((b) => b.commandId), ['transport.start']);
  // The nudges keep theirs.
  for (const [chord, commandId] of [['Mod+ArrowLeft', 'edit.nudgeLeft'], ['Mod+ArrowRight', 'edit.nudgeRight'], ['Alt+ArrowLeft', 'edit.nudgeStartLeft'], ['Alt+ArrowRight', 'edit.nudgeEndRight'], ['Alt+Shift+ArrowLeft', 'edit.nudgeEndLeft'], ['Alt+Shift+ArrowRight', 'edit.nudgeStartRight']]) {
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord).map((b) => b.commandId), [commandId], chord);
  }
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+C').map((b) => b.commandId), ['edit.copy']);
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

test('Ctrl+P (Cmd+P on macOS) opens the Media tab, Cubase\'s Open Pool key (m5b-ui-media; UI redesign UR-5, 10.8, 1)', () => {
  const found = CUBASE_PRESET.filter((b) => b.commandId === 'media.open');
  assert.deepEqual(found, [{ chord: 'Mod+P', commandId: 'media.open', scope: 'window' }]);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+P').map((b) => [b.scope, b.commandId]), [['window', 'media.open']]);
  // The Pool's command is gone (the Media tab replaced the Pool).
  assert.ok(!CUBASE_PRESET.some((b) => (b.commandId as string) === 'pool.open'));
  assert.ok(!(COMMAND_IDS as readonly string[]).includes('pool.open'));
  assert.ok((COMMAND_IDS as readonly string[]).includes('media.open'));
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
  // Add Bus and Remove Bus (m5b-ui-sends-buses; UI redesign 3.6): Cubase gives neither a key.
  const unbound = ['studio.setup', 'mixer.bus.add', 'mixer.bus.remove', ...Array.from({ length: 10 }, (_, i) => `project.openRecent.${i + 1}`)];
  for (const id of unbound) {
    assert.ok((COMMAND_IDS as readonly string[]).includes(id), `${id} is a command`);
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === id), [], `${id} has no key`);
  }
  assert.ok(!(COMMAND_IDS as readonly string[]).includes('project.openRecent.11'), 'ten recent entries, no more');
});

// m5b-ui-sends-buses (UI redesign 3.4; 10.11, 25): Escape with the lower zone
// focused clears the bus selection. A press on a bus strip leaves the focus
// on the zone's frame (the strip is not focusable), so the key is the lower
// zone's edit.cancel, as the project zone's Escape is, and not a handler on
// the MixConsole's own element.
test('Escape is the lower zone\'s edit.cancel, as the project zone\'s', () => {
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'edit.cancel').map((b) => [b.chord, b.scope]), [['Escape', 'project'], ['Escape', 'lower']]);
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

// m5b-ui-recording (UI redesign 3.1, 3.3, 3.6): R arms the selected track in
// the project zone, as M and S act on it; Num * records, Ctrl+Shift+R (Cmd on
// macOS) is its laptop fallback; I and O toggle the punch in and out. None of
// them collides with a chord already bound.
test('the record keys: R, Num *, Mod+Shift+R, I and O (m5b-ui-recording)', () => {
  const rows: Array<[string, string, string]> = [
    ['R', 'project', 'track.recordEnable'],
    ['NumpadMultiply', 'window', 'transport.record'],
    ['Mod+Shift+R', 'window', 'transport.record'],
    ['I', 'window', 'transport.punchIn'],
    ['O', 'window', 'transport.punchOut'],
  ];
  for (const [chord, scope, commandId] of rows) {
    assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === chord), [{ chord, commandId, scope }], chord);
    assert.ok((COMMAND_IDS as readonly string[]).includes(commandId), commandId);
  }
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'transport.record').map((b) => b.chord), ['NumpadMultiply', 'Mod+Shift+R']);
  // The neighbours keep their commands.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Mod+Alt+R').map((b) => b.commandId), ['zone.right.toggle']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'Alt+I').map((b) => b.commandId), ['zone.left.toggle']);
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'M').map((b) => b.commandId), ['track.muteSelected']);
});

// m5b-ui-keymap (UI redesign 3.1, 3.6, UR-11; acceptance 2 and 3): every
// command the numeric keypad reaches has a second chord off it in the same
// scope, so a laptop reaches the whole transport; the remaining transport
// keys of Cubase are bound; and every off-keypad fallback is one of the SIANN
// additions spec 3.6 lists.
const NUMPAD = /Numpad/;

test('every command bound on the numeric keypad has a binding off it in the same scope', () => {
  const missing: string[] = [];
  for (const binding of CUBASE_PRESET.filter((b) => NUMPAD.test(b.chord))) {
    const off = CUBASE_PRESET.some((b) => b.commandId === binding.commandId && b.scope === binding.scope && !NUMPAD.test(b.chord));
    if (!off) missing.push(`${binding.scope} ${binding.chord} -> ${binding.commandId}`);
  }
  assert.deepEqual(missing, []);
});

test('wind, nudge cursor and the tempo field: Num -/+, Ctrl+Num -/+ and Shift+T, with their fallbacks (m5b-ui-keymap)', () => {
  const windowRows: Array<[string, string]> = [
    ['NumpadSubtract', 'transport.rewind'],
    ['NumpadAdd', 'transport.forward'],
    ['Minus', 'transport.rewind'],
    ['Equal', 'transport.forward'],
    ['Mod+NumpadSubtract', 'transport.nudgeCursorLeft'],
    ['Mod+NumpadAdd', 'transport.nudgeCursorRight'],
    ['Mod+Minus', 'transport.nudgeCursorLeft'],
    ['Mod+Equal', 'transport.nudgeCursorRight'],
    ['Shift+T', 'transport.enterTempo'],
    // The fallbacks of start, stop and the set-locator keys.
    ['Shift+Enter', 'transport.start'],
    ['Shift+0', 'transport.stop'],
    ['Mod+1', 'transport.setLeftLocator'],
    ['Mod+2', 'transport.setRightLocator'],
    // Cubase's other keypad key for Go to Project Start.
    ['NumpadComma', 'transport.toStart'],
  ];
  for (const [chord, commandId] of windowRows) {
    const found = CUBASE_PRESET.filter((b) => b.chord === chord);
    assert.deepEqual(found.map((b) => [b.scope, b.commandId]), [['window', commandId]], chord);
  }
  // Help > Key Commands has no key, as in Cubase.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.commandId === 'help.keyCommands'), []);
  // T stays Add Track, Shift+C unbound.
  assert.deepEqual(CUBASE_PRESET.filter((b) => b.chord === 'T').map((b) => b.commandId), ['track.add']);
});

// The keys of spec 3.6's table of SIANN additions, as it writes them.
function additionsTableKeys(): Set<string> {
  const spec = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md'), 'utf8');
  const lines = spec.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('- **SIANN additions**'));
  assert.ok(start > 0, '3.6 has the table of SIANN additions');
  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- **')) break;
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[2] ?? '';
    for (const match of cell.matchAll(/`([^`]+)`/g)) keys.add(match[1]!);
  }
  return keys;
}

test('every off-keypad fallback of a keypad command is listed in spec 3.6\'s table of SIANN additions', () => {
  const listed = additionsTableKeys();
  const missing: string[] = [];
  for (const command of new Set(CUBASE_PRESET.filter((b) => NUMPAD.test(b.chord)).map((b) => b.commandId))) {
    for (const binding of CUBASE_PRESET.filter((b) => b.commandId === command && !NUMPAD.test(b.chord))) {
      // Cubase's own key for the command (Shift+3..9 for the markers) is no fallback.
      if (CUBASE_REFERENCE.some((row) => row.chord === binding.chord && row.commandId === command)) continue;
      const written = formatChord(binding.chord, 'other');
      if (!listed.has(written)) missing.push(`${binding.chord} (${written}) -> ${command}`);
    }
  }
  assert.deepEqual(missing, []);
  // The table is read: the fallbacks of earlier features are in it.
  for (const key of [',', '/', 'Shift+1', 'Ctrl+Shift+R']) assert.ok(listed.has(key), key);
});
