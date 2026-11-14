// Catalog-built wording per locale (m5-ui-i18n, m5-ui-plan-panel; UI redesign
// spec 6.2 and P1-5): plan step descriptions for every op of the engine's
// command set, engine error codes, toast messages, plurals and relative times.
// Steps name tracks by their names, clips by their track and position (seconds
// from the frame string and the root's sample rate), plugins by their names,
// and never by an id; a track or clip made by an earlier step of the same plan
// is named from that step. dB and pan go through format.ts and are
// byte-identical across locales; text an agent wrote is passed through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMilliDb, formatPan } from '../../src/renderer/format';
import { errorText, KNOWN_ERROR_CODES, refusalLine } from '../../src/renderer/i18n/errors';
import { LOCALES, type Locale } from '../../src/renderer/i18n/locale';
import { planArrivedMessage, reconnectedMessage } from '../../src/renderer/i18n/messages';
import { plural, relativeTime, translator } from '../../src/renderer/i18n/t';
import { describePlan, describeStep, type StepNames } from '../../src/renderer/plans/describe';

const NAMES: StepNames = {
  track: (id) => ({ trk_a: 'Lead', trk_v: 'Vox BG 主唱', trk_k: 'Keys' } as Record<string, string>)[id],
  clip: (id) => ({ clp_1: { trackId: 'trk_k', position: '72000' } } as Record<string, { trackId: string; position: string }>)[id],
  slot: (id) => ({ slt_1: { trackId: 'trk_k', name: 'Pro-Q 3' } } as Record<string, { trackId: string; name: string }>)[id],
  sampleRate: 48000,
};

const STEPS = {
  add: { op: 'track.add', trackId: 'trk_b', name: 'Bass', channels: 2 },
  remove: { op: 'track.remove', trackId: 'trk_a' },
  removeUnknown: { op: 'track.remove', trackId: 'trk_x' },
  rename: { op: 'track.rename', trackId: 'trk_a', name: 'FX Riser' },
  gain: { op: 'track.set_gain', trackId: 'trk_v', gainMilliDb: -6000 },
  gainUnknown: { op: 'track.set_gain', trackId: 'trk_x', gainMilliDb: -600 },
  pan: { op: 'track.set_pan', trackId: 'trk_a', pan: -2500 },
  panCentre: { op: 'track.set_pan', trackId: 'trk_a', pan: 0 },
  panRight: { op: 'track.set_pan', trackId: 'trk_a', pan: 4000 },
  mute: { op: 'track.set_mute', trackId: 'trk_a', mute: true },
  unmute: { op: 'track.set_mute', trackId: 'trk_a', mute: false },
  solo: { op: 'track.set_solo', trackId: 'trk_a', solo: true },
  unsolo: { op: 'track.set_solo', trackId: 'trk_a', solo: false },
  explode: { op: 'track.explode', trackId: 'trk_k' },
  place: {
    op: 'clip.place',
    clipId: 'clp_new',
    trackId: 'trk_k',
    mediaId: 'med_1',
    position: { domain: 'audio', value: '96000' },
    sourceStart: '0',
    length: '48000',
  },
  move: { op: 'clip.move', clipId: 'clp_1', position: { domain: 'audio', value: '12000' } },
  moveTrack: { op: 'clip.move', clipId: 'clp_1', trackId: 'trk_a', position: { domain: 'audio', value: '24000' } },
  trim: { op: 'clip.trim', clipId: 'clp_1', sourceStart: '0', length: '120000' },
  clipRemove: { op: 'clip.remove', clipId: 'clp_1' },
  clipRemoveUnknown: { op: 'clip.remove', clipId: 'clp_9' },
  clipGain: { op: 'clip.set_gain', clipId: 'clp_1', gainMilliDb: -3000 },
  mediaAdd: { op: 'media.add', mediaId: 'med_2', contentHash: 'sha256:' + 'a'.repeat(64), format: 'wav', channels: 2, sampleRate: 48000, frames: '480000' },
  mediaRemove: { op: 'media.remove', mediaId: 'med_1' },
  mediaRename: { op: 'media.rename', mediaId: 'med_1', name: 'Kick Loop.wav' },
  mediaUnname: { op: 'media.rename', mediaId: 'med_1', name: null },
  insert: {
    op: 'plugin.insert',
    trackId: 'trk_k',
    index: 0,
    slotId: 'slt_new',
    descriptor: { format: 'clap', uid: 'com.example.eq', name: 'Fine EQ' },
    stateBlob: null,
  },
  pluginRemove: { op: 'plugin.remove', slotId: 'slt_1' },
  bypass: { op: 'plugin.set_bypass', slotId: 'slt_1', bypass: true },
  unbypass: { op: 'plugin.set_bypass', slotId: 'slt_1', bypass: false },
  sessionRename: { op: 'session.rename', name: 'Night Drive' },
  tempo: { op: 'session.set_tempo', tempo: [{ ticks: '0', milliBpm: 128000 }] },
  tempoMap: { op: 'session.set_tempo', tempo: [{ ticks: '0', milliBpm: 120000 }, { ticks: '7680', milliBpm: 96500 }] },
  unknown: { op: 'track.set_colour', trackId: 'trk_a', colour: '#ff0000' },
} as const satisfies Record<string, Record<string, unknown>>;

type StepName = keyof typeof STEPS;

const describe = (locale: Locale, step: StepName) => describeStep(STEPS[step], translator(locale), NAMES);

test('English wording for every op the engine accepts, and a generic line for an unknown one', () => {
  const expected: Record<StepName, string> = {
    add: 'Add track Bass',
    remove: 'Remove Lead',
    removeUnknown: 'Remove a track',
    rename: 'Rename Lead to FX Riser',
    gain: `Set Vox BG 主唱 volume to ${formatMilliDb(-6000)}`,
    gainUnknown: `Set a track volume to ${formatMilliDb(-600)}`,
    pan: 'Pan Lead to L25',
    panCentre: 'Pan Lead to C',
    panRight: 'Pan Lead to R40',
    mute: 'Mute Lead',
    unmute: 'Unmute Lead',
    solo: 'Solo Lead',
    unsolo: 'Unsolo Lead',
    explode: 'Split Keys into one track per channel',
    place: 'Place a clip on Keys at 2 s',
    move: 'Move a clip on Keys to 0.25 s',
    moveTrack: 'Move a clip on Keys to Lead at 0.5 s',
    trim: 'Trim a clip on Keys to 2.5 s',
    clipRemove: 'Remove a clip on Keys at 1.5 s',
    clipRemoveUnknown: 'Remove a clip',
    clipGain: `Set the volume of a clip on Keys to ${formatMilliDb(-3000)}`,
    mediaAdd: 'Add an audio file to the pool',
    mediaRemove: 'Remove an audio file from the pool',
    mediaRename: 'Rename an audio file in the pool to Kick Loop.wav',
    mediaUnname: 'Clear the name of an audio file in the pool',
    insert: 'Insert Fine EQ on Keys',
    pluginRemove: 'Remove Pro-Q 3 on Keys',
    bypass: 'Bypass Pro-Q 3 on Keys',
    unbypass: 'Turn Pro-Q 3 on Keys back on',
    sessionRename: 'Rename the session to Night Drive',
    tempo: 'Set the tempo to 128 BPM',
    tempoMap: 'Set a tempo map with 2 changes',
    unknown: 'Change (details below)',
  };
  for (const [step, text] of Object.entries(expected)) assert.equal(describe('en', step as StepName), text, step);
});

test('a track, clip or plugin made by an earlier step of the plan is named from that step', () => {
  const t = translator('en');
  const plan = [
    { op: 'track.add', trackId: 'trk_pad', name: 'Pad', channels: 2 },
    { op: 'track.set_gain', trackId: 'trk_pad', gainMilliDb: -9000 },
    { op: 'clip.place', clipId: 'clp_p', trackId: 'trk_pad', mediaId: 'med_1', position: { domain: 'audio', value: '0' }, sourceStart: '0', length: '48000' },
    { op: 'clip.move', clipId: 'clp_p', position: { domain: 'audio', value: '48000' } },
    { op: 'plugin.insert', trackId: 'trk_pad', index: 0, slotId: 'slt_p', descriptor: { format: 'clap', uid: 'u', name: 'Verb' }, stateBlob: null },
    { op: 'plugin.set_bypass', slotId: 'slt_p', bypass: true },
  ];
  assert.deepEqual(describePlan(plan, t, NAMES), [
    'Add track Pad',
    `Set Pad volume to ${formatMilliDb(-9000)}`,
    'Place a clip on Pad at 0 s',
    'Move a clip on Pad to 1 s',
    'Insert Verb on Pad',
    'Bypass Verb on Pad',
  ]);
  // Without a sample rate a position is not invented.
  const noRate: StepNames = { ...NAMES, sampleRate: undefined };
  assert.equal(describeStep(STEPS.move, t, noRate), 'Move a clip on Keys to a new position');
});

test('no step description shows an entity id, a raw pan value or a milli-dB integer', () => {
  const ids = ['trk_a', 'trk_b', 'trk_v', 'trk_k', 'trk_x', 'trk_pad', 'clp_1', 'clp_9', 'clp_new', 'med_1', 'med_2', 'slt_1', 'slt_new', 'com.example.eq'];
  for (const locale of LOCALES) {
    for (const step of Object.keys(STEPS) as StepName[]) {
      const text = describe(locale, step);
      for (const id of ids) assert.ok(!text.includes(id), `${locale} ${step}: ${text} shows ${id}`);
      // No integer of four or more digits (milli-dB, pan units, frames, milliBpm).
      assert.ok(!/\d{4,}/.test(text), `${locale} ${step}: ${text}`);
      assert.ok(!text.includes('{'), `${locale} ${step}: ${text} (raw JSON or a placeholder)`);
    }
  }
});

test('Chinese step descriptions use the glossary terms', () => {
  const terms: Record<'zh-Hant' | 'zh-Hans', Partial<Record<StepName, string>>> = {
    'zh-Hant': { add: '音軌', removeUnknown: '音軌', gain: '音量', pan: '聲相', mute: '靜音', unmute: '靜音', solo: '獨奏', unsolo: '獨奏', move: '片段', clipRemove: '片段', insert: '外掛', tempo: '速度' },
    'zh-Hans': { add: '音轨', removeUnknown: '音轨', gain: '音量', pan: '声像', mute: '静音', unmute: '静音', solo: '独奏', unsolo: '独奏', move: '片段', clipRemove: '片段', insert: '插件', tempo: '速度' },
  };
  for (const [locale, table] of Object.entries(terms) as Array<['zh-Hant' | 'zh-Hans', Record<string, string>]>) {
    for (const [step, term] of Object.entries(table)) {
      const text = describe(locale, step as StepName);
      assert.ok(text.includes(term), `${locale} ${step}: ${text} lacks ${term}`);
      assert.notEqual(text, describe('en', step as StepName), `${locale} ${step}`);
    }
    for (const step of Object.keys(STEPS) as StepName[]) {
      const text = describe(locale, step);
      assert.ok(/\p{Script=Han}/u.test(text), `${locale} ${step}: ${text}`);
    }
  }
});

test('dB, pan values, seconds and agent-written names are byte-identical across locales', () => {
  for (const locale of LOCALES) {
    assert.ok(describe(locale, 'gain').includes(formatMilliDb(-6000)), locale);
    assert.ok(describe(locale, 'gain').includes('Vox BG 主唱'), locale);
    assert.ok(describe(locale, 'pan').includes(formatPan(-2500)), locale);
    assert.ok(describe(locale, 'panRight').includes('R40'), locale);
    assert.ok(describe(locale, 'move').includes('0.25'), locale);
    assert.ok(describe(locale, 'rename').includes('FX Riser'), locale);
    assert.ok(describe(locale, 'add').includes('Bass'), locale);
    assert.ok(describe(locale, 'insert').includes('Fine EQ'), locale);
    assert.ok(describe(locale, 'mediaRename').includes('Kick Loop.wav'), locale);
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

// UI redesign 6.2: the refusal line keeps the protocol code in front in every
// locale; a refusal without a code is the message alone.
test('the refusal line is "<code>: <text>" in every locale', () => {
  const engine = 'Entities changed: track:trk_v';
  for (const locale of LOCALES) {
    assert.equal(refusalLine('plan_stale', engine, locale), `plan_stale: ${errorText('plan_stale', engine, locale)}`, locale);
    assert.equal(refusalLine('plan_stale', engine, locale, ' (trk_v)'), `plan_stale: ${errorText('plan_stale', engine, locale)} (trk_v)`, locale);
    assert.equal(refusalLine('brand_new_code', 'boom', locale), 'brand_new_code: boom', locale);
    assert.equal(refusalLine(null, 'socket closed', locale), 'socket closed', locale);
  }
  assert.equal(refusalLine('plan_stale', engine, 'en'), `plan_stale: ${engine}`);
  assert.equal(refusalLine('plan_stale', engine, 'zh-Hant'), `plan_stale: ${translator('zh-Hant')('error.plan_stale')}`);
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
