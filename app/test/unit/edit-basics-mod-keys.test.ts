// A source check over the edit-basics e2e (m5-ui-edit-basics): the Object
// Selection tool's Mod gestures (tool-modifiers.ts: constrain and noSnap are
// 'Mod', Ctrl on Windows and Linux and Cmd on macOS) must be driven with
// Playwright's 'ControlOrMeta', not a bare 'Control' or 'Meta'. The e2e runs
// on macOS too (ci.yml, the Electron matrix), where a held Control is not
// Mod: a Ctrl-drag would not constrain and a Ctrl resize would still snap.
// This check runs on every platform, so the mistake shows on Windows as well.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// dist/test/unit -> app/test/e2e. m5b-ui-edit-more's spec drives Mod as well
// (Ctrl+X/C/V, Ctrl+K, Ctrl+Left/Right, Ctrl+Shift+A, Ctrl+Enter).
const SPECS = ['edit-basics.spec.ts', 'edit-more.spec.ts'].map((name) => path.resolve(__dirname, '..', '..', '..', 'test', 'e2e', name));

// keyboard.down/up/press('Control'), 'Control+X', 'Meta' alone, and
// modifiers: ['Control'] or ['Meta'].
const BARE_MOD = /keyboard\.(down|up|press)\(\s*['"](Control|Meta)(['"]|\+)|modifiers:\s*\[[^\]]*['"](Control|Meta)['"]/;

test('the edit-basics and edit-more e2e hold Mod as ControlOrMeta, never a bare Control or Meta', () => {
  const found: string[] = [];
  for (const spec of SPECS) {
    assert.ok(fs.existsSync(spec), `no spec at ${spec}`);
    fs.readFileSync(spec, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (BARE_MOD.test(line)) found.push(`${path.basename(spec)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
});

test('the pattern catches the bare forms and passes ControlOrMeta', () => {
  assert.ok(BARE_MOD.test("await page.keyboard.down('Control');"));
  assert.ok(BARE_MOD.test("await page.keyboard.press('Meta+KeyD');"));
  assert.ok(BARE_MOD.test("click({ modifiers: ['Control'] })"));
  assert.ok(!BARE_MOD.test("await page.keyboard.down('ControlOrMeta');"));
  assert.ok(!BARE_MOD.test("await page.keyboard.press('ControlOrMeta+KeyA');"));
  assert.ok(!BARE_MOD.test("click({ modifiers: ['ControlOrMeta'] })"));
});
