// The "ask the agent" box's keys and text bounds (m5b-ui-composer; UI redesign
// 4.4, 2.1; protocol-engine-v0.md "Agent requests"): Enter and numpad Enter
// send, Shift+Enter breaks the line, and the Enter that confirms an
// input-method composition (isComposing, or keyCode 229 where a browser
// reports it so) does nothing. A text is sent trimmed of nothing but must hold
// a character other than white space, and is counted in code points against
// limits.agentRequestTextChars, as the engine counts it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkText, composerKey, textLength } from '../../src/renderer/plans/composer-keys';

const key = (over: Partial<Parameters<typeof composerKey>[0]>) => composerKey({ key: 'Enter', code: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...over });

test('Enter and numpad Enter send, Shift+Enter breaks the line, other keys do nothing', () => {
  assert.equal(key({}), 'send');
  assert.equal(key({ code: 'NumpadEnter' }), 'send');
  assert.equal(key({ shiftKey: true }), 'newline');
  assert.equal(key({ code: 'NumpadEnter', shiftKey: true }), 'newline');
  for (const [k, code] of [
    ['a', 'KeyA'],
    [' ', 'Space'],
    ['Escape', 'Escape'],
    ['Tab', 'Tab'],
    ['Delete', 'Delete'],
    ['1', 'Digit1'],
  ]) {
    assert.equal(key({ key: k, code, keyCode: 0 }), 'none', code);
  }
});

test('an Enter that confirms an input-method composition never sends', () => {
  assert.equal(key({ isComposing: true }), 'none');
  assert.equal(key({ isComposing: true, shiftKey: true }), 'none');
  // Chromium reports the confirming Enter with keyCode 229 (Process) on some platforms.
  assert.equal(key({ keyCode: 229 }), 'none');
  assert.equal(key({ key: 'Process', keyCode: 229 }), 'none');
});

test('a text counts in code points, not UTF-16 units', () => {
  assert.equal(textLength('abc'), 3);
  assert.equal(textLength('鼓'), 1);
  assert.equal(textLength('𝄞'), 1, 'a character outside the BMP is one code point');
  assert.equal('𝄞'.length, 2);
});

test('an empty or whitespace-only text never sends; a text over the limit is refused, at the limit it passes', () => {
  assert.deepEqual(checkText('', 4000), { ok: false, reason: 'empty' });
  assert.deepEqual(checkText('   \n\t ', 4000), { ok: false, reason: 'empty' });
  assert.deepEqual(checkText(' Lower the drums ', 4000), { ok: true, text: ' Lower the drums ' }, 'the text goes as typed');
  const chinese = '鼓'.repeat(4000);
  assert.deepEqual(checkText(chinese, 4000), { ok: true, text: chinese }, '4,000 Chinese characters pass');
  assert.deepEqual(checkText(chinese + '鼓', 4000), { ok: false, reason: 'too_long' }, '4,001 are refused');
  const astral = '𝄞'.repeat(4000);
  assert.equal(astral.length, 8000);
  assert.deepEqual(checkText(astral, 4000), { ok: true, text: astral }, 'counted with [...text].length');
  assert.deepEqual(checkText('ab', 1), { ok: false, reason: 'too_long' });
});
