// Catalog-built wording per locale (m5-ui-i18n, m5-ui-plan-panel; UI redesign
// spec 6.2 and P1-5): plan step descriptions for every op of the engine's
// command set, engine error codes, toast messages, plurals and relative times.
// Steps name tracks by their names, clips by their track and position (in the
// position display's primary format, Bars+Beats by default, from the frame
// string, the root's tempo map and sample rate), plugins by their names,
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
import { isolateName as n } from '../../src/renderer/plans/isolate';

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
  inputMono: { op: 'track.set_input', trackId: 'trk_a', input: { port: 3, channels: 1 } },
  inputStereo: { op: 'track.set_input', trackId: 'trk_a', input: { port: 2, channels: 2 } },
  inputClear: { op: 'track.set_input', trackId: 'trk_a', input: null },
  monitorOff: { op: 'track.set_monitor', trackId: 'trk_a', monitor: 'off' },
  monitorAuto: { op: 'track.set_monitor', trackId: 'trk_a', monitor: 'auto' },
  monitorInput: { op: 'track.set_monitor', trackId: 'trk_a', monitor: 'input' },
  notes: { op: 'track.set_notes', trackId: 'trk_v', notes: 'Double the chorus 1234\nkeep trk_a breaths' },
  notesClear: { op: 'track.set_notes', trackId: 'trk_v', notes: '' },
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
  // m5b-ui-fades: lengths in ms at the root's rate (48 kHz: 480 frames are 10 ms).
  fadeIn: { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '480', curve: 'linear' } },
  fadeOut: { op: 'clip.set_fade', clipId: 'clp_1', fadeOut: { length: '8640', curve: 'equal_power' } },
  fades: { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '576', curve: 'linear' }, fadeOut: { length: '8640', curve: 'linear' } },
  fadeInRemove: { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '0', curve: 'linear' } },
  fadeOutRemove: { op: 'clip.set_fade', clipId: 'clp_1', fadeOut: { length: '0', curve: 'equal_power' } },
  fadesRemove: { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '0', curve: 'linear' }, fadeOut: { length: '0', curve: 'linear' } },
  fadeInRemoveOut: { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '480', curve: 'linear' }, fadeOut: { length: '0', curve: 'linear' } },
  fadeOutRemoveIn: { op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '0', curve: 'linear' }, fadeOut: { length: '960', curve: 'linear' } },
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
    add: `Add track ${n('Bass')}`,
    remove: `Remove ${n('Lead')}`,
    removeUnknown: 'Remove a track',
    rename: `Rename ${n('Lead')} to ${n('FX Riser')}`,
    gain: `Set ${n('Vox BG 主唱')} volume to ${formatMilliDb(-6000)}`,
    gainUnknown: `Set a track volume to ${formatMilliDb(-600)}`,
    pan: `Pan ${n('Lead')} to L25`,
    panCentre: `Pan ${n('Lead')} to C`,
    panRight: `Pan ${n('Lead')} to R40`,
    mute: `Mute ${n('Lead')}`,
    unmute: `Unmute ${n('Lead')}`,
    solo: `Solo ${n('Lead')}`,
    unsolo: `Unsolo ${n('Lead')}`,
    inputMono: `Record ${n('Lead')} from input 4`,
    inputStereo: `Record ${n('Lead')} from inputs 3-4`,
    inputClear: `Clear the input of ${n('Lead')}`,
    monitorOff: `Turn monitoring off on ${n('Lead')}`,
    monitorAuto: `Set ${n('Lead')} to auto monitoring`,
    monitorInput: `Monitor the input of ${n('Lead')}`,
    notes: `Edit the notes of ${n('Vox BG 主唱')}`,
    notesClear: `Clear the notes of ${n('Vox BG 主唱')}`,
    explode: `Split ${n('Keys')} into one track per channel`,
    place: `Place a clip on ${n('Keys')} at 2.1.000`,
    move: `Move a clip on ${n('Keys')} to 1.1.960`,
    moveTrack: `Move a clip on ${n('Keys')} to ${n('Lead')} at 1.2.000`,
    trim: `Trim a clip on ${n('Keys')} to 2.5 s`,
    clipRemove: `Remove a clip on ${n('Keys')} at 1.4.000`,
    clipRemoveUnknown: 'Remove a clip',
    clipGain: `Set the volume of a clip on ${n('Keys')} to ${formatMilliDb(-3000)}`,
    fadeIn: `Set the fade in of a clip on ${n('Keys')} to 10 ms`,
    fadeOut: `Set the fade out of a clip on ${n('Keys')} to 180 ms`,
    fades: `Set the fades of a clip on ${n('Keys')} to 12 ms in and 180 ms out`,
    fadeInRemove: `Remove the fade in of a clip on ${n('Keys')}`,
    fadeOutRemove: `Remove the fade out of a clip on ${n('Keys')}`,
    fadesRemove: `Remove the fades of a clip on ${n('Keys')}`,
    fadeInRemoveOut: `Set the fade in of a clip on ${n('Keys')} to 10 ms and remove its fade out`,
    fadeOutRemoveIn: `Remove the fade in of a clip on ${n('Keys')} and set its fade out to 20 ms`,
    mediaAdd: 'Add an audio file to the pool',
    mediaRemove: 'Remove an audio file from the pool',
    mediaRename: `Rename an audio file in the pool to ${n('Kick Loop.wav')}`,
    mediaUnname: 'Clear the name of an audio file in the pool',
    insert: `Insert ${n('Fine EQ')} on ${n('Keys')}`,
    pluginRemove: `Remove ${n('Pro-Q 3')} on ${n('Keys')}`,
    bypass: `Bypass ${n('Pro-Q 3')} on ${n('Keys')}`,
    unbypass: `Turn ${n('Pro-Q 3')} on ${n('Keys')} back on`,
    sessionRename: `Rename the session to ${n('Night Drive')}`,
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
    `Add track ${n('Pad')}`,
    `Set ${n('Pad')} volume to ${formatMilliDb(-9000)}`,
    `Place a clip on ${n('Pad')} at 1.1.000`,
    `Move a clip on ${n('Pad')} to 1.3.000`,
    `Insert ${n('Verb')} on ${n('Pad')}`,
    `Bypass ${n('Verb')} on ${n('Pad')}`,
  ]);
  // Without a sample rate a position is not invented.
  const noRate: StepNames = { ...NAMES, sampleRate: undefined };
  assert.equal(describeStep(STEPS.move, t, noRate), `Move a clip on ${n('Keys')} to a new position`);
});

// UI redesign spec 7, P1-5: positions in plan wording follow the position
// display's primary format (m5-ui-transport): Bars+Beats through root.tempo,
// or Seconds as the display shows them. Lengths stay in seconds.
test('positions follow the primary display format and the tempo map', () => {
  const t = translator('en');
  const seconds: StepNames = { ...NAMES, timeFormat: 'seconds' };
  assert.equal(describeStep(STEPS.place, t, seconds), `Place a clip on ${n('Keys')} at 00:00:02.000`);
  assert.equal(describeStep(STEPS.move, t, seconds), `Move a clip on ${n('Keys')} to 00:00:00.250`);
  assert.equal(describeStep(STEPS.clipRemove, t, seconds), `Remove a clip on ${n('Keys')} at 00:00:01.500`);
  assert.equal(describeStep(STEPS.trim, t, seconds), `Trim a clip on ${n('Keys')} to 2.5 s`);
  // At 60 BPM a quarter is a second: 2 s is beat 3 of bar 1.
  const slow: StepNames = { ...NAMES, tempo: [{ ticks: '0', milliBpm: 60_000 }] };
  assert.equal(describeStep(STEPS.place, t, slow), `Place a clip on ${n('Keys')} at 1.3.000`);
  assert.equal(describeStep(STEPS.place, t, { ...slow, timeFormat: 'bars' }), `Place a clip on ${n('Keys')} at 1.3.000`);
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
    'zh-Hant': { add: '音軌', removeUnknown: '音軌', gain: '音量', pan: '聲相', mute: '靜音', unmute: '靜音', solo: '獨奏', unsolo: '獨奏', move: '片段', clipRemove: '片段', insert: '外掛', tempo: '速度', inputMono: '輸入', inputClear: '輸入', monitorOff: '監聽', monitorAuto: '監聽', monitorInput: '監聽', notes: '記事本', notesClear: '記事本', fadeIn: '淡入', fadeOut: '淡出', fades: '淡出', fadeInRemove: '淡入', fadesRemove: '淡入', fadeOutRemoveIn: '淡出' },
    'zh-Hans': { add: '音轨', removeUnknown: '音轨', gain: '音量', pan: '声像', mute: '静音', unmute: '静音', solo: '独奏', unsolo: '独奏', move: '片段', clipRemove: '片段', insert: '插件', tempo: '速度', inputMono: '输入', inputClear: '输入', monitorOff: '监听', monitorAuto: '监听', monitorInput: '监听', notes: '记事本', notesClear: '记事本', fadeIn: '淡入', fadeOut: '淡出', fades: '淡出', fadeInRemove: '淡入', fadesRemove: '淡入', fadeOutRemoveIn: '淡出' },
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

test('dB, pan values, positions and agent-written names are byte-identical across locales', () => {
  for (const locale of LOCALES) {
    assert.ok(describe(locale, 'gain').includes(formatMilliDb(-6000)), locale);
    assert.ok(describe(locale, 'gain').includes('Vox BG 主唱'), locale);
    assert.ok(describe(locale, 'pan').includes(formatPan(-2500)), locale);
    assert.ok(describe(locale, 'panRight').includes('R40'), locale);
    assert.ok(describe(locale, 'move').includes('1.1.960'), locale);
    assert.ok(describe(locale, 'rename').includes('FX Riser'), locale);
    assert.ok(describe(locale, 'add').includes('Bass'), locale);
    assert.ok(describe(locale, 'insert').includes('Fine EQ'), locale);
    assert.ok(describe(locale, 'mediaRename').includes('Kick Loop.wav'), locale);
    assert.ok(describe(locale, 'notes').includes('Vox BG 主唱'), locale);
    // m5b-ui-fades: the fade lengths read "<n> ms" in every locale.
    assert.ok(describe(locale, 'fadeIn').includes('10 ms'), locale);
    assert.ok(describe(locale, 'fades').includes('12 ms') && describe(locale, 'fades').includes('180 ms'), locale);
  }
});

// m5b-ui-fades (10.11, 23): a clip.set_fade step names its clip and its
// lengths; a malformed one (no side, a bad length) is the generic line, and
// without the root's rate the lengths are not guessed.
test('a fade step names the clip and its lengths in ms; a malformed one is the generic line', () => {
  for (const locale of LOCALES) {
    const t = translator(locale);
    const generic = describe(locale, 'unknown');
    assert.equal(describeStep({ op: 'clip.set_fade', clipId: 'clp_1' }, t, NAMES), generic, `${locale}: no side`);
    assert.equal(describeStep({ op: 'clip.set_fade', clipId: 'clp_1', fadeIn: { length: '-1', curve: 'linear' } }, t, NAMES), generic, `${locale}: a bad length`);
    const fadeIn = describe(locale, 'fadeIn');
    assert.ok(fadeIn.includes(n('Keys')), `${locale}: ${fadeIn}`);
    assert.ok(!fadeIn.includes('clp_1') && !fadeIn.includes('480'), `${locale}: ${fadeIn}`);
    const noRate = describeStep(STEPS.fadeIn, t, { ...NAMES, sampleRate: undefined });
    assert.ok(!noRate.includes(' ms'), `${locale}: ${noRate}`);
    assert.notEqual(noRate, generic, locale);
  }
});

// m5b-engine-track-notes: a notes step names the track and never prints the
// notes themselves (free text an agent wrote, shown in the diff, not the sentence).
test('a set-notes and a clear-notes step name the track and never print the notes', () => {
  for (const locale of LOCALES) {
    const set = describe(locale, 'notes');
    const clear = describe(locale, 'notesClear');
    assert.notEqual(set, clear, locale);
    for (const text of [set, clear]) {
      assert.ok(text.includes(n('Vox BG 主唱')), `${locale}: ${text}`);
      assert.ok(!text.includes('chorus') && !text.includes('breaths') && !text.includes('\n'), `${locale}: ${text}`);
    }
    // A malformed step (notes not a string) falls back to the generic line.
    assert.equal(describeStep({ ...STEPS.notes, notes: 42 }, translator(locale), NAMES), describe(locale, 'unknown'), locale);
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
  'invalid_name',
  // The plugin codes an insert slot and the picker show (m5b-ui-inserts-master; protocol-plugins-v0.md).
  'plugin_not_registered',
  'plugin_not_found',
  'plugin_load_failed',
  'plugin_missing',
  'editor_failed',
  'no_plugin_host',
  // The "ask the agent" box's refusals (m5b-ui-composer).
  'agent_busy',
  'agent_not_connected',
  'invalid_request_text',
  // The Notepad's refusal (m5b-ui-notepad; protocol-engine-v0.md track.set_notes).
  'invalid_notes',
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
