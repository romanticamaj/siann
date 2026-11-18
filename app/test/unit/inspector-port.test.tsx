// The Inspector port (m5-ui-port-inspector; UI redesign 10.9, 10.10 P1-14,
// 3.0, 3.4): the left zone renders what the mockup's app.innerHTML template
// writes inside aside.leftzone, on the selected track of the read model. The
// expectations come from the mockup's own script (support/mockup.ts) and from
// app/test/fidelity/manifest.json (which parts are pending), not from the code
// under test:
//
// - the rows in the template's order and classes: .z-head (the title and its
//   .k hint), .i-track (.i-name, .i-btns, the volume and pan .i-row), the six
//   rows of sec(), .z-foot (Track and the box of Editor);
// - .i-name: the colour swatch as the mockup styles it, the name, mono or
//   stereo in <small>; .i-btns: M and S as .msr.m and .msr.s (.on from the
//   track) and the boxes of record, monitor, read, write and e;
// - the volume row: the label, .hs with its fill and thumb at the taper's
//   position, the value in b.num as dB with one decimal; the pan row: the
//   label, .hs with its thumb only, the value as C, L35, R100;
// - the labels per locale are the mockup's (en and zh-TW);
// - the ids are the mockup's minus the pending parts'; an empty box carries
//   no id, role, focus or text;
// - with no track selected: the head and the foot, nothing between them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore } from '../../src/renderer/i18n/t';
import { milliDbToPosition } from '../../src/renderer/mixer/taper';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { TrackEntity } from '../../src/renderer/model/document';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { Inspector } from '../../src/renderer/shell/Inspector';
import { translator } from '../../src/renderer/i18n/t';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { GhostContext } from '../../src/renderer/plans/ghost-context';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { planName } from '../../src/renderer/plans/plan-name';
import { mockupPlans, PENDING, T } from './support/mockup-plan';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
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

const gestures = {} as unknown as GestureController;

// The Inspector's rows, as the zone body holds them (a #root of its children).
function render(tracks: TrackEntity[], options: { trackId?: string | null; caps?: Capabilities | null; locale?: Locale } = {}): Element {
  const trackId = options.trackId === undefined ? (tracks[0]?.id ?? null) : options.trackId;
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={options.caps === undefined ? FULL : options.caps}>
      <Inspector client={fakeClient(tracks)} gestures={gestures} trackId={trackId} />
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

const mockupZone = (lang = 'en') => find(parse(loadMockup(lang).leftzone), byClass('leftzone'));
const withoutTooltip = (el: Element) => elements(el).filter((child) => !classes(child).includes('value-tooltip'));

// An empty box (UI redesign 3.0): no child, no text, no role, no focus, no id, hidden from assistive technology.
function assertEmptyBox(el: Element, what: string): void {
  assert.deepEqual(el.children, [], `${what}: nothing in it`);
  assert.equal(el.attrs['aria-hidden'], 'true', `${what}: aria-hidden`);
  for (const name of ['role', 'tabindex', 'data-part', 'data-testid']) assert.ok(!(name in el.attrs), `${what}: no ${name}`);
}

// The mockup's selected track: Vox Lead, mono, +1.5 dB, C.
const vox = (): TrackEntity => ({ ...track('trk_a'), name: 'Vox Lead', channels: 1, gainMilliDb: 1500, pan: 0 });

test('the left zone has the template\'s rows in its order and classes', () => {
  const app = render([vox()]);
  const mockup = mockupZone();
  // The six rows of sec() keep their places as empty boxes (next tests).
  assert.deepEqual(elements(app).map((el) => (classes(el).includes('inspector-hold') ? 'div.sec' : sig(el).replace(/\.shut$/, ''))), elements(mockup).map((el) => sig(el).replace(/\.shut$/, '')));
  assert.deepEqual(elements(app).map(sig).slice(0, 2), ['div.z-head', 'div.i-track']);
  assert.equal(sig(elements(app).at(-1)!), 'div.z-foot');
  const track = find(app, byClass('i-track'));
  assert.deepEqual(elements(track).map(sig), elements(find(mockup, byClass('i-track'))).map(sig));
  assert.deepEqual(elements(track).map(sig), ['div.i-name', 'div.i-btns', 'div.i-row', 'div.i-row']);
});

test('the head: the title and the key hint of the left zone', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const head = find(render([vox()], { locale }), byClass('z-head'));
    const mHead = find(mockupZone(lang), byClass('z-head'));
    assert.equal(text(head), text(mHead), locale);
    assert.deepEqual(elements(head).map(sig), ['span.k']);
    assert.equal(text(elements(head)[0]!), 'Alt+I');
  }
});

test('the track block: the swatch in the track colour, the name, mono or stereo, the stripe in the track colour', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const app = render([vox()], { locale });
    const name = find(app, byClass('i-name'));
    const mName = find(mockupZone(lang), byClass('i-name'));
    const [swatch, label, small] = elements(name);
    const [mSwatch, mSmall] = elements(mName);
    // The swatch: the mockup's inline style, with the track's own colour (trk_a hashes to --track-8).
    for (const property of ['width', 'height', 'border-radius']) assert.equal(styleOf(swatch!, property), styleOf(mSwatch!, property), property);
    assert.equal(styleOf(swatch!, 'background'), 'var(--track-8)');
    // The mockup's name is a text node; the app's isolates it in a span (UI redesign 3.0, bidi).
    assert.equal(label!.tag, 'span');
    assert.equal(label!.attrs.dir, 'auto');
    assert.equal(text(label!), 'Vox Lead');
    assert.equal(sig(small!), sig(mSmall!));
    assert.equal(text(small!), text(mSmall!), `${locale}: mono`);
    // The left stripe the shared rule draws in --track-6 (Vox Lead's) is the track's colour.
    assert.match(styleOf(find(app, byClass('i-track')), 'box-shadow')!, /var\(--track-8\)/);
  }
  const stereo = render([{ ...vox(), channels: 2 }], { locale: 'zh-Hant' });
  assert.equal(text(find(find(stereo, byClass('i-name')), (el) => el.tag === 'small')), '立體聲');
  assert.equal(text(find(find(render([{ ...vox(), channels: 2 }]), byClass('i-name')), (el) => el.tag === 'small')), 'Stereo');
});

test('the buttons: M and S as .msr.m and .msr.s with .on from the track, then the boxes of record, monitor, read, write and e', () => {
  for (const [mute, solo] of [[false, false], [true, false], [false, true]] as const) {
    const btns = find(render([{ ...vox(), mute, solo }]), byClass('i-btns'));
    const mBtns = find(mockupZone(), byClass('i-btns'));
    assert.equal(elements(btns).length, elements(mBtns).length, 'seven places, as the mockup');
    const [m, s, ...boxes] = elements(btns);
    assert.equal(m!.tag, 'button');
    assert.deepEqual(classes(m!).sort(), ['m', 'msr', ...(mute ? ['on'] : [])].sort());
    assert.equal(m!.attrs['aria-pressed'], String(mute));
    assert.equal(text(m!), 'M');
    assert.deepEqual(classes(s!).sort(), ['msr', 's', ...(solo ? ['on'] : [])].sort());
    assert.equal(s!.attrs['aria-pressed'], String(solo));
    assert.equal(text(s!), 'S');
    assert.equal(boxes.length, 5);
    for (const box of boxes) {
      assertEmptyBox(box, 'a pending button');
      assert.ok(!classes(box).includes('msr'), 'a box is not drawn as a button');
    }
  }
});

test('the volume row: the label, .hs with fill and thumb at the taper\'s position, the value in dB with one decimal', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const [volume] = findAll(render([vox()], { locale }), byClass('i-row'));
    const [mVolume] = findAll(mockupZone(lang), byClass('i-row'));
    assert.deepEqual(elements(volume!).map(sig), elements(mVolume!).map(sig));
    const [label, hs, value] = elements(volume!);
    const [mLabel, mHs, mValue] = elements(mVolume!);
    assert.equal(text(label!), text(mLabel!), locale);
    assert.deepEqual(withoutTooltip(hs!).map(sig), elements(mHs!).map(sig));
    const [fill, thumb] = withoutTooltip(hs!);
    const [mFill, mThumb] = elements(mHs!);
    // +1.5 dB: the mockup writes 81 %, the taper's 81.25 % to a whole percent.
    const at = `${(milliDbToPosition(1500) * 100).toFixed(1)}%`;
    assert.equal(styleOf(fill!, 'width'), at);
    assert.equal(styleOf(thumb!, 'left'), at);
    assert.ok(Math.abs(parseFloat(at) - parseFloat(styleOf(mFill!, 'width')!)) < 0.5);
    assert.ok(Math.abs(parseFloat(at) - parseFloat(styleOf(mThumb!, 'left')!)) < 0.5);
    assert.equal(text(value!), text(mValue!));
    assert.equal(text(value!), '+1.5 dB');
    assert.equal(hs!.attrs.role, 'slider');
    assert.equal(hs!.attrs['aria-valuenow'], '1500');
    assert.equal(hs!.attrs['aria-valuetext'], '+1.5 dB');
    assert.equal(hs!.attrs['data-testid'], 'inspector-volume');
    assert.equal(value!.attrs['data-testid'], 'inspector-volume-value');
  }
  for (const [milliDb, shown] of [[-6500, '-6.5 dB'], [-650, '-0.7 dB'], [0, '0.0 dB'], [-2147483648, '-inf dB']] as const) {
    for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
      const [row] = findAll(render([{ ...vox(), gainMilliDb: milliDb }], { locale }), byClass('i-row'));
      assert.equal(text(elements(row!)[2]!), shown, locale);
    }
  }
});

test('the pan row: the label, .hs with its thumb only, the value as C, L35, R100', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const [, pan] = findAll(render([vox()], { locale }), byClass('i-row'));
    const [, mPan] = findAll(mockupZone(lang), byClass('i-row'));
    assert.deepEqual(elements(pan!).map(sig), elements(mPan!).map(sig));
    const [label, hs, value] = elements(pan!);
    const [mLabel, mHs, mValue] = elements(mPan!);
    assert.equal(text(label!), text(mLabel!), locale);
    assert.deepEqual(withoutTooltip(hs!).map(sig), elements(mHs!).map(sig));
    assert.deepEqual(withoutTooltip(hs!).map(sig), ['u']);
    assert.equal(parseFloat(styleOf(withoutTooltip(hs!)[0]!, 'left')!), parseFloat(styleOf(elements(mHs!)[0]!, 'left')!));
    assert.equal(text(value!), text(mValue!));
    assert.equal(hs!.attrs['data-testid'], 'inspector-pan');
  }
  for (const [pan, shown, left] of [[-3500, 'L35', '32.5%'], [10_000, 'R100', '100.0%'], [-10_000, 'L100', '0.0%']] as const) {
    const [, row] = findAll(render([{ ...vox(), pan }]), byClass('i-row'));
    const [, hs, value] = elements(row!);
    assert.equal(text(value!), shown);
    assert.equal(hs!.attrs['aria-valuetext'], shown);
    assert.equal(styleOf(withoutTooltip(hs!)[0]!, 'left'), left);
  }
});

test('the five pending sections keep their rows as empty boxes, the open two and the shut three; Agent changes is sec()', () => {
  const app = render([vox()]);
  const holds = findAll(app, byClass('inspector-hold'));
  // Agent changes landed with m5b-ui-ghosts: its section is the mockup's sec() (the next tests).
  const mockup = findAll(mockupZone(), byClass('sec')).filter((sec) => sec.attrs['data-part'] !== 'inspector-agent-changes');
  assert.equal(holds.length, 5);
  assert.equal(mockup.length, 5);
  for (const [i, hold] of holds.entries()) {
    assertEmptyBox(hold, `section ${i + 1}`);
    const id = mockup[i]!.attrs['data-part']!;
    assert.ok(pending(id), `${id} is pending`);
    // Its box: the section's name, shut when the mockup draws it shut.
    const name = id.replace(/^inspector-/, '');
    assert.ok(classes(hold).includes(name), `${id}: .${name}`);
    assert.equal(classes(hold).includes('shut'), classes(mockup[i]!).includes('shut'), `${id}: shut`);
  }
});

test('the foot: the Track tab and the empty box of Editor', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    for (const tracks of [[vox()], []]) {
      const foot = find(render(tracks, { locale, trackId: tracks[0]?.id ?? null }), byClass('z-foot'));
      const mFoot = find(mockupZone(lang), byClass('z-foot'));
      assert.deepEqual(elements(foot).map(sig), elements(mFoot).map(sig));
      const [track, editor] = elements(foot);
      assert.equal(text(track!), text(elements(mFoot)[0]!), locale);
      assertEmptyBox(editor!, 'the Editor tab');
    }
  }
});

test('the ids are the mockup\'s minus the pending parts\', and no pending id is anywhere', () => {
  const app = render([vox()]);
  const ids = (root: Element) => findAll(root, byAttr('data-part')).map((el) => el.attrs['data-part']!).sort();
  assert.deepEqual(ids(app), ids(mockupZone()).filter((id) => !pending(id)));
  assert.deepEqual(ids(app), ['inspector-agent-changes', 'inspector-buttons', 'inspector-head', 'inspector-mute', 'inspector-name', 'inspector-pan', 'inspector-solo', 'inspector-tabs', 'inspector-track', 'inspector-volume'].sort());
});

test('with no track selected, or a track gone, the zone shows its head and foot and nothing between them', () => {
  for (const trackId of [null, 'trk_gone']) {
    const app = render([vox()], { trackId });
    assert.deepEqual(elements(app).map(sig), ['div.z-head', 'div.z-foot'], String(trackId));
    assert.equal(findAll(app, (el) => el.attrs.role === 'slider').length, 0);
  }
});

test('a selection change shows the other track', () => {
  const other: TrackEntity = { ...track('trk_b'), name: 'Kick', gainMilliDb: -4000, pan: 2500, mute: true };
  const app = render([vox(), other], { trackId: 'trk_b' });
  assert.equal(text(elements(find(app, byClass('i-name')))[1]!), 'Kick');
  const [volume, pan] = findAll(app, byClass('i-row'));
  assert.equal(text(elements(volume!)[2]!), '-4.0 dB');
  assert.equal(text(elements(pan!)[2]!), 'R25');
  assert.ok(classes(find(app, byAttr('data-part', 'inspector-mute'))).includes('on'));
});

test('reduced capabilities remove the controls, and their boxes stay', () => {
  const noMuteSolo: Capabilities = { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_mute' && c !== 'track.set_solo') };
  const btns = find(render([vox()], { caps: noMuteSolo }), byClass('i-btns'));
  assert.equal(findAll(btns, (el) => el.tag === 'button').length, 0);
  assert.equal(elements(btns).length, 7);
  for (const box of elements(btns)) assertEmptyBox(box, 'an unlisted button');
  const bare = render([vox()], { caps: null });
  assert.equal(findAll(bare, (el) => el.attrs.role === 'slider').length, 0);
  // The rows keep their label and value; the slider's place is an empty box.
  for (const row of findAll(bare, byClass('i-row'))) {
    assert.equal(elements(row).length, 3);
    assertEmptyBox(elements(row)[1]!, 'an unlisted slider');
  }
});

// ---- m5b-ui-ghosts (UI redesign 4.2, 4.4): the Agent changes section is
// sec('Agent changes'): .sec > .sec-h (chevron, title, the empty right span)
// and .sec-b with one .hist row per applied plan that touched the track ("rN ·
// <the step> by <b>plan name</b>"), then the pending line, or "No pending
// change on this track.". The Volume and Pan rows carry the pending values as
// added elements.

function renderReview(tracks: TrackEntity[], trackId: string, ghosts: readonly Ghost[], locale?: Locale): Element {
  const plans = new PlanStore({ now: () => 0 });
  plans.fromList({ plans: mockupPlans().map((p) => p.raw) });
  const plan = plans.getSnapshot().byHash.get(PENDING);
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={FULL}>
      <GhostContext.Provider value={{ ghosts, outline: null, pin: () => undefined, plan }}>
        <Inspector client={fakeClient(tracks)} gestures={gestures} trackId={trackId} plans={plans} />
      </GhostContext.Provider>
    </CapabilitiesContext.Provider>
  );
  const before = localeStore();
  if (locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return parse(renderToStaticMarkup(node));
  } finally {
    installLocaleStore(before);
  }
}

const keysTrack = (): TrackEntity => ({ ...track(T.keys), name: 'Keys', gainMilliDb: -8000, pan: -3500 });
const voxTrack = (): TrackEntity => ({ ...track(T.lead), name: 'Vox Lead', gainMilliDb: 1500 });

test('Agent changes is sec(): its head, and a .hist row per applied plan that touched the track, then the pending line', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const zone = renderReview([keysTrack()], T.keys, [{ kind: 'pan', step: 4, trackId: T.keys, before: -3500, after: -2000 }], locale);
    const app = find(zone, byAttr('data-part', 'inspector-agent-changes'));
    const mockup = find(mockupZone(lang), byAttr('data-part', 'inspector-agent-changes'));
    assert.equal(sig(app), sig(mockup));
    assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
    const [head, body] = elements(app);
    const [mHead] = elements(mockup);
    assert.deepEqual(elements(head!).map(sig), elements(mHead!).map(sig));
    assert.equal(text(head!), text(mHead!), locale);
    const rows = elements(body!);
    assert.ok(rows.every((row) => sig(row) === 'div.hist'));
    // The applied plan of the mockup's history changed Keys' pan at r31.
    const t = translator(locale);
    const plan = mockupPlans()[2]!;
    const name = planName(plan, t, namesFromSnapshot(null))!;
    const [applied, pendingRow] = rows;
    assert.equal(text(find(applied!, byClass('mono'))), 'r31');
    assert.equal(text(find(applied!, (el) => el.tag === 'b')), name.lead);
    assert.ok(text(applied!).includes(name.steps), locale);
    assert.ok(text(pendingRow!).includes('4'), 'the pending step\'s number');
  }
});

test('a track no plan touched or will touch reads the mockup\'s "No pending change on this track."; the section is in the window with any track selected', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const app = find(renderReview([voxTrack()], T.lead, [], locale), byAttr('data-part', 'inspector-agent-changes'));
    const mockRows = elements(elements(find(mockupZone(lang), byAttr('data-part', 'inspector-agent-changes')))[1]!);
    const rows = elements(elements(app)[1]!);
    assert.equal(text(rows.at(-1)!), text(mockRows.at(-1)!), locale);
    assert.equal(styleOf(rows.at(-1)!, 'color'), styleOf(mockRows.at(-1)!, 'color'));
  }
  // The hold of the section is gone.
  assert.equal(findAll(render([vox()]), byClass('agent-changes')).length, 0);
});

test('the Volume and Pan rows show a pending value beside the current one; a rename shows both names', () => {
  const zone = renderReview([keysTrack()], T.keys, [
    { kind: 'gain', step: 3, trackId: T.keys, before: -8000, after: -6000 },
    { kind: 'pan', step: 4, trackId: T.keys, before: -3500, after: -2000 },
    { kind: 'rename', step: 5, trackId: T.keys, before: 'Keys', after: 'Rhodes' },
  ]);
  const [volume, pan] = findAll(zone, byClass('i-row'));
  assert.equal(text(find(volume!, byClass('ghost-to'))), '→ -6.0 dB');
  assert.equal(text(find(pan!, byClass('ghost-to'))), '→ L20');
  assert.equal(text(find(zone, byAttr('data-testid', 'inspector-track'))), 'Keys → Rhodes');
});

test('a stored gain above +6 dB pins the thumb at the end and warns on the value', () => {
  const [row] = findAll(render([{ ...vox(), gainMilliDb: 9000 }]), byClass('i-row'));
  const [, hs, value] = elements(row!);
  assert.equal(styleOf(withoutTooltip(hs!)[1]!, 'left'), '100.0%');
  assert.equal(text(value!), '+9.0 dB');
  assert.ok(classes(value!).includes('warn'));
  assert.ok(classes(hs!).includes('warn'));
});
