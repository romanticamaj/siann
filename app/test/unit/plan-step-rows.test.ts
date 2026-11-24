// A plan's step rows in the mockup's wording (m5-ui-port-plans; mockup.html
// step(); UI redesign 10.7, 3): each step a title (names emphasised as the
// mockup's <b>) and a detail line, the old value struck and the new one
// emphasised (<s>, <em>). Old values are plan.preview's `before` with the
// plan's earlier steps applied; with no preview (an applied, rolled-back or
// refused plan) the line gives the new value only. A step that names a clip
// names it by its track. The dot is the track's colour, the AI colour for a
// track the plan adds. Expectations are the mockup's own strings, read from
// mockup.html (its step() calls and its ZH table).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LOCALES } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { FSI, PDI } from '../../src/renderer/plans/isolate';
import { stepRows, type Segment } from '../../src/renderer/plans/step-rows';
import { trackColourVar } from '../../src/renderer/timeline/track-colour';
import { bus, busSnapshot, send } from './support/buses';
import { track } from './support/timeline';
import { BAR, MOCKUP, MOCKUP_STEPS, mockupPreview, mockupSnapshot, mockupZh, RISER, T } from './support/mockup-plan';

const NAMES = namesFromSnapshot(mockupSnapshot());
const en = translator('en');

// The mockup's form of a line: <b>, <s> and <em> around the emphasised parts.
function html(segments: readonly Segment[]): string {
  const tag = { plain: '', name: 'b', struck: 's', em: 'em' } as const;
  return segments
    .map((s) => {
      const text = s.text.replace(/[⁨⁩]/g, '');
      return tag[s.kind] ? `<${tag[s.kind]}>${text}</${tag[s.kind]}>` : text;
    })
    .join('');
}

// The mockup's six step() calls: [title, detail].
const MOCK_STEPS: ReadonlyArray<readonly [string, string]> = [...MOCKUP.matchAll(/\$\{step\((\d),'([^']*)','([^']*)'/g)].map((m) => [m[2]!, m[3]!] as const);

test('the reader found the mockup\'s six steps', () => {
  assert.equal(MOCK_STEPS.length, 6);
  assert.equal(MOCK_STEPS[0]![0], 'Add track <b>Pad</b>');
});

test("the mockup's six steps in English, with plan.preview", () => {
  const rows = stepRows(MOCKUP_STEPS, mockupPreview(), NAMES, en);
  assert.deepEqual(rows.map((r) => [html(r.title), html(r.detail)]), [
    ['Add track <b>Pad</b>', 'stereo · after FX'],
    ['Place <b>pad_swell.wav</b> on Pad', 'bar 9.1 → 17.1 · pad_swell.wav'],
    ['<b>Vox BG</b> gain', '<s>−9.0 dB</s> → <em>−6.0 dB</em>'],
    ['<b>Keys</b> pan', '<s>L35</s> → <em>L20</em>'],
    ['Unmute <b>FX</b>', '<s>muted</s> → <em>on</em>'],
    ['Move <b>Riser</b> on FX', '<s>bar 6.1</s> → <em>bar 7.1</em> · ends on 9.1'],
  ]);
  // The mockup's own strings, where they can be derived: a step that names a
  // clip names it by its media (m5b-ui-media), so step 6 is the mockup's;
  // step 2's clip is "Pad swell" in the mockup and its media pad_swell.wav.
  for (const index of [0, 2, 3, 4, 5]) assert.equal(html(rows[index]!.title), MOCK_STEPS[index]![0], `title of step ${index + 1}`);
  // Only the two steps that name a clip carry the title part.
  assert.deepEqual(rows.map((r) => r.namesClip === true), [false, true, false, false, false, true]);
  for (const index of [0, 1, 2, 3, 4, 5]) assert.equal(html(rows[index]!.detail), MOCK_STEPS[index]![1], `detail of step ${index + 1}`);
  assert.deepEqual(
    rows.map((r) => r.colour),
    ['--ai', '--ai', trackColourVar(T.bg), trackColourVar(T.keys), trackColourVar(T.fx), trackColourVar(T.fx)],
  );
});

test('names are their own bidi isolates inside the emphasis', () => {
  const rows = stepRows(MOCKUP_STEPS, mockupPreview(), NAMES, en);
  assert.deepEqual(rows[2]!.title[0], { kind: 'name', text: `${FSI}Vox BG${PDI}` });
});

test('zh-Hant equals the mockup\'s ZH entries; zh-Hans is its simplified form', () => {
  const zh = mockupZh();
  const rows = stepRows(MOCKUP_STEPS, mockupPreview(), NAMES, translator('zh-Hant'));
  for (const index of [0, 2, 3, 4, 5]) {
    const want = zh[MOCK_STEPS[index]![0]];
    assert.ok(want, `the ZH table has step ${index + 1}`);
    assert.equal(html(rows[index]!.title), want, `title of step ${index + 1}`);
  }
  assert.equal(html(rows[4]!.detail), zh[MOCK_STEPS[4]![1]]);
  assert.equal(html(rows[0]!.detail), zh[MOCK_STEPS[0]![1]], 'stereo · after FX');
  assert.equal(html(rows[5]!.detail), zh[MOCK_STEPS[5]![1]], 'the move');
  const hans = stepRows(MOCKUP_STEPS, mockupPreview(), NAMES, translator('zh-Hans'));
  assert.equal(html(hans[4]!.title), '取消 <b>FX</b> 静音');
  assert.equal(html(hans[4]!.detail), '<s>静音</s> → <em>开启</em>');
  assert.equal(html(hans[0]!.detail), '立体声 · 排在 FX 之后');
  // Every locale words every step, and never shows an id.
  for (const locale of LOCALES) {
    for (const row of stepRows(MOCKUP_STEPS, mockupPreview(), NAMES, translator(locale))) {
      const line = html(row.title) + html(row.detail);
      assert.ok(line.trim() !== '' && !/trk_|clp_|med_/.test(line), `${locale}: ${line}`);
    }
  }
});

test('with no preview, the new value only', () => {
  const rows = stepRows(MOCKUP_STEPS, null, NAMES, en);
  assert.deepEqual(rows.map((r) => html(r.detail)), [
    'stereo · after FX',
    'bar 9.1 → 17.1 · pad_swell.wav',
    '<em>−6.0 dB</em>',
    '<em>L20</em>',
    '<em>on</em>',
    '<em>bar 7.1</em> · ends on 9.1',
  ]);
});

test('an applied plan whose track the head already holds names the track before it', () => {
  const names = { ...NAMES, trackOrder: [...(NAMES.trackOrder ?? []), T.pad], track: (id: string) => (id === T.pad ? 'Pad' : NAMES.track(id)) };
  const [row] = stepRows(MOCKUP_STEPS.slice(0, 1), null, names, en);
  assert.equal(html(row!.detail), 'stereo · after FX');
});

test('old values carry the earlier steps of the plan: two gain steps on one track', () => {
  const steps = [
    { op: 'track.set_gain', trackId: T.bg, gainMilliDb: -6000 },
    { op: 'track.set_gain', trackId: T.bg, gainMilliDb: -3000 },
    { op: 'clip.move', clipId: RISER, position: { domain: 'audio', value: String(6 * BAR) } },
    { op: 'clip.move', clipId: RISER, position: { domain: 'audio', value: String(7 * BAR) } },
  ];
  assert.deepEqual(stepRows(steps, mockupPreview(), NAMES, en).map((r) => html(r.detail)), [
    '<s>−9.0 dB</s> → <em>−6.0 dB</em>',
    '<s>−6.0 dB</s> → <em>−3.0 dB</em>',
    '<s>bar 6.1</s> → <em>bar 7.1</em> · ends on 9.1',
    '<s>bar 7.1</s> → <em>bar 8.1</em> · ends on 10.1',
  ]);
});

test('every other op has a title and, where it has one, a detail', () => {
  const steps: Record<string, unknown>[] = [
    { op: 'track.remove', trackId: T.bg },
    { op: 'track.rename', trackId: T.fx, name: 'FX Riser' },
    { op: 'track.set_solo', trackId: T.keys, solo: true },
    { op: 'track.set_mute', trackId: T.keys, mute: true },
    { op: 'clip.remove', clipId: RISER },
    { op: 'clip.trim', clipId: RISER, length: String(BAR) },
    { op: 'clip.set_gain', clipId: RISER, gainMilliDb: -3000 },
    { op: 'clip.move', clipId: RISER, trackId: T.keys, position: { domain: 'audio', value: String(6 * BAR) } },
    { op: 'track.add', trackId: 'trk_new', name: 'Mono', channels: 1 },
    { op: 'session.rename', name: 'Night' },
  ];
  const rows = stepRows(steps, mockupPreview(), NAMES, en);
  assert.deepEqual(rows.map((r) => [html(r.title), html(r.detail)]), [
    ['Remove track <b>Vox BG</b>', ''],
    ['<b>FX</b> name', '<s>FX</s> → <em>FX Riser</em>'],
    ['Solo <b>Keys</b>', '<s>off</s> → <em>solo</em>'],
    ['Mute <b>Keys</b>', '<s>on</s> → <em>muted</em>'],
    ['Remove a clip on FX', 'bar 6.1 → 8.1'],
    ['Trim a clip on FX', '<s>4 s</s> → <em>2 s</em>'],
    ['Clip gain on FX', '<s>0.0 dB</s> → <em>−3.0 dB</em>'],
    // The trim two steps before shortened the clip to a bar.
    ['Move <b>Riser</b> to Keys', '<s>bar 6.1</s> → <em>bar 7.1</em> · ends on 8.1'],
    // After the track the plan's first step removed: the last one left.
    ['Add track <b>Mono</b>', 'mono · after FX'],
    ['Rename the session to Night', ''],
  ]);
  assert.equal(rows[9]!.colour, '--tx-4', 'a step on no track');
  assert.equal(rows[8]!.colour, '--ai');
});

test('a step that names a clip whose media has no name, or an unknown clip, keeps the generic title and no title part', () => {
  const steps = [
    { op: 'clip.place', clipId: 'clp_x', trackId: T.fx, mediaId: 'med_unnamed', position: { domain: 'audio', value: '0' }, sourceStart: '0', length: '48000' },
    { op: 'clip.move', clipId: 'clp_unknown', position: { domain: 'audio', value: String(BAR) } },
  ];
  const rows = stepRows(steps, null, NAMES, en);
  assert.deepEqual(rows.map((r) => html(r.title)), ['Place a clip on FX', 'Move a clip on a track']);
  assert.deepEqual(rows.map((r) => r.namesClip === true), [false, false]);
  const zh = stepRows(MOCKUP_STEPS, null, NAMES, translator('zh-Hant'));
  assert.equal(html(zh[1]!.title), '在 Pad 放置 <b>pad_swell.wav</b>');
  assert.equal(html(zh[5]!.title), '移動 FX 上的 <b>Riser</b>');
  const hans = stepRows(MOCKUP_STEPS, null, NAMES, translator('zh-Hans'));
  assert.equal(html(hans[5]!.title), '移动 FX 上的 <b>Riser</b>');
});

// m5b-ui-sends-buses (4.2; 10.11, 25): the bus, send and routing steps get no
// ghost but are read on the plan card: each of the fourteen commands has a
// row in the three catalogs, named from the session (a bus by its name, a
// send by its track and bus) or from an earlier bus.add of the plan, never
// by an id and never the generic line.
test('the fourteen bus, send and routing commands have rows in three locales, named and without ids', () => {
  const snap = busSnapshot(
    [bus('bus_v', 'Verb'), bus('bus_d', 'Delay')],
    [send('snd_1', 'trk_k', 'bus_v')],
    [{ ...track('trk_k'), name: 'Keys', sends: ['snd_1'] }],
  );
  const names = namesFromSnapshot(snap);
  const steps: Record<string, unknown>[] = [
    { op: 'bus.add', busId: 'bus_n', name: 'Hall' },
    { op: 'bus.remove', busId: 'bus_d' },
    { op: 'bus.rename', busId: 'bus_v', name: 'Plate' },
    { op: 'bus.set_gain', busId: 'bus_n', gainMilliDb: -6000 },
    { op: 'bus.set_pan', busId: 'bus_v', pan: 2500 },
    { op: 'bus.set_mute', busId: 'bus_v', mute: true },
    { op: 'bus.set_solo', busId: 'bus_v', solo: true },
    { op: 'bus.set_output', busId: 'bus_v', output: { busId: 'bus_n' } },
    { op: 'send.add', sendId: 'snd_2', trackId: 'trk_k', busId: 'bus_n' },
    { op: 'send.remove', sendId: 'snd_1' },
    { op: 'send.set_level', sendId: 'snd_2', levelMilliDb: -12000 },
    { op: 'send.set_pre', sendId: 'snd_2', pre: true },
    { op: 'send.set_enabled', sendId: 'snd_2', enabled: false },
    { op: 'track.set_output', trackId: 'trk_k', output: null },
  ];
  const en = stepRows(steps, null, names, translator('en')).map((r) => html(r.title));
  assert.deepEqual(en, [
    'Add bus Hall',
    'Remove bus Delay',
    'Rename bus Verb to Plate',
    'Set bus Hall volume to -6.00 dB',
    'Pan bus Verb to R25',
    'Mute bus Verb',
    'Solo bus Verb',
    'Route bus Verb to Hall',
    'Send Keys to Hall',
    'Remove the send from Keys to Verb',
    'Set the send from Keys to Hall to -12.00 dB',
    'Make the send from Keys to Hall pre-fader',
    'Turn off the send from Keys to Hall',
    'Route Keys to the master',
  ]);
  for (const locale of LOCALES) {
    const t = translator(locale);
    const rows = stepRows(steps, null, names, t).map((r) => html(r.title));
    const generic = t('step.unknown');
    for (const [i, row] of rows.entries()) {
      assert.notEqual(row, generic, `${locale} step ${i + 1}`);
      for (const id of ['bus_v', 'bus_d', 'bus_n', 'snd_1', 'snd_2', 'trk_k']) assert.ok(!row.includes(id), `${locale} step ${i + 1}: ${row} shows ${id}`);
      if (locale !== 'en') assert.ok(/\p{Script=Han}/u.test(row), `${locale} step ${i + 1}: ${row}`);
    }
  }
});
