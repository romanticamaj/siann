// The recording parts, ported from the mockup's markup (m5b-ui-recording; UI
// redesign 10.9, 3.0, 3.1, 3.3, 3.5; 10.11, 16 and 17): the expectations come
// from mockup.html's own script (support/mockup.ts: th(), strip(), ic() and
// the left zone's block of the template) and from the fidelity manifest, not
// from the code under test.
//
// - track-N-record: th()'s fourth .msr of .r1, `.msr.r` holding an <i> (the
//   dot), lit (.on, aria-pressed) while the track is armed;
// - strip-N-record: the third .msr of strip()'s second .btns (after the boxes
//   of R and W), the same markup;
// - inspector-record and inspector-monitor: the third and fourth .msr of
//   .i-btns, the monitor a `.msr` holding ic('mon','s'), .on while the mode
//   is not off, the mode in its tooltip;
// - transport-record: the mockup's `.tbtn.rec` holding ic('rec'), fifth in
//   .tgroup[transport-buttons], aria-pressed while recording;
// - the In row: sec('Routing')'s first .irow (a span, then .pick with the
//   input's name and ic('chev','s')) inside the box held for the section;
// - against capabilities without features.recording none of them is in the
//   DOM and each box stays (msr-box, transport-hold-tbtn, the Routing box).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import { CommandRegistry } from '../../src/renderer/keys/commands';
import { Mixer } from '../../src/renderer/mixer/Mixer';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { TrackEntity } from '../../src/renderer/model/document';
import { parseEngineStatus, type EngineStatus } from '../../src/renderer/model/engine-status';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import { structuralBlocked } from '../../src/renderer/model/edit-guard';
import type { MeterLegend } from '../../src/renderer/model/meter-frames';
import type { PendingTake } from '../../src/renderer/model/pending-takes';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import { RecordController, RecordStore, type RecordState } from '../../src/renderer/model/record';
import { SessionClient, type ClientState, type EventMessage } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { HeardContext } from '../../src/renderer/plans/heard-context';
import { Inspector } from '../../src/renderer/shell/Inspector';
import { PendingTakes } from '../../src/renderer/shell/Recording';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { RecordContext, type RecordHost } from '../../src/renderer/shell/record-context';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { Transport } from '../../src/renderer/shell/Transport';
import { TrackList } from '../../src/renderer/timeline/TrackList';
import { byAttr, byClass, classes, elements, find, findAll, loadMockup, parse, sig, text, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'test', 'fidelity', 'manifest.json'), 'utf8')) as { gates: Record<string, string> };
const MOCKUP = loadMockup('en');
const LEGEND: MeterLegend = { epoch: '1', entities: ['master', 'track:trk_a', 'track:trk_b'] };

const DEVICE = { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 256, outputLatencyFrames: 256, input: { id: 'fake', channels: 2, latencyFrames: 256 } };
const WITH_INPUT = parseEngineStatus({ device: DEVICE, xruns: '0' });

const vox = (): TrackEntity => ({ ...track('trk_a'), name: 'Vox Lead', channels: 1, input: { port: 0, channels: 1 } });
const keys = (): TrackEntity => ({ ...track('trk_b'), name: 'Keys', monitor: 'input' } as TrackEntity);

function host(snapshot: Snapshot, caps: Capabilities | null, state: RecordState | null, status: EngineStatus | null = WITH_INPUT, blocked?: () => boolean, pendingTakes: readonly PendingTake[] = []): RecordHost {
  const events = new Map<string, Set<(event: EventMessage) => void>>();
  const clientState = { status: 'connected', capabilities: caps, connections: 1, syncCount: 1, pendingTakes } as unknown as ClientState;
  const client = {
    request: async () => ({}),
    execute: async () => ({}),
    getState: () => clientState,
    subscribe: () => () => undefined,
    onEvent: (type: string, fn: (event: EventMessage) => void) => {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type)!.add(fn);
      return () => void events.get(type)!.delete(fn);
    },
  };
  const store = new RecordStore(client);
  if (state) store.apply(state);
  const statusSource = { getSnapshot: () => status, subscribe: () => () => undefined };
  const controller = new RecordController({
    client,
    model: { getSnapshot: () => snapshot },
    store,
    status: statusSource,
    capabilities: () => capabilitySelector(caps),
    toasts: { push: () => 0 },
    locale: () => 'en',
    ...(blocked ? { blocked } : {}),
  });
  return { controller, status: statusSource };
}

function fakeClient(snap: Snapshot, caps: Capabilities | null) {
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => snap.entities[ref],
    subscribe: () => () => undefined,
  };
  return { model, getState: () => ({ status: 'connected', legend: LEGEND, capabilities: caps }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
}

interface Options {
  caps?: Capabilities;
  state?: RecordState | null;
  status?: EngineStatus | null;
  // The side heard (HeardContext; the edit guard holds while it is a branch).
  heard?: string;
}

const ARMED: RecordState = { recording: false, armed: ['trk_a'], takes: [] };

function renderZones(options: Options = {}): { headers: Element; mixer: Element; inspector: Element } {
  const caps = options.caps ?? FULL;
  const tracks = [vox(), keys()];
  const snap = snapshotOf(tracks.map((t) => t.id), tracks, [], []);
  const client = fakeClient(snap, caps);
  const heard = options.heard ?? null;
  const recordHost = host(snap, caps, options.state === undefined ? ARMED : options.state, options.status === undefined ? WITH_INPUT : options.status, () => structuralBlocked(heard));
  const wrap = (node: ReactNode) =>
    parse(
      renderToStaticMarkup(
        <CapabilitiesContext.Provider value={caps}>
          <RecordContext.Provider value={recordHost}>
            <HeardContext.Provider value={heard}>{node}</HeardContext.Provider>
          </RecordContext.Provider>
        </CapabilitiesContext.Provider>,
      ),
    );
  return {
    headers: wrap(<TrackList client={client} realtime={null} timeline={null} layout={createLayoutStore({ storage: null })} selectedTrackId="trk_a" onSelectTrack={() => undefined} />),
    mixer: wrap(<Mixer client={client} gestures={{} as unknown as GestureController} realtime={{ subscribe: () => () => undefined } as unknown as RealtimeClient} selectedTrackId="trk_a" />),
    inspector: wrap(<Inspector client={client} gestures={{} as unknown as GestureController} trackId="trk_a" />),
  };
}

function sessionClient(): SessionClient {
  return new SessionClient({
    createSocket: () => {
      throw new Error('no socket');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
    model: { getSnapshot: () => null, subscribe: () => () => undefined } as unknown as ReadModel,
  });
}

function renderTransport(options: Options = {}): Element {
  const caps = options.caps ?? FULL;
  const session = sessionClient();
  const status = options.status === undefined ? WITH_INPUT : options.status;
  const loopClick = new LoopClickController({
    client: session,
    model: session.model,
    state: new TransportStateStore(session),
    deviceReady: () => status?.device != null,
    capabilities: () => capabilitySelector(caps),
    toasts: new ToastStore({ schedule: () => () => undefined }),
    locale: () => 'en',
  });
  const transport = new TransportController({ client: session, playing: () => false, toasts: new ToastStore({ schedule: () => () => undefined }), locale: () => 'en' });
  const snap = snapshotOf(['trk_a'], [vox()], [], []);
  const heard = options.heard ?? null;
  const recordHost = host(snap, caps, options.state === undefined ? ARMED : options.state, status, () => structuralBlocked(heard));
  return parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={caps}>
        <RecordContext.Provider value={recordHost}>
          <HeardContext.Provider value={heard}>
            <Transport client={session} realtime={null} engineStatus={{ getSnapshot: () => status, subscribe: () => () => undefined }} layout={createLayoutStore({ storage: null })} commands={new CommandRegistry()} transport={transport} loopClick={loopClick} onStudioSetup={() => undefined} />
          </HeardContext.Provider>
        </RecordContext.Provider>
      </CapabilitiesContext.Provider>,
    ),
  );
}

const byTestId = (id: string) => byAttr('data-testid', id);
const mockupHeader = () => find(parse(MOCKUP.th(MOCKUP.T.find((t) => t.sel)!, MOCKUP.T.findIndex((t) => t.sel))), byClass('th'));
const mockupStrip = () => find(parse(MOCKUP.strip(MOCKUP.T.find((t) => t.sel)!, MOCKUP.T.findIndex((t) => t.sel))), byClass('strip'));
const mockupZone = () => find(parse(MOCKUP.leftzone), byClass('leftzone'));
const svgOf = (markup: string) => find(parse(markup), (el) => el.tag === 'svg');

// The markup of a record enable as the mockup writes it: .msr.r holding one <i>, nothing else.
function assertRecordButton(el: Element, mockup: Element, what: string): void {
  assert.deepEqual(classes(el).filter((c) => c !== 'on').sort(), classes(mockup).filter((c) => c !== 'on').sort(), `${what}: .msr.r`);
  assert.deepEqual(elements(el).map(sig), elements(mockup).map(sig), `${what}: the dot`);
  assert.equal(text(el), '', `${what}: no text`);
}

function assertEmptyBox(el: Element, what: string): void {
  assert.deepEqual(el.children, [], `${what}: nothing in it`);
  assert.equal(el.attrs['aria-hidden'], 'true', `${what}: aria-hidden`);
  for (const name of ['role', 'tabindex', 'data-part', 'data-part-of', 'data-testid']) assert.ok(!(name in el.attrs), `${what}: no ${name}`);
}

test('the gate of m5b-ui-recording reports', () => {
  assert.equal(MANIFEST.gates['m5b-ui-recording'], 'report');
});

test('track-N-record is th()\'s fourth .msr of .r1, lit while armed', () => {
  const { headers } = renderZones();
  const header = find(headers, byTestId('track-header-trk_a'));
  const r1 = find(header, byClass('r1'));
  const mR1 = find(mockupHeader(), byClass('r1'));
  const record = elements(r1).filter((el) => classes(el).includes('msr'))[2]!;
  const mRecord = elements(mR1).filter((el) => classes(el).includes('msr'))[2]!;
  assert.equal(mRecord.attrs['data-part']?.endsWith('-record'), true, 'the mockup\'s third .msr is the record button');
  assertRecordButton(record, mRecord, 'header');
  assert.equal(record.attrs['data-testid'], 'track-record-trk_a');
  assert.equal(record.attrs['data-part-of'], 'record');
  assert.equal(record.tag, 'button');
  assert.ok(classes(record).includes('on'), 'armed: lit');
  assert.equal(record.attrs['aria-pressed'], 'true');
  // Read and write stay empty boxes after it.
  const after = elements(r1).slice(elements(r1).indexOf(record) + 1);
  assert.equal(after.length, 2);
  after.forEach((el, i) => assertEmptyBox(el, `header box ${i}`));
  const other = find(headers, byTestId('track-record-trk_b'));
  assert.ok(!classes(other).includes('on'));
  assert.equal(other.attrs['aria-pressed'], 'false');
});

test('strip-N-record is the third .msr of strip()\'s second .btns, after the boxes of R and W', () => {
  const { mixer } = renderZones();
  const strip = find(mixer, (el) => el.attrs['data-testid'] === 'mixer-strip-trk_a');
  // The row of R, W and record: the strip's last .btns (its id is m6a-ui-automation's, so it carries none).
  const row = findAll(strip, byClass('btns')).at(-1)!;
  assert.ok(!('data-part-of' in row.attrs) && !('aria-hidden' in row.attrs));
  const mRow = find(mockupStrip(), (el) => (el.attrs['data-part'] ?? '').endsWith('-automation'));
  assert.equal(elements(row).length, elements(mRow).length, 'R, W and record');
  assertEmptyBox(elements(row)[0]!, 'R');
  assertEmptyBox(elements(row)[1]!, 'W');
  const record = elements(row)[2]!;
  assertRecordButton(record, elements(mRow)[2]!, 'strip');
  assert.equal(record.attrs['data-testid'], 'strip-record-trk_a');
  assert.equal(record.attrs['data-part-of'], 'record');
  assert.ok(classes(record).includes('on'));
});

test('inspector-record and inspector-monitor are the third and fourth .msr of .i-btns; the monitor holds ic(\'mon\',\'s\')', () => {
  const { inspector } = renderZones();
  const buttons = find(inspector, byClass('i-btns'));
  const mButtons = find(mockupZone(), byClass('i-btns'));
  const record = elements(buttons)[2]!;
  const monitor = elements(buttons)[3]!;
  const mRecord = elements(mButtons)[2]!;
  const mMonitor = elements(mButtons)[3]!;
  assert.equal(mRecord.attrs['data-part'], 'inspector-record');
  assert.equal(mMonitor.attrs['data-part'], 'inspector-monitor');
  assertRecordButton(record, mRecord, 'inspector');
  assert.equal(record.attrs['data-part'], 'inspector-record');
  assert.ok(classes(record).includes('on'));
  // The monitor: the mockup's .msr with its icon, and no class the mockup lacks
  // (its lit rule selects [data-part="inspector-monitor"].on).
  assert.equal(monitor.attrs['data-part'], 'inspector-monitor');
  assert.equal(monitor.tag, 'button');
  assert.deepEqual(classes(monitor).filter((c) => c !== 'on'), classes(mMonitor));
  assert.deepEqual(elements(monitor).map(sig), elements(mMonitor).map(sig), 'svg.i.s');
  const appSvg = elements(monitor)[0]!;
  const mSvg = svgOf(MOCKUP.ic('mon', 's'));
  assert.deepEqual(elements(appSvg).map((p) => p.attrs.d), elements(mSvg).map((p) => p.attrs.d), 'the mon paths');
  // Vox Lead's monitor is off: not lit; its tooltip names the mode.
  assert.ok(!classes(monitor).includes('on'));
  assert.equal(monitor.attrs['aria-pressed'], 'false');
  assert.ok((monitor.attrs.title ?? '').includes(translator('en')('monitor.mode.off')));
  // The boxes of read, write and e stay.
  elements(buttons).slice(4).forEach((el, i) => assertEmptyBox(el, `i-btns box ${i}`));
});

test('a monitored track\'s monitor is lit with its mode in the tooltip', () => {
  const caps = FULL;
  const tracks = [vox(), keys()];
  const snap = snapshotOf(tracks.map((t) => t.id), tracks, [], []);
  const markup = parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={caps}>
        <RecordContext.Provider value={host(snap, caps, ARMED)}>
          <Inspector client={fakeClient(snap, caps)} gestures={{} as unknown as GestureController} trackId="trk_b" />
        </RecordContext.Provider>
      </CapabilitiesContext.Provider>,
    ),
  );
  const monitor = find(markup, byAttr('data-part', 'inspector-monitor'));
  const mMonitor = find(mockupZone(), byAttr('data-part', 'inspector-monitor'));
  assert.ok(classes(monitor).includes('on'));
  assert.deepEqual(classes(monitor).filter((c) => c !== 'on'), classes(mMonitor));
  assert.equal(monitor.attrs['aria-pressed'], 'true');
  assert.ok((monitor.attrs.title ?? '').includes(translator('en')('monitor.mode.input')));
});

test('the In row is sec(\'Routing\')\'s first .irow, alone inside the box held for the section', () => {
  const { inspector } = renderZones();
  const routing = find(inspector, (el) => classes(el).includes('inspector-hold') && classes(el).includes('routing'));
  // The box keeps the section's place; it is no part (the section's id arrives with m5b-ui-sends-buses).
  assert.ok(!('data-part' in routing.attrs));
  const rows = elements(routing);
  assert.equal(rows.length, 1, 'the In row alone');
  const row = rows[0]!;
  const mRouting = find(mockupZone(), byAttr('data-part', 'inspector-routing'));
  const mRow = findAll(mRouting, byClass('irow'))[0]!;
  assert.equal(sig(row), sig(mRow));
  assert.deepEqual(elements(row).map((el) => sig(el)), elements(mRow).map((el) => sig(el)), 'span, then .pick');
  assert.equal(text(elements(row)[0]!), text(elements(mRow)[0]!), 'the label In');
  const pick = elements(row)[1]!;
  // The mockup's "Mono In 1": Vox Lead's input, port 0, mono.
  assert.ok(text(pick).startsWith(text(elements(mRow)[1]!)), `the input's name: ${text(pick)}`);
  const chev = find(pick, (el) => el.tag === 'svg');
  assert.equal(sig(chev), sig(svgOf(MOCKUP.ic('chev', 's'))));
  // The choice is a native select over the .pick: the open input's two mono ports, one stereo pair and none.
  const select = find(pick, (el) => el.tag === 'select');
  assert.equal(select.attrs['data-testid'], 'inspector-input');
  assert.equal(findAll(select, (el) => el.tag === 'option').length, 4);
});

test('transport-record is the mockup\'s .tbtn.rec holding ic(\'rec\'), fifth in the transport buttons', () => {
  const root = renderTransport();
  const group = find(root, byAttr('data-part', 'transport-buttons'));
  const record = elements(group)[4]!;
  assert.equal(record.attrs['data-part'], 'transport-record');
  assert.equal(record.tag, 'button');
  assert.deepEqual(classes(record).sort(), ['rec', 'tbtn']);
  const appSvg = elements(record)[0]!;
  const mSvg = svgOf(MOCKUP.ic('rec'));
  assert.equal(sig(appSvg), sig(mSvg));
  assert.deepEqual(elements(appSvg).map((c) => c.tag), elements(mSvg).map((c) => c.tag));
  assert.equal(record.attrs['aria-pressed'], 'false');
  // Armed with an input: enabled; its tooltip names it.
  assert.ok(!('disabled' in record.attrs) && !('aria-disabled' in record.attrs));
  // Recording: pressed.
  const recording = elements(find(renderTransport({ state: { recording: true, armed: ['trk_a'], takes: [] } }), byAttr('data-part', 'transport-buttons')))[4]!;
  assert.equal(recording.attrs['aria-pressed'], 'true');
});

test('Record is aria-disabled with the reason: nothing armed; no input open (with the Studio Setup hint); no device', () => {
  const t = translator('en');
  const nothing = find(renderTransport({ state: { recording: false, armed: [], takes: [] } }), byAttr('data-part', 'transport-record'));
  assert.equal(nothing.attrs['aria-disabled'], 'true');
  assert.equal(nothing.attrs.title, t('record.reason.nothingArmed'));
  const noInput = find(renderTransport({ status: parseEngineStatus({ device: { ...DEVICE, input: null } }) }), byAttr('data-part', 'transport-record'));
  assert.equal(noInput.attrs['aria-disabled'], 'true');
  assert.equal(noInput.attrs.title, `${t('record.reason.noInput')}\n${t('transport.studioSetupHint')}`);
  const noDevice = find(renderTransport({ status: parseEngineStatus({ device: null }) }), byAttr('data-part', 'transport-record'));
  assert.equal(noDevice.attrs['aria-disabled'], 'true');
  assert.ok((noDevice.attrs.title ?? '').endsWith(t('transport.studioSetupHint')));
});

test('against capabilities without features.recording none of the parts is in the DOM and every box stays', () => {
  const zones = renderZones({ caps: REDUCED });
  for (const [name, root] of Object.entries(zones)) {
    assert.deepEqual(findAll(root, (el) => /-record$|^inspector-monitor$/.test(el.attrs['data-part'] ?? '') || el.attrs['data-part-of'] === 'record'), [], name);
    assert.deepEqual(findAll(root, (el) => el.tag === 'select'), [], `${name}: no input selector`);
  }
  const r1 = find(find(zones.headers, byTestId('track-header-trk_a')), byClass('r1'));
  assert.equal(elements(r1).filter((el) => classes(el).includes('msr-box')).length >= 3, true, 'the boxes of record, read and write');
  const buttons = find(zones.inspector, byClass('i-btns'));
  elements(buttons).slice(2).forEach((el, i) => assertEmptyBox(el, `i-btns box ${i}`));
  const routing = find(zones.inspector, (el) => classes(el).includes('inspector-hold') && classes(el).includes('routing'));
  assertEmptyBox(routing, 'the Routing box');
  // The reduced fixture has no transport at all; the full one without recording keeps it.
  const transport = renderTransport({ caps: { ...FULL, features: { ...FULL.features, recording: false } } });
  const group = find(transport, byAttr('data-part', 'transport-buttons'));
  const box = elements(group)[4]!;
  assert.deepEqual(classes(box).sort(), ['transport-hold', 'transport-hold-tbtn']);
  assertEmptyBox(box, 'the Record box');
  assert.deepEqual(findAll(transport, byAttr('data-part', 'transport-record')), []);
});

test('an engine without track.set_monitor or features.monitoring has no monitor; its box stays', () => {
  const caps = { ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'track.set_monitor') };
  const { inspector } = renderZones({ caps });
  assert.deepEqual(findAll(inspector, byAttr('data-part', 'inspector-monitor')), []);
  const buttons = find(inspector, byClass('i-btns'));
  assert.ok(elements(buttons)[2]!.attrs['data-part'] === 'inspector-record');
  assertEmptyBox(elements(buttons)[3]!, 'the monitor box');
});

test('while a proposal is heard Record, the In selector, the monitor and Keep are disabled with the guard\'s reason; record enable and Discard are not (4.5 C5; 10.11, 22)', () => {
  const t = translator('en');
  const reason = t('guard.structural');
  const { headers, mixer, inspector } = renderZones({ heard: 'prop_1' });
  const record = find(renderTransport({ heard: 'prop_1' }), byAttr('data-part', 'transport-record'));
  assert.equal(record.attrs['aria-disabled'], 'true', 'Record');
  assert.equal(record.attrs.title, reason);
  const select = find(inspector, byTestId('inspector-input'));
  assert.ok('disabled' in select.attrs, 'the In selector');
  assert.equal(select.attrs.title, reason);
  const monitor = find(inspector, byAttr('data-part', 'inspector-monitor'));
  assert.ok('disabled' in monitor.attrs, 'the monitor');
  assert.equal(monitor.attrs.title, reason);
  // Record enable is engine state: it arms and disarms as before, on the header, the strip and the Inspector.
  for (const [what, root, id] of [['header', headers, 'track-record-trk_a'], ['strip', mixer, 'strip-record-trk_a']] as const) {
    const enable = find(root, byTestId(id));
    assert.ok(!('aria-disabled' in enable.attrs) && !('disabled' in enable.attrs), what);
  }
  assert.ok(!('aria-disabled' in find(inspector, byAttr('data-part', 'inspector-record')).attrs), 'inspector');
  // A recording that runs can be stopped.
  const running = find(renderTransport({ heard: 'prop_1', state: { recording: true, armed: ['trk_a'], takes: [] } }), byAttr('data-part', 'transport-record'));
  assert.ok(!('aria-disabled' in running.attrs) && !('disabled' in running.attrs));
  assert.equal(running.attrs['aria-pressed'], 'true');
  // With main heard nothing is held.
  const main = renderZones({ heard: 'main' });
  assert.ok(!('disabled' in find(main.inspector, byTestId('inspector-input')).attrs));
  assert.ok(!('disabled' in find(main.inspector, byAttr('data-part', 'inspector-monitor')).attrs));
  assert.ok(!('aria-disabled' in find(renderTransport({ heard: 'main' }), byAttr('data-part', 'transport-record')).attrs));

  // The pending takes: Keep commits onto main and is held; Discard moves the files to the trash and is not.
  const pending: PendingTake[] = [{ takeId: 'take_a1', trackId: 'trk_a', channels: 1, sampleRate: 48000, startFrame: '0', endedBy: 'device', overflows: '0' }];
  const snap = snapshotOf(['trk_a'], [vox()], [], []);
  const renderPending = (heard: string) => {
    const recordHost = host(snap, FULL, { recording: false, armed: [], takes: [] }, WITH_INPUT, () => structuralBlocked(heard), pending);
    const client = { model: { getSnapshot: () => snap }, getState: () => ({ connections: 1 }), subscribe: () => () => undefined } as unknown as SessionClient;
    return parse(
      renderToStaticMarkup(
        <HeardContext.Provider value={heard}>
          <PendingTakes controller={recordHost.controller} client={client} />
        </HeardContext.Provider>,
      ),
    );
  };
  const held = renderPending('prop_1');
  const keep = find(held, byTestId('pending-take-keep-take_a1'));
  assert.ok('disabled' in keep.attrs, 'Keep');
  assert.equal(keep.attrs.title, reason);
  assert.ok(!('disabled' in find(held, byTestId('pending-take-discard-take_a1')).attrs), 'Discard');
  assert.ok(!('disabled' in find(renderPending('main'), byTestId('pending-take-keep-take_a1')).attrs), 'Keep with main heard');
});
