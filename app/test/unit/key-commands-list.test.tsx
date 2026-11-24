// The Key Commands list (m5b-ui-keymap; UI redesign 3.6; acceptance 6; tour
// state 39): Help > Key Commands opens a modal dialog on the shell's dialog
// rules listing every command of COMMAND_IDS once, by category, with its
// name from the catalogs and its keys from the preset written for the
// platform; a command without a key has an empty key cell. A search field
// narrows the list by a command's name or by a key as it is written. The
// list is read-only: no row is a control, and nothing rebinds a key (the
// key-command editor is phase 3). In English, Traditional and Simplified
// Chinese.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore, translator } from '../../src/renderer/i18n/t';
import { chordsOf, formatChord } from '../../src/renderer/keys/chord-label';
import { KEY_CATEGORIES, categoryOf, commandName, keyCommandGroups } from '../../src/renderer/keys/command-names';
import { COMMAND_IDS } from '../../src/renderer/keys/commands';
import { KeyCommands } from '../../src/renderer/shell/KeyCommands';

// A catalog key this feature adds, read without the typed signature.
const say = (t: unknown, key: string): string => (t as (k: string) => string)(key);

const LOCALES = ['en', 'zh-Hant', 'zh-Hans'] as const;

function withLocale<R>(locale: Locale, fn: () => R): R {
  const before = localeStore();
  installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return fn();
  } finally {
    installLocaleStore(before);
  }
}

test('every command is in exactly one category, the ten in their order', () => {
  assert.deepEqual([...KEY_CATEGORIES], ['transport', 'markers', 'tools', 'edit', 'track', 'zoom', 'navigate', 'zones', 'file', 'plans']);
  for (const id of COMMAND_IDS) assert.ok(KEY_CATEGORIES.includes(categoryOf(id)), id);
  assert.equal(categoryOf('transport.rewind'), 'transport');
  assert.equal(categoryOf('marker.goTo3'), 'markers');
  assert.equal(categoryOf('tool.glue'), 'tools');
  assert.equal(categoryOf('edit.glue'), 'edit');
  assert.equal(categoryOf('track.add'), 'track');
  assert.equal(categoryOf('view.zoomIn'), 'zoom');
  assert.equal(categoryOf('focus.nextZone'), 'navigate');
  assert.equal(categoryOf('zone.left.toggle'), 'zones');
  assert.equal(categoryOf('help.keyCommands'), 'zones');
  assert.equal(categoryOf('project.save'), 'file');
  assert.equal(categoryOf('plans.toggleGhosts'), 'plans');
});

test('every command once, with its name and its keys from the preset, in every locale', () => {
  for (const locale of LOCALES) {
    const t = translator(locale);
    const groups = keyCommandGroups(t, 'other');
    assert.deepEqual(groups.map((g) => g.category), [...KEY_CATEGORIES], locale);
    const rows = groups.flatMap((g) => g.rows);
    assert.deepEqual(rows.map((r) => r.commandId).sort(), [...COMMAND_IDS].sort(), `${locale}: every command once`);
    for (const group of groups) {
      assert.equal(group.label, say(t, `keys.category.${group.category}`), locale);
      for (const row of group.rows) {
        assert.equal(categoryOf(row.commandId), group.category, row.commandId);
        assert.equal(row.name, commandName(t, row.commandId), row.commandId);
        assert.ok(row.name.length > 0 && !row.name.startsWith('command.'), `${locale} ${row.commandId}: ${row.name}`);
        assert.deepEqual(row.keys, chordsOf(row.commandId).map((c) => formatChord(c, 'other')), row.commandId);
      }
    }
    if (locale !== 'en') {
      const english = keyCommandGroups(translator('en'), 'other').flatMap((g) => g.rows);
      for (const [i, row] of rows.entries()) {
        if (!row.commandId.startsWith('project.openRecent.')) assert.ok(/\p{Script=Han}/u.test(row.name), `${locale} ${row.commandId}: ${row.name}`);
        assert.equal(row.commandId, english[i]!.commandId);
      }
    }
  }
  // The keys of a sample, written for each platform; a command without a key has none.
  const row = (id: string, platform: 'mac' | 'other') => keyCommandGroups(translator('en'), platform).flatMap((g) => g.rows).find((r) => r.commandId === id)!;
  assert.deepEqual(row('zone.left.toggle', 'other').keys, ['Ctrl+Alt+L', 'Alt+I']);
  assert.deepEqual(row('zone.left.toggle', 'mac').keys, ['⌥⌘L', '⌥I']);
  assert.deepEqual(row('transport.stop', 'other').keys, ['Num 0', 'Shift+0']);
  assert.deepEqual(row('edit.glue', 'other').keys, []);
  assert.deepEqual(row('help.keyCommands', 'other').keys, []);
});

test('the search narrows the list by name and by key, in the current language', () => {
  const t = translator('en');
  const names = (query: string, platform: 'mac' | 'other' = 'other') => keyCommandGroups(t, platform, query).flatMap((g) => g.rows.map((r) => r.commandId));
  assert.ok(names('glue').includes('edit.glue') && names('glue').includes('tool.glue'));
  assert.ok(!names('glue').includes('transport.stop'));
  assert.ok(names('GLUE').includes('edit.glue'), 'case does not matter');
  // By key: the written form.
  assert.deepEqual(names('Num 0'), ['transport.stop']);
  assert.ok(names('Ctrl+Alt+L').includes('zone.left.toggle'));
  assert.ok(names('⌥⌘L', 'mac').includes('zone.left.toggle'));
  // Empty groups go; nothing found is an empty list.
  assert.deepEqual(keyCommandGroups(t, 'other', 'Num 0').map((g) => g.category), ['transport']);
  assert.deepEqual(keyCommandGroups(t, 'other', 'no such command at all'), []);
  // In Chinese, by the Chinese name.
  const zh = translator('zh-Hant');
  const glue = commandName(zh, 'edit.glue');
  assert.ok(keyCommandGroups(zh, 'other', glue).flatMap((g) => g.rows).some((r) => r.commandId === 'edit.glue'));
});

test('the dialog: a title, a search field, the groups with their rows, read-only, a close button', () => {
  for (const locale of LOCALES) {
    const t = translator(locale);
    const html = withLocale(locale, () => renderToStaticMarkup(<KeyCommands open onClose={() => undefined} platform="other" />));
    assert.match(html, /^<dialog class="key-commands" data-testid="key-commands" aria-labelledby="key-commands-title"/, locale);
    assert.ok(html.includes(`<h2 id="key-commands-title">${say(t, 'keys.title')}</h2>`), locale);
    assert.match(html, /<input type="search"[^>]*data-testid="key-commands-search"/, locale);
    assert.ok(html.includes(`aria-label="${say(t, 'keys.search')}"`), locale);
    for (const category of KEY_CATEGORIES) assert.ok(html.includes(`>${say(t, `keys.category.${category}`)}</h3>`), `${locale} ${category}`);
    // One row per command, its name a row header and its keys kbd elements.
    assert.equal(html.match(/<tr data-command="/g)?.length, COMMAND_IDS.length, locale);
    assert.ok(html.includes(`<tr data-command="transport.stop"><th scope="row">${commandName(t, 'transport.stop')}</th><td class="keys"><kbd>Num 0</kbd><kbd>Shift+0</kbd></td></tr>`), locale);
    assert.ok(html.includes(`<tr data-command="edit.glue"><th scope="row">${commandName(t, 'edit.glue')}</th><td class="keys"></td></tr>`), locale);
    // Read-only: no control inside the list (the search field and Close are outside it).
    const list = /<div class="key-commands-list"[^>]*>([\s\S]*)<\/div><div class="confirm-dialog-buttons">/.exec(html)?.[1] ?? '';
    assert.ok(list.length > 0, locale);
    assert.ok(!/<(button|input|select|textarea)\b|tabindex=|contenteditable/.test(list), `${locale}: nothing in the list takes input`);
    assert.match(html, new RegExp(`<button type="button" data-testid="key-commands-close">${say(t, 'keys.close')}</button>`), locale);
  }
});

test('the dialog with a query shows only what matches, and says so when nothing does', () => {
  const t = translator('en');
  const html = withLocale('en', () => renderToStaticMarkup(<KeyCommands open onClose={() => undefined} platform="other" initialQuery="Num 0" />));
  assert.equal(html.match(/<tr data-command="/g)?.length, 1);
  const none = withLocale('en', () => renderToStaticMarkup(<KeyCommands open onClose={() => undefined} platform="other" initialQuery="zzzz" />));
  assert.ok(none.includes(`data-testid="key-commands-none">${say(t, 'keys.none')}<`), none);
});
