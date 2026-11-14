// The tool modifiers (m5-ui-edit-basics; UI redesign spec 3.6, "a second
// small table, as in Cubase's Tool Modifiers page"): Alt copies on a drag and
// splits on a click, Mod (Ctrl on Windows and Linux, Cmd on macOS)
// constrains a move to one axis and ignores snap while resizing, Shift is the
// fine step. Resolved from a pointer event's modifier flags per platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_MODIFIERS, toolModifiers } from '../../src/renderer/keys/tool-modifiers';

const NONE = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

test('the table: copy and split-click Alt, constrain and no-snap Mod, fine Shift', () => {
  assert.deepEqual(TOOL_MODIFIERS, { copy: 'Alt', splitClick: 'Alt', constrain: 'Mod', noSnap: 'Mod', fine: 'Shift' });
});

test('no modifier: nothing held', () => {
  for (const platform of ['mac', 'other'] as const) {
    assert.deepEqual(toolModifiers(NONE, platform), { copy: false, splitClick: false, constrain: false, noSnap: false, fine: false });
  }
});

test('Alt copies and splits on every platform; Shift is fine', () => {
  for (const platform of ['mac', 'other'] as const) {
    const alt = toolModifiers({ ...NONE, altKey: true }, platform);
    assert.equal(alt.copy, true);
    assert.equal(alt.splitClick, true);
    assert.equal(alt.constrain, false);
    assert.equal(toolModifiers({ ...NONE, shiftKey: true }, platform).fine, true);
  }
});

test('Mod is Ctrl on Windows and Linux and Cmd on macOS', () => {
  const ctrl = { ...NONE, ctrlKey: true };
  const meta = { ...NONE, metaKey: true };
  assert.equal(toolModifiers(ctrl, 'other').constrain, true);
  assert.equal(toolModifiers(ctrl, 'other').noSnap, true);
  assert.equal(toolModifiers(meta, 'other').constrain, false, 'the Windows key is the OS\'s');
  assert.equal(toolModifiers(meta, 'mac').constrain, true);
  assert.equal(toolModifiers(meta, 'mac').noSnap, true);
  assert.equal(toolModifiers(ctrl, 'mac').constrain, false, 'Control on macOS is not Mod');
});
