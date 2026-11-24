// The MixConsole port (m5-ui-port-mixer-strip; UI redesign 10.9, 10.10 P1-12,
// 3.0, 3.4): the Mixer renders, per track, what the mockup's strip() returns,
// and the master strip as the mockup's master, on real data. The expectations
// come from the mockup's own script (support/mockup.ts) and from
// app/test/fidelity/manifest.json (which parts are pending), not from the code
// under test:
//
// - a strip's rows in strip()'s order and classes: .ins, .panrow (.lab,
//   svg.knob, .lab), .btns (.msr.m, .msr.s, the e box), .fad (.scale with its
//   seven labels at the taper's positions, .ftrack with .unity and .cap, .meter
//   with two .ch), .readout (the level and .pk), the second .btns, .nametag;
//   the track colour as --c; muted and sel; .on from mute and solo;
// - the master: .strip.master with .fad (.scale, an empty fader column,
//   .meter), the readout's peak value only and its name; every other row an
//   empty box;
// - the ids of the fidelity run (data-part-item / data-part-of, counted as
//   mockup-fidelity.spec.ts counts them) are the mockup's minus the pending
//   parts', and an empty box carries no id, role, focus or text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore } from '../../src/renderer/i18n/t';
import { Mixer } from '../../src/renderer/mixer/Mixer';
import { percent, Strip } from '../../src/renderer/mixer/Strip';
import { milliDbToPosition } from '../../src/renderer/mixer/taper';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { BusEntity, PluginSlotEntity, SendEntity, TrackEntity } from '../../src/renderer/model/document';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { MeterLegend } from '../../src/renderer/model/meter-frames';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { RecordContext } from '../../src/renderer/shell/record-context';
import { recordHost } from './support/record-host';
import { GhostContext, type GhostView } from '../../src/renderer/plans/ghost-context';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';
import { bus, busSnapshot, send } from './support/buses';
import { BusSelection } from '../../src/renderer/mixer/bus-selection';
import { trackColourVar } from '../../src/renderer/timeline/track-colour';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'test', 'fidelity', 'manifest.json'), 'utf8')) as {
  gates: Record<string, string>;
  rules: Array<{ match: string[]; gate: string }>;
};
const MOCKUP = loadMockup('en');
const LEGEND: MeterLegend = { epoch: '1', entities: ['master', 'track:trk_a', 'track:trk_b'] };

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const pending = (id: string) => {
  const rule = MANIFEST.rules.find((r) => r.match.some((p) => glob(p).test(id)));
  assert.ok(rule, `no manifest rule owns ${id}`);
  return MANIFEST.gates[rule.gate] === 'pending';
};

function fakeClient(snap: Snapshot, legend: MeterLegend | null = LEGEND) {
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => snap.entities[ref],
    subscribe: () => () => undefined,
  };
  return { model, getState: () => ({ status: 'connected', legend }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
}

const gestures = {} as unknown as GestureController;
const realtime = { subscribe: () => () => undefined } as unknown as RealtimeClient;

interface RenderOptions {
  selected?: string | null;
  caps?: Capabilities | null;
  locale?: Locale;
  // m5b-ui-inserts-master: the plugin slots in the session, and the Inserts rack switch.
  slots?: PluginSlotEntity[];
  racks?: { shown: 'routing' | 'inserts' | 'sends' | null };
  // m5b-ui-editor-channel: the track the Channel zone shows (its e lit).
  channelTrackId?: string | null;
}

function withSlots(snap: Snapshot, slots: readonly PluginSlotEntity[]): Snapshot {
  const entities = { ...snap.entities };
  for (const s of slots) entities[`plugin_slot:${s.id}`] = s;
  return { ...snap, entities, pluginSlots: [...slots] };
}

function render(tracks: TrackEntity[], options: RenderOptions = {}): Element {
  const snap = withSlots(snapshotOf(tracks.map((t) => t.id), tracks, [], []), options.slots ?? []);
  const caps = options.caps === undefined ? FULL : options.caps;
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={caps}>
      <RecordContext.Provider value={recordHost(snap, caps)}>
        <Mixer client={fakeClient(snap)} gestures={gestures} realtime={realtime} selectedTrackId={options.selected ?? null} racks={options.racks} channelTrackId={options.channelTrackId ?? null} onEditChannel={() => undefined} />
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

const strips = (root: Element) => findAll(root, byClass('strip'));
const mockupStrip = (i: number) => find(parse(MOCKUP.strip(MOCKUP.T[i]!, i)), byClass('strip'));
const mockupMaster = () => find(parse(MOCKUP.master), byClass('strip'));

// The ids the fidelity run reads from a strip: data-part on the mockup's, data-part-item / -of on the app's.
function mockupIds(strip: Element): string[] {
  return findAll(strip, byAttr('data-part')).map((el) => el.attrs['data-part']!).sort();
}
function appIds(strip: Element, key: string): string[] {
  const id = `${strip.attrs['data-part-item']}-${strip.attrs['data-part-key'] ?? key}`;
  const out = [id];
  const walk = (el: Element) => {
    for (const child of elements(el)) {
      if ('data-part-item' in child.attrs) continue;
      if ('data-part-of' in child.attrs) out.push(`${id}-${child.attrs['data-part-of']}`);
      walk(child);
    }
  };
  walk(strip);
  return out.sort();
}

// An empty box (UI redesign 3.0): no child, no text, no role, no focus, no id, hidden from assistive technology.
function assertEmptyBox(el: Element, what: string): void {
  assert.deepEqual(el.children, [], `${what}: nothing in it`);
  assert.equal(el.attrs['aria-hidden'], 'true', `${what}: aria-hidden`);
  for (const name of ['role', 'tabindex', 'data-part', 'data-part-of', 'data-part-item', 'data-testid']) assert.ok(!(name in el.attrs), `${what}: no ${name}`);
}

const kick = (): TrackEntity => ({ ...track('trk_a'), name: 'Kick' });
const snare = (): TrackEntity => ({ ...track('trk_b'), name: 'Snare', gainMilliDb: -2500 });

test('a strip has strip()\'s rows in its order and classes, the track colour as --c', () => {
  const app = strips(render([kick(), snare()]))[0]!;
  const mockup = mockupStrip(0);
  assert.equal(sig(app), sig(mockup));
  assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
  assert.deepEqual(elements(app).map(sig), ['div.ins', 'div.panrow', 'div.btns', 'div.fad', 'div.readout', 'div.btns', 'div.nametag']);
  // trk_a hashes to palette entry 8 (timeline-colour.test.ts).
  assert.equal(styleOf(app, '--c'), 'var(--track-8)');
  assert.equal(text(find(app, byClass('nametag'))), 'Kick');
});

test('the pan row: the PAN label as the mockup styles it, the knob, the value', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    // Keys in the mockup carries a ghost (m5b-ui-ghosts); the plain label is Kick's.
    const plain = find(find(parse(loadMockup(lang).strip(MOCKUP.T[0]!, 0)), byClass('strip')), byClass('panrow'));
    const keys: TrackEntity = { ...track('trk_a'), name: 'Keys', pan: -3500 };
    const app = find(strips(render([keys], { locale }))[0]!, byClass('panrow'));
    assert.deepEqual(elements(app).filter((el) => !classes(el).includes('value-tooltip')).map(sig), elements(plain).map(sig), locale);
    const [label, knob, value] = elements(app);
    const [mLabel] = elements(plain);
    for (const property of ['text-align', 'color', 'font-size']) assert.equal(styleOf(label!, property), styleOf(mLabel!, property), `${locale} ${property}`);
    assert.equal(text(label!), text(mLabel!), locale);
    assert.equal(knob!.tag, 'svg');
    assert.equal(knob!.attrs.role, 'slider');
    assert.equal(knob!.attrs['aria-valuetext'], 'L35');
    assert.equal(text(value!), 'L35');
  }
});

test('the buttons row: M and S as .msr.m and .msr.s, .on from the track, then e as strip()\'s .msr.e', () => {
  const muted: TrackEntity = { ...kick(), mute: true };
  const soloed: TrackEntity = { ...snare(), solo: true };
  const [a, b] = strips(render([muted, soloed]));
  for (const [strip, mute, solo] of [[a!, true, false], [b!, false, true]] as const) {
    const btns = find(strip, byClass('btns'));
    const [m, s, e] = elements(btns);
    assert.equal(m!.tag, 'button');
    assert.deepEqual(classes(m!).sort(), ['m', 'msr', ...(mute ? ['on'] : [])].sort());
    assert.equal(m!.attrs['aria-pressed'], String(mute));
    assert.equal(text(m!), 'M');
    assert.deepEqual(classes(s!).sort(), ['msr', 's', ...(solo ? ['on'] : [])].sort());
    assert.equal(s!.attrs['aria-pressed'], String(solo));
    assert.equal(text(s!), 'S');
    // m5b-ui-editor-channel: e, Edit Channel Settings, is on every track strip.
    assert.equal(e!.tag, 'button');
    assert.deepEqual(classes(e!).sort(), ['e', 'msr']);
    assert.equal(e!.attrs['data-part-of'], 'edit');
    assert.equal(e!.attrs['aria-pressed'], 'false');
    assert.equal(text(e!), 'e');
    // strip()'s row: span.msr.m, span.msr.s, span.msr.e.
    const mockupRow = find(mockupStrip(0), byClass('btns'));
    assert.deepEqual(elements(btns).map((el) => classes(el).filter((c) => c !== 'on').sort().join('.')), elements(mockupRow).filter((el) => classes(el).includes('msr')).map((el) => classes(el).filter((c) => c !== 'on' && c !== 'ghost').sort().join('.')));
  }
  assert.ok(classes(a!).includes('muted'));
  assert.ok(!classes(b!).includes('muted'));
});

// m5b-ui-editor-channel (UI redesign 3.4, 10.11): e is lit while the Channel
// zone shows its track (.on and aria-pressed="true", the app-only rule of
// shell.css), and a press reports the strip's track. The master's e is
// M6c's and a proposed track has none.
test('e is lit while the Channel zone shows its track; the master and a proposed track have no e', () => {
  const lit = render([kick(), snare()], { channelTrackId: 'trk_b' });
  const [a, b] = strips(lit);
  const e = (strip: Element) => find(find(strip, byClass('btns')), (el) => classes(el).includes('e'));
  assert.deepEqual(classes(e(b!)).sort(), ['e', 'msr', 'on']);
  assert.equal(e(b!).attrs['aria-pressed'], 'true');
  assert.deepEqual(classes(e(a!)).sort(), ['e', 'msr']);
  assert.equal(e(a!).attrs['aria-pressed'], 'false');
  assert.ok(e(a!).attrs['aria-label']!.includes('Kick'), 'named for its track');
  const master = find(lit, (el) => classes(el).includes('master'));
  assert.equal(findAll(master, (el) => classes(el).includes('e')).length, 0, 'the master has no e');
  assert.equal(findAll(master, byAttr('data-part-of')).filter((el) => el.attrs['data-part-of'] === 'edit').length, 0);
});

// The Channel zone's strip (m5b-ui-editor-channel): the MixConsole's strip
// component, without data-part-item (the MixConsole's strip-N numbering stays)
// and with its test ids prefixed, so no id is the MixConsole strip's twin.
test('the Channel zone\'s strip is the same component without data-part-item and with prefixed test ids', () => {
  const tracks = [kick()];
  const snap = snapshotOf(['trk_a'], tracks, [], []);
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={FULL}>
      <RecordContext.Provider value={recordHost(snap, FULL)}>
        <Strip trackId="trk_a" client={fakeClient(snap)} gestures={gestures} variant="channel" editLit onEdit={() => undefined} />
      </RecordContext.Provider>
    </CapabilitiesContext.Provider>
  );
  const root = parse(renderToStaticMarkup(node));
  const strip = find(root, byClass('strip'));
  assert.ok(!('data-part-item' in strip.attrs), 'no data-part-item');
  assert.deepEqual(elements(strip).map(sig), ['div.ins', 'div.panrow', 'div.btns', 'div.fad', 'div.readout', 'div.btns', 'div.nametag']);
  const ids = findAll(root, byAttr('data-testid')).map((el) => el.attrs['data-testid']!);
  assert.ok(ids.length > 5);
  for (const id of ids) assert.ok(id.startsWith('channel-'), id);
  for (const id of ['channel-mixer-strip-trk_a', 'channel-mute-trk_a', 'channel-solo-trk_a', 'channel-edit-trk_a', 'channel-fader-trk_a', 'channel-pan-trk_a', 'channel-meter-trk_a', 'channel-fader-value-trk_a']) assert.ok(ids.includes(id), id);
  for (const el of findAll(root, (x) => 'id' in x.attrs)) assert.ok(el.attrs.id!.startsWith('channel-'), el.attrs.id!);
  assert.ok(classes(find(strip, (el) => classes(el).includes('e'))).includes('on'));
});

test('the fader area: the scale at the taper\'s positions, the fader with its unity line and cap, two meter channels', () => {
  const app = find(strips(render([kick(), snare()]))[1]!, byClass('fad'));
  const mockup = find(mockupStrip(1), byClass('fad'));
  assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
  const [scale, fader, meter] = elements(app);
  const [mScale, mFader, mMeter] = elements(mockup);
  // The labels, and where they sit: the mockup's table is the taper's (UI redesign 4.5 C7).
  assert.deepEqual(elements(scale!).map((el) => [text(el), styleOf(el, 'bottom')]), elements(mScale!).map((el) => [text(el), styleOf(el, 'bottom')]));
  assert.deepEqual(
    elements(scale!).map((el) => styleOf(el, 'bottom')),
    MOCKUP.SCALE.map(([db]) => `${(milliDbToPosition(db * 1000) * 100).toFixed(1)}%`),
  );
  assert.deepEqual(elements(fader!).filter((el) => !classes(el).includes('value-tooltip')).map(sig), elements(mFader!).map(sig));
  const [unity, cap] = elements(fader!);
  assert.equal(styleOf(unity!, 'bottom'), '75.0%');
  // Snare at -2.5 dB: the cap where the mockup puts it, at the taper's position.
  assert.equal(styleOf(cap!, 'bottom'), styleOf(elements(mFader!)[1]!, 'bottom'));
  assert.equal(styleOf(cap!, 'bottom'), `${(milliDbToPosition(-2500) * 100).toFixed(1)}%`);
  assert.equal(fader!.attrs.role, 'slider');
  assert.equal(fader!.attrs['aria-valuenow'], '-2500');
  // Two wells; the bars and hold lines are the meter canvas's, never DOM.
  assert.deepEqual(elements(meter!).map(sig), elements(mMeter!).map(sig));
  assert.deepEqual(elements(meter!).map(sig), ['div.ch', 'div.ch']);
  for (const ch of elements(meter!)) assert.deepEqual(ch.children, []);
});

test('the readout holds the level and the peak value; the second button row holds the boxes of R and W and record enable', () => {
  const strip = strips(render([kick(), snare()]))[1]!;
  const rows = elements(strip);
  const readout = rows[4]!;
  const [level, peak] = elements(readout);
  assert.equal(level!.tag, 'span');
  assert.equal(text(level!), '-2.5 dB');
  assert.equal(peak!.tag, 'button');
  assert.ok(classes(peak!).includes('pk'));
  // R and W are m6a-ui-automation's (empty boxes); record enable landed with m5b-ui-recording.
  const [r, w, record] = elements(rows[5]!);
  assertEmptyBox(r!, 'R');
  assertEmptyBox(w!, 'W');
  assert.deepEqual(classes(record!).sort(), ['msr', 'r']);
  assert.equal(record!.attrs['data-part-of'], 'record');
  // Without features.recording the row is an empty box, as in M5.
  const bare = strips(render([kick(), snare()], { caps: { ...FULL, features: { ...FULL.features, recording: false } } }))[1]!;
  assertEmptyBox(elements(bare)[5]!, 'the automation row without recording');
});

test('the selected track\'s strip is .sel', () => {
  const [a, b] = strips(render([kick(), snare()], { selected: 'trk_b' }));
  assert.ok(!classes(a!).includes('sel'));
  assert.ok(classes(b!).includes('sel'));
});

test('the master strip is the mockup\'s .strip.master: its loudness row, scale, fader and meter, the level and the peak value, its name; the rest empty', () => {
  const root = render([kick()]);
  const master = find(root, (el) => classes(el).includes('master'));
  const mockup = mockupMaster();
  assert.equal(sig(master), sig(mockup));
  assert.deepEqual(elements(master).map(sig), elements(mockup).map(sig));
  assert.equal(styleOf(master, '--c'), 'var(--lit-1)');
  const [ins, loudness, buttons, fad, readout, automation, name] = elements(master);
  // The master's M, rack and e are M6c's.
  assertEmptyBox(ins!, 'master .ins');
  // m5b-ui-meter (mockup.html line 201): the LUFS-S label and the value the meter surface writes.
  assert.equal(loudness!.attrs['data-part-of'], 'loudness');
  assert.equal(loudness!.attrs['data-testid'], 'strip-master-loudness');
  const mockLoudness = elements(mockup)[1]!;
  assert.deepEqual(elements(loudness!).map(sig), elements(mockLoudness).map(sig));
  const [label, value] = elements(loudness!);
  assert.equal(text(label!), 'LUFS-S');
  assert.equal(styleOf(label!, 'color'), styleOf(elements(mockLoudness)[0]!, 'color'));
  assert.equal(styleOf(value!, 'color'), styleOf(elements(mockLoudness)[1]!, 'color'));
  assert.equal(text(value!), '', 'the value is written by the meter surface, not React');
  assert.equal(value!.attrs['data-testid'], 'strip-master-lufs');
  assertEmptyBox(buttons!, 'master buttons');
  assertEmptyBox(automation!, 'master automation');
  const [mScale, mFader] = elements(elements(mockup)[3]!);
  const [scale, fader, meter] = elements(fad!);
  assert.deepEqual(elements(scale!).map((el) => [text(el), styleOf(el, 'bottom')]), elements(mScale!).map((el) => [text(el), styleOf(el, 'bottom')]));
  // m5b-ui-inserts-master: the mockup's .ftrack with its unity line and its cap, at 0 dB (75.0 %) while master:master is absent.
  assert.equal(sig(fader!), sig(mFader!));
  assert.equal(fader!.attrs['data-part-of'], 'fader');
  assert.deepEqual(elements(fader!).filter((el) => !classes(el).includes('value-tooltip')).map(sig), elements(mFader!).map(sig));
  const [unity, cap] = elements(fader!);
  const [mUnity, mCap] = elements(mFader!);
  assert.equal(parseFloat(styleOf(unity!, 'bottom')!), parseFloat(styleOf(mUnity!, 'bottom')!), 'the mockup writes 75%');
  assert.equal(parseFloat(styleOf(cap!, 'bottom')!), parseFloat(styleOf(mCap!, 'bottom')!));
  assert.equal(styleOf(cap!, 'bottom'), '75.0%');
  assert.equal(cap!.attrs['data-part-of'], 'cap');
  assert.equal(fader!.attrs.role, 'slider');
  assert.equal(fader!.attrs.tabindex, '0');
  assert.equal(fader!.attrs['aria-valuenow'], '0');
  assert.equal(fader!.attrs['aria-valuemax'], '6000');
  assert.equal(fader!.attrs['aria-valuetext'], '0.0 dB');
  assert.equal(fader!.attrs['aria-label'], 'Master gain');
  assert.deepEqual(elements(meter!).map(sig), ['div.ch', 'div.ch']);
  // The readout: the level, then the peak value, as the mockup's two spans.
  assert.deepEqual(elements(readout!).map(sig), ['span', 'button.pk']);
  assert.equal(text(elements(readout!)[0]!), '0.0 dB');
  assert.equal(text(name!), 'Master');
});

test('the master fader reads master:master\'s gain at the taper\'s position', () => {
  const snap = snapshotOf(['trk_a'], [kick()], [], []);
  const withMaster = { ...snap, master: { schema: 'siann.entity.master.v1' as const, id: 'master' as const, gainMilliDb: -6000 }, entities: { ...snap.entities, 'master:master': { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb: -6000 } } } as Snapshot;
  const root = parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={FULL}>
        <Mixer client={fakeClient(withMaster)} gestures={gestures} realtime={realtime} />
      </CapabilitiesContext.Provider>,
    ),
  );
  const fader = find(find(root, byClass('master')), byClass('ftrack'));
  assert.equal(styleOf(find(fader, byClass('cap')), 'bottom'), `${(milliDbToPosition(-6000) * 100).toFixed(1)}%`);
  assert.equal(fader.attrs['aria-valuenow'], '-6000');
  assert.equal(text(elements(find(find(root, byClass('master')), byClass('readout')))[0]!), '-6.0 dB');
});

test('without features.masterGain, master.set_gain or the gesture methods the master stays the M5 meter', () => {
  const noMaster = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-no-master.json'), 'utf8')) as Capabilities;
  const without = [
    noMaster,
    { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'master.set_gain') },
    { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'gesture.begin') },
  ];
  for (const caps of without) {
    const master = find(render([kick()], { caps }), (el) => classes(el).includes('master'));
    const [, column] = elements(find(master, byClass('fad')));
    assertEmptyBox(column!, 'the master fader column');
    assert.deepEqual(elements(find(master, byClass('readout'))).map(sig), ['button.pk']);
    assert.deepEqual(appIds(master, 'master'), ['strip-master', 'strip-master-fader-area', 'strip-master-loudness', 'strip-master-meter', 'strip-master-name', 'strip-master-readout', 'strip-master-scale']);
  }
});

// ---- m5b-ui-inserts-master: the insert rack of a track strip, strip()'s
// .ins: a .slot per plugin_slot in the track's inserts order, .slot.empty '+'
// filling the two positions, all slots then one empty slot when there are two
// or more; each filled slot holds its name and the added bypass, e and Remove.

const pluginSlot = (id: string, trackId: string, name: string, bypass = false): PluginSlotEntity => ({
  schema: 'siann.entity.plugin_slot.v1',
  id,
  trackId,
  format: 'clap',
  uid: `org.test.${id}`,
  name,
  path: `/plugins/${id}.clap`,
  bypass,
});

test('the rack: strip()\'s .ins with a .slot per insert in signal order and .slot.empty in the remaining position', () => {
  // The mockup's Kick: one insert (Transient) and one empty slot.
  const withOne: TrackEntity = { ...kick(), inserts: ['slt_1'] };
  const app = find(strips(render([withOne], { slots: [pluginSlot('slt_1', 'trk_a', 'Transient')] }))[0]!, byClass('ins'));
  const mockup = find(mockupStrip(0), byClass('ins'));
  assert.equal(app.attrs['data-part-of'], 'inserts');
  assert.ok(!('aria-hidden' in app.attrs));
  assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
  assert.deepEqual(elements(app).map(sig), ['div.slot', 'div.empty.slot']);
  const [filled, empty] = elements(app);
  assert.equal(text(find(filled!, byClass('slot-name'))), text(elements(mockup)[0]!));
  assert.equal(text(empty!), text(elements(mockup)[1]!), '+');
  assert.equal(empty!.attrs.role, 'button');
  assert.equal(empty!.attrs.tabindex, '0');
  assert.equal(empty!.attrs['aria-label'], 'Add insert to Kick');
  // The three buttons added to the slot: bypass, e, Remove.
  const buttons = findAll(filled!, (el) => el.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.attrs['data-testid']), ['slot-bypass-slt_1', 'slot-edit-slt_1', 'slot-remove-slt_1']);
  assert.equal(text(buttons[1]!), 'e');
  assert.equal(buttons[0]!.attrs['aria-pressed'], 'false');
  assert.equal(buttons[1]!.attrs['aria-pressed'], 'false', 'e is unlit until an editor opens');
  // No slot carries a fidelity id: the mockup has none for them.
  for (const el of findAll(app, () => true).slice(1)) assert.ok(!('data-part-of' in el.attrs) && !('data-part' in el.attrs), sig(el));
});

test('the rack: no insert is two empty slots; two or more are every slot then one empty slot; bypass is pressed', () => {
  const none = find(strips(render([kick()]))[0]!, byClass('ins'));
  assert.deepEqual(elements(none).map(sig), ['div.empty.slot', 'div.empty.slot']);
  const many: TrackEntity = { ...kick(), inserts: ['slt_3', 'slt_1', 'slt_2'] };
  const slots = [pluginSlot('slt_1', 'trk_a', 'EQ'), pluginSlot('slt_2', 'trk_a', 'Verb', true), pluginSlot('slt_3', 'trk_a', 'Gate')];
  const rack = find(strips(render([many], { slots }))[0]!, byClass('ins'));
  assert.deepEqual(elements(rack).map(sig), ['div.slot', 'div.slot', 'div.bypassed.slot', 'div.empty.slot']);
  assert.deepEqual(findAll(rack, byClass('slot-name')).map(text), ['Gate', 'EQ', 'Verb'], 'the track\'s inserts order');
  assert.equal(find(rack, byAttr('data-testid', 'slot-bypass-slt_2')).attrs['aria-pressed'], 'true');
});

test('the rack is an empty box without plugins, without plugin.instantiate or plugin.registry, or with the Inserts switch off', () => {
  const noPlugins = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-no-plugins.json'), 'utf8')) as Capabilities;
  const withOne: TrackEntity = { ...kick(), inserts: ['slt_1'] };
  const slots = [pluginSlot('slt_1', 'trk_a', 'Transient')];
  for (const [what, options] of [
    ['no features.plugins', { caps: noPlugins }],
    ['no plugin.instantiate', { caps: { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'plugin.instantiate') } }],
    ['no plugin.registry', { caps: { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'plugin.registry') } }],
    ['the switch off', { racks: { shown: null } }],
  ] as const) {
    const strip = strips(render([withOne], { slots, ...options }))[0]!;
    assertEmptyBox(find(strip, byClass('ins')), `${what}: .ins`);
    assert.ok(!appIds(strip, '1').includes('strip-1-inserts'), what);
  }
});

test('a slot without bypass, Remove or the editor methods leaves out that button; a missing plugin shows the engine\'s code', () => {
  const withOne: TrackEntity = { ...kick(), inserts: ['slt_1'] };
  const slots = [pluginSlot('slt_1', 'trk_a', 'Transient')];
  const less: Capabilities = {
    ...FULL,
    commands: (FULL.commands ?? []).filter((c) => c !== 'plugin.set_bypass' && c !== 'plugin.remove'),
    methods: (FULL.methods ?? []).filter((m) => m !== 'plugin.open_editor'),
  };
  const slot = find(strips(render([withOne], { slots, caps: less }))[0]!, byClass('slot'));
  assert.deepEqual(findAll(slot, (el) => el.tag === 'button'), []);
  assert.equal(text(find(slot, byClass('slot-name'))), 'Transient');
});

// ---- m5b-ui-ghosts (UI redesign 4.2): what a pending plan adds to a strip,
// held to strip() for the mockup's Keys (pan, step 4), Vox BG (gain, step 3),
// FX (unmute, step 5) and its proposed track Pad (step 1).

const keys = (): TrackEntity => ({ ...track('trk_keys'), name: 'Keys', gainMilliDb: -8000, pan: -3500 });
const voxBg = (): TrackEntity => ({ ...track('trk_bg'), name: 'Vox BG', gainMilliDb: -9000, pan: 4000 });
const fx = (): TrackEntity => ({ ...track('trk_fx'), name: 'FX', gainMilliDb: -12000, mute: true });
const MOCKUP_GHOSTS: readonly Ghost[] = [
  { kind: 'track-add', step: 1, trackId: 'trk_pad', name: 'Pad', channels: 2, key: 'ghost' },
  { kind: 'gain', step: 3, trackId: 'trk_bg', before: -9000, after: -6000 },
  { kind: 'pan', step: 4, trackId: 'trk_keys', before: -3500, after: -2000 },
  { kind: 'mute', step: 5, trackId: 'trk_fx', before: true, after: false },
];

function renderGhosts(tracks: TrackEntity[], ghosts: readonly Ghost[], locale?: Locale): Element {
  const snap = snapshotOf(tracks.map((t) => t.id), tracks, [], []);
  const view: GhostView = { ghosts, outline: null, pin: () => undefined };
  const before = localeStore();
  if (locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return parse(
      renderToStaticMarkup(
        <CapabilitiesContext.Provider value={FULL}>
          <GhostContext.Provider value={view}>
            <Mixer client={fakeClient(snap)} gestures={gestures} realtime={realtime} />
          </GhostContext.Provider>
        </CapabilitiesContext.Provider>,
      ),
    );
  } finally {
    installLocaleStore(before);
  }
}

const stripOf = (root: Element, name: string) => strips(root).find((s) => text(find(s, byClass('nametag'))).includes(name))!;

test('a gain ghost: strip()\'s badge, the line from the real cap to the ghost cap, and the readout with both values', () => {
  const root = renderGhosts([keys(), voxBg(), fx()], MOCKUP_GHOSTS);
  const app = stripOf(root, 'Vox BG');
  const mockup = mockupStrip(5);
  assert.deepEqual(elements(app).map(sig), elements(mockup).map(sig));
  const [appBadge] = elements(app);
  const [mockBadge] = elements(mockup);
  assert.equal(text(appBadge!), '3');
  for (const property of ['right', 'top']) assert.equal(styleOf(appBadge!, property), styleOf(mockBadge!, property), property);
  const fader = (strip: Element) => elements(find(strip, byClass('ftrack'))).filter((el) => !classes(el).includes('value-tooltip'));
  assert.deepEqual(fader(app).map(sig), fader(mockup).map(sig));
  const [, appLine, appGhost, appCap] = fader(app);
  const [, mockLine, mockGhost, mockCap] = fader(mockup);
  for (const [a, m] of [[appLine, mockLine], [appGhost, mockGhost], [appCap, mockCap]] as const) assert.equal(styleOf(a!, 'bottom'), styleOf(m!, 'bottom'));
  assert.equal(styleOf(appLine!, 'height'), styleOf(mockLine!, 'height'));
  const readout = find(app, byClass('readout'));
  assert.equal(text(elements(readout)[0]!), '-9.0 dB');
  assert.equal(text(find(readout, byClass('to'))), '→ -6.0', 'the new value without its unit, as the mockup writes it, so both fit');
  const ids = appIds(app, '6');
  for (const id of ['strip-6-gain-step-ghost', 'strip-6-gain-line-ghost', 'strip-6-cap-ghost']) assert.ok(ids.includes(id), id);
});

test('a pan ghost: the badge in the PAN label\'s place, knob()\'s ghost tick and the new value in violet', () => {
  const app = find(stripOf(renderGhosts([keys(), voxBg(), fx()], MOCKUP_GHOSTS), 'Keys'), byClass('panrow'));
  const mockup = find(mockupStrip(3), byClass('panrow'));
  const visible = (row: Element) => elements(row).filter((el) => !classes(el).includes('value-tooltip'));
  assert.deepEqual(visible(app).map(sig), visible(mockup).map(sig));
  const [badge, knob, value] = visible(app);
  const [mBadge, , mValue] = visible(mockup);
  assert.equal(badge!.attrs['data-part-of'], 'pan-step-ghost');
  assert.equal(styleOf(badge!, 'justify-content'), styleOf(mBadge!, 'justify-content'));
  assert.equal(text(find(badge!, byClass('stepn'))), '4');
  assert.equal(findAll(knob!, (el) => el.tag === 'g')[0]?.attrs['data-part-of'], 'pan-knob-ghost');
  assert.equal(value!.attrs['data-part-of'], 'pan-value-ghost');
  assert.equal(styleOf(value!, 'color'), styleOf(mValue!, 'color'));
  assert.equal(text(value!), 'L20');
});

test('a mute ghost: the badge out of the flow and the dashed ring on M', () => {
  const app = find(stripOf(renderGhosts([keys(), voxBg(), fx()], MOCKUP_GHOSTS), 'FX'), byClass('btns'));
  const mockup = find(mockupStrip(6), byClass('btns'));
  const [badge, mute] = elements(app);
  const [mBadge, mMute] = elements(mockup);
  assert.equal(sig(badge!), sig(mBadge!));
  assert.equal(badge!.attrs['data-part-of'], 'mute-step-ghost');
  assert.equal(text(badge!), '5');
  for (const property of ['position', 'z-index', 'left']) assert.equal(styleOf(badge!, property), styleOf(mBadge!, property), property);
  assert.equal(sig(mute!).replace('button', 'span'), sig(mMute!));
});

test('a proposed track: a dashed strip labelled NEW · STEP n before the master, its insert row an empty box, with the mockup\'s ids', () => {
  for (const [locale, lang] of [['en', 'en'], ['zh-Hant', 'zh-TW']] as const) {
    const root = renderGhosts([keys(), voxBg(), fx()], MOCKUP_GHOSTS, locale);
    const all = strips(root);
    const ghost = all.find((s) => classes(s).includes('ghost'))!;
    assert.equal(all.indexOf(ghost), 3, 'after the tracks');
    assert.ok(classes(all[4]!).includes('master') || all.length === 4);
    const mockup = find(parse(loadMockup(lang).strip(MOCKUP.T[7]!, 7)), byClass('strip'));
    assert.equal(sig(ghost), sig(mockup));
    assert.deepEqual(elements(ghost).map(sig), elements(mockup).map(sig));
    assert.equal(ghost.attrs['data-part-key'], 'ghost');
    assert.deepEqual(appIds(ghost, 'ghost'), mockupIds(mockup));
    const label = elements(find(ghost, byClass('btns')))[0]!;
    assert.equal(text(label), text(elements(find(mockup, byClass('btns')))[0]!).replace('1', '1'), locale);
    const ins = find(ghost, byClass('ins'));
    assert.deepEqual(ins.children, []);
    assert.ok(!('role' in ins.attrs));
    assert.equal(findAll(ghost, (el) => el.attrs.role === 'slider' || el.tag === 'button').length, 0, 'nothing to operate on a proposed track');
    assert.equal(text(find(ghost, byClass('nametag'))), 'Pad');
  }
  // A second proposed track takes ghost-2.
  const two = renderGhosts([keys()], [...MOCKUP_GHOSTS, { kind: 'track-add', step: 7, trackId: 'trk_two', name: 'Two', channels: 1, key: 'ghost-2' }]);
  assert.deepEqual(strips(two).filter((s) => classes(s).includes('ghost')).map((s) => s.attrs['data-part-key']), ['ghost', 'ghost-2']);
});

// m5b-ui-audition (UI redesign 4.3): while the proposal is heard its ghosts
// are solid (data-ghost-mode="solid", shell.css) and the value each replaces,
// main's, is the faint outline: the real cap stays at main's value, marked
// data-replaced. A ghost without a step (a gesture on the branch) carries no
// badge. The dashed ghosts carry neither attribute.
test('solid ghosts while the proposal is heard: the ghost cap, the pan tick and the M ring solid, the real cap the outline', () => {
  const solid: readonly Ghost[] = [
    { kind: 'gain', step: 3, trackId: 'trk_bg', before: -9000, after: -4500, mode: 'solid', replaced: -9000 },
    { kind: 'pan', step: 4, trackId: 'trk_keys', before: -3500, after: -2000, mode: 'solid', replaced: -3500 },
    { kind: 'mute', step: 5, trackId: 'trk_fx', before: true, after: false, mode: 'solid', replaced: true },
    { kind: 'gain', step: 0, trackId: 'trk_keys', before: -8000, after: -2500, mode: 'solid', replaced: -8000 },
  ];
  const root = renderGhosts([keys(), voxBg(), fx()], solid);
  const bg = stripOf(root, 'Vox BG');
  const ghostCap = find(bg, byClass('ghost'));
  assert.equal(ghostCap.attrs['data-ghost-mode'], 'solid');
  assert.equal(styleOf(ghostCap, 'bottom'), `${(milliDbToPosition(-4500) * 100).toFixed(1)}%`, 'at the branch value');
  const cap = findAll(bg, (el) => el.attrs['data-part-of'] === 'cap')[0]!;
  assert.equal(cap.attrs['data-replaced'], 'true');
  assert.equal(styleOf(cap, 'bottom'), `${(milliDbToPosition(-9000) * 100).toFixed(1)}%`, 'the outline at main\'s value');
  const tick = findAll(stripOf(root, 'Keys'), (el) => el.attrs['data-part-of'] === 'pan-knob-ghost')[0]!;
  assert.equal(tick.attrs['data-ghost-mode'], 'solid');
  const mute = findAll(stripOf(root, 'FX'), (el) => el.attrs['data-part-of'] === 'mute')[0]!;
  assert.ok(classes(mute).includes('ghost'));
  assert.equal(mute.attrs['data-ghost-mode'], 'solid');
  // The un-numbered gain ghost on Keys: the solid cap, no badge.
  const keysStrip = stripOf(root, 'Keys');
  assert.equal(find(keysStrip, byClass('ghost')).attrs['data-ghost-mode'], 'solid');
  assert.equal(findAll(keysStrip, (el) => el.attrs['data-part-of'] === 'gain-step-ghost').length, 0, 'no step badge');
});

test('dashed ghosts carry no solid mode and no replaced mark', () => {
  const markup = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <GhostContext.Provider value={{ ghosts: MOCKUP_GHOSTS, outline: null, pin: () => undefined }}>
        <Mixer client={fakeClient(snapshotOf(['trk_keys', 'trk_bg', 'trk_fx'], [keys(), voxBg(), fx()], [], []))} gestures={gestures} realtime={realtime} />
      </GhostContext.Provider>
    </CapabilitiesContext.Provider>,
  );
  assert.ok(!markup.includes('data-ghost-mode'));
  assert.ok(!markup.includes('data-replaced'));
});

test('a removed track\'s strip is dimmed by an added class; a rename shows both names', () => {
  const root = renderGhosts([keys(), voxBg()], [
    { kind: 'track-remove', step: 2, trackId: 'trk_keys' },
    { kind: 'rename', step: 3, trackId: 'trk_bg', before: 'Vox BG', after: 'Vox Pad' },
  ]);
  assert.ok(classes(stripOf(root, 'Keys')).includes('ghost-removed'));
  const name = find(stripOf(root, 'Vox BG'), byClass('nametag'));
  assert.equal(text(name), 'Vox BG → Vox Pad');
  assert.equal(text(find(name, byClass('ghost-name'))), 'Vox Pad');
  // .nametag is a grid: the pair is its one item (a bare text node beside an
  // element would be a second grid item, on a second row the tag cuts off).
  assert.equal(name.children.length, 1);
  assert.deepEqual(elements(name).map(sig), ['span.ghost-rename']);
  assert.equal(name.attrs.title, 'Vox BG → Vox Pad');
});

// ---- the master-gain ghost (UI redesign 4.2): the ghost cap joined to the real cap, both values.
test('a master-gain ghost: the line from the real cap to the ghost cap and the readout with both values', () => {
  const root = renderGhosts([keys()], [{ kind: 'master-gain', step: 2, before: 0, after: -6000 }]);
  const master = find(root, (el) => classes(el).includes('master'));
  const fader = find(master, byClass('ftrack'));
  assert.deepEqual(elements(fader).filter((el) => !classes(el).includes('value-tooltip')).map(sig), ['div.unity', 'div.gline', 'div.cap.ghost', 'div.cap']);
  const [, line, ghost, cap] = elements(fader);
  const at = (db: number) => `${(milliDbToPosition(db) * 100).toFixed(1)}%`;
  assert.equal(styleOf(ghost!, 'bottom'), at(-6000));
  assert.equal(styleOf(cap!, 'bottom'), at(0));
  assert.equal(styleOf(line!, 'bottom'), at(-6000));
  assert.equal(styleOf(line!, 'height'), `${((milliDbToPosition(0) - milliDbToPosition(-6000)) * 100).toFixed(1)}%`);
  assert.equal(ghost!.attrs['data-ghost'], '2');
  const readout = find(master, byClass('readout'));
  assert.equal(text(elements(readout)[0]!), '0.0 dB');
  assert.equal(text(find(readout, byClass('to'))), '→ -6.0');
  const ids = appIds(master, 'master');
  for (const id of ['strip-master-cap-ghost', 'strip-master-gain-line-ghost']) assert.ok(ids.includes(id), id);
});

test('slot ghosts: a dashed slot numbered by its step for an insert, a dimmed slot for a removal, a ring on bypass', () => {
  const withTwo: TrackEntity = { ...keys(), inserts: ['slt_1', 'slt_2'] };
  const snap = withSlots(snapshotOf(['trk_keys'], [withTwo], [], []), [pluginSlot('slt_1', 'trk_keys', 'Comp'), pluginSlot('slt_2', 'trk_keys', 'EQ', true)]);
  const ghosts: Ghost[] = [
    { kind: 'insert-remove', step: 3, trackId: 'trk_keys', slotId: 'slt_1' },
    { kind: 'insert-bypass', step: 4, trackId: 'trk_keys', slotId: 'slt_2', before: true, after: false },
    { kind: 'insert-add', step: 5, trackId: 'trk_keys', slotId: 'slt_9', name: 'Limiter', index: 2 },
  ];
  const view: GhostView = { ghosts, outline: null, pin: () => undefined };
  const root = parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={FULL}>
        <GhostContext.Provider value={view}>
          <Mixer client={fakeClient(snap)} gestures={gestures} realtime={realtime} />
        </GhostContext.Provider>
      </CapabilitiesContext.Provider>,
    ),
  );
  const rack = find(strips(root)[0]!, byClass('ins'));
  assert.deepEqual(elements(rack).map(sig), ['div.ghost-removed.slot', 'div.bypassed.slot', 'div.ghost.slot', 'div.empty.slot']);
  const [removed, bypassed, added] = elements(rack);
  assert.equal(removed!.attrs['data-ghost'], '3');
  assert.ok(classes(find(bypassed!, byAttr('data-testid', 'slot-bypass-slt_2'))).includes('ghost'), 'the dashed ring on bypass');
  assert.equal(added!.attrs['data-ghost'], '5');
  assert.equal(text(find(added!, byClass('stepn'))), '5');
  assert.equal(text(find(added!, byClass('slot-name'))), 'Limiter');
  assert.deepEqual(findAll(added!, (el) => el.tag === 'button'), [], 'nothing to operate on a proposed slot');
});

test('the ids are the mockup\'s minus the pending parts\', and no pending id is anywhere', () => {
  const root = render([kick(), snare()]);
  const [one, two] = strips(root);
  for (const [i, app] of [[0, one!], [1, two!]] as const) {
    const expected = mockupIds(mockupStrip(i)).filter((id) => !pending(id));
    assert.deepEqual(appIds(app, String(i + 1)), expected, `strip-${i + 1}`);
  }
  const master = find(root, (el) => classes(el).includes('master'));
  assert.deepEqual(appIds(master, 'master'), mockupIds(mockupMaster()).filter((id) => !pending(id)));
  assert.deepEqual(appIds(master, 'master'), ['strip-master', 'strip-master-cap', 'strip-master-fader', 'strip-master-fader-area', 'strip-master-loudness', 'strip-master-meter', 'strip-master-name', 'strip-master-readout', 'strip-master-scale']);
  // The mixer itself.
  assert.equal(find(root, byClass('mixer')).attrs['data-part'], 'mixer');
  // Nothing else carries an id the manifest has pending.
  for (const el of findAll(root, byAttr('data-part'))) assert.ok(!pending(el.attrs['data-part']!), el.attrs['data-part']!);
});

test('without features.loudness the master\'s loudness row is the empty .panrow the shared rules size', () => {
  const noLoudness: Capabilities = { ...FULL, features: { ...FULL.features, loudness: false } };
  for (const caps of [noLoudness, null]) {
    const master = find(render([kick()], { caps }), (el) => classes(el).includes('master'));
    const row = elements(master)[1]!;
    assert.equal(sig(row), 'div.panrow');
    assertEmptyBox(row, 'the master loudness row');
    assert.ok(!appIds(master, 'master').includes('strip-master-loudness'));
  }
});

test('reduced capabilities still remove the controls, and the boxes stay', () => {
  const noMuteSolo: Capabilities = { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_mute' && c !== 'track.set_solo') };
  const strip = strips(render([kick()], { caps: noMuteSolo }))[0]!;
  const btns = find(strip, byClass('btns'));
  // e needs no engine method (m5b-ui-editor-channel): it stays.
  assert.deepEqual(findAll(btns, (el) => el.tag === 'button').map((el) => text(el)), ['e']);
  assert.equal(elements(btns).length, 3, 'M, S and e keep their boxes');
  for (const box of elements(btns).slice(0, 2)) assertEmptyBox(box, 'an unlisted button');
  const bare = strips(render([kick()], { caps: null }))[0]!;
  assert.equal(findAll(bare, (el) => el.attrs.role === 'slider').length, 0);
  assert.deepEqual(elements(bare).map(sig), ['div.ins', 'div.panrow', 'div.btns', 'div.fad', 'div.readout', 'div.btns', 'div.nametag']);
});

test('a stored gain above +6 dB pins the cap at the top and warns on the fader and the level', () => {
  const loud: TrackEntity = { ...kick(), gainMilliDb: 9000 };
  const strip = strips(render([loud]))[0]!;
  const fader = find(strip, byClass('ftrack'));
  assert.equal(styleOf(find(fader, byClass('cap')), 'bottom'), '100.0%');
  assert.equal(fader.attrs['data-position'], '1');
  assert.ok(classes(fader).includes('warn'));
  const level = elements(find(strip, byClass('readout')))[0]!;
  assert.equal(text(level), '+9.0 dB');
  assert.ok(classes(level).includes('warn'));
});

// ---- m5b-ui-sends-buses (UI redesign 3.4, 3.0, 4.2; 10.11, 25). A bus strip
// has the track strip's controls: strip()'s rows in its order and classes,
// its fader to +6 dB on bus:<id>, the pan knob, M and S, the meter on
// bus:<id>, the readout, its insert rack; the box of e and the R, W and
// record row stay empty, and its Sends rack is an empty box. Bus strips
// stand after the track strips in busOrder, then the ghost strips, then the
// master. The rack row shows the rack of the lit switch: Routing (one .slot,
// the output selector), Inserts, or Sends (a .slot per send by the two-slot
// rule); none lit, the empty box. Without features.buses nothing of it is in
// the DOM.

function renderBuses(
  tracks: TrackEntity[],
  buses: BusEntity[],
  sends: SendEntity[],
  options: { caps?: Capabilities | null; racks?: { shown: 'routing' | 'inserts' | 'sends' | null }; ghosts?: readonly Ghost[]; selectedBus?: string | null; locale?: Locale } = {},
): Element {
  const snap = busSnapshot(buses, sends, tracks);
  const caps = options.caps === undefined ? FULL : options.caps;
  const legend: MeterLegend = { epoch: '1', entities: ['master', ...tracks.map((t) => `track:${t.id}`), ...buses.map((b) => `bus:${b.id}`)] };
  const view: GhostView = { ghosts: options.ghosts ?? [], outline: null, pin: () => undefined };
  const selection = new BusSelection();
  if (options.selectedBus) selection.set(options.selectedBus);
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={caps}>
      <RecordContext.Provider value={recordHost(snap, caps)}>
        <GhostContext.Provider value={view}>
          <Mixer client={fakeClient(snap, legend)} gestures={gestures} realtime={realtime} racks={options.racks} busSelection={selection} />
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

const busStrips = (root: Element) => strips(root).filter((s) => (s.attrs['data-testid'] ?? '').startsWith('mixer-strip-bus-'));
const verb = (): BusEntity => ({ ...bus('bus_v', 'Verb'), gainMilliDb: -6000, pan: -2500 });
const delay = (): BusEntity => ({ ...bus('bus_d', 'Delay'), mute: true });

test('a bus strip has strip()\'s rows in its order and classes, its colour the palette entry of its id', () => {
  const root = renderBuses([kick()], [verb()], []);
  const app = busStrips(root)[0]!;
  const mockup = mockupStrip(0);
  assert.equal(sig(app), sig(mockup));
  assert.deepEqual(elements(app).map(sig), ['div.ins', 'div.panrow', 'div.btns', 'div.fad', 'div.readout', 'div.btns', 'div.nametag']);
  assert.equal(styleOf(app, '--c'), `var(${trackColourVar('bus_v')})`);
  assert.equal(app.attrs['data-part-item'], 'strip');
  assert.equal(app.attrs['data-part-key'], 'bus-bus_v', 'a bus takes no strip number from the tracks');
  assert.equal(app.attrs.role, 'group');
  assert.equal(app.attrs['aria-label'], 'Verb');
  assert.equal(text(find(app, byClass('nametag'))), 'Verb');
  // The pan row: strip()'s label, knob and value, the bus's pan.
  assert.deepEqual(elements(find(app, byClass('panrow'))).filter((el) => !classes(el).includes('value-tooltip')).map(sig), ['span.lab', 'svg.knob', 'span.lab']);
  assert.equal(text(find(app, byAttr('data-testid', 'pan-value-bus_v'))), 'L25');
  // M and S, then the empty box of e.
  const [m, s, e] = elements(find(app, byClass('btns')));
  assert.equal(sig(m!), 'button.m.msr');
  assert.equal(sig(s!), 'button.msr.s');
  assertEmptyBox(e!, 'the bus\'s e');
  // The fader on bus:<id> with the taper (+6 dB at the top), the meter with two channels.
  const fader = find(app, byAttr('data-testid', 'fader-bus_v'));
  assert.equal(fader.attrs.role, 'slider');
  assert.equal(fader.attrs['aria-valuemax'], '6000');
  assert.equal(styleOf(find(fader, byClass('cap')), 'bottom'), percent(milliDbToPosition(-6000)));
  assert.deepEqual(elements(find(app, byAttr('data-testid', 'meter-bus_v'))).map(sig), ['div.ch', 'div.ch']);
  // The readout: the level and the peak value.
  assert.equal(text(find(app, byAttr('data-testid', 'fader-value-bus_v'))), '-6.0 dB');
  assert.ok(find(app, byAttr('data-testid', 'peak-value-bus_v')));
  // R, W and record: the empty row.
  assertEmptyBox(elements(app)[5]!, 'the bus\'s R W record row');
  // Its insert rack (the Inserts switch is lit by default): two empty slots, adding to the bus.
  const ins = find(app, byClass('ins'));
  assert.deepEqual(elements(ins).map(sig), ['div.empty.slot', 'div.empty.slot']);
  assert.equal(elements(ins)[0]!.attrs['aria-label'], 'Add insert to Verb');
});

test('the strips stand tracks, buses in busOrder, ghost strips, then the master; a muted or selected bus is .muted, .sel', () => {
  const ghosts: Ghost[] = [{ kind: 'bus-add', step: 2, busId: 'bus_n', name: 'Hall', key: 'bus-ghost' }, { kind: 'track-add', step: 1, trackId: 'trk_n', name: 'Pad', channels: 2, key: 'ghost' }];
  const root = renderBuses([kick(), snare()], [delay(), verb()], [], { ghosts, selectedBus: 'bus_v' });
  const ids = strips(root).map((s) => s.attrs['data-testid']);
  assert.deepEqual(ids, ['mixer-strip-trk_a', 'mixer-strip-trk_b', 'mixer-strip-bus-bus_d', 'mixer-strip-bus-bus_v', 'mixer-strip-ghost', 'mixer-strip-bus-ghost', 'mixer-strip-master']);
  const [d, v] = busStrips(root);
  assert.ok(classes(d!).includes('muted'));
  assert.ok(!classes(d!).includes('sel'));
  assert.equal(d!.attrs['aria-selected'], 'false');
  assert.ok(classes(v!).includes('sel'));
  assert.equal(v!.attrs['aria-selected'], 'true');
  assert.equal(find(d!, byAttr('data-testid', 'mute-bus_d')).attrs['aria-pressed'], 'true');
});

test('a proposed bus is a dashed strip labelled new after the bus strips, keyed bus-ghost; a removed bus dims with its badge', () => {
  const ghosts: Ghost[] = [
    { kind: 'bus-add', step: 1, busId: 'bus_n', name: 'Hall', key: 'bus-ghost' },
    { kind: 'bus-add', step: 3, busId: 'bus_m', name: 'Room', key: 'bus-ghost-2' },
    { kind: 'bus-remove', step: 2, busId: 'bus_v' },
  ];
  const root = renderBuses([kick()], [verb()], [], { ghosts });
  const all = strips(root);
  const proposed = all.filter((s) => classes(s).includes('ghost'));
  assert.deepEqual(proposed.map((s) => s.attrs['data-part-key']), ['bus-ghost', 'bus-ghost-2']);
  assert.deepEqual(elements(proposed[0]!).map(sig), ['div.ins', 'div.panrow', 'div.btns', 'div.fad', 'div.readout', 'div.btns', 'div.nametag']);
  assert.equal(text(find(proposed[0]!, byClass('nametag'))), 'Hall');
  assert.equal(findAll(proposed[0]!, (el) => el.attrs.role === 'slider' || el.tag === 'button').length, 0, 'nothing to operate on a proposed bus');
  const removed = busStrips(root)[0]!;
  assert.ok(classes(removed).includes('ghost-removed'));
  assert.equal(removed.attrs['data-ghost'], '2');
  assert.equal(text(find(removed, byClass('stepn'))), '2');
});

test('the Routing rack: one .slot, the output selector naming the master or the bus; the list offers the master and the buses', () => {
  const tracks: TrackEntity[] = [kick(), { ...snare(), output: { busId: 'bus_v' } }];
  const root = renderBuses(tracks, [verb(), { ...delay(), output: { busId: 'bus_v' } }], [], { racks: { shown: 'routing' } });
  const [one, two] = strips(root);
  const rack = find(one!, byClass('ins'));
  assert.equal(rack.attrs.role, 'group');
  assert.deepEqual(elements(rack).map(sig), ['div.slot']);
  const slot = elements(rack)[0]!;
  assert.equal(text(find(slot, byClass('slot-name'))), 'Master');
  const select = find(slot, (el) => el.tag === 'select');
  assert.equal(select.attrs['data-testid'], 'output-trk_a');
  assert.deepEqual(findAll(select, (el) => el.tag === 'option').map((o) => [o.attrs.value, text(o)]), [['', 'Master'], ['bus_v', 'Verb'], ['bus_d', 'Delay']]);
  assert.equal(text(find(find(two!, byClass('ins')), byClass('slot-name'))), 'Verb');
  // A bus's selector: the master and the other buses.
  const delayStrip = busStrips(root)[1]!;
  const busSelect = find(find(delayStrip, byClass('ins')), (el) => el.tag === 'select');
  assert.deepEqual(findAll(busSelect, (el) => el.tag === 'option').map((o) => o.attrs.value), ['', 'bus_v']);
  assert.equal(text(find(find(delayStrip, byClass('ins')), byClass('slot-name'))), 'Verb');
});

test('the Sends rack: a .slot per send with on, the bus name as the level, pre/post and Remove; the two-slot rule; a bus\'s is empty', () => {
  const sends = [send('snd_1', 'trk_a', 'bus_v', -6000, false, true), send('snd_2', 'trk_a', 'bus_d', 0, true, false)];
  const root = renderBuses([{ ...kick(), sends: ['snd_2', 'snd_1'] }, snare()], [verb(), delay()], sends, { racks: { shown: 'sends' } });
  const [one, two] = strips(root);
  const rack = find(one!, byClass('ins'));
  // Two sends: every slot in the track's sends order, then one empty slot.
  // A send slot carries .send-slot (shell.css keeps its level the room in the
  // strip's 80 px), a pre-fader one .send-pre too; its tooltip names PRE or POST.
  assert.deepEqual(elements(rack).map(sig), ['div.off.send-pre.send-slot.slot', 'div.send-slot.slot', 'div.empty.slot']);
  const [off, on, empty] = elements(rack);
  assert.equal(off!.attrs.title, 'Delay · 0.0 dB · PRE');
  assert.equal(on!.attrs.title, 'Verb · -6.0 dB · POST');
  assert.deepEqual(findAll(off!, (el) => el.tag === 'button').map((b) => b.attrs['data-testid']), ['send-on-snd_2', 'send-pre-snd_2', 'send-remove-snd_2']);
  assert.equal(find(off!, byAttr('data-testid', 'send-on-snd_2')).attrs['aria-pressed'], 'false');
  assert.equal(text(find(off!, byAttr('data-testid', 'send-pre-snd_2'))), 'PRE');
  assert.equal(text(find(on!, byAttr('data-testid', 'send-pre-snd_1'))), 'POST');
  const level = find(on!, byAttr('data-testid', 'send-level-snd_1'));
  assert.ok(classes(level).includes('slot-name'));
  assert.equal(text(level), 'Verb');
  assert.equal(level.attrs.role, 'slider');
  assert.equal(level.attrs['aria-valuetext'], '-6.0 dB');
  assert.equal(level.attrs.tabindex, '0');
  assert.equal(empty!.attrs.role, 'button');
  assert.equal(empty!.attrs['aria-label'], 'Add send from Kick');
  // No send: two empty slots.
  assert.deepEqual(elements(find(two!, byClass('ins'))).map(sig), ['div.empty.slot', 'div.empty.slot']);
  // A bus strip's Sends rack: the empty box.
  assertEmptyBox(find(busStrips(root)[0]!, byClass('ins')), 'a bus\'s sends rack');
  // None lit: every rack row the empty box.
  for (const strip of strips(renderBuses([kick()], [verb()], [], { racks: { shown: null } })).slice(0, 2)) assertEmptyBox(find(strip, byClass('ins')), 'none lit');
});

test('a send ghost: a dashed slot numbered by step in the sends rack; a removed send\'s slot dims', () => {
  const sends = [send('snd_1', 'trk_a', 'bus_v')];
  const ghosts: Ghost[] = [
    { kind: 'send-add', step: 2, sendId: 'snd_9', trackId: 'trk_a', busId: 'bus_v', busName: 'Verb' },
    { kind: 'send-remove', step: 3, sendId: 'snd_1', trackId: 'trk_a', busId: 'bus_v', cascade: false },
  ];
  const rack = find(strips(renderBuses([{ ...kick(), sends: ['snd_1'] }], [verb()], sends, { racks: { shown: 'sends' }, ghosts }))[0]!, byClass('ins'));
  assert.deepEqual(elements(rack).map(sig), ['div.ghost-removed.send-slot.slot', 'div.ghost.slot', 'div.empty.slot']);
  const added = elements(rack)[1]!;
  assert.equal(text(find(added, byClass('stepn'))), '2');
  assert.equal(text(find(added, byClass('slot-name'))), 'Verb');
  assert.equal(elements(rack)[0]!.attrs['data-ghost'], '3');
});

test('without features.buses no bus strip, routing selector or sends rack is in the DOM (capabilities-reduced.json too)', () => {
  const reduced = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-reduced.json'), 'utf8')) as Capabilities;
  const noBuses: Capabilities = { ...FULL, features: { ...FULL.features, buses: false, sends: false } };
  const sends = [send('snd_1', 'trk_a', 'bus_v')];
  for (const [what, caps] of [['reduced', reduced], ['no features.buses', noBuses]] as const) {
    for (const shown of ['routing', 'sends'] as const) {
      const root = renderBuses([{ ...kick(), sends: ['snd_1'] }], [verb()], sends, { caps, racks: { shown } });
      assert.deepEqual(busStrips(root), [], `${what}: no bus strip`);
      assert.equal(findAll(root, (el) => el.tag === 'select').length, 0, `${what}: no selector`);
      assert.equal(findAll(root, (el) => (el.attrs['data-testid'] ?? '').startsWith('send-')).length, 0, `${what}: no send slot`);
      assertEmptyBox(find(strips(root)[0]!, byClass('ins')), `${what} ${shown}: the empty rack box`);
    }
  }
});
