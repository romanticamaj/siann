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
import { toPosition } from '../../src/renderer/mixer/value-gesture';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { BusEntity, ClipEntity, PluginSlotEntity, SendEntity, TrackEntity } from '../../src/renderer/model/document';
import { bus, send } from './support/buses';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { InsertsContext, type InsertsHost } from '../../src/renderer/mixer/inserts-context';
import type { PickerController } from '../../src/renderer/mixer/picker';
import { parseEngineStatus } from '../../src/renderer/model/engine-status';
import type { PluginActions } from '../../src/renderer/model/plugin-actions';
import { Inspector } from '../../src/renderer/shell/Inspector';
import { RecordContext } from '../../src/renderer/shell/record-context';
import { recordHost } from './support/record-host';
import { translator } from '../../src/renderer/i18n/t';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { GhostContext } from '../../src/renderer/plans/ghost-context';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { planNameParts } from '../../src/renderer/plans/plan-name';
import { BAR, hashOf, mockupPlans, PENDING, RISER, T } from './support/mockup-plan';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';
import { clip, snapshotOf, track } from './support/timeline';

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

function fakeClient(tracks: TrackEntity[], clips: readonly ClipEntity[] = [], slots: readonly PluginSlotEntity[] = [], buses: readonly BusEntity[] = [], sends: readonly SendEntity[] = []) {
  const base = snapshotOf(tracks.map((t) => t.id), tracks, [], clips);
  // m5b-ui-sends-buses: the buses (root.busOrder in their order) and the sends.
  const root = { ...base.root!, ...(buses.length > 0 ? { busOrder: buses.map((b) => b.id) } : {}) };
  const rows = [...buses.map((b) => [`bus:${b.id}`, b] as const), ...sends.map((s) => [`send:${s.id}`, s] as const)];
  const snap = { ...base, root, buses, sends, busOrder: root.busOrder ?? [], entities: { ...base.entities, 'root:root': root, ...Object.fromEntries(slots.map((s) => [`plugin_slot:${s.id}`, s])), ...Object.fromEntries(rows) } };
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
function render(tracks: TrackEntity[], options: { trackId?: string | null; caps?: Capabilities | null; locale?: Locale; slots?: readonly PluginSlotEntity[]; ghosts?: readonly Ghost[]; buses?: readonly BusEntity[]; sends?: readonly SendEntity[] } = {}): Element {
  const trackId = options.trackId === undefined ? (tracks[0]?.id ?? null) : options.trackId;
  const caps = options.caps === undefined ? FULL : options.caps;
  const client = fakeClient(tracks, [], options.slots ?? [], options.buses ?? [], options.sends ?? []);
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={caps}>
      <RecordContext.Provider value={recordHost(client.model.getSnapshot(), caps)}>
        <GhostContext.Provider value={{ ghosts: options.ghosts ?? [], outline: null, pin: () => undefined }}>
          <Inspector client={client} gestures={gestures} trackId={trackId} />
        </GhostContext.Provider>
      </RecordContext.Provider>
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

test('the buttons: M and S as .msr.m and .msr.s with .on from the track, record and monitor (m5b-ui-recording), then the boxes of read, write and e', () => {
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
    // Record enable and monitor landed with m5b-ui-recording (recording-port.test.tsx).
    const [record, monitor, ...rest] = boxes;
    assert.equal(record!.attrs['data-part'], 'inspector-record');
    assert.equal(monitor!.attrs['data-part'], 'inspector-monitor');
    assert.equal(rest.length, 3);
    for (const box of rest) {
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

test('the one pending section keeps its row as an empty box, shut as the mockup draws it; the others are sec()', () => {
  const app = render([vox()]);
  const holds = findAll(app, byClass('inspector-hold'));
  // Agent changes landed with m5b-ui-ghosts, Inserts with m5b-ui-inserts-master, Notepad with m5b-ui-notepad,
  // Routing and Sends with m5b-ui-sends-buses: their sections are the mockup's sec() (the next tests, notepad-port).
  const landed = ['inspector-agent-changes', 'inspector-inserts', 'inspector-notepad', 'inspector-routing', 'inspector-sends'];
  const mockup = findAll(mockupZone(), byClass('sec')).filter((sec) => !landed.includes(sec.attrs['data-part']!));
  assert.equal(holds.length, 1);
  assert.equal(mockup.length, 1);
  for (const [i, hold] of holds.entries()) {
    const id = mockup[i]!.attrs['data-part']!;
    assertEmptyBox(hold, `section ${i + 1}`);
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
  assert.deepEqual(ids(app), ['inspector-agent-changes', 'inspector-buttons', 'inspector-head', 'inspector-inserts', 'inspector-monitor', 'inspector-mute', 'inspector-name', 'inspector-notepad', 'inspector-pan', 'inspector-record', 'inspector-routing', 'inspector-sends', 'inspector-solo', 'inspector-tabs', 'inspector-track', 'inspector-volume'].sort());
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
  // Without mute, solo and recording (m5b-ui-recording) every button of the row is a box.
  const noMuteSolo: Capabilities = {
    ...FULL,
    commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_mute' && c !== 'track.set_solo'),
    features: { ...FULL.features, recording: false, monitoring: false },
  };
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

interface ReviewOptions {
  readonly clips?: readonly ClipEntity[];
  // The ticked steps of the plan under review (0-based; null: all).
  readonly ticked?: ReadonlySet<number> | null;
  // More plans for the store, as plan.list gives them.
  readonly extra?: readonly unknown[];
}

function renderReview(tracks: TrackEntity[], trackId: string, ghosts: readonly Ghost[], locale?: Locale, options: ReviewOptions = {}): Element {
  const plans = new PlanStore({ now: () => 0 });
  plans.fromList({ plans: [...mockupPlans().map((p) => p.raw), ...(options.extra ?? [])] });
  const plan = plans.getSnapshot().byHash.get(PENDING);
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={FULL}>
      <GhostContext.Provider value={{ ghosts, outline: null, pin: () => undefined, plan, ticked: options.ticked ?? null }}>
        <Inspector client={fakeClient(tracks, options.clips)} gestures={gestures} trackId={trackId} plans={plans} />
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
    // The mockup's applied plan carries a title, so it leads the row (m5b-ui-plan-metadata).
    const name = planNameParts(plan, t, namesFromSnapshot(null), capabilitySelector(FULL))!;
    assert.equal(name.lead, plan.title);
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
  // The current value without its unit, then the pending one: 4.2's "the value
  // shows both" in the value column, which shell.css lets grow (ghosts.spec.ts
  // checks nothing is cut off).
  const value = (row: Element) => find(row, (el) => el.tag === 'b');
  assert.equal(text(value(volume!)), '-8.0 → -6.0 dB');
  assert.equal(text(find(volume!, byClass('ghost-to'))), '→ -6.0 dB');
  assert.equal(text(value(pan!)), 'L35 → L20');
  assert.equal(text(find(pan!, byClass('ghost-to'))), '→ L20');
  assert.equal(text(find(zone, byAttr('data-testid', 'inspector-track'))), 'Keys → Rhodes');
  assert.deepEqual(elements(find(zone, byClass('ghost-rename'))).map(sig), ['span.ghost-was', 'span.ghost-arrow', 'span.ghost-name']);
  // Without a ghost the values keep their unit.
  const [plainVolume] = findAll(renderReview([keysTrack()], T.keys, []), byClass('i-row'));
  assert.equal(text(value(plainVolume!)), '-8.0 dB');
});

// 4.2: a pending gain puts a ghost cap on the Volume slider at the new
// position, joined to the real one; a pending pan a violet tick on the Pan
// slider. The marks are the ticked steps' (the ghost list is), aria-hidden,
// and go with the ghosts.
test('the Volume slider carries a ghost thumb at each pending gain, joined to the thumb before it; the Pan slider a violet tick', () => {
  const at = (kind: 'gain' | 'pan', value: number) => `${(toPosition(kind, value) * 100).toFixed(1)}%`;
  const span = (kind: 'gain', from: number, to: number) => ((toPosition(kind, to) - toPosition(kind, from)) * 100).toFixed(1);
  const zone = renderReview([keysTrack()], T.keys, [
    { kind: 'gain', step: 3, trackId: T.keys, before: -8000, after: -6000 },
    { kind: 'gain', step: 6, trackId: T.keys, before: -6000, after: 0 },
    { kind: 'pan', step: 4, trackId: T.keys, before: -3500, after: -2000 },
  ]);
  const volume = find(zone, byAttr('data-testid', 'inspector-volume'));
  const pan = find(zone, byAttr('data-testid', 'inspector-pan'));
  // The marks sit before the thumb, so the fill and the thumb stay the mockup's <i> and <u>.
  assert.deepEqual(withoutTooltip(volume).map(sig), ['i', 'span.ghost-line', 'span.ghost-thumb', 'span.ghost-line', 'span.ghost-thumb', 'u']);
  assert.deepEqual(withoutTooltip(pan).map(sig), ['span.ghost-tick', 'u']);
  const [, line3, thumb3, line6, thumb6] = withoutTooltip(volume);
  // Step 3 runs from the real thumb (-8.0 dB) to -6.0 dB; step 6 on from there to 0.0 dB.
  assert.equal(styleOf(thumb3!, 'left'), at('gain', -6000));
  assert.equal(styleOf(line3!, 'left'), at('gain', -8000));
  assert.equal(parseFloat(styleOf(line3!, 'width')!).toFixed(1), span('gain', -8000, -6000));
  assert.equal(styleOf(thumb6!, 'left'), at('gain', 0));
  assert.equal(styleOf(line6!, 'left'), at('gain', -6000));
  assert.equal(parseFloat(styleOf(line6!, 'width')!).toFixed(1), span('gain', -6000, 0));
  const [tick] = withoutTooltip(pan);
  assert.equal(styleOf(tick!, 'left'), at('pan', -2000));
  // Hidden from assistive technology (the value text says both values), each with its step.
  for (const [el, step] of [[line3, '3'], [thumb3, '3'], [line6, '6'], [thumb6, '6'], [tick, '4']] as const) {
    assert.equal(el!.attrs['aria-hidden'], 'true');
    assert.equal(el!.attrs['data-ghost'], step);
  }
  assert.equal(thumb3!.attrs['data-testid'], 'inspector-volume-ghost-3');
  assert.equal(tick!.attrs['data-testid'], 'inspector-pan-ghost-4');
  // The sliders' own values are the track's, not the plan's.
  assert.equal(volume.attrs['aria-valuenow'], '-8000');
  assert.equal(pan.attrs['aria-valuenow'], '-3500');
  // Step 3 unticked: only step 6's mark, joined to the real thumb (its before is then the track's value).
  const one = withoutTooltip(find(renderReview([keysTrack()], T.keys, [{ kind: 'gain', step: 6, trackId: T.keys, before: -8000, after: 0 }]), byAttr('data-testid', 'inspector-volume')));
  assert.deepEqual(one.map(sig), ['i', 'span.ghost-line', 'span.ghost-thumb', 'u']);
  assert.equal(styleOf(one[1]!, 'left'), at('gain', -8000));
  // A ghost with no known before starts at the real thumb too.
  const unknown = withoutTooltip(find(renderReview([keysTrack()], T.keys, [{ kind: 'gain', step: 3, trackId: T.keys, before: null, after: -6000 }]), byAttr('data-testid', 'inspector-volume')));
  assert.equal(styleOf(unknown[1]!, 'left'), at('gain', -8000));
  // The ghosts toggled off (the plan still pending) or no ghost: the mockup's sliders alone.
  const off = renderReview([keysTrack()], T.keys, []);
  assert.deepEqual(withoutTooltip(find(off, byAttr('data-testid', 'inspector-volume'))).map(sig), ['i', 'u']);
  assert.deepEqual(withoutTooltip(find(off, byAttr('data-testid', 'inspector-pan'))).map(sig), ['u']);
  // Another track's ghosts stay off this track's sliders.
  const other = renderReview([keysTrack(), voxTrack()], T.lead, [{ kind: 'gain', step: 3, trackId: T.keys, before: -8000, after: -6000 }]);
  assert.equal(findAll(other, byClass('ghost-thumb')).length, 0);
});

test('the slider ghost marks are drawn on the --ai tokens, the thumb in the strip\'s .cap.ghost look (shell.css)', () => {
  const renderer = path.resolve(__dirname, '..', '..', '..', 'renderer');
  const css = fs.readFileSync(path.join(renderer, 'shell.css'), 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start + selector.length + 2, css.indexOf('}', start));
  };
  const squash = (decl: string) => decl.replace(/\s+/g, '');
  const capGhost = /\.cap\.ghost\{([^}]*)\}/.exec(fs.readFileSync(path.join(renderer, 'ui', 'lower-zone.css'), 'utf8'))![1]!;
  const thumb = squash(rule('.hs > .ghost-thumb'));
  // The strip's ghost cap's hatch, dashed violet edge and glow, declaration for declaration.
  for (const decl of capGhost.split(';')) assert.ok(thumb.includes(squash(decl)), decl);
  for (const selector of ['.hs > .ghost-line', '.hs > .ghost-tick', '.hs > .ghost-tick::after']) assert.match(rule(selector), /background: var\(--ai\)/, selector);
  // No literal colour: the --ai tokens only.
  for (const selector of ['.hs > .ghost-thumb', '.hs > .ghost-line', '.hs > .ghost-tick', '.hs > .ghost-tick::after']) assert.doesNotMatch(rule(selector), /#[0-9a-f]{3,8}\b|rgb\(/i, selector);
});

test('a pending mute or solo puts the dashed ring on the Inspector\'s M or S (.msr.ghost), as on the header and the strip', () => {
  const zone = renderReview([keysTrack()], T.keys, [
    { kind: 'mute', step: 3, trackId: T.keys, before: false, after: true },
    { kind: 'solo', step: 4, trackId: T.keys, before: false, after: true },
  ]);
  const mute = find(zone, byAttr('data-testid', 'inspector-mute'));
  const solo = find(zone, byAttr('data-testid', 'inspector-solo'));
  assert.deepEqual(classes(mute).sort(), ['ghost', 'm', 'msr']);
  assert.deepEqual(classes(solo).sort(), ['ghost', 'msr', 's']);
  assert.equal(mute.attrs['data-ghost'], '3');
  assert.equal(solo.attrs['data-ghost'], '4');
  const plain = renderReview([keysTrack()], T.keys, [{ kind: 'solo', step: 4, trackId: T.keys, before: false, after: true }]);
  assert.ok(!classes(find(plain, byAttr('data-testid', 'inspector-mute'))).includes('ghost'));
});

const fxTrack = (): TrackEntity => ({ ...track(T.fx), name: 'FX', gainMilliDb: -12000, mute: true });
const riser = () => clip(RISER, T.fx, 'med_fx', String(5 * BAR), '0', String(2 * BAR));
const pendingRows = (zone: Element) => findAll(find(zone, byAttr('data-part', 'inspector-agent-changes')), byAttr('data-testid')).map((el) => el.attrs['data-testid']!).filter((id) => id.startsWith('agent-pending-'));

test('what is pending on a track is every ticked step of the plan under review on it, its clips\' steps too, with the ghosts shown or not', () => {
  // Step 5 unmutes FX, step 6 moves the Riser, a clip on FX (the step names the clip only).
  const shown = renderReview([fxTrack()], T.fx, [{ kind: 'mute', step: 5, trackId: T.fx, before: true, after: false }], undefined, { clips: [riser()] });
  assert.deepEqual(pendingRows(shown), ['agent-pending-5', 'agent-pending-6']);
  // The ghosts toggled off (Ctrl+Alt+G): the plan is still pending.
  const hidden = renderReview([fxTrack()], T.fx, [], undefined, { clips: [riser()] });
  assert.deepEqual(pendingRows(hidden), ['agent-pending-5', 'agent-pending-6']);
  // An unticked step is not what approving would do.
  const ticked = renderReview([fxTrack()], T.fx, [], undefined, { clips: [riser()], ticked: new Set([0, 1, 2, 3, 5]) });
  assert.deepEqual(pendingRows(ticked), ['agent-pending-6']);
  // A track whose only pending change is a clip's: its row, not "No pending change".
  const onlyClip = renderReview([fxTrack()], T.fx, [], undefined, { clips: [riser()], ticked: new Set([5]) });
  assert.deepEqual(pendingRows(onlyClip), ['agent-pending-6']);
  assert.ok(!text(find(onlyClip, byAttr('data-part', 'inspector-agent-changes'))).includes('No pending change'));
});

test('an applied plan that only changed a track\'s clips is listed as touching it', () => {
  const trimmed = { schema: 'siann.plan.v1', hash: hashOf('e'), state: 'applied', appliedRevision: 'r35', baseRevision: 'r34', steps: [{ op: 'clip.trim', clipId: RISER, sourceStart: '0', length: String(BAR) }], readSet: [], writeSet: [], stale: [] };
  const zone = renderReview([fxTrack()], T.fx, [], undefined, { clips: [riser()], extra: [trimmed] });
  const row = find(zone, byAttr('data-testid', `agent-change-${'e'.repeat(8)}`));
  assert.equal(text(find(row, byClass('mono'))), 'r35');
  // A plan that touched neither the track nor its clips is not.
  assert.equal(findAll(renderReview([keysTrack()], T.keys, [], undefined, { clips: [riser()], extra: [trimmed] }), byAttr('data-testid', `agent-change-${'e'.repeat(8)}`)).length, 0);
});

// ---- m5b-ui-inserts-master: the Inserts section, the mockup's
// sec('Inserts', ...): .sec with its head (the chevron, the title, the count),
// .sec-b with a .islot per slot in the track's inserts order, each holding
// the mockup's <em>e</em> (the e control's place) and the added bypass and
// Remove, then one .islot.empty "+ Add insert". Without plugins, the section
// is a Hold box sized by a shell.css calc().

const islot = (id: string, name: string, bypass = false): PluginSlotEntity => ({
  schema: 'siann.entity.plugin_slot.v1',
  id,
  trackId: 'trk_a',
  format: 'clap',
  uid: `org.test.${id}`,
  name,
  path: `/plugins/${id}.clap`,
  bypass,
});

test('the Inserts section is sec(\'Inserts\'): its head with the count, a .islot per slot with its e, then one .islot.empty', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const withTwo: TrackEntity = { ...vox(), inserts: ['slt_2', 'slt_1'] };
    const app = find(render([withTwo], { locale, slots: [islot('slt_1', 'Comp'), islot('slt_2', 'De-ess')] }), byAttr('data-part', 'inspector-inserts'));
    const mockup = find(mockupZone(lang), byAttr('data-part', 'inspector-inserts'));
    assert.equal(sig(app), sig(mockup));
    assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
    const [head, body] = elements(app);
    const [mHead, mBody] = elements(mockup);
    assert.deepEqual(elements(head!).map(sig), elements(mHead!).map(sig));
    assert.equal(text(head!), text(mHead!), `${locale}: the title and the count 2`);
    assert.deepEqual(elements(body!).map(sig), elements(mBody!).map(sig));
    const [first, second, empty] = elements(body!);
    const [mFirst, , mEmpty] = elements(mBody!);
    assert.equal(text(find(first!, byClass('islot-name'))), 'De-ess', 'signal order');
    assert.equal(text(find(second!, byClass('islot-name'))), 'Comp');
    // The mockup's em is the e control's place.
    const em = find(first!, (el) => el.tag === 'em');
    assert.equal(text(em), text(find(mFirst!, (el) => el.tag === 'em')));
    const e = find(em, (el) => el.tag === 'button');
    assert.equal(e.attrs['data-testid'], 'islot-edit-slt_2');
    assert.equal(text(e), 'e');
    assert.equal(find(first!, byAttr('data-testid', 'islot-bypass-slt_2')).attrs['aria-pressed'], 'false');
    assert.ok(findAll(first!, byAttr('data-testid', 'islot-remove-slt_2')).length === 1);
    assert.equal(text(empty!), text(mEmpty!), `${locale}: + Add insert`);
    assert.equal(empty!.attrs.role, 'button');
  }
});

test('the Inserts section lists every slot without a limit, then one empty slot', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const many: TrackEntity = { ...vox(), inserts: ids };
  const body = find(find(render([many], { slots: ids.map((id) => islot(id, id.toUpperCase())) }), byAttr('data-part', 'inspector-inserts')), byClass('sec-b'));
  assert.deepEqual(elements(body).map(sig), [...ids.map(() => 'div.islot'), 'div.empty.islot']);
  assert.equal(text(find(find(render([vox()]), byAttr('data-part', 'inspector-inserts')), byClass('sec-h'))).endsWith('0'), true, 'a track without inserts counts 0');
});

test('without plugins the Inserts section is an empty box kept by its calc() rule, with no id', () => {
  const noPlugins = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-no-plugins.json'), 'utf8')) as Capabilities;
  const app = render([vox()], { caps: noPlugins });
  assert.equal(findAll(app, byAttr('data-part', 'inspector-inserts')).length, 0);
  const holds = findAll(app, byClass('inspector-hold'));
  const inserts = holds.find((h) => classes(h).includes('inserts'));
  assert.ok(inserts, 'the inserts box');
  assertEmptyBox(inserts, 'the Inserts box');
  // Its size: the shell.css calc() of the tokens the shared rules size the section with (117 px in the mockup).
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.inspector-hold\.inserts \{ height: calc\(var\(--section-head-h\) \+ var\(--hairline\) \+ var\(--space-7q\) \+ var\(--space-9q\) \+ 3 \* var\(--control-h\) \+ 2 \* var\(--space\)\); \}/);
});

test('a missing plugin shows its state with the engine\'s code (engine.status plugins[])', () => {
  const withOne: TrackEntity = { ...vox(), inserts: ['slt_1'] };
  const status = parseEngineStatus({
    device: null,
    xruns: '0',
    plugins: [{ slotId: 'slt_1', trackId: 'trk_a', format: 'clap', uid: 'org.x', state: 'missing', error: { code: 'plugin_not_approved', message: 'org.x is not approved' } }],
  });
  const actions = { editorOpen: () => false, subscribe: () => () => undefined, getVersion: () => 0 } as unknown as PluginActions;
  const host = { actions, picker: {} as PickerController, status: { subscribe: () => () => undefined, getSnapshot: () => status } } as unknown as InsertsHost;
  const markup = parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={FULL}>
        <InsertsContext.Provider value={host}>
          <Inspector client={fakeClient([withOne], [], [islot('slt_1', 'Comp')])} gestures={gestures} trackId="trk_a" />
        </InsertsContext.Provider>
      </CapabilitiesContext.Provider>,
    ),
  );
  const slot = find(markup, byAttr('data-testid', 'islot-slt_1'));
  assert.ok(classes(slot).includes('missing'));
  assert.equal(slot.attrs['data-state'], 'missing');
  assert.equal(text(find(slot, byClass('islot-state'))), 'plugin_not_approved');
  assert.equal(slot.attrs.title, 'Comp · plugin_not_approved: org.x is not approved');
});

test('a slot ghost in the Inspector: a dashed slot numbered by its step, a dimmed removal, a ring on bypass', () => {
  const withTwo: TrackEntity = { ...vox(), inserts: ['slt_1', 'slt_2'] };
  const ghosts: Ghost[] = [
    { kind: 'insert-remove', step: 2, trackId: 'trk_a', slotId: 'slt_1' },
    { kind: 'insert-bypass', step: 3, trackId: 'trk_a', slotId: 'slt_2', before: false, after: true },
    { kind: 'insert-add', step: 4, trackId: 'trk_a', slotId: 'slt_7', name: 'Limiter', index: 2 },
  ];
  const body = find(find(render([withTwo], { slots: [islot('slt_1', 'Comp'), islot('slt_2', 'EQ')], ghosts }), byAttr('data-part', 'inspector-inserts')), byClass('sec-b'));
  assert.deepEqual(elements(body).map(sig), ['div.ghost-removed.islot', 'div.islot', 'div.ghost.islot', 'div.empty.islot']);
  const [removed, bypassed, added] = elements(body);
  assert.equal(removed!.attrs['data-ghost'], '2');
  assert.ok(classes(find(bypassed!, byAttr('data-testid', 'islot-bypass-slt_2'))).includes('ghost'));
  assert.equal(text(find(added!, byClass('stepn'))), '4');
  assert.equal(text(find(added!, byClass('islot-name'))), 'Limiter');
});

test('a stored gain above +6 dB pins the thumb at the end and warns on the value', () => {
  const [row] = findAll(render([{ ...vox(), gainMilliDb: 9000 }]), byClass('i-row'));
  const [, hs, value] = elements(row!);
  assert.equal(styleOf(withoutTooltip(hs!)[1]!, 'left'), '100.0%');
  assert.equal(text(value!), '+9.0 dB');
  assert.ok(classes(value!).includes('warn'));
  assert.ok(classes(hs!).includes('warn'));
});

// ---- m5b-ui-sends-buses (UI redesign 3.0, 3.4; 10.11, 25). The Routing
// section is sec('Routing', ...): .sec > .sec-h, .sec-b with two .irow, each a
// label and a .pick (In: the input selector of m5b-ui-recording; Out: the
// output selector, the master and the buses in busOrder), data-part
// inspector-routing; a row that cannot be is an empty .irow box, and with
// neither the section is the calc() box. The Sends section is sec('Sends',
// body, count): a .islot per send in the track's sends order, then one
// .islot.empty "+ Add send", the count at the right of the head, data-part
// inspector-sends; open where the mockup draws it shut (the gate is report).
// Without features.sends or send.add it is the shut empty box.

const mockupSec = (id: string, lang = 'en') => find(mockupZone(lang), byAttr('data-part', id));

test('the Routing section is sec(\'Routing\'): its head, In and Out rows of a label and a .pick, against the mockup\'s markup', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const routed: TrackEntity = { ...vox(), output: { busId: 'bus_v' } };
    const app = find(render([routed], { locale, buses: [bus('bus_d', 'Delay'), bus('bus_v', 'Verb')] }), byAttr('data-part', 'inspector-routing'));
    const mockup = mockupSec('inspector-routing', lang);
    assert.equal(sig(app), sig(mockup));
    assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
    const [head, body] = elements(app);
    const [mHead, mBody] = elements(mockup);
    assert.deepEqual(elements(head!).map(sig), elements(mHead!).map(sig));
    assert.equal(text(head!), text(mHead!), `${locale}: the title`);
    assert.deepEqual(elements(body!).map(sig), elements(mBody!).map(sig));
    assert.deepEqual(elements(body!).map(sig), ['div.irow', 'div.irow']);
    const [inRow, outRow] = elements(body!);
    const [, mOut] = elements(mBody!);
    for (const [row, m] of [[inRow!, elements(mBody!)[0]!], [outRow!, mOut!]] as const) {
      assert.deepEqual(elements(row).map(sig), elements(m).map(sig), locale);
      assert.equal(text(elements(row)[0]!), text(elements(m)[0]!), `${locale}: the label`);
      assert.ok(findAll(find(row, byClass('pick')), (el) => el.tag === 'svg').length === 1, 'the chevron');
    }
    assert.equal(outRow!.attrs['data-testid'], 'inspector-out-row');
    assert.equal(text(find(outRow!, byClass('pick-name'))), 'Verb');
    const select = find(outRow!, (el) => el.tag === 'select');
    assert.equal(select.attrs['data-testid'], 'inspector-output');
    assert.deepEqual(findAll(select, (el) => el.tag === 'option').map((o) => o.attrs.value), ['', 'bus_d', 'bus_v']);
  }
  // A track on the master reads the master's name.
  const master = find(render([vox()], { buses: [bus('bus_v', 'Verb')] }), byAttr('data-testid', 'inspector-out-row'));
  assert.equal(text(find(master, byClass('pick-name'))), 'Master');
});

test('the Routing section by capability: In only, Out only, both; neither is the calc() box with no id', () => {
  const noRecording: Capabilities = { ...FULL, features: { ...FULL.features, recording: false, monitoring: false } };
  const noBuses: Capabilities = { ...FULL, features: { ...FULL.features, buses: false, sends: false } };
  const neither: Capabilities = { ...noBuses, features: { ...noBuses.features, recording: false, monitoring: false } };
  const rows = (caps: Capabilities | null) => {
    const sec = findAll(render([vox()], { caps }), byAttr('data-part', 'inspector-routing'))[0];
    return sec ? elements(find(sec, byClass('sec-b'))) : null;
  };
  // Out only: the In row an empty .irow box.
  const outOnly = rows(noRecording)!;
  assert.deepEqual(outOnly.map(sig), ['div.irow', 'div.irow']);
  assertEmptyBox(outOnly[0]!, 'the In row without recording');
  assert.equal(outOnly[1]!.attrs['data-testid'], 'inspector-out-row');
  // In only: the Out row an empty .irow box.
  const inOnly = rows(noBuses)!;
  assert.equal(inOnly[0]!.attrs['data-testid'], 'inspector-in-row');
  assertEmptyBox(inOnly[1]!, 'the Out row without buses');
  // Neither: no section, the box of the shell.css calc() (the 91 px the mockup measures).
  for (const caps of [neither, null]) {
    assert.equal(rows(caps), null);
    const box = findAll(render([vox()], { caps }), byClass('inspector-hold')).find((h) => classes(h).includes('routing'));
    assert.ok(box, 'the routing box');
    assertEmptyBox(box, 'the Routing box');
  }
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.inspector-hold\.routing \{ height: calc\(var\(--section-head-h\) \+ var\(--hairline\) \+ var\(--space-7q\) \+ var\(--space-9q\) \+ 2 \* var\(--control-h\) \+ var\(--space\)\); \}/);
  assert.doesNotMatch(css, /--hold-inspector-routing-h/);
});

test('the Sends section is sec(\'Sends\', body, count): a .islot per send with its controls, then .islot.empty; the count at the head', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const sends = [send('snd_1', 'trk_a', 'bus_v', -6000, false, true), send('snd_2', 'trk_a', 'bus_d', 0, true, false)];
    const withTwo: TrackEntity = { ...vox(), sends: ['snd_2', 'snd_1'] };
    const app = find(render([withTwo], { locale, buses: [bus('bus_v', 'Verb'), bus('bus_d', 'Delay')], sends }), byAttr('data-part', 'inspector-sends'));
    const mockup = mockupSec('inspector-sends', lang);
    // The mockup draws it shut with no body; the app opens it with one (the report shows the difference).
    assert.ok(classes(mockup).includes('shut'));
    assert.equal(sig(app), 'div.sec');
    const [head, body] = elements(app);
    const [mHead] = elements(mockup);
    assert.deepEqual(elements(head!).map(sig), elements(mHead!).map(sig));
    assert.equal(text(head!), text(mHead!).replace(/0$/, '2'), `${locale}: the title and the count`);
    assert.deepEqual(elements(body!).map(sig), ['div.islot.off.send-pre.send-slot', 'div.islot.send-slot', 'div.empty.islot']);
    const [first, second, empty] = elements(body!);
    assert.equal(text(find(first!, byClass('islot-name'))), 'Delay', 'the track\'s sends order');
    assert.deepEqual(findAll(second!, (el) => el.tag === 'button').map((b) => b.attrs['data-testid']), ['islot-send-on-snd_1', 'islot-send-pre-snd_1', 'islot-send-remove-snd_1']);
    const level = find(second!, byClass('islot-name'));
    assert.equal(level.attrs.role, 'slider');
    assert.equal(level.attrs['aria-valuetext'], '-6.0 dB');
    assert.equal(empty!.attrs.role, 'button');
    assert.equal(empty!.attrs['data-testid'], 'islot-send-add-trk_a');
    assert.ok(text(empty!).startsWith('+ '), locale);
  }
  // No bus to send to: the empty slot is aria-disabled with the reason.
  const lone = find(find(render([vox()]), byAttr('data-part', 'inspector-sends')), byClass('empty'));
  assert.equal(lone.attrs['aria-disabled'], 'true');
  assert.equal(lone.attrs.title, 'Add a bus to send to');
});

test('without features.sends or send.add the Sends section is the shut empty box, with no id', () => {
  for (const caps of [
    { ...FULL, features: { ...FULL.features, sends: false } },
    { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'send.add') },
  ] as Capabilities[]) {
    const app = render([vox()], { caps, buses: [bus('bus_v', 'Verb')] });
    assert.equal(findAll(app, byAttr('data-part', 'inspector-sends')).length, 0);
    const box = findAll(app, byClass('inspector-hold')).find((h) => classes(h).includes('sends'))!;
    assert.ok(classes(box).includes('shut'));
    assertEmptyBox(box, 'the Sends box');
  }
});

test('a send ghost in the Inspector: a dashed slot numbered by its step; a removed send dims', () => {
  const ghosts: Ghost[] = [
    { kind: 'send-add', step: 4, sendId: 'snd_9', trackId: 'trk_a', busId: 'bus_v', busName: 'Verb' },
    { kind: 'send-remove', step: 5, sendId: 'snd_1', trackId: 'trk_a', busId: 'bus_v', cascade: true },
  ];
  const body = find(find(render([{ ...vox(), sends: ['snd_1'] }], { buses: [bus('bus_v', 'Verb')], sends: [send('snd_1', 'trk_a', 'bus_v')], ghosts }), byAttr('data-part', 'inspector-sends')), byClass('sec-b'));
  assert.deepEqual(elements(body).map(sig), ['div.ghost-removed.islot.send-slot', 'div.ghost.islot', 'div.empty.islot']);
  assert.equal(text(find(elements(body)[1]!, byClass('stepn'))), '4');
  assert.equal(elements(body)[0]!.attrs['data-ghost'], '5');
});
