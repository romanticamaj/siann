// Catalog-built wording per locale (m5-ui-i18n; UI redesign spec 6.2): plan
// step descriptions, engine error codes, toast messages, plurals and relative
// times. English keeps today's wording exactly; Chinese uses the glossary of
// 6.5; dB values, pan values and the M/S letters are byte-identical across
// locales, and text an agent wrote (track names) is passed through as is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorText, KNOWN_ERROR_CODES } from '../../src/renderer/i18n/errors';
import { LOCALES, type Locale } from '../../src/renderer/i18n/locale';
import { planArrivedMessage, reconnectedMessage } from '../../src/renderer/i18n/messages';
import { plural, relativeTime, translator } from '../../src/renderer/i18n/t';
import { describeStep } from '../../src/renderer/plans/describe';

const names = (id: string) => ({ trk_a: 'Lead', trk_v: 'Vox BG 主唱' })[id];

const STEPS: Record<string, Record<string, unknown>> = {
  add: { op: 'track.add', trackId: 'trk_b', name: 'Bass', channels: 2 },
  remove: { op: 'track.remove', trackId: 'trk_a' },
  rename: { op: 'track.rename', trackId: 'trk_a', name: 'FX Riser' },
  gain: { op: 'track.set_gain', trackId: 'trk_v', gainMilliDb: -6000 },
  gainUnknown: { op: 'track.set_gain', trackId: 'trk_x', gainMilliDb: -600 },
  pan: { op: 'track.set_pan', trackId: 'trk_a', pan: -2500 },
  mute: { op: 'track.set_mute', trackId: 'trk_a', mute: true },
  unmute: { op: 'track.set_mute', trackId: 'trk_a', mute: false },
  solo: { op: 'track.set_solo', trackId: 'trk_a', solo: true },
  unsolo: { op: 'track.set_solo', trackId: 'trk_a', solo: false },
  other: { op: 'clip.remove', clipId: 'clp_1' },
};

const describe = (locale: Locale, step: keyof typeof STEPS) => describeStep(STEPS[step]!, translator(locale), names);

test('English step descriptions are today\'s wording, unchanged', () => {
  const expected: Record<keyof typeof STEPS, string> = {
    add: 'Add track Bass',
    remove: 'Remove track Lead',
    rename: 'Rename Lead to FX Riser',
    gain: 'Set gain of Vox BG 主唱 to -6.00 dB',
    gainUnknown: 'Set gain of trk_x to -0.60 dB',
    pan: 'Set pan of Lead to -2500',
    mute: 'Mute Lead',
    unmute: 'Unmute Lead',
    solo: 'Solo Lead',
    unsolo: 'Unsolo Lead',
    other: 'clip.remove {"clipId":"clp_1"}',
  };
  for (const [step, text] of Object.entries(expected)) assert.equal(describe('en', step), text, step);
  // Without a name lookup the step names the track by id; track.add by its new name.
  assert.equal(describeStep(STEPS.remove!, translator('en')), 'Remove track trk_a');
  assert.equal(describeStep({ op: 'track.add', trackId: 'trk_n' }, translator('en')), 'Add track trk_n');
});

test('Chinese step descriptions use the glossary terms', () => {
  const terms: Record<'zh-Hant' | 'zh-Hans', Partial<Record<keyof typeof STEPS, string>>> = {
    'zh-Hant': { add: '音軌', remove: '音軌', gain: '音量', pan: '聲相', mute: '靜音', unmute: '靜音', solo: '獨奏', unsolo: '獨奏' },
    'zh-Hans': { add: '音轨', remove: '音轨', gain: '音量', pan: '声像', mute: '静音', unmute: '静音', solo: '独奏', unsolo: '独奏' },
  };
  for (const [locale, table] of Object.entries(terms) as Array<['zh-Hant' | 'zh-Hans', Record<string, string>]>) {
    for (const [step, term] of Object.entries(table)) {
      const text = describe(locale, step);
      assert.ok(text.includes(term), `${locale} ${step}: ${text} lacks ${term}`);
      assert.notEqual(text, describe('en', step), `${locale} ${step}`);
    }
    // A step the catalogs have no wording for is shown as the protocol has it.
    assert.equal(describe(locale, 'other'), 'clip.remove {"clipId":"clp_1"}');
  }
});

test('dB, pan values and agent-written names are byte-identical across locales', () => {
  for (const locale of LOCALES) {
    assert.ok(describe(locale, 'gain').includes('-6.00 dB'), locale);
    assert.ok(describe(locale, 'gain').includes('Vox BG 主唱'), locale);
    assert.ok(describe(locale, 'gainUnknown').includes('-0.60 dB'), locale);
    assert.ok(describe(locale, 'gainUnknown').includes('trk_x'), locale);
    assert.ok(describe(locale, 'pan').includes('-2500'), locale);
    assert.ok(describe(locale, 'rename').includes('FX Riser'), locale);
    assert.ok(describe(locale, 'add').includes('Bass'), locale);
  }
});

// The codes the renderer meets (session-client, timeline, plan review) and the
// rest of docs/schemas/protocol-*.md.
const CODES = [
  'revision_mismatch',
  'plan_stale',
  'invalid_state',
  'already_exists',
  'session_mismatch',
  'disconnected',
  'audition_budget_exceeded',
  'not_found',
  'invalid_params',
  'internal_error',
  'not_supported',
  'nothing_to_undo',
  'nothing_to_redo',
  'session_locked',
  'media_missing',
  'device_open_failed',
  'device_lost',
  'no_device',
  'plugin_not_approved',
  'gesture_open',
  'queue_full',
  'lease_expired',
];

test('engine error codes: catalog text in Chinese, the engine\'s own message in English', () => {
  assert.deepEqual([...KNOWN_ERROR_CODES].sort(), [...CODES].sort());
  const seen = new Map<string, string>();
  for (const code of CODES) {
    const engine = `engine says ${code}`;
    assert.equal(errorText(code, engine, 'en'), engine, code);
    assert.notEqual(errorText(code, '', 'en'), '', `${code}: English text when the engine sent none`);
    for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
      const text = errorText(code, engine, locale);
      assert.notEqual(text, engine, `${locale} ${code}`);
      assert.ok(/\p{Script=Han}/u.test(text), `${locale} ${code}: ${text}`);
      assert.ok(!seen.has(`${locale}${text}`), `${locale} ${code} repeats ${seen.get(`${locale}${text}`)}`);
      seen.set(`${locale}${text}`, code);
    }
  }
  assert.notEqual(errorText('plan_stale', 'x', 'zh-Hant'), errorText('plan_stale', 'x', 'zh-Hans'));
});

test('an unknown error code shows the engine\'s English message in every locale', () => {
  for (const locale of LOCALES) assert.equal(errorText('brand_new_code', 'something went wrong', locale), 'something went wrong', locale);
});

test('toast messages per locale: a plan arrived, reconnected at a revision', () => {
  assert.equal(planArrivedMessage('en', { steps: 1 }), 'A plan with 1 step arrived');
  assert.equal(planArrivedMessage('en', { steps: 5 }), 'A plan with 5 steps arrived');
  assert.equal(reconnectedMessage('en', { revision: 'r12' }), 'Reconnected at r12');
  for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
    const arrived = planArrivedMessage(locale, { steps: 5 });
    assert.ok(arrived.includes('5') && /\p{Script=Han}/u.test(arrived), `${locale}: ${arrived}`);
    const back = reconnectedMessage(locale, { revision: 'r12' });
    assert.ok(back.includes('r12') && /\p{Script=Han}/u.test(back), `${locale}: ${back}`);
  }
  assert.ok(planArrivedMessage('zh-Hant', { steps: 5 }).includes('計畫'));
  assert.ok(planArrivedMessage('zh-Hans', { steps: 5 }).includes('计划'));
});

test('plural goes through Intl.PluralRules', () => {
  const forms = { one: 'one', other: 'other' };
  assert.equal(plural('en', 1, forms), 'one');
  assert.equal(plural('en', 0, forms), 'other');
  assert.equal(plural('en', 2, forms), 'other');
  // Chinese has no plural forms: always other.
  assert.equal(plural('zh-Hant', 1, forms), 'other');
  assert.equal(plural('zh-Hans', 1, forms), 'other');
  const t = translator('en');
  assert.equal(t('plans.steps', { count: 1 }), '1 step');
  assert.equal(t('plans.steps', { count: 3 }), '3 steps');
});

test('relativeTime goes through Intl.RelativeTimeFormat with an injected now', () => {
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  assert.equal(relativeTime(now - 30_000, now, 'en'), '30 seconds ago');
  assert.equal(relativeTime(now - 5 * 60_000, now, 'en'), '5 minutes ago');
  assert.equal(relativeTime(now - 3 * 3_600_000, now, 'en'), '3 hours ago');
  assert.equal(relativeTime(now - 2 * 86_400_000, now, 'en'), '2 days ago');
  assert.equal(relativeTime(now - 86_400_000, now, 'en'), 'yesterday');
  assert.equal(relativeTime(now, now, 'en'), 'now');
  for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
    const tag = locale === 'zh-Hant' ? 'zh-TW' : 'zh-CN';
    const expected = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(-5, 'minute');
    assert.equal(relativeTime(now - 5 * 60_000, now, locale), expected, locale);
    assert.ok(/\p{Script=Han}/u.test(expected), expected);
  }
  assert.notEqual(relativeTime(now - 5 * 60_000, now, 'zh-Hant'), relativeTime(now - 5 * 60_000, now, 'en'));
});
