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

// dist/test/unit -> app/test/e2e
const SPEC = path.resolve(__dirname, '..', '..', '..', 'test', 'e2e', 'edit-basics.spec.ts');

// keyboard.down/up/press('Control'), 'Control+X', 'Meta' alone, and
// modifiers: ['Control'] or ['Meta'].
const BARE_MOD = /keyboard\.(down|up|press)\(\s*['"](Control|Meta)(['"]|\+)|modifiers:\s*\[[^\]]*['"](Control|Meta)['"]/;

test('the edit-basics e2e holds Mod as ControlOrMeta, never a bare Control or Meta', () => {
  assert.ok(fs.existsSync(SPEC), `no spec at ${SPEC}`);
  const found: string[] = [];
  fs.readFileSync(SPEC, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (BARE_MOD.test(line)) found.push(`edit-basics.spec.ts:${i + 1}: ${line.trim()}`);
    });
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
