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
    ['Place a clip on Pad', 'bar 9.1 → 17.1 · pad_swell.wav'],
    ['<b>Vox BG</b> gain', '<s>-9.0 dB</s> → <em>-6.0 dB</em>'],
    ['<b>Keys</b> pan', '<s>L35</s> → <em>L20</em>'],
    ['Unmute <b>FX</b>', '<s>muted</s> → <em>on</em>'],
    ['Move a clip on FX', '<s>bar 6.1</s> → <em>bar 7.1</em> · ends on 9.1'],
  ]);
  // The mockup's own strings, where M5 can derive them (the clip titles name
  // the clip by its track: their text is m5b-ui-media's).
  for (const index of [0, 2, 3, 4]) assert.equal(html(rows[index]!.title), MOCK_STEPS[index]![0], `title of step ${index + 1}`);
  for (const index of [0, 1, 3, 4, 5]) assert.equal(html(rows[index]!.detail), MOCK_STEPS[index]![1], `detail of step ${index + 1}`);
  // The mockup writes the minus as U+2212; the app's dB values are the strip's.
  assert.equal(html(rows[2]!.detail), MOCK_STEPS[2]![1].replace(/−/g, '-'));
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
  for (const index of [0, 2, 3, 4]) {
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
    '<em>-6.0 dB</em>',
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
    '<s>-9.0 dB</s> → <em>-6.0 dB</em>',
    '<s>-6.0 dB</s> → <em>-3.0 dB</em>',
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
    ['Clip gain on FX', '<s>0.0 dB</s> → <em>-3.0 dB</em>'],
    // The trim two steps before shortened the clip to a bar.
    ['Move a clip to Keys', '<s>bar 6.1</s> → <em>bar 7.1</em> · ends on 8.1'],
    // After the track the plan's first step removed: the last one left.
    ['Add track <b>Mono</b>', 'mono · after FX'],
    ['Rename the session to Night', ''],
  ]);
  assert.equal(rows[9]!.colour, '--tx-4', 'a step on no track');
  assert.equal(rows[8]!.colour, '--ai');
});
