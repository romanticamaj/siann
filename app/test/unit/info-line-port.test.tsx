// The info line port (m5-ui-port-toolbar; UI redesign 10.9, 10.10 P1-16, 3.0,
// 3.2, 10.8): the info line renders what the mockup's app.innerHTML template
// writes in div.infoline, on the selected clip of the read model. The
// expectations come from the mockup's script (support/mockup.ts) and from
// app/test/fidelity/manifest.json, not from the code under test:
//
// - one span.f per field in the template's order: the name (its track's
//   colour in <i>, the clip's title in <b>), then start, end, length, offset
//   and volume, each its label and b.num;
// - the fade fields are pending (m5b-ui-fades): their boxes stay at the end,
//   empty, so the volume field is not the last child and keeps its hairline;
// - the mockup's selected clip reads 9.1.1.0, 12.4.1.0, 3.3.0.0, 1.0.2.0 and
//   0.00 dB;
// - no clip selected: the line and nothing between its edges; several: the
//   primary one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore } from '../../src/renderer/i18n/t';
import type { ClipEntity, MediaEntity } from '../../src/renderer/model/document';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { InfoLine } from '../../src/renderer/timeline/InfoLine';
import { trackColourVar } from '../../src/renderer/timeline/track-colour';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';
import { clip, media, snapshotOf, track } from './support/timeline';

const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'test', 'fidelity', 'manifest.json'), 'utf8')) as {
  gates: Record<string, string>;
  rules: Array<{ match: string[]; gate: string }>;
};
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const pending = (id: string) => {
  const rule = MANIFEST.rules.find((r) => r.match.some((p) => glob(p).test(id)));
  assert.ok(rule, `no manifest rule owns ${id}`);
  return MANIFEST.gates[rule.gate] === 'pending';
};

// The mockup's selected clip at 120 BPM and 48 kHz (a bar is 96000 frames, a
// sixteenth 6000): bar 9 for three bars and three beats, two sixteenths and a
// bar into its media, at 0 dB.
const chorus = (over: Partial<ClipEntity> = {}): ClipEntity => ({ ...clip('clp_ch', 'trk_v', 'med_ch', '768000', '108000', '360000'), ...over });
const named = (name?: string): MediaEntity => ({ ...media('med_ch', '4800000'), ...(name ? { name } : {}) });

function client(snapshot: Snapshot): SessionClient {
  return { model: { getSnapshot: () => snapshot, subscribe: () => () => undefined } } as unknown as SessionClient;
}

function render(snapshot: Snapshot, clipId: string | null, locale?: Locale): Element {
  const before = localeStore();
  if (locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return find(parse(renderToStaticMarkup(<InfoLine client={client(snapshot)} clipId={clipId} />)), byClass('infoline'));
  } finally {
    installLocaleStore(before);
  }
}

const session = (mediaRow = named('Chorus A · take 3'), clips = [chorus()]) => snapshotOf(['trk_v'], [track('trk_v')], [mediaRow], clips);
const mockupLine = (lang = 'en') => find(parse(loadMockup(lang).projectHead), byClass('infoline'));
const FIELDS = ['info-start', 'info-end', 'info-length', 'info-offset', 'info-volume'];

test('the info line has one span.f per field in the template\'s order, the fades\' boxes empty at the end', () => {
  const app = render(session(), 'clp_ch');
  const mockup = mockupLine();
  assert.equal(sig(app), 'div.infoline');
  assert.equal(app.attrs['data-part'], 'info-line');
  assert.equal(app.attrs['data-testid'], 'info-line');
  assert.equal(app.attrs['data-clip'], 'clp_ch');
  const mine = elements(app);
  const theirs = elements(mockup);
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < theirs.length; i += 1) {
    const id = theirs[i]!.attrs['data-part']!;
    if (pending(id)) {
      assert.match(id, /^info-fade-(in|out)$/);
      const box = mine[i]!;
      assert.deepEqual(box.children, [], `${id}: nothing in it`);
      assert.equal(box.attrs['aria-hidden'], 'true');
      for (const name of ['role', 'tabindex', 'data-part', 'data-testid']) assert.ok(!(name in box.attrs), `${id}: no ${name}`);
      assert.ok(!classes(box).includes('f'), `${id}: not a field`);
    } else {
      assert.equal(sig(mine[i]!), 'span.f', id);
      assert.equal(mine[i]!.attrs['data-part'], id);
    }
  }
  // The volume field is not the last child, so the shared rule keeps its hairline.
  assert.notEqual(mine.at(-1)!.attrs['data-part'], 'info-volume');
});

test('the name: the track\'s colour in <i> and the clip\'s title in <b>', () => {
  const app = render(session(), 'clp_ch');
  const name = find(app, byAttr('data-part', 'info-name'));
  const mName = find(mockupLine(), byAttr('data-part', 'info-name'));
  assert.deepEqual(elements(name).map((el) => el.tag), elements(mName).map((el) => el.tag));
  const [swatch, title] = elements(name);
  assert.deepEqual(swatch!.children, []);
  assert.equal(styleOf(swatch!, 'background'), `var(${trackColourVar('trk_v')})`);
  assert.equal(text(title!), 'Chorus A · take 3');
  assert.equal(text(title!), text(elements(mName)[1]!), 'the mockup\'s clip');
  assert.equal(title!.attrs['data-testid'], 'info-name');
  // No media name: the media id (clipTitle).
  assert.equal(text(find(render(session(named()), 'clp_ch'), byAttr('data-testid', 'info-name'))), 'med_ch');
  // The media entity missing: the media id too.
  assert.equal(text(find(render(snapshotOf(['trk_v'], [track('trk_v')], [], [chorus()]), 'clp_ch'), byAttr('data-testid', 'info-name'))), 'med_ch');
});

test('each value field is its label and b.num, the mockup\'s row for the mockup\'s clip', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const app = render(session(), 'clp_ch', locale);
    const mockup = mockupLine(lang);
    for (const id of FIELDS) {
      const field = find(app, byAttr('data-part', id));
      const mField = find(mockup, byAttr('data-part', id));
      assert.deepEqual(field.children.map((c) => (typeof c === 'string' ? '#text' : sig(c))), mField.children.map((c) => (typeof c === 'string' ? '#text' : sig(c))), `${locale}: ${id}`);
      // The label and the value as the mockup writes them, the label per locale.
      assert.equal(text(field), text(mField), `${locale}: ${id}`);
      assert.equal(find(field, byClass('num')).attrs['data-testid'], id);
    }
  }
});

test('nothing selected: the line and nothing between its edges', () => {
  for (const id of [null, 'clp_gone']) {
    const app = render(session(), id);
    assert.equal(sig(app), 'div.infoline');
    assert.equal(app.attrs['data-part'], 'info-line');
    assert.equal(app.attrs['data-clip'], '');
    assert.deepEqual(app.children, [], String(id));
    assert.deepEqual(findAll(app, byClass('f')), []);
  }
});

test('several selected: the primary clip\'s fields', () => {
  const other = chorus({ id: 'clp_two', position: { domain: 'audio', value: '96000' } });
  const snapshot = session(named('Chorus A · take 3'), [chorus(), other]);
  assert.equal(text(find(render(snapshot, 'clp_two'), byAttr('data-testid', 'info-start'))), '2.1.1.0');
  assert.equal(text(find(render(snapshot, 'clp_ch'), byAttr('data-testid', 'info-start'))), '9.1.1.0');
});

test('the ids are the mockup\'s minus the pending parts\'', () => {
  const ids = (root: Element) => findAll(root, byAttr('data-part')).map((el) => el.attrs['data-part']!).sort();
  assert.deepEqual(ids(render(session(), 'clp_ch')), ids(mockupLine()).filter((id) => !pending(id)));
  assert.deepEqual(ids(render(session(), 'clp_ch')), ['info-end', 'info-length', 'info-line', 'info-name', 'info-offset', 'info-start', 'info-volume']);
});
