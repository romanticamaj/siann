// The track list port (m5-ui-port-track-list; UI redesign 10.9, 10.10 P1-15,
// 3.0, 3.3, 10.8 (4)): the TrackList renders what the mockup's app.innerHTML
// template writes for div.headers, and one header per track as th() returns
// it, on real data. The expectations come from the mockup's own script
// (support/mockup.ts) and from app/test/fidelity/manifest.json (which parts are
// pending), not from the code under test:
//
// - .headers holds .corner (.add, then .cnt), the marker row's empty box, then
//   the headers (in the app inside the scroll wrappers, as their only
//   children, so .th:nth-child(odd) keeps the mockup's parity);
// - a header is .th with --c, .col, .idx, .body with .r1 (.name, .msr.m,
//   .msr.s, record enable .msr.r (m5b-ui-recording), then the empty boxes of
//   read and write) and .r2 (.db.num,
//   .pan.num, .hmeter); sel, muted and .on follow the track;
// - the number, gain and pan read as the mockup's fdb / fpan for its seven
//   tracks (the app's gain keeps its ASCII minus, as the strip's readout does);
// - the ids of the fidelity run (data-part-item / data-part-of, counted as
//   mockup-fidelity.spec.ts counts them) are the mockup's minus the pending
//   parts', and an empty box carries no id, role, focus or text;
// - the head's count, "7 tracks · 17 clips", in three locales with English
//   plurals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { en } from '../../src/renderer/i18n/en';
import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore } from '../../src/renderer/i18n/t';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { ClipEntity, TrackEntity } from '../../src/renderer/model/document';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { RecordContext } from '../../src/renderer/shell/record-context';
import { recordHost } from './support/record-host';
import { GhostContext } from '../../src/renderer/plans/ghost-context';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { trackColourVar } from '../../src/renderer/timeline/track-colour';
import { TrackHeaderView, TrackList } from '../../src/renderer/timeline/TrackList';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';
import { clip, media, snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'test', 'fidelity', 'manifest.json'), 'utf8')) as {
  gates: Record<string, string>;
  rules: Array<{ match: string[]; gate: string }>;
};
const MOCKUP = loadMockup('en');

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const pending = (id: string) => {
  const rule = MANIFEST.rules.find((r) => r.match.some((p) => glob(p).test(id)));
  assert.ok(rule, `no manifest rule owns ${id}`);
  return MANIFEST.gates[rule.gate] === 'pending';
};

// The mockup's seven tracks (its T without the ghost track) as entities: the
// mockup's dB and pan percent in the model's units.
const MOCKUP_TRACKS = MOCKUP.T.filter((t) => !t.ghost);
const IDS = MOCKUP_TRACKS.map((_, i) => `trk_${String.fromCharCode(97 + i)}`);
const mockupEntities = (): TrackEntity[] =>
  MOCKUP_TRACKS.map((t, i) => ({ ...track(IDS[i]!), name: t.n, gainMilliDb: Math.round(t.db * 1000), pan: t.pan * 100, mute: t.mute === true }));
const SELECTED = IDS[MOCKUP_TRACKS.findIndex((t) => t.sel)]!;

function snapshotWith(tracks: readonly TrackEntity[], clipCount = 0): Snapshot {
  const clips: ClipEntity[] = [];
  for (let i = 0; i < clipCount; i += 1) clips.push(clip(`clp_${i}`, tracks[i % tracks.length]!.id, 'med_sq', String(i * 48000), '0', '48000'));
  return snapshotOf(
    tracks.map((t) => t.id),
    tracks,
    clipCount > 0 ? [media('med_sq', '48000')] : [],
    clips,
  );
}

function fakeClient(snap: Snapshot) {
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => snap.entities[ref],
    subscribe: () => () => undefined,
  };
  return { model, getState: () => ({ status: 'connected', legend: null }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
}

function withLocale<T>(locale: Locale | undefined, fn: () => T): T {
  const before = localeStore();
  if (locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return fn();
  } finally {
    installLocaleStore(before);
  }
}

function render(
  tracks: TrackEntity[],
  options: { selected?: readonly string[]; caps?: Capabilities | null; locale?: Locale; clips?: number } = {},
): Element {
  const snap = snapshotWith(tracks, options.clips ?? 0);
  const caps = options.caps === undefined ? FULL : options.caps;
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={caps}>
     <RecordContext.Provider value={recordHost(snap, caps)}>
      <TrackList
        client={fakeClient(snap)}
        realtime={null}
        timeline={null}
        layout={createLayoutStore({ storage: null })}
        selectedTrackId={options.selected?.[0] ?? null}
        selectedTrackIds={options.selected}
        onSelectTrack={() => undefined}
      />
     </RecordContext.Provider>
    </CapabilitiesContext.Provider>
  );
  return withLocale(options.locale, () => parse(renderToStaticMarkup(node)));
}

const list = (root: Element) => find(root, byClass('headers'));
const headers = (root: Element) => findAll(root, byClass('th'));
const mockupHeaders = (lang = 'en') => find(parse(loadMockup(lang).headers), byClass('headers'));
const mockupHeader = (i: number) => find(parse(MOCKUP.th(MOCKUP.T[i]!, i)), byClass('th'));
// The app's own pieces inside a header: the lane-height handle.
const APP_ONLY = new Set(['track-resize']);
const ported = (el: Element) => elements(el).filter((child) => !classes(child).some((c) => APP_ONLY.has(c)));
// The mockup's classes that a pending feature adds (.ghost: m5b-ui-ghosts).
const landed = (el: Element) => classes(el).filter((c) => c !== 'ghost').sort();
// The app writes the gain with an ASCII minus; the mockup's fdb writes U+2212.
const ascii = (s: string) => s.replace(/−/g, '-');

// An empty box (UI redesign 3.0): no child, no text, no role, no focus, no id, hidden from assistive technology.
function assertEmptyBox(el: Element, what: string): void {
  assert.deepEqual(el.children, [], `${what}: nothing in it`);
  assert.equal(el.attrs['aria-hidden'], 'true', `${what}: aria-hidden`);
  for (const name of ['role', 'tabindex', 'data-part', 'data-part-of', 'data-part-item', 'data-testid']) assert.ok(!(name in el.attrs), `${what}: no ${name}`);
}

// The ids the fidelity run reads (mockup-fidelity.spec.ts, collectDom): data-part, and data-part-item numbered in document order with its data-part-of children.
function ids(root: Element): string[] {
  const out: string[] = [];
  for (const el of findAll(root, byAttr('data-part'))) out.push(el.attrs['data-part']!);
  const counts = new Map<string, number>();
  for (const item of findAll(root, byAttr('data-part-item'))) {
    const name = item.attrs['data-part-item']!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const id = `${name}-${item.attrs['data-part-key'] ?? counts.get(name)}`;
    out.push(id);
    const walk = (el: Element) => {
      for (const child of elements(el)) {
        if ('data-part-item' in child.attrs) continue;
        if ('data-part-of' in child.attrs) out.push(`${id}-${child.attrs['data-part-of']}`);
        walk(child);
      }
    };
    walk(item);
  }
  return out.sort();
}

test('the list is .headers holding .corner (.add, then .cnt), the empty marker box, then the headers', () => {
  const root = list(render(mockupEntities(), { clips: 17 }));
  const mockup = mockupHeaders();
  assert.equal(sig(root), sig(mockup));
  assert.equal(root.attrs['data-part'], 'track-list');
  assert.equal(root.attrs['data-testid'], 'track-list');
  assert.equal(root.attrs.role, 'group');
  const [corner, marker, body, ...rest] = elements(root);
  assert.deepEqual(rest, [], 'the head, the marker box and the body of headers');
  // The head: .corner with .add and .cnt, as the template writes it.
  const mCorner = elements(mockup)[0]!;
  assert.equal(sig(corner!), sig(mCorner));
  assert.equal(corner!.attrs['data-part'], 'track-list-head');
  assert.deepEqual(elements(corner!).map((el) => classes(el)), elements(mCorner).map((el) => classes(el)));
  // The marker row (m5b-ui-markers): the mockup's .mk[marker-head] is an empty box, without .mk.
  assert.equal(sig(elements(mockup)[1]!), 'div.mk');
  assert.equal(marker!.tag, 'div');
  assert.deepEqual(classes(marker!), [], 'no .mk: it would draw the marker row');
  assertEmptyBox(marker!, 'the marker box');
  // The headers, in document order, are the only children of the scroll column.
  assert.ok(classes(body!).includes('track-list-body'));
  const column = find(body!, byClass('track-list-column'));
  assert.deepEqual(elements(column).map((el) => classes(el)[0]), IDS.map(() => 'th'));
  assert.deepEqual(elements(mockup).slice(2, 2 + IDS.length).map((el) => classes(el)[0]), IDS.map(() => 'th'));
});

test('the add button is the mockup\'s .add: the plus icon and its visible label, in three locales', () => {
  for (const [locale, lang, label] of [
    ['en', 'en', 'Track'],
    ['zh-Hant', 'zh-TW', '音軌'],
    ['zh-Hans', 'zh-TW', '音轨'],
  ] as const) {
    const add = find(render(mockupEntities(), { locale }), byClass('add'));
    const mAdd = find(mockupHeaders(lang), byClass('add'));
    assert.equal(add.tag, 'button', locale);
    assert.equal(add.attrs['data-part'], 'track-add');
    assert.equal(add.attrs['data-testid'], 'track-add');
    assert.deepEqual(elements(add).map(sig), elements(mAdd).map(sig), `${locale}: svg.i.s`);
    assert.equal(find(add, (el) => el.tag === 'path').attrs.d, find(mAdd, (el) => el.tag === 'path').attrs.d, 'the mockup\'s plus');
    assert.equal(text(add), label, locale);
    if (locale !== 'zh-Hans') assert.equal(text(add), text(mAdd), `${locale}: the mockup's label`);
  }
});

test('each header equals th() for a non-ghost track: .th with --c, .col, .idx, .body with .r1 and .r2', () => {
  const app = headers(render(mockupEntities(), { selected: [SELECTED] }));
  assert.equal(app.length, MOCKUP_TRACKS.length);
  for (const [i, header] of app.entries()) {
    const mockup = mockupHeader(i);
    const what = `${MOCKUP_TRACKS[i]!.n}`;
    assert.deepEqual(landed(header), landed(mockup), `${what}: .th and its state classes`);
    assert.equal(styleOf(header, '--c'), `var(${trackColourVar(IDS[i]!)})`, what);
    assert.deepEqual(ported(header).map(sig), elements(mockup).map(sig), `${what}: .col, .idx, .body`);
    assert.deepEqual(ported(header).map(sig), ['div.col', 'div.idx', 'div.body']);
    const body = find(header, byClass('body'));
    const mBody = find(mockup, byClass('body'));
    assert.deepEqual(elements(body).map(sig), elements(mBody).map(sig), `${what}: .r1, .r2`);
    // .r1: the name, M, S and record enable (m5b-ui-recording), then the boxes of read and write (pending).
    const r1 = elements(find(body, byClass('r1')));
    const mR1 = elements(find(mBody, byClass('r1')));
    assert.equal(r1.length, mR1.length, what);
    assert.deepEqual(r1.slice(0, 3).map((el) => [el.tag === 'button' ? 'span' : el.tag, ...landed(el)]), mR1.slice(0, 3).map((el) => [el.tag, ...landed(el)]), `${what}: name, M, S`);
    assert.deepEqual(r1.slice(1, 3).map((el) => el.tag), ['button', 'button']);
    assert.equal(text(r1[0]!), MOCKUP_TRACKS[i]!.n);
    assert.deepEqual(r1.slice(1, 3).map(text), ['M', 'S']);
    assert.equal(r1[3]!.tag, 'button');
    assert.deepEqual(landed(r1[3]!).filter((c) => c !== 'on'), landed(mR1[3]!).filter((c) => c !== 'on'), `${what}: record enable`);
    for (const box of r1.slice(4)) assertEmptyBox(box, `${what}: read and write`);
    assert.deepEqual(r1.slice(4).map((el) => classes(el)), [['msr-box'], ['msr-box']]);
    // .r2: gain, pan and the meter well (DOM, empty: one canvas paints the bar).
    const r2 = elements(find(body, byClass('r2')));
    const mR2 = elements(find(mBody, byClass('r2')));
    assert.deepEqual(r2.map(sig), mR2.map(sig), `${what}: .db.num, .pan.num, .hmeter`);
    assert.deepEqual(r2.map(sig), ['span.db.num', 'span.num.pan', 'span.hmeter']);
    assert.deepEqual(r2[2]!.children, [], 'the well holds no <i>');
  }
});

test('sel on a selected track, muted on a muted or implicitly muted one, .on from mute and solo', () => {
  const tracks = [{ ...track('trk_a'), mute: true }, { ...track('trk_b'), solo: true }, track('trk_c')];
  const [a, b, c] = headers(render(tracks, { selected: ['trk_c'] }));
  assert.deepEqual(classes(a!).sort(), ['muted', 'th']);
  assert.deepEqual(classes(b!).sort(), ['th'], 'the soloed track is heard');
  assert.deepEqual(classes(c!).sort(), ['muted', 'sel', 'th'], 'muted by the other\'s solo, and selected');
  const msr = (h: Element) => findAll(h, (el) => el.tag === 'button' && classes(el).includes('msr')).map((el) => classes(el).join(' '));
  // M, S and record enable (m5b-ui-recording; nothing armed here).
  assert.deepEqual(msr(a!), ['msr m on', 'msr s', 'msr r']);
  assert.deepEqual(msr(b!), ['msr m', 'msr s on', 'msr r']);
  assert.deepEqual(msr(c!), ['msr m', 'msr s', 'msr r']);
  for (const h of [a!, b!, c!]) assert.ok(!('style' in h.attrs) || !/opacity/.test(h.attrs.style!), 'the shared rule dims, not an inline opacity');
  assert.equal(a!.attrs['data-dimmed'], 'true');
  assert.equal(c!.attrs['data-dimmed'], 'true');
  assert.equal(b!.attrs['data-dimmed'], undefined);
  assert.equal(c!.attrs['aria-selected'], 'true');
});

test('the number is the index + 1, the gain formatDb with one decimal, the pan formatPan: the mockup\'s values', () => {
  const app = headers(render(mockupEntities()));
  for (const [i, header] of app.entries()) {
    const t = MOCKUP_TRACKS[i]!;
    const mockup = mockupHeader(i);
    assert.equal(text(find(header, byClass('idx'))), String(i + 1));
    assert.equal(text(find(header, byClass('idx'))), text(find(mockup, byClass('idx'))));
    assert.equal(text(find(header, byClass('db'))), ascii(`${MOCKUP.fdb(t.db)} dB`), t.n);
    assert.equal(text(find(header, byClass('db'))), ascii(text(find(mockup, byClass('db')))), t.n);
    assert.equal(text(find(header, byClass('pan'))), MOCKUP.fpan(t.pan), t.n);
    assert.equal(text(find(header, byClass('pan'))), text(find(mockup, byClass('pan'))), t.n);
  }
  // Values the mockup does not show: a hard pan, a gain below -10 dB.
  const [h] = headers(render([{ ...track('trk_a'), gainMilliDb: -12340, pan: 10000 }]));
  assert.equal(text(find(h!, byClass('db'))), '-12.3 dB');
  assert.equal(text(find(h!, byClass('pan'))), 'R100');
});

test('the ids are the mockup\'s minus the pending parts\', and no pending id is anywhere', () => {
  const root = list(render(mockupEntities(), { clips: 17 }));
  const mockup = mockupHeaders();
  const mockupIds = findAll(mockup, byAttr('data-part')).map((el) => el.attrs['data-part']!);
  // The mockup's list names the marker head, the read and write buttons: pending; record landed (m5b-ui-recording).
  for (const id of ['marker-head', 'track-1-read', 'track-1-write']) {
    assert.ok(mockupIds.includes(id), `the mockup has ${id}`);
    assert.ok(pending(id), `${id} is pending`);
  }
  assert.ok(mockupIds.includes('track-1-record') && !pending('track-1-record'));
  // The ghost track landed with m5b-ui-ghosts: it is drawn for a reviewable plan only, and there is none here.
  assert.ok(mockupIds.includes('track-ghost') && !pending('track-ghost'));
  assert.deepEqual(ids(root), mockupIds.filter((id) => !pending(id) && !/ghost/.test(id)).sort());
  for (const id of ids(root)) assert.ok(!pending(id), id);
  assert.ok(!ids(root).some((id) => /^(marker-head|track-ghost|track-\d+-(read|write))$/.test(id)));
  assert.ok(ids(root).includes('track-1-record'));
  assert.ok(!findAll(root, byAttr('data-part')).some((el) => /ghost|marker/.test(el.attrs['data-part']!)));
  // The test ids the specs use stay.
  const h = headers(root)[0]!;
  for (const part of ['colour', 'number', 'name', 'mute', 'solo', 'record', 'gain', 'pan', 'meter']) {
    assert.equal(find(h, byAttr('data-part-of', part)).attrs['data-testid'], `track-${part}-${IDS[0]}`, part);
  }
  assert.equal(h.attrs['data-testid'], `track-header-${IDS[0]}`);
  assert.equal(find(h, byClass('track-resize')).attrs['data-testid'], `track-resize-${IDS[0]}`);
});

test('reduced capabilities remove the add button, M and S, and their boxes stay', () => {
  const noTrackCommands: Capabilities = {
    ...FULL,
    commands: (FULL.commands ?? []).filter((c) => !['track.add', 'track.set_mute', 'track.set_solo', 'track.rename'].includes(c)),
    // Record enable needs features.recording (m5b-ui-recording).
    features: { ...FULL.features, recording: false },
  };
  for (const caps of [noTrackCommands, null]) {
    const root = render([track('trk_a')], { caps });
    const corner = find(root, byClass('corner'));
    assert.deepEqual(elements(corner).map((el) => classes(el)), [['cnt']], 'the count stays, the add button goes');
    const r1 = elements(find(root, byClass('r1')));
    assert.equal(findAll(find(root, byClass('r1')), (el) => el.tag === 'button').length, 0);
    assert.equal(r1.length, 6, 'the name and five boxes');
    for (const box of r1.slice(1)) assertEmptyBox(box, 'an unlisted button');
    assert.ok(!('data-renamable' in find(root, byClass('name')).attrs));
    assert.ok(!('data-addable' in find(root, byClass('track-list-body')).attrs));
  }
});

test('rename: the name gives way to the input, an app-only element, and the row keeps its boxes', () => {
  const t: TrackEntity = { ...track('trk_a'), name: 'Kick' };
  const snap = snapshotWith([t]);
  const row = (editing: boolean) =>
    find(
      parse(
        renderToStaticMarkup(
          <CapabilitiesContext.Provider value={FULL}>
            <TrackHeaderView
              track={t}
              number={1}
              height={53}
              dimmed={false}
              selected={false}
              canRename
              client={fakeClient(snap)}
              editing={editing}
              onEditing={() => undefined}
              onSelect={() => undefined}
              onResize={() => undefined}
            />
          </CapabilitiesContext.Provider>,
        ),
      ),
      byClass('r1'),
    );
  const at = row(false);
  assert.equal(sig(elements(at)[0]!), 'span.name');
  assert.equal(elements(at)[0]!.attrs['data-renamable'], 'true');
  const editing = row(true);
  const [input, ...rest] = elements(editing);
  assert.equal(input!.tag, 'input');
  assert.deepEqual(classes(input!), ['track-rename']);
  assert.equal(input!.attrs['data-testid'], 'track-rename-trk_a');
  assert.equal(input!.attrs.value, 'Kick');
  assert.ok(!('data-part-of' in input!.attrs), 'the input is the app\'s, not the mockup\'s name');
  assert.deepEqual(rest.map((el) => classes(el).join(' ')), ['msr m', 'msr s', 'msr-box', 'msr-box', 'msr-box']);
});

test('the count: "N tracks · M clips" in English with plurals, and in both Chinese catalogs', () => {
  const count = en['tracklist.count'];
  assert.equal(count({ tracks: 1, clips: 1 }), '1 track · 1 clip');
  assert.equal(count({ tracks: 7, clips: 17 }), '7 tracks · 17 clips');
  assert.equal(count({ tracks: 0, clips: 0 }), '0 tracks · 0 clips');
  assert.equal(count({ tracks: 2, clips: 1 }), '2 tracks · 1 clip');
  assert.equal(zhHant['tracklist.count']({ tracks: 7, clips: 17 }), '7 條音軌 · 17 個片段');
  assert.equal(zhHans['tracklist.count']({ tracks: 7, clips: 17 }), '7 条音轨 · 17 个片段');
  assert.equal(zhHant['tracklist.count']({ tracks: 1, clips: 1 }), '1 條音軌 · 1 個片段');
});

test('the rendered count is the mockup\'s .cnt for its seven tracks and seventeen clips, with the id track-count', () => {
  for (const [locale, lang] of [
    ['en', 'en'],
    ['zh-Hant', 'zh-TW'],
  ] as const) {
    const cnt = find(render(mockupEntities(), { locale, clips: 17 }), byClass('cnt'));
    const mCnt = find(mockupHeaders(lang), byClass('cnt'));
    assert.equal(cnt.tag, 'span');
    assert.equal(cnt.attrs['data-part'], 'track-count');
    assert.equal(cnt.attrs['data-testid'], 'track-count');
    assert.equal(text(cnt), text(mCnt), locale);
  }
  assert.equal(text(find(render([track('trk_a')], { clips: 1 }), byClass('cnt'))), '1 track · 1 clip');
  assert.equal(text(find(render([], { clips: 0 }), byClass('cnt'))), '0 tracks · 0 clips');
  assert.equal(text(find(render([track('trk_a')], { locale: 'zh-Hans', clips: 1 }), byClass('cnt'))), '1 条音轨 · 1 个片段');
});

// ---- m5b-ui-ghosts (UI redesign 4.2): the proposed track's header is th()
// for the mockup's ghost track (Pad, step 1); a header carries its track's
// ghosts: the dashed ring on M or S (th()'s .msr.ghost), and, as added
// elements the mockup has no markup for, the gain readout with both values
// and both names on a rename.

function renderGhosts(tracks: TrackEntity[], ghosts: readonly Ghost[], locale?: Locale): Element {
  const snap = snapshotWith(tracks);
  const pinned: number[] = [];
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={FULL}>
      <GhostContext.Provider value={{ ghosts, outline: null, pin: (step) => void pinned.push(step) }}>
        <TrackList client={fakeClient(snap)} realtime={null} timeline={null} layout={createLayoutStore({ storage: null })} selectedTrackId={null} onSelectTrack={() => undefined} />
      </GhostContext.Provider>
    </CapabilitiesContext.Provider>
  );
  return withLocale(locale, () => parse(renderToStaticMarkup(node)));
}

const PAD: Ghost = { kind: 'track-add', step: 1, trackId: 'trk_pad', name: 'Pad', channels: 2, key: 'ghost' };

test('a proposed track\'s header is th() for the ghost track: .th.ghost, "+", the step badge, the name, "proposed track" and the summary', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const root = renderGhosts(mockupEntities(), [PAD], locale);
    const all = headers(root);
    assert.equal(all.length, 8);
    const app = all[7]!;
    const mockup = find(parse(loadMockup(lang).th(MOCKUP.T[7]!, 7)), byClass('th'));
    assert.equal(sig(app), sig(mockup));
    assert.equal(styleOf(app, '--c'), 'var(--ai)');
    const tree = (el: Element): string[] => elements(el).flatMap((child) => [sig(child), ...tree(child).map((s) => `  ${s}`)]);
    assert.deepEqual(ported(app).flatMap((child) => [sig(child), ...tree(child).map((s) => `  ${s}`)]), elements(mockup).flatMap((child) => [sig(child), ...tree(child).map((s) => `  ${s}`)]), locale);
    assert.equal(text(find(app, byClass('idx'))), '+');
    const r1 = elements(find(app, byClass('r1')));
    const m1 = elements(find(mockup, byClass('r1')));
    assert.equal(text(r1[0]!), '1');
    assert.equal(styleOf(r1[0]!, 'margin-right'), styleOf(m1[0]!, 'margin-right'));
    assert.equal(text(r1[1]!), 'Pad');
    assert.equal(text(r1[2]!), text(m1[2]!), locale);
    for (const property of ['color', 'font-size', 'white-space']) assert.equal(styleOf(r1[2]!, property), styleOf(m1[2]!, property), property);
    assert.equal(text(find(app, byClass('r2'))), text(find(mockup, byClass('r2'))).trim(), locale);
    // The ids: track-ghost and its colour, number and name, as th() gives them.
    const mockIds = findAll(mockup, byAttr('data-part')).map((el) => el.attrs['data-part']!).sort();
    assert.deepEqual(ids(root).filter((id) => /ghost/.test(id)), mockIds);
  }
  // A second proposed track takes ghost-2.
  const two = renderGhosts([track('trk_a')], [PAD, { kind: 'track-add', step: 4, trackId: 'trk_two', name: 'Two', channels: 1, key: 'ghost-2' }]);
  assert.deepEqual(headers(two).filter((h) => classes(h).includes('ghost')).map((h) => h.attrs['data-part-key']), ['ghost', 'ghost-2']);
  assert.match(text(headers(two)[2]!), /mono/);
});

test('a header\'s ghosts: the dashed ring on M for a mute change (th()\'s .msr.m.ghost), on S for solo, the gain with both values, both names', () => {
  const fxIndex = MOCKUP.T.findIndex((t) => t.gUnmute);
  const tracks = mockupEntities();
  const fx = tracks[fxIndex]!;
  const bg = tracks[5]!;
  const root = renderGhosts(tracks, [
    { kind: 'mute', step: 5, trackId: fx.id, before: true, after: false },
    { kind: 'solo', step: 6, trackId: bg.id, before: false, after: true },
    { kind: 'gain', step: 3, trackId: bg.id, before: -9000, after: -6000 },
    { kind: 'rename', step: 7, trackId: tracks[0]!.id, before: 'Kick', after: 'Kick In' },
  ]);
  const all = headers(root);
  const mute = find(all[fxIndex]!, byAttr('data-part-of', 'mute'));
  const mockMute = find(mockupHeader(fxIndex), (el) => classes(el).includes('m'));
  assert.deepEqual(classes(mute).sort(), classes(mockMute).sort());
  assert.ok(classes(find(all[5]!, byAttr('data-part-of', 'solo'))).includes('ghost'));
  // 4.2's "-9.0 → -6.0": both values without their unit, so the readout fits
  // (shell.css lets its cell grow; ghosts.spec.ts checks it clears the pan).
  const gain = find(all[5]!, byAttr('data-part-of', 'gain'));
  assert.equal(text(gain), '-9.0 → -6.0');
  assert.equal(text(find(gain, byClass('ghost-to'))), '→ -6.0');
  // Both names, each in its own element, so shell.css lets the old one give way first.
  const name = find(all[0]!, byAttr('data-part-of', 'name'));
  assert.equal(text(name), 'Kick → Kick In');
  assert.equal(name.attrs.title, 'Kick → Kick In');
  const pair = find(name, byClass('ghost-rename'));
  assert.deepEqual(elements(pair).map(sig), ['span.ghost-was', 'span.ghost-arrow', 'span.ghost-name']);
  assert.equal(text(find(pair, byClass('ghost-was'))), 'Kick');
  assert.equal(text(find(pair, byClass('ghost-name'))), 'Kick In');
  // No ghost of another track leaks: Snare's header is th() as before.
  assert.ok(!findAll(all[1]!, (el) => classes(el).some((c) => /ghost/.test(c))).length);
});

test('a removed track\'s header dims (an added class) and carries its step badge and ghost attributes', () => {
  const tracks = mockupEntities();
  const fx = tracks[6]!;
  const root = renderGhosts(tracks, [{ kind: 'track-remove', step: 7, trackId: fx.id }]);
  const header = headers(root)[6]!;
  assert.ok(classes(header).includes('ghost-removed'));
  assert.equal(header.attrs['data-ghost'], '7');
  const r1 = elements(find(header, byClass('r1')));
  assert.equal(sig(r1[0]!), 'span.stepn');
  assert.equal(text(r1[0]!), '7');
  // The other headers are untouched.
  assert.ok(headers(root).slice(0, 6).every((h) => !classes(h).includes('ghost-removed') && h.attrs['data-ghost'] === undefined));
});
