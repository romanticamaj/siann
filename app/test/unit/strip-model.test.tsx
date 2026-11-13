// The MixConsole strips and the Inspector's Track tab (m5-ui-mixer; UI
// redesign spec 3.4, 4.5 C7, 3.0), rendered with react-dom/server:
//
// - a strip holds, top to bottom: pan, M and S, the fader beside its meter
//   slot, the level and peak values, and the name on the track colour;
// - strips follow snapshot.trackOrder; a meter-only master strip exists only
//   when the meter legend names "master";
// - a stored gain above +6 dB pins the cap at the top, shows the true value
//   and carries the warning class;
// - no milli-dB or internal pan unit is visible;
// - the capability rule holds (spec 3.0);
// - the Inspector's Track tab shows the selected track's name, colour, M, S,
//   volume and pan through the same components and the same read-model
//   select(), so a gesture overlay shows in both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Mixer } from '../../src/renderer/mixer/Mixer';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { Entity, TrackEntity } from '../../src/renderer/model/document';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { MeterLegend } from '../../src/renderer/model/meter-frames';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { Inspector } from '../../src/renderer/shell/Inspector';
import { trackColour } from '../../src/renderer/track-colour';
import { clip, media, snapshotOf, track } from './support/timeline';

// dist/test/unit -> app/test/unit/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

const LEGEND: MeterLegend = { epoch: '1', entities: ['master', 'track:trk_a', 'track:trk_b'] };

function snapshot(tracks: TrackEntity[] = [track('trk_a'), track('trk_b')]): Snapshot {
  return snapshotOf(['trk_b', 'trk_a'], tracks, [media('med_sq', '48000')], [clip('clp_1', 'trk_a', 'med_sq', '0', '0', '24000')]);
}

// A session client double: the read model's select() may carry an overlay
// (the gestured entity) that the snapshot does not.
function fakeClient(snap: Snapshot, legend: MeterLegend | null = LEGEND, overlay: Entity | null = null) {
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: overlay }),
    select: (ref: string) => (overlay && `track:${overlay.id}` === ref ? overlay : snap.entities[ref]),
    subscribe: () => () => undefined,
  };
  return {
    model,
    getState: () => ({ status: 'connected', legend }),
    subscribe: () => () => undefined,
    execute: async () => undefined,
  } as unknown as SessionClient;
}

const gestures = {} as unknown as GestureController;
const realtime = { subscribe: () => () => undefined } as unknown as RealtimeClient;

function within(caps: Capabilities | null, node: ReactNode): string {
  return renderToStaticMarkup(<CapabilitiesContext.Provider value={caps}>{node}</CapabilitiesContext.Provider>);
}

function mixer(client: SessionClient, caps: Capabilities | null = FULL): string {
  return within(caps, <Mixer client={client} gestures={gestures} realtime={realtime} />);
}

function inspector(client: SessionClient, caps: Capabilities | null = FULL): string {
  return within(caps, <Inspector client={client} gestures={gestures} clipId="clp_1" />);
}

// The opening tag carrying data-testid="<id>".
function tag(markup: string, id: string): string {
  const at = markup.indexOf(`data-testid="${id}"`);
  assert.ok(at >= 0, `no ${id}`);
  const start = markup.lastIndexOf('<', at);
  return markup.slice(start, markup.indexOf('>', at) + 1);
}

// The text content of the element carrying data-testid="<id>" (no nesting of the same tag).
function textOf(markup: string, id: string): string {
  const open = tag(markup, id);
  const name = /^<([a-z0-9]+)/.exec(open)![1]!;
  const from = markup.indexOf(open) + open.length;
  const to = markup.indexOf(`</${name}>`, from);
  return markup.slice(from, to).replace(/<[^>]+>/g, '');
}

function attr(markup: string, id: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag(markup, id));
  return match ? match[1]! : null;
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

test('a strip holds pan, M S, the fader with its meter, level and peak values, then the name', () => {
  const html = mixer(fakeClient(snapshot()));
  const order = ['pan-trk_a', 'mute-trk_a', 'solo-trk_a', 'fader-trk_a', 'meter-trk_a', 'fader-value-trk_a', 'peak-value-trk_a', 'strip-name-trk_a'];
  const at = order.map((id) => html.indexOf(`data-testid="${id}"`));
  at.forEach((index, i) => assert.ok(index >= 0, `missing ${order[i]}`));
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i - 1]! < at[i]!, `${order[i - 1]} before ${order[i]}`);
  // Inside its strip: the strip of trk_a opens before them and trk_b's does not sit between.
  const strip = html.indexOf('data-testid="mixer-strip-trk_a"');
  assert.ok(strip >= 0 && strip < at[0]!);
  // The name carries the track colour.
  assert.match(tag(html, 'strip-name-trk_a'), new RegExp(trackColour('trk_a'), 'i'));
  assert.equal(textOf(html, 'strip-name-trk_a'), 'trk_a');
  // A fader is a slider in milli-dB with its value as text.
  assert.equal(attr(html, 'fader-trk_a', 'role'), 'slider');
  assert.equal(attr(html, 'fader-trk_a', 'aria-valuenow'), '0');
  assert.equal(attr(html, 'fader-trk_a', 'aria-valuetext'), '0.0 dB');
  assert.equal(attr(html, 'fader-trk_a', 'aria-orientation'), 'vertical');
  assert.equal(attr(html, 'fader-trk_a', 'data-position'), '0.75');
  assert.equal(textOf(html, 'fader-value-trk_a'), '0.0 dB');
  assert.equal(attr(html, 'pan-trk_a', 'role'), 'slider');
  assert.equal(attr(html, 'pan-trk_a', 'aria-valuetext'), 'C');
});

test('strips follow trackOrder; the master strip exists only with a master legend entry and has no controls', () => {
  const html = mixer(fakeClient(snapshot()));
  const b = html.indexOf('data-testid="mixer-strip-trk_b"');
  const a = html.indexOf('data-testid="mixer-strip-trk_a"');
  const master = html.indexOf('data-testid="mixer-strip-master"');
  assert.ok(b >= 0 && a > b, 'trk_b first, as trackOrder says');
  assert.ok(master > a, 'the master strip after the tracks');
  const masterHtml = html.slice(master);
  assert.ok(masterHtml.includes('data-testid="meter-master"'));
  assert.ok(masterHtml.includes('data-testid="peak-value-master"'));
  for (const id of ['fader-master', 'pan-master', 'mute-master', 'solo-master']) assert.ok(!html.includes(`data-testid="${id}"`), id);
  assert.ok(html.includes('data-testid="mixer-meters"'), 'the one meter canvas');
  assert.equal((html.match(/<canvas/g) ?? []).length, 1, 'exactly one canvas');

  const noMaster = mixer(fakeClient(snapshot(), { epoch: '1', entities: ['track:trk_a'] }));
  assert.ok(!noMaster.includes('data-testid="mixer-strip-master"'));
  assert.ok(!mixer(fakeClient(snapshot(), null)).includes('data-testid="mixer-strip-master"'));
});

test('a stored gain above +6 dB pins the cap at the top and shows the true value as a warning', () => {
  const loud = { ...track('trk_a'), gainMilliDb: 9000 };
  const html = mixer(fakeClient(snapshot([loud, track('trk_b')])));
  assert.equal(attr(html, 'fader-trk_a', 'data-position'), '1');
  assert.equal(attr(html, 'fader-trk_a', 'aria-valuenow'), '9000');
  assert.equal(attr(html, 'fader-trk_a', 'aria-valuetext'), '+9.0 dB');
  assert.equal(textOf(html, 'fader-value-trk_a'), '+9.0 dB');
  assert.match(attr(html, 'fader-value-trk_a', 'class') ?? '', /\bwarn\b/);
  assert.match(attr(html, 'fader-trk_a', 'class') ?? '', /\bwarn\b/);
  assert.doesNotMatch(attr(html, 'fader-value-trk_b', 'class') ?? '', /\bwarn\b/);
});

test('no milli-dB or internal pan unit is visible', () => {
  const tracks = [
    { ...track('trk_a'), gainMilliDb: -12345, pan: -3500 },
    { ...track('trk_b'), gainMilliDb: -2147483648, pan: 4000 },
  ];
  const client = fakeClient(snapshot(tracks));
  const shown = text(mixer(client)) + ' ' + text(inspector(client));
  assert.doesNotMatch(shown, /\d{4,}/, shown);
  assert.match(shown, /-12\.3 dB/);
  assert.match(shown, /-inf dB/);
  assert.match(shown, /L35/);
  assert.match(shown, /R40/);
});

test('the capability rule: the fader and pan need the gesture methods; M and S their commands', () => {
  const reduced = mixer(fakeClient(snapshot()), REDUCED);
  for (const id of ['fader-trk_a', 'pan-trk_a']) assert.ok(!reduced.includes(`data-testid="${id}"`), id);
  assert.ok(reduced.includes('data-testid="fader-value-trk_a"'), 'the level value still reads');
  const noMuteSolo: Capabilities = { ...REDUCED, commands: (REDUCED.commands ?? []).filter((c) => c !== 'track.set_mute' && c !== 'track.set_solo') };
  const bare = mixer(fakeClient(snapshot()), noMuteSolo);
  for (const id of ['fader-trk_a', 'pan-trk_a', 'mute-trk_a', 'solo-trk_a']) assert.ok(!bare.includes(`data-testid="${id}"`), id);
  const bareInspector = inspector(fakeClient(snapshot()), noMuteSolo);
  for (const id of ['inspector-volume', 'inspector-pan', 'inspector-mute', 'inspector-solo']) assert.ok(!bareInspector.includes(`data-testid="${id}"`), id);
  const unknown = mixer(fakeClient(snapshot()), null);
  for (const id of ['fader-trk_a', 'pan-trk_a', 'mute-trk_a', 'solo-trk_a']) assert.ok(!unknown.includes(`data-testid="${id}"`), id);
});

test('the Inspector\'s Track tab shows the selected clip\'s track: name, colour, M, S, volume and pan', () => {
  const tracks = [{ ...track('trk_a'), gainMilliDb: -4000, pan: -3500, mute: true }, track('trk_b')];
  const html = inspector(fakeClient(snapshot(tracks)));
  assert.equal(textOf(html, 'inspector-track'), 'trk_a');
  assert.match(tag(html, 'inspector-colour'), new RegExp(trackColour('trk_a'), 'i'));
  assert.equal(attr(html, 'inspector-mute', 'aria-pressed'), 'true');
  assert.equal(attr(html, 'inspector-solo', 'aria-pressed'), 'false');
  assert.equal(attr(html, 'inspector-volume', 'role'), 'slider');
  assert.equal(attr(html, 'inspector-volume', 'aria-valuenow'), '-4000');
  assert.equal(attr(html, 'inspector-volume', 'aria-valuetext'), '-4.0 dB');
  assert.equal(attr(html, 'inspector-pan', 'aria-valuetext'), 'L35');
  assert.equal(textOf(html, 'inspector-volume-value'), '-4.0 dB');
  // No clip selected: no track.
  const none = within(FULL, <Inspector client={fakeClient(snapshot())} gestures={gestures} clipId={null} />);
  assert.ok(!none.includes('data-testid="inspector-volume"'));
});

test('a gesture overlay on the track shows in its strip and in the Inspector alike', () => {
  const overlay = { ...track('trk_a'), gainMilliDb: -3000, pan: 2500 };
  const client = fakeClient(snapshot(), LEGEND, overlay);
  const strip = mixer(client);
  const side = inspector(client);
  assert.equal(attr(strip, 'fader-trk_a', 'aria-valuenow'), '-3000');
  assert.equal(attr(side, 'inspector-volume', 'aria-valuenow'), '-3000');
  assert.equal(textOf(strip, 'fader-value-trk_a'), '-3.0 dB');
  assert.equal(textOf(side, 'inspector-volume-value'), '-3.0 dB');
  assert.equal(attr(strip, 'pan-trk_a', 'aria-valuetext'), 'R25');
  assert.equal(attr(side, 'inspector-pan', 'aria-valuetext'), 'R25');
});
