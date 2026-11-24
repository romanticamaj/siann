// Catalog completeness (m5-ui-i18n; UI redesign spec 6.3). tsc enforces the
// key set: zh-Hant.ts and zh-Hans.ts declare `const x: Catalog = {...}`, so a
// missing key or an extra key is a compile error (checked by hand when this
// test was written: deleting 'status.engineConnected' from zhHant gives TS2741, adding
// 'status.extra' gives TS2353). This test adds what types cannot see: no empty
// value, every placeholder of the English message kept, no value identical to
// the English one unless allow-listed, no character of the other script, and
// a pseudo-locale that pads English by at least 40 % and keeps placeholders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { en, type Catalog } from '../../src/renderer/i18n/en';
import { pseudoCatalog } from '../../src/renderer/i18n/pseudo';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';

type Key = keyof Catalog;
const KEYS = Object.keys(en) as Key[];

// Values that are the same in every locale on purpose.
// The click level is a number and dB, the same symbol in every locale (spec 6.2).
const SAME_AS_ENGLISH: ReadonlySet<Key> = new Set<Key>([
  'app.title',
  'transport.clickLevelValue',
  // The status bar's units, the mockup's in every locale (m5-ui-alignment-chrome).
  'status.sampleRate',
  'status.latencyValue',
  // The branch chip's "main", the mockup's in every locale (m5b-ui-audition).
  'chip.main',
  // The saved mark, a bullet, and Studio Setup's sample rate in Hz (m5b-ui-project).
  'session.unsavedMark',
  'setup.rateValue',
  // The Media tab's sample rate in kHz (m5b-ui-media).
  'media.rate',
  // The agent's transport is the protocol's name, MCP in every locale (the mockup's).
  'agent.transport.mcp',
  // A history row's "N steps · agent": the mockup's separator in every locale.
  'history.summaryBy',
  // The DSP load's label and the loudness units: the mockup's, in every locale (m5b-ui-meter).
  'topbar.dsp',
  'strip.loudnessShortTerm',
  'meter.lufs',
]);

// The parameters each function message is called with. Strings are sentinels
// that must come back in every locale; numbers must come back as digits.
const SENTINELS: Partial<Record<Key, Record<string, string | number>>> = {
  'plans.steps': { count: 7 },
  'plans.count': { count: 7 },
  'toast.planArrived': { steps: 7 },
  'confirm.removeTracks': { count: 7 },
  'tracklist.count': { tracks: 7, clips: 17 },
  'media.inUse': { count: 7 },
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

// m5b-ui-meter (acceptance 5): the DSP load, the master's loudness row, the
// Meter tab and its panel. The Chinese terms are provisional until the
// zh-glossary-m5b gate; the tab's label is the mockup's (電平表).
test('the DSP load, the loudness row and the Meter tab have their strings in the three catalogs', () => {
  const keys = ['topbar.dsp', 'topbar.dspLoad', 'topbar.dspPeak', 'strip.loudnessShortTerm', 'tab.meter', 'meter.master', 'meter.momentary', 'meter.shortTerm', 'meter.integrated', 'meter.lufs', 'meter.peak', 'meter.reset', 'meter.masterPeak'];
  for (const [name, catalog] of [['en', en] as const, ...CHINESE]) {
    for (const key of keys) assert.ok(key in catalog, `${name} ${key}`);
  }
  assert.equal(en['topbar.dsp'], 'DSP');
  assert.equal(en['strip.loudnessShortTerm'], 'LUFS-S');
  assert.equal(en['tab.meter'], 'Meter');
  assert.equal(zhHant['tab.meter'], '電平表');
  assert.deepEqual(placeholders(en['topbar.dspPeak']), ['percent']);
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
  const zhBad: Record<string, unknown> = { ...zhHant, 'status.engineConnected': '', 'strip.gainLabel': '音量', 'plans.details': en['plans.details'], 'status.tracks': '音轨' };
  assert.equal(rendered(zhBad as Catalog, 'status.engineConnected').trim(), '');
  assert.notDeepEqual(placeholders(zhBad['strip.gainLabel'] as string), placeholders(en['strip.gainLabel']));
  assert.equal(rendered(zhBad as Catalog, 'plans.details'), rendered(en, 'plans.details'));
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

test('the toolbar and info line words are in every catalog, the mockup\'s in en and zh-TW (m5-ui-port-toolbar)', () => {
  const keys = ['snap.typeGrid', 'toolbar.autoScrollTitle', 'info.volume'] as const;
  for (const key of keys) {
    for (const [name, catalog] of [['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.equal(typeof catalog[key], 'string', `${name} ${key}`);
      assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
  }
  // The mockup's L() and its ZH table: Snap, Grid, the grid types, the info line's labels.
  const mockup: Array<[Key, string, string]> = [
    ['snap.toggle', 'Snap', '貼齊'],
    ['snap.typeGrid', 'Grid', '格線'],
    ['grid.adapt', 'Adapt to Zoom', '依縮放調整'],
    ['info.start', 'Start', '起點'],
    ['info.end', 'End', '終點'],
    ['info.length', 'Length', '長度'],
    ['info.offset', 'Offset', '偏移'],
    ['info.volume', 'Volume', '音量'],
  ];
  for (const [key, english, traditional] of mockup) {
    assert.equal(en[key], english, key);
    assert.equal(zhHant[key], traditional, key);
  }
  assert.equal(en['toolbar.autoScrollTitle'], 'Auto-Scroll (F)');
  // The old toolbar's words are gone: no Delete clip button, the gain field is the volume field.
  for (const gone of ['timeline.deleteClip', 'timeline.mediaPool', 'info.gain']) assert.ok(!(gone in en), gone);
});

// m5-ui-port-cleanup (acceptance 2): no catalog string is left that only the
// markup before the port used. Every key of en.ts is named by the renderer: as
// a quoted literal (a t('key') call, or a key table such as GRID_LABELS), or
// through one of the dynamic prefixes below, each of which a renderer source
// builds with a template (`zone.${zone}`).
const DYNAMIC_PREFIXES = ['zone.', 'badge.', 'diff.kind.', 'actionReason.', 'agent.tool.', 'command.'] as const;

test('every key of en.ts is used by the renderer', () => {
  const renderer = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');
  const catalogs = new Set(['en.ts', 'zh-Hant.ts', 'zh-Hans.ts'].map((name) => path.join(renderer, 'i18n', name)));
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) && !catalogs.has(full) ? [full] : [];
    });
  const text = walk(renderer)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  for (const prefix of DYNAMIC_PREFIXES) assert.ok(text.includes(`t(\`${prefix}\${`), `a renderer source builds ${prefix}<name>`);
  const quoted = (key: string) => text.includes(`'${key}'`) || text.includes(`"${key}"`) || text.includes(`\`${key}\``);
  const unused = KEYS.filter((key) => !quoted(key) && !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)));
  assert.ok(KEYS.length > 300, `${KEYS.length} keys`);
  assert.deepEqual(unused, [], 'catalog keys no renderer source names: delete them from every catalog');
});

test("the agent row's words and the titled banner and toast are in every catalog, the mockup's in en and zh-TW (m5b-ui-plan-metadata)", () => {
  const keys = ['agent.connected', 'agent.disconnected', 'agent.idle', 'agent.none', 'agent.tool.other', 'agent.tool.submit_plan', 'banner.hearingTitled', 'toast.planArrivedTitled'] as const;
  for (const key of keys) {
    for (const [name, catalog] of [['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.equal(typeof catalog[key], 'string', `${name} ${key}`);
      assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
  }
  assert.equal(en['agent.transport.mcp'], 'MCP');
  assert.equal(en['agent.none'], 'No agent connected');
  // The mockup's "connected · idle" and its zh-TW words.
  assert.equal(`${en['agent.connected']} · ${en['agent.idle']}`, 'connected · idle');
  assert.equal(`${zhHant['agent.connected']} · ${zhHant['agent.idle']}`, '已連線 · 閒置');
  assert.equal(zhHans['agent.connected'], '已连接');
  assert.equal(en['plans.reason'], 'Reason (sent to agent)');
  for (const catalog of [en, zhHant, zhHans]) {
    assert.deepEqual(placeholders(catalog['banner.hearingTitled'] as string), ['title']);
    assert.deepEqual(placeholders(catalog['toast.planArrivedTitled'] as string), ['title']);
    assert.deepEqual(placeholders(catalog['history.summaryBy'] as string), ['name', 'steps']);
  }
});

test('the words of glue, erase, the snap types, the repeat dialog and the info line\'s editing are in every catalog (m5b-ui-edit-more)', () => {
  const words: Array<[Key, string, string, string]> = [
    ['tool.glue', 'Glue', '黏合', '粘合'],
    ['tool.erase', 'Erase', '擦除', '擦除'],
    ['snap.type', 'Snap type', '貼齊類型', '吸附类型'],
    ['snap.typeGridRelative', 'Grid Relative', '相對格線', '相对网格'],
    ['snap.typeEvents', 'Events', '事件', '事件'],
    ['snap.typeCursor', 'Magnetic Cursor', '磁性游標', '磁性光标'],
    ['repeat.title', 'Repeat', '重複', '重复'],
    ['repeat.confirm', 'Repeat', '重複', '重复'],
  ];
  for (const [key, english, traditional, simplified] of words) {
    assert.equal(en[key], english, key);
    assert.equal(zhHant[key], traditional, key);
    assert.equal(zhHans[key], simplified, key);
  }
  const keys: Key[] = [
    'repeat.count',
    'info.editHint',
    'glue.refused.no_next',
    'glue.refused.gap',
    'glue.refused.other_media',
    'glue.refused.source_not_continuous',
    'glue.refused.other_track',
    'glue.refused.selection',
  ];
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', key);
    for (const [name, catalog] of [['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.equal(typeof catalog[key], 'string', `${name} ${key}`);
      assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
  }
  // The snap field's word for Grid stays the mockup's.
  assert.equal(zhHant['snap.typeGrid'], '格線');
});

// m5b-ui-media: the Media tab replaced the Pool, so the pool.* strings are
// gone and every media.* string is in the three catalogs, translated, with
// the mockup's tab label in en and zh-TW.
test('the Media tab and import words are in every catalog and the Pool\'s are gone (m5b-ui-media)', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('media.')) as Key[];
  for (const key of [
    'media.tab', 'media.search', 'media.import', 'media.remove', 'media.inUse', 'media.empty', 'media.noMatch',
    'media.colName', 'media.colLength', 'media.colChannels', 'media.colRate', 'media.colUses',
    'media.open', 'media.menu', 'media.rename', 'media.importing', 'media.importFailed', 'media.refused',
  ]) assert.ok(keys.includes(key as Key), key);
  // The sample rate's unit reads the same in every locale.
  const same = new Set<string>(['media.rate']);
  for (const key of keys) {
    for (const [name, catalog] of [['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.ok(['string', 'function'].includes(typeof catalog[key]), `${name} ${key}`);
      if (!same.has(key)) assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
  }
  assert.equal(en['media.tab'], 'Media');
  assert.equal(zhHant['media.tab'], '媒體');
  for (const catalog of [en, zhHant, zhHans]) {
    assert.ok(!Object.keys(catalog).some((key) => key.startsWith('pool.')), 'no pool.* key');
    assert.match(String(catalog['media.importFailed']), /\{name\}/);
    assert.match(String(catalog['media.importFailed']), /\{code\}/);
    assert.match(String(catalog['media.refused']), /\{name\}/);
  }
});

// m5b-ui-fades: the info line's two fade labels are the mockup's in en and
// zh-TW (mockup.html: 'Fade In', 'Fade Out', 淡入, 淡出; glossary 6.5 gives
// the same two words in zh-Hans), and a clip.set_fade step has its words in
// the three catalogs, translated, with the clip and the lengths as placeholders.
test('the fade fields and the fade step words are in every catalog, the mockup\'s in en and zh-TW (m5b-ui-fades)', () => {
  const words: Array<[Key, string, string, string]> = [
    ['info.fadeIn', 'Fade In', '淡入', '淡入'],
    ['info.fadeOut', 'Fade Out', '淡出', '淡出'],
  ];
  for (const [key, english, traditional, simplified] of words) {
    assert.equal(en[key], english, key);
    assert.equal(zhHant[key], traditional, key);
    assert.equal(zhHans[key], simplified, key);
  }
  const steps: Array<[Key, string[]]> = [
    ['step.setFadeIn', ['clip', 'length']],
    ['step.setFadeOut', ['clip', 'length']],
    ['step.setFades', ['clip', 'fadeIn', 'fadeOut']],
    ['step.removeFadeIn', ['clip']],
    ['step.removeFadeOut', ['clip']],
    ['step.removeFades', ['clip']],
    ['step.setFadeInRemoveOut', ['clip', 'length']],
    ['step.removeFadeInSetOut', ['clip', 'length']],
  ];
  for (const [key, placeholders] of steps) {
    for (const [name, catalog] of [['en', en], ['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.equal(typeof catalog[key], 'string', `${name} ${key}`);
      for (const p of placeholders) assert.ok(String(catalog[key]).includes(`{${p}}`), `${name} ${key} has {${p}}`);
      if (name !== 'en') assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
  }
});

test("the marker track's words and the marker step words are in every catalog, the mockup's in en and zh-TW (m5b-ui-markers)", () => {
  // The marker head's label: the mockup's L('Markers'), and the glossary's 标记 (UI redesign 6.5).
  assert.equal(en['markers.label'], 'Markers');
  assert.equal(zhHant['markers.label'], '標記');
  assert.equal(zhHans['markers.label'], '标记');
  const keys: Array<[Key, string[]]> = [
    ['markers.rename', ['marker']],
    ['step.addMarker', ['name', 'time']],
    ['step.addMarkerUnnamed', ['time']],
    ['step.addCycleMarker', ['name', 'time', 'end']],
    ['step.addCycleMarkerUnnamed', ['time', 'end']],
    ['step.moveMarker', ['marker', 'time']],
    ['step.resizeMarker', ['marker', 'time', 'end']],
    ['step.renameMarker', ['marker', 'name']],
    ['step.removeMarker', ['marker']],
    ['step.aMarker', []],
    ['step.markerNamed', ['name']],
    ['step.positionMarker', ['number']],
    ['step.positionMarkerNamed', ['number', 'name']],
    ['step.cycleMarker', ['number']],
    ['step.cycleMarkerNamed', ['number', 'name']],
  ];
  for (const [key, placeholders] of keys) {
    for (const [name, catalog] of [['en', en], ['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
      assert.equal(typeof catalog[key], 'string', `${name} ${key}`);
      for (const p of placeholders) assert.ok(String(catalog[key]).includes(`{${p}}`), `${name} ${key} has {${p}}`);
      if (name !== 'en') assert.notEqual(catalog[key], en[key], `${name} ${key} is translated`);
    }
    // Each wording names the marker in the glossary's word, unless its {marker} does.
    if (placeholders.includes('marker')) continue;
    assert.ok(String(zhHant[key]).includes('標記'), `zh-Hant ${key}`);
    assert.ok(String(zhHans[key]).includes('标记'), `zh-Hans ${key}`);
  }
});
