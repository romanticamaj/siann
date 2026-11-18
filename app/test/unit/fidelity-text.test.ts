// The agent text of the fidelity session (test/e2e/support/fidelity-text.ts;
// m5b-ui-plan-metadata, UI redesign 10.7, 3): per locale, the words the
// mockup's right zone draws for the plans' titles, the intent and the
// rejection note, so the zh-TW window is not English beside a Chinese mockup.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { translator } from '../../src/renderer/i18n/t';
import { EN_TEXT, sessionText } from '../e2e/support/fidelity-text';
import { find, MOCKUP, mockupRightZone, parse, textOf, type Node } from './support/mockup-plan';

function part(zone: Node, id: string): Node {
  const found = find(zone, (node) => node.attrs['data-part'] === id);
  assert.ok(found, `the mockup's right zone has no ${id}`);
  return found;
}
const bold = (row: Node): string => textOf(row.children.find((child) => child.tag === 'b')!).trim();
const small = (row: Node): string => textOf(row.children.find((child) => child.tag === 'small')!).trim();

for (const [locale, catalog] of [['en', 'en'], ['zh-TW', 'zh-Hant']] as const) {
  test(`the fidelity session's agent text is what the mockup draws (${locale})`, () => {
    const text = sessionText(locale, MOCKUP);
    const zone = parse(mockupRightZone(locale));
    assert.equal(textOf(part(zone, 'plan-title')).trim(), text.titles.plan);
    assert.equal(textOf(part(zone, 'plan-intent')).trim(), text.intent);
    assert.equal(bold(part(zone, 'plan-history-1')), text.titles.applied);
    assert.equal(bold(part(zone, 'plan-history-2')), text.titles.rejected);
    assert.equal(bold(part(zone, 'plan-history-3')), text.titles.stale);
    // The app's row around the submitted note reads the mockup's row.
    assert.equal(translator(catalog)('history.rejected', { note: text.note }), small(part(zone, 'plan-history-2')));
  });
}

test('the zh-TW session submits the mockup\'s Chinese, not its English', () => {
  const zh = sessionText('zh-TW', MOCKUP);
  assert.equal(zh.titles.plan, '提升副歌');
  assert.equal(zh.titles.applied, '收緊低頻');
  assert.equal(zh.titles.rejected, '疊加主唱');
  assert.equal(zh.titles.stale, '修剪鼓組的空白');
  assert.equal(zh.note, '主歌聽起來太寬，維持單聲道。');
  assert.notEqual(zh.intent, EN_TEXT.intent);
  assert.deepEqual(sessionText('en', MOCKUP), EN_TEXT);
});
