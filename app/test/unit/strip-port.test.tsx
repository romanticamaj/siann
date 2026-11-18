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
import { milliDbToPosition } from '../../src/renderer/mixer/taper';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { TrackEntity } from '../../src/renderer/model/document';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { MeterLegend } from '../../src/renderer/model/meter-frames';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, styleOf, text, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';

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

function render(tracks: TrackEntity[], options: { selected?: string | null; caps?: Capabilities | null; locale?: Locale } = {}): Element {
  const snap = snapshotOf(tracks.map((t) => t.id), tracks, [], []);
  const node: ReactNode = (
    <CapabilitiesContext.Provider value={options.caps === undefined ? FULL : options.caps}>
      <Mixer client={fakeClient(snap)} gestures={gestures} realtime={realtime} selectedTrackId={options.selected ?? null} />
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

test('the buttons row: M and S as .msr.m and .msr.s, .on from the track, and the empty box of e', () => {
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
    assertEmptyBox(e!, 'the e box');
    assert.ok(!classes(e!).includes('msr'), 'the e box is not drawn as a button');
  }
  assert.ok(classes(a!).includes('muted'));
  assert.ok(!classes(b!).includes('muted'));
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

test('the readout holds the level and the peak value; the second button row and the insert row are empty boxes', () => {
  const strip = strips(render([kick(), snare()]))[1]!;
  const rows = elements(strip);
  const readout = rows[4]!;
  const [level, peak] = elements(readout);
  assert.equal(level!.tag, 'span');
  assert.equal(text(level!), '-2.5 dB');
  assert.equal(peak!.tag, 'button');
  assert.ok(classes(peak!).includes('pk'));
  assertEmptyBox(rows[0]!, '.ins');
  assertEmptyBox(rows[5]!, 'the automation row');
});

test('the selected track\'s strip is .sel', () => {
  const [a, b] = strips(render([kick(), snare()], { selected: 'trk_b' }));
  assert.ok(!classes(a!).includes('sel'));
  assert.ok(classes(b!).includes('sel'));
});

test('the master strip is the mockup\'s .strip.master: its fader area with scale and meter, the peak value, its name; the rest empty', () => {
  const root = render([kick()]);
  const master = find(root, (el) => classes(el).includes('master'));
  const mockup = mockupMaster();
  assert.equal(sig(master), sig(mockup));
  assert.deepEqual(elements(master).map(sig), elements(mockup).map(sig));
  assert.equal(styleOf(master, '--c'), 'var(--lit-1)');
  const [ins, loudness, buttons, fad, readout, automation, name] = elements(master);
  assertEmptyBox(ins!, 'master .ins');
  assertEmptyBox(loudness!, 'master loudness row');
  assertEmptyBox(buttons!, 'master buttons');
  assertEmptyBox(automation!, 'master automation');
  const [scale, column, meter] = elements(fad!);
  assert.deepEqual(elements(scale!).map((el) => [text(el), styleOf(el, 'bottom')]), elements(elements(elements(mockup)[3]!)[0]!).map((el) => [text(el), styleOf(el, 'bottom')]));
  assertEmptyBox(column!, 'the master fader column');
  assert.deepEqual(elements(meter!).map(sig), ['div.ch', 'div.ch']);
  assert.deepEqual(elements(readout!).map(sig), ['button.pk']);
  assert.equal(text(name!), 'Master');
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
  assert.deepEqual(appIds(master, 'master'), ['strip-master', 'strip-master-fader-area', 'strip-master-meter', 'strip-master-name', 'strip-master-readout', 'strip-master-scale']);
  // The mixer itself.
  assert.equal(find(root, byClass('mixer')).attrs['data-part'], 'mixer');
  // Nothing else carries an id the manifest has pending.
  for (const el of findAll(root, byAttr('data-part'))) assert.ok(!pending(el.attrs['data-part']!), el.attrs['data-part']!);
});

test('reduced capabilities still remove the controls, and the boxes stay', () => {
  const noMuteSolo: Capabilities = { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_mute' && c !== 'track.set_solo') };
  const strip = strips(render([kick()], { caps: noMuteSolo }))[0]!;
  const btns = find(strip, byClass('btns'));
  assert.equal(findAll(btns, (el) => el.tag === 'button').length, 0);
  assert.equal(elements(btns).length, 3, 'M, S and e keep their boxes');
  for (const box of elements(btns)) assertEmptyBox(box, 'an unlisted button');
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
