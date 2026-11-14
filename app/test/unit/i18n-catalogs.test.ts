// Catalog completeness (m5-ui-i18n; UI redesign spec 6.3). tsc enforces the
// key set: zh-Hant.ts and zh-Hans.ts declare `const x: Catalog = {...}`, so a
// missing key or an extra key is a compile error (checked by hand when this
// test was written: deleting 'status.engine' from zhHant gives TS2741, adding
// 'status.extra' gives TS2353). This test adds what types cannot see: no empty
// value, every placeholder of the English message kept, no value identical to
// the English one unless allow-listed, no character of the other script, and
// a pseudo-locale that pads English by at least 40 % and keeps placeholders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { en, type Catalog } from '../../src/renderer/i18n/en';
import { pseudoCatalog } from '../../src/renderer/i18n/pseudo';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';

type Key = keyof Catalog;
const KEYS = Object.keys(en) as Key[];

// Values that are the same in every locale on purpose.
// The click level is a number and dB, the same symbol in every locale (spec 6.2).
const SAME_AS_ENGLISH: ReadonlySet<Key> = new Set<Key>(['app.title', 'transport.clickLevelValue']);

// The parameters each function message is called with. Strings are sentinels
// that must come back in every locale; numbers must come back as digits.
const SENTINELS: Partial<Record<Key, Record<string, string | number>>> = {
  'plans.steps': { count: 7 },
  'toast.planArrived': { steps: 7 },
  'confirm.removeTracks': { count: 7 },
};

// Simplified / Traditional pairs (spec 6.3 and the glossary of 6.5).
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['轨', '軌'],
  ['声', '聲'],
  ['发', '發'],
  ['独', '獨'],
  ['静', '靜'],
  ['环', '環'],
  ['设', '設'],
  ['档', '檔'],
  ['录', '錄'],
  ['监', '監'],
  ['检', '檢'],
  ['应', '應'],
];
const SIMPLIFIED_ONLY = PAIRS.map(([s]) => s);
const TRADITIONAL_ONLY = PAIRS.map(([, t]) => t);

const CHINESE: ReadonlyArray<readonly [string, Catalog, readonly string[]]> = [
  ['zh-Hant', zhHant, SIMPLIFIED_ONLY],
  ['zh-Hans', zhHans, TRADITIONAL_ONLY],
];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

// What a message renders as for the checks: the template of a string message,
// the output of a function message called with its sentinels.
function rendered(catalog: Catalog, key: Key): string {
  const message = catalog[key] as unknown;
  if (typeof message === 'string') return message;
  if (typeof message !== 'function') throw new Error(`${key}: neither a string nor a function`);
  const params = SENTINELS[key];
  if (!params) throw new Error(`${key} is a function message: add its parameters to SENTINELS`);
  return (message as (p: Record<string, string | number>) => string)(params);
}

test('every catalog has the English key set at runtime too', () => {
  for (const [name, catalog] of [...CHINESE, ['pseudo', pseudoCatalog(en)] as const]) {
    assert.deepEqual(Object.keys(catalog).sort(), [...KEYS].sort(), name);
  }
});

test('no catalog value is empty', () => {
  for (const [name, catalog] of [['en', en] as const, ...CHINESE]) {
    for (const key of KEYS) assert.notEqual(rendered(catalog, key).trim(), '', `${name} ${key}`);
  }
});

test('every placeholder of the English message is in both Chinese messages', () => {
  for (const key of KEYS) {
    const english = en[key] as unknown;
    for (const [name, catalog] of CHINESE) {
      if (typeof english === 'string') {
        assert.equal(typeof catalog[key], 'string', `${name} ${key}: English is a string`);
        assert.deepEqual(placeholders(catalog[key] as string), placeholders(english), `${name} ${key}`);
      } else {
        const params = SENTINELS[key]!;
        const out = rendered(catalog, key);
        for (const value of Object.values(params)) assert.ok(out.includes(String(value)), `${name} ${key} drops ${value}: ${out}`);
      }
    }
  }
});

test('no Chinese value equals the English one unless allow-listed', () => {
  for (const key of KEYS) {
    for (const [name, catalog] of CHINESE) {
      const same = rendered(catalog, key) === rendered(en, key);
      assert.equal(same, SAME_AS_ENGLISH.has(key), `${name} ${key}: ${same ? 'equals English' : 'allow-listed but differs'}`);
    }
  }
});

test('no catalog uses a character of the other Chinese script', () => {
  for (const [name, catalog, forbidden] of CHINESE) {
    for (const key of KEYS) {
      const text = rendered(catalog, key);
      const found = forbidden.filter((c) => text.includes(c));
      assert.deepEqual(found, [], `${name} ${key}: ${text}`);
    }
  }
});

test('the check itself catches each failure (fixture catalogs)', () => {
  const zhBad: Record<string, unknown> = { ...zhHant, 'status.engine': '', 'strip.gainLabel': '音量', 'diff.entity': en['diff.entity'], 'status.tracks': '音轨' };
  assert.equal(rendered(zhBad as Catalog, 'status.engine').trim(), '');
  assert.notDeepEqual(placeholders(zhBad['strip.gainLabel'] as string), placeholders(en['strip.gainLabel']));
  assert.equal(rendered(zhBad as Catalog, 'diff.entity'), rendered(en, 'diff.entity'));
  assert.ok(SIMPLIFIED_ONLY.some((c) => (zhBad['status.tracks'] as string).includes(c)));
});

test('the pseudo-locale pads every English string by at least 40 % and keeps its placeholders', () => {
  const pseudo = pseudoCatalog(en);
  for (const key of KEYS) {
    const english = rendered(en, key);
    const padded = rendered(pseudo, key);
    assert.ok(padded.length >= Math.ceil(english.length * 1.4), `${key}: ${JSON.stringify(padded)} vs ${JSON.stringify(english)}`);
    assert.deepEqual(placeholders(padded), placeholders(english), key);
    if (typeof en[key] !== 'string') {
      for (const value of Object.values(SENTINELS[key]!)) assert.ok(padded.includes(String(value)), key);
    }
  }
});

test('the locator, cycle and metronome words are in every catalog (m5-ui-loop-click)', () => {
  const keys = [
    'transport.cycle',
    'transport.metronome',
    'transport.click',
    'transport.clickLevel',
    'transport.locators',
    'transport.toLeftLocator',
    'transport.toRightLocator',
    'transport.setLeftLocator',
    'transport.setRightLocator',
    'transport.noDeviceCycle',
    'transport.noDeviceClick',
  ] as const;
  for (const key of keys) {
    for (const [name, catalog] of [['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.equal(typeof catalog[key], 'string', `${name} ${key}`);
      assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
  }
  // The glossary (UI redesign 6.5): cycle, locator, metronome.
  assert.equal(zhHant['transport.cycle'], '循環');
  assert.equal(zhHans['transport.cycle'], '循环');
  assert.equal(zhHant['transport.metronome'], '節拍器');
  assert.equal(zhHans['transport.metronome'], '节拍器');
  assert.match(String(zhHant['transport.toLeftLocator']), /左定位點/);
  assert.match(String(zhHans['transport.toLeftLocator']), /左定位器/);
  // The level reads in dB in every locale.
  for (const catalog of [en, zhHant, zhHans]) assert.equal(catalog['transport.clickLevelValue'], '{db} dB');
});
