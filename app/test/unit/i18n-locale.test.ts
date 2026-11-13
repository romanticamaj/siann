// Locale detection and the locale store (m5-ui-i18n; UI redesign spec 6.1):
// system language tags map to en, zh-Hant or zh-Hans, <html lang> is zh-TW or
// zh-CN for the Chinese locales, and a stored manual choice (siann.locale)
// overrides detection and survives a new store over the same storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLocaleStore, htmlLang, localeForTags, LOCALE_STORAGE_KEY, type LocaleStorage } from '../../src/renderer/i18n/locale';

// The table of 6.1: the first tag decides.
const TABLE: ReadonlyArray<readonly [readonly string[], string]> = [
  [['zh-TW'], 'zh-Hant'],
  [['zh-HK'], 'zh-Hant'],
  [['zh-MO'], 'zh-Hant'],
  [['zh-Hant'], 'zh-Hant'],
  [['zh-Hant-TW'], 'zh-Hant'],
  [['zh-Hant-CN'], 'zh-Hant'],
  [['zh-CN'], 'zh-Hans'],
  [['zh-SG'], 'zh-Hans'],
  [['zh-Hans'], 'zh-Hans'],
  [['zh-Hans-TW'], 'zh-Hans'],
  [['zh'], 'zh-Hans'],
  [['en-US'], 'en'],
  [['ja'], 'en'],
  [['fr'], 'en'],
  [[], 'en'],
  [['en-US', 'zh-TW'], 'en'],
  [['zh-TW', 'en-US'], 'zh-Hant'],
  // Case-insensitive.
  [['ZH-tw'], 'zh-Hant'],
  [['zh-hant-hk'], 'zh-Hant'],
  [['ZH-HANS'], 'zh-Hans'],
  [['zh-cn'], 'zh-Hans'],
  [['ZH'], 'zh-Hans'],
];

test('system language tags map to en, zh-Hant or zh-Hans (the first tag decides)', () => {
  for (const [tags, expected] of TABLE) assert.equal(localeForTags(tags), expected, JSON.stringify(tags));
});

test('<html lang> is en, zh-TW or zh-CN', () => {
  assert.equal(htmlLang('en'), 'en');
  assert.equal(htmlLang('zh-Hant'), 'zh-TW');
  assert.equal(htmlLang('zh-Hans'), 'zh-CN');
});

function memoryStorage(initial: Record<string, string> = {}): LocaleStorage & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

test('without a stored choice the store follows detection', () => {
  const store = createLocaleStore({ languages: ['zh-TW'], storage: memoryStorage() });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  assert.equal(createLocaleStore({ languages: ['de-DE'], storage: memoryStorage() }).getSnapshot(), 'en');
});

test('a stored siann.locale wins over detection', () => {
  const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'zh-Hans' });
  assert.equal(LOCALE_STORAGE_KEY, 'siann.locale');
  assert.equal(createLocaleStore({ languages: ['zh-TW'], storage }).getSnapshot(), 'zh-Hans');
  assert.equal(createLocaleStore({ languages: ['en-US'], storage: memoryStorage({ [LOCALE_STORAGE_KEY]: 'en' }) }).getSnapshot(), 'en');
});

test('an invalid stored value is ignored', () => {
  for (const bad of ['', 'fr', 'zh', 'EN', 'pseudo']) {
    const store = createLocaleStore({ languages: ['zh-CN'], storage: memoryStorage({ [LOCALE_STORAGE_KEY]: bad }) });
    assert.equal(store.getSnapshot(), 'zh-Hans', bad);
  }
});

test('setLocale notifies subscribers, persists, and a new store over the storage keeps it', () => {
  const storage = memoryStorage();
  const store = createLocaleStore({ languages: ['zh-TW'], storage });
  const seen: string[] = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));
  store.setLocale('zh-Hans');
  store.setLocale('zh-Hans');
  store.setLocale('en');
  assert.deepEqual(seen, ['zh-Hans', 'en']);
  assert.equal(storage.data.get(LOCALE_STORAGE_KEY), 'en');
  unsubscribe();
  store.setLocale('zh-Hant');
  assert.deepEqual(seen, ['zh-Hans', 'en']);
  assert.equal(createLocaleStore({ languages: ['zh-TW'], storage }).getSnapshot(), 'zh-Hant');
});

test('storage that throws is survived: detection only, the switch still works', () => {
  const throwing: LocaleStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const store = createLocaleStore({ languages: ['zh-HK'], storage: throwing });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  store.setLocale('en');
  assert.equal(store.getSnapshot(), 'en');
  assert.equal(createLocaleStore({ languages: ['zh-HK'], storage: null }).getSnapshot(), 'zh-Hant');
});

test('the pseudo-locale is accepted only when the store allows it (test hooks)', () => {
  const storage = memoryStorage();
  const plain = createLocaleStore({ languages: ['en-US'], storage });
  assert.throws(() => plain.setLocale('pseudo'));
  assert.equal(plain.getSnapshot(), 'en');
  const hooked = createLocaleStore({ languages: ['en-US'], storage, allowPseudo: true });
  hooked.setLocale('pseudo');
  assert.equal(hooked.getSnapshot(), 'pseudo');
  assert.equal(htmlLang('pseudo'), 'en');
  // A stored pseudo choice is honoured under the hooks only.
  assert.equal(createLocaleStore({ languages: ['en-US'], storage, allowPseudo: true }).getSnapshot(), 'pseudo');
  assert.equal(createLocaleStore({ languages: ['en-US'], storage }).getSnapshot(), 'en');
});
