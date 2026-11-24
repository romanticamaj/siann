// The Notepad section (m5b-ui-notepad; UI redesign 3.4, 3.0, 10.9): the
// mockup's sec('Notepad',''), on the selected track. The expectations come
// from the mockup's own script (support/mockup.ts), the catalogs and the
// spec, not from the code under test:
//
// - closed (the default), the section is what sec('Notepad','') writes:
//   div.sec.shut[data-part=inspector-notepad] > div.sec-h > (svg, the title,
//   an empty span), with no .sec-b; the head is a toggle (role=button,
//   tabindex 0, aria-expanded), attributes added to the mockup's markup only;
// - open, it is div.sec with .sec-b holding the text area (the track's notes);
// - an engine without the command track.set_notes has no part, and the
//   section's empty box stays (.inspector-hold.notepad.shut), sized by its
//   shell.css calc();
// - under the edit guard the text area is read-only with the guard's reason;
// - the refusal line and the "changed elsewhere" line come from the catalogs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { en } from '../../src/renderer/i18n/en';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';
import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore } from '../../src/renderer/i18n/t';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { TrackEntity } from '../../src/renderer/model/document';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { HeardContext } from '../../src/renderer/plans/heard-context';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { Inspector } from '../../src/renderer/shell/Inspector';
import { createNotepadStore, type NotepadStore } from '../../src/renderer/shell/notepad';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, text, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const WITHOUT_NOTES: Capabilities = { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_notes') } as Capabilities;

const vox = (notes?: string): TrackEntity => ({ ...track('trk_a'), name: 'Vox Lead', channels: 1, gainMilliDb: 1500, pan: 0, ...(notes === undefined ? {} : { notes }) });

function fakeClient(tracks: TrackEntity[]) {
  const snap = snapshotOf(tracks.map((t) => t.id), tracks, [], []);
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => snap.entities[ref],
    subscribe: () => () => undefined,
  };
  return { model, getState: () => ({ status: 'connected', legend: null }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
}

interface Options {
  readonly caps?: Capabilities;
  readonly open?: boolean;
  readonly heard?: string | null;
  readonly locale?: Locale;
  readonly notes?: string;
}

function render(options: Options = {}): Element {
  const tracks = [vox(options.notes)];
  const client = fakeClient(tracks);
  const store = createNotepadStore({ model: client.model, execute: async () => undefined, blocked: () => false, refusal: () => ({ code: 'invalid_notes', message: 'm', changedEntities: [] }) });
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={options.caps ?? FULL}>
      <HeardContext.Provider value={options.heard ?? null}>
        <Inspector client={client} gestures={{} as unknown as GestureController} trackId="trk_a" notepad={store} notepadOpen={options.open ?? false} onNotepadToggle={() => undefined} />
      </HeardContext.Provider>
    </CapabilitiesContext.Provider>
  );
  const before = localeStore();
  if (options.locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => options.locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return parse(renderToStaticMarkup(node));
  } finally {
    installLocaleStore(before);
  }
}

const mockupSection = (lang = 'en') => find(parse(loadMockup(lang).leftzone), byAttr('data-part', 'inspector-notepad'));
const section = (root: Element) => find(root, byAttr('data-part', 'inspector-notepad'));
const ADDED = ['role', 'tabindex', 'aria-expanded'];

test('closed, the section is the mockup\'s sec(\'Notepad\',\'\'): .sec.shut > .sec-h > (svg, the title, a span), no .sec-b', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const app = section(render({ locale }));
    const mockup = mockupSection(lang);
    assert.equal(sig(app), sig(mockup));
    assert.equal(sig(app), 'div.sec.shut');
    assert.deepEqual(elements(app).map(sig), ['div.sec-h']);
    assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
    const [head] = elements(app);
    const [mHead] = elements(mockup);
    assert.deepEqual(elements(head!).map((el) => el.tag), ['svg', 'span']);
    assert.deepEqual(elements(head!).map(sig), elements(mHead!).map(sig));
    assert.equal(text(head!), text(mHead!), locale);
    assert.equal(text(elements(head!)[1]!), '', 'the span is empty');
    // The head is a toggle: only role, tabindex and aria-expanded are added.
    assert.equal(head!.attrs.role, 'button');
    assert.equal(head!.attrs.tabindex, '0');
    assert.equal(head!.attrs['aria-expanded'], 'false');
    assert.deepEqual(Object.keys(head!.attrs).filter((name) => !(name in mHead!.attrs)).sort(), [...ADDED].sort());
    assert.equal(findAll(app, byClass('sec-b')).length, 0);
    assert.equal(findAll(app, (el) => el.tag === 'textarea').length, 0);
  }
});

test('open, the section is .sec (no shut) with .sec-b holding the text area with the track\'s notes, LF for CR LF', () => {
  const app = section(render({ open: true, notes: 'Double the chorus\r\nbreath at bar 9' }));
  assert.equal(sig(app), 'div.sec');
  const [head, body] = elements(app);
  assert.equal(head!.attrs['aria-expanded'], 'true');
  assert.equal(sig(body!), 'div.sec-b');
  const area = elements(body!)[0]!;
  assert.equal(area.tag, 'textarea');
  assert.equal(text(area), 'Double the chorus\nbreath at bar 9');
  assert.equal(area.attrs['aria-label'], en['notepad.label']({ track: 'Vox Lead' }));
  assert.ok(!('readonly' in area.attrs), 'editable while main is heard');
  // Nothing else in the body while there is nothing to say.
  assert.deepEqual(elements(body!).map((el) => el.tag), ['textarea']);
});

test('without the command track.set_notes the section is not in the DOM and its empty box stays, shut', () => {
  const app = render({ caps: WITHOUT_NOTES, open: true });
  assert.equal(findAll(app, byAttr('data-part', 'inspector-notepad')).length, 0);
  assert.equal(findAll(app, (el) => el.tag === 'textarea').length, 0);
  const box = findAll(app, byClass('notepad'));
  assert.equal(box.length, 1);
  assert.deepEqual(classes(box[0]!).sort(), ['inspector-hold', 'notepad', 'shut']);
  assert.deepEqual(box[0]!.children, []);
  assert.equal(box[0]!.attrs['aria-hidden'], 'true');
  for (const name of ['role', 'tabindex', 'data-part', 'data-testid']) assert.ok(!(name in box[0]!.attrs), name);
});

test('while a proposal is heard the text area is read-only with the guard\'s reason as its title', () => {
  for (const [locale, catalog] of [['en', en], ['zh-Hant', zhHant]] as const) {
    const area = find(section(render({ open: true, heard: 'prp_1', locale })), (el) => el.tag === 'textarea');
    assert.ok('readonly' in area.attrs, locale);
    assert.equal(area.attrs.title, catalog['guard.structural']);
  }
});

// The open section of `store` on `client`'s track, in `locale`.
function renderStore(client: SessionClient, store: NotepadStore, locale: Locale): Element {
  const before = localeStore();
  installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return parse(
      renderToStaticMarkup(
        <CapabilitiesContext.Provider value={FULL}>
          <Inspector client={client} gestures={{} as unknown as GestureController} trackId="trk_a" notepad={store} notepadOpen onNotepadToggle={() => undefined} />
        </CapabilitiesContext.Provider>,
      ),
    );
  } finally {
    installLocaleStore(before);
  }
}

test('the refusal line and the "changed elsewhere" line render from the catalogs', async () => {
  // A refused commit: the line carries the code and the catalog's text, and the draft stays.
  let refuse: (e: unknown) => void = () => undefined;
  const client = fakeClient([vox('stored')]);
  const refused = createNotepadStore({
    model: client.model,
    execute: () => new Promise((_resolve, reject) => (refuse = reject)),
    blocked: () => false,
    refusal: () => ({ code: 'invalid_notes', message: 'engine says no', changedEntities: [] }),
  });
  refused.typed('trk_a', 'bad\u202e');
  refused.commit('trk_a');
  refuse(new Error('refused'));
  await new Promise((resolve) => setImmediate(resolve));
  for (const [locale, catalog] of [['en', en], ['zh-Hant', zhHant]] as const) {
    const root = renderStore(client, refused, locale);
    const line = find(root, byAttr('data-testid', 'notepad-refusal'));
    assert.equal(line.attrs['data-code'], 'invalid_notes');
    // The line is the code and the catalog's text, not the engine's message (RefusalLine.tsx).
    assert.ok(text(line).startsWith(`invalid_notes: ${catalog['error.invalid_notes']}`), `${locale}: ${text(line)}`);
    assert.ok(!text(line).includes('engine says no'));
    assert.equal(text(find(root, (el) => el.tag === 'textarea')), 'bad\u202e', 'the draft is kept');
  }

  // A change that arrives while the draft is dirty: the line says so, with role=status.
  const live = { revision: 'r1', tracks: [vox('v1')] };
  const listeners = new Set<() => void>();
  const model = { getSnapshot: () => live, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
  const flagged = createNotepadStore({ model, execute: async () => undefined, blocked: () => false, refusal: () => ({ code: null, message: '', changedEntities: [] }) });
  flagged.typed('trk_a', 'mine');
  assert.equal(findAll(renderStore(fakeClient([vox('v1')]), flagged, 'en'), byAttr('data-testid', 'notepad-changed')).length, 0, 'no line before a change');
  live.tracks = [vox('v2')];
  for (const l of [...listeners]) l();
  for (const [locale, catalog] of [['en', en], ['zh-Hant', zhHant]] as const) {
    const root = renderStore(fakeClient([vox('v2')]), flagged, locale);
    const line = find(root, byAttr('data-testid', 'notepad-changed'));
    assert.equal(line.attrs.role, 'status');
    assert.equal(text(line), catalog['notepad.changedElsewhere']);
    assert.equal(text(find(root, (el) => el.tag === 'textarea')), 'mine');
  }
});

test('shell.css keeps the empty box at the closed section\'s height and gives the text area its height from existing tokens', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.inspector-hold\.notepad\b[^{]*\{ height: calc\(var\(--section-head-h\) \+ var\(--hairline\)\); \}/);
  assert.match(css, /\.notepad-text \{[^}]*height: calc\(6 \* var\(--control-h\)\);[^}]*\}/);
  assert.match(css, /\.notepad-text \{[^}]*resize: none;[^}]*\}/);
  assert.match(css, /\.notepad-text \{[^}]*overflow-y: auto;[^}]*\}/);
});
