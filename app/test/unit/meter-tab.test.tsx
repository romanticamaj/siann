// The Meter tab (m5b-ui-meter; UI redesign UR-14, 2.1, 3.0, 5.3): the right
// zone's third tab, ported from the mockup's tab row (mockup.html line 303:
// span.tab[tab-meter] with the bars icon and the catalog label). The mockup
// draws the label only; the panel is built from the shared rules (.z-head,
// .meter, .ch, .readout, .btn) and laid out by shell.css with existing tokens:
//
//   div.meter-panel
//     div.z-head                   the master's name
//     div.meter-panel-body
//       div.meter > div.ch x2      the master's two channel wells (the canvas paints them)
//       div.meter-panel-values     .readout rows: the peak value (button.pk, a
//                                  click resets the peak and the clip), then
//                                  momentary, short-term and integrated, each
//                                  label, value (written by the meter surface)
//                                  and unit; the reset of the integrated value
//                                  (button.btn, only with meter.reset_loudness)
//     canvas.meter-panel-canvas
//
// Without features.loudness the tab is absent and its box an empty
// span.tab-meter-empty (UI redesign 3.0), and a stored Meter tab shows Plans.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import { MeterStore } from '../../src/renderer/model/meter-store';
import { PlanStore } from '../../src/renderer/model/plan-store';
import type { ReadModel } from '../../src/renderer/model/read-model';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import { LoudnessStore } from '../../src/renderer/model/loudness-store';
import { SessionClient } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { UndoHistory } from '../../src/renderer/model/undo-history';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { LAYOUT_KEY } from '../../src/renderer/shell/layout';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { MeterPanel } from '../../src/renderer/shell/MeterPanel';
import { Shell } from '../../src/renderer/shell/Shell';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { FakeSocket, until } from './support/fakes';
import { find, findAll, mockupRightZone, parse, sig, textOf, type Node } from './support/mockup-plan';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const WITHOUT_LOUDNESS: Capabilities = { ...FULL, features: { ...FULL.features, loudness: false } };
const WITHOUT_RESET: Capabilities = { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'meter.reset_loudness') };

const partOf = (n: Node) => n.attrs['data-part'];

function offlineClient(): SessionClient {
  const model = { getSnapshot: () => null, subscribe: () => () => undefined, select: () => undefined } as unknown as ReadModel;
  return new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
    model,
  });
}

function fakeRealtime(): RealtimeClient {
  const loudness = new LoudnessStore();
  return {
    legend: () => ({ epoch: '1', entities: ['master'] }),
    latest: () => null,
    frameCount: () => 0,
    subscribe: () => () => undefined,
    subscribeLoudness: () => () => undefined,
    loudness,
  } as unknown as RealtimeClient;
}

function panel(caps: Capabilities = FULL): string {
  const realtime = fakeRealtime();
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={caps}>
      <MeterPanel client={offlineClient()} realtime={realtime} store={new MeterStore(realtime)} />
    </CapabilitiesContext.Provider>,
  );
}

function shell(caps: Capabilities, stored: string | null = null): Node {
  const client = offlineClient();
  const plans = new PlanStore();
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const model = client.model;
  const loopClick = new LoopClickController({
    client,
    model,
    state: new TransportStateStore(client),
    deviceReady: () => false,
    capabilities: () => capabilitySelector(caps),
    toasts,
    locale: () => 'en',
  });
  const storage = { getItem: (key: string) => (key === LAYOUT_KEY ? stored : null), setItem: () => undefined };
  const markup = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={caps}>
      <Shell
        client={client}
        plans={plans}
        engineStatus={{ getSnapshot: () => null, subscribe: () => () => undefined }}
        store={createLayoutStore({ storage })}
        commands={new CommandRegistry()}
        platform="other"
        phase="online"
        toasts={toasts}
        realtime={null}
        transport={new TransportController({ client, playing: () => false, toasts, locale: () => 'en' })}
        loopClick={loopClick}
        history={new UndoHistory(client)}
        left={<p>left</p>}
        project={<p>project</p>}
        lower={<p>lower</p>}
        right={<p data-testid="the-plans">plans</p>}
        rightMeter={<p data-testid="the-meter">meter</p>}
      />
    </CapabilitiesContext.Provider>,
  );
  const zone = find(parse(markup), (n) => n.attrs['data-region'] === 'right-zone');
  assert.ok(zone, 'the right zone');
  return zone;
}

test('with features.loudness the tab row holds the mockup\'s Meter tab: button.tab[tab-meter], the bars icon and the catalog label', () => {
  const mock = find(parse(mockupRightZone('en')), (n) => partOf(n) === 'tab-meter')!;
  assert.equal(sig(mock), 'span.tab[tab-meter]');
  assert.deepEqual(mock.children.map((c) => [c.tag, c.classes.join('.'), c.attrs['data-icon']]), [['svg', 'i.s', 'bars']]);
  const zone = shell(FULL);
  const head = find(zone, (n) => partOf(n) === 'right-tabs')!;
  // (No hearing switch is passed to this Shell.)
  assert.deepEqual(head.children.map(sig), ['button.tab.on[tab-plans]', 'button.tab[tab-media]', 'button.tab[tab-meter]']);
  const tab = find(zone, (n) => partOf(n) === 'tab-meter')!;
  assert.equal(tab.attrs['data-testid'], 'tab-right-meter');
  assert.equal(tab.attrs.role, 'tab');
  assert.equal(tab.attrs['aria-selected'], 'false');
  assert.deepEqual(tab.children.map((c) => [c.tag, c.classes.join('.')]), [['svg', 'i.s']]);
  // The bars icon is the mockup's drawing.
  assert.deepEqual(tab.children[0]!.children.map((c) => c.attrs.d), ['M4 13V7M8 13V3M12 13V9']);
  assert.equal(textOf(tab), 'Meter');
  for (const [lang, word] of [['zh-TW', '電平表']] as const) {
    assert.equal(textOf(find(parse(mockupRightZone(lang)), (n) => partOf(n) === 'tab-meter')!), word, `the mockup's ${lang} label`);
  }
  // The Plans tab is selected, the zone shows its body.
  assert.ok(find(zone, (n) => n.attrs['data-testid'] === 'the-plans'));
  assert.equal(find(zone, (n) => n.attrs['data-testid'] === 'the-meter'), undefined);
});

test('a stored Meter tab is selected and the zone shows the Meter panel; without features.loudness it shows Plans', () => {
  const stored = JSON.stringify({ tabs: { right: 'meter' } });
  const zone = shell(FULL, stored);
  const tab = find(zone, (n) => partOf(n) === 'tab-meter')!;
  assert.deepEqual(tab.classes, ['tab', 'on']);
  assert.equal(tab.attrs['aria-selected'], 'true');
  assert.deepEqual(find(zone, (n) => partOf(n) === 'tab-plans')!.classes, ['tab']);
  assert.ok(find(zone, (n) => n.attrs['data-testid'] === 'the-meter'));
  assert.equal(find(zone, (n) => n.attrs['data-testid'] === 'the-plans'), undefined);
  const fallback = shell(WITHOUT_LOUDNESS, stored);
  assert.ok(find(fallback, (n) => n.attrs['data-testid'] === 'the-plans'), 'Plans while the engine has no loudness');
  assert.deepEqual(find(fallback, (n) => partOf(n) === 'tab-plans')!.classes, ['tab', 'on']);
});

test('without features.loudness the Meter tab is absent and its box is an empty span.tab-meter-empty', () => {
  const zone = shell(WITHOUT_LOUDNESS);
  assert.equal(find(zone, (n) => partOf(n) === 'tab-meter'), undefined);
  const head = find(zone, (n) => partOf(n) === 'right-tabs')!;
  assert.deepEqual(head.children.map(sig), ['button.tab.on[tab-plans]', 'button.tab[tab-media]', 'span.tab-meter-empty']);
  const box = head.children[2]!;
  assert.equal(box.attrs['aria-hidden'], 'true');
  for (const attr of ['role', 'tabindex', 'data-part', 'data-testid', 'title', 'aria-label']) assert.ok(!(attr in box.attrs), attr);
  assert.equal(textOf(box), '');
  assert.equal(box.children.length, 0);
});

test('the Meter panel: a zone head, the master\'s two channel wells, the peak value, three loudness readouts and the reset', () => {
  const root = find(parse(panel()), (n) => n.classes.includes('meter-panel'))!;
  assert.ok(root, 'div.meter-panel');
  assert.equal(root.attrs['data-testid'], 'meter-panel');
  assert.deepEqual(root.children.map(sig), ['div.z-head', 'div.meter-panel-body', 'canvas.meter-panel-canvas']);
  assert.equal(textOf(root.children[0]!), 'Master');
  const [body] = [root.children[1]!];
  assert.deepEqual(body.children.map(sig), ['div.meter', 'div.meter-panel-values']);
  const meter = body.children[0]!;
  assert.equal(meter.attrs['data-testid'], 'meter-panel-master');
  assert.deepEqual(meter.children.map(sig), ['div.ch', 'div.ch']);
  const values = body.children[1]!;
  assert.deepEqual(values.children.map(sig), ['div.readout', 'div.readout', 'div.readout', 'div.readout', 'button.btn']);
  // The peak value reuses the strip's PeakValue: button.pk, its text written by the surface.
  const [peak, momentary, shortTerm, integrated] = values.children;
  assert.deepEqual(peak!.children.map(sig), ['span', 'button.pk']);
  assert.equal(textOf(peak!.children[0]!), 'Peak');
  const pk = peak!.children[1]!;
  assert.equal(pk.attrs['data-testid'], 'meter-panel-peak');
  assert.equal(pk.attrs['aria-label'], 'Master peak; click to reset');
  assert.equal(textOf(pk), '');
  for (const [row, label, id] of [
    [momentary!, 'Momentary', 'loudness-momentary'],
    [shortTerm!, 'Short-term', 'loudness-short-term'],
    [integrated!, 'Integrated', 'loudness-integrated'],
  ] as const) {
    assert.deepEqual(row.children.map(sig), ['span', 'span', 'span'], label);
    assert.equal(textOf(row.children[0]!), label);
    assert.equal(row.children[1]!.attrs['data-testid'], id);
    assert.equal(textOf(row.children[1]!), '', `${label}: written by the surface, not React`);
    assert.equal(textOf(row.children[2]!), 'LUFS');
  }
  const reset = values.children[4]!;
  assert.equal(reset.tag, 'button');
  assert.equal(reset.attrs.type, 'button');
  assert.equal(reset.attrs['data-testid'], 'meter-reset-loudness');
  assert.equal(textOf(reset), 'Reset');
  // Every colour of the panel is a token.
  for (const el of findAll(root, (n) => 'style' in n.attrs)) assert.doesNotMatch(el.attrs.style!, /#|rgb|\d+px/, el.attrs.style);
});

test('the reset exists only when the engine lists meter.reset_loudness', () => {
  const root = find(parse(panel(WITHOUT_RESET)), (n) => n.classes.includes('meter-panel'))!;
  const values = find(root, (n) => n.classes.includes('meter-panel-values'))!;
  assert.deepEqual(values.children.map(sig), ['div.readout', 'div.readout', 'div.readout', 'div.readout']);
});

test('resetLoudness sends meter.reset_loudness {} once', async () => {
  const sockets: FakeSocket[] = [];
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      socket.handler = (message) => {
        if (message.type === 'auth') {
          queueMicrotask(() => socket.deliver({ type: 'auth', ok: true, sessionId: 'ses_0000000000000001', revision: 'r1', seq: '1', meters: null }));
          return;
        }
        if (message.method === 'engine.capabilities') queueMicrotask(() => socket.deliver({ requestId: message.requestId, ok: true, result: FULL as unknown as Record<string, unknown> }));
        if (message.method === 'meter.reset_loudness') queueMicrotask(() => socket.deliver({ requestId: message.requestId, ok: true, result: {} }));
      };
      sockets.push(socket);
      return socket;
    },
    currentEndpoint: async () => ({ port: 1, token: 'tok' }),
    schedule: () => () => undefined,
  });
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => client.getState().status === 'connected', 'connected');
  await client.resetLoudness();
  const sent = sockets[0]!.requests('meter.reset_loudness');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.params, {});
});

test('no loudness value passes through React state: the panel and the loudness row read no store while rendering', () => {
  for (const file of [path.join(SRC, 'shell', 'MeterPanel.tsx'), path.join(SRC, 'shell', 'dsp-load.ts')]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /useState\(|useSyncExternalStore\(|useReducer\(/, path.basename(file));
  }
  const strip = fs.readFileSync(path.join(SRC, 'mixer', 'Strip.tsx'), 'utf8');
  const loudness = strip.slice(strip.indexOf('function LoudnessValue'), strip.indexOf('}', strip.indexOf('return <span', strip.indexOf('function LoudnessValue'))));
  assert.ok(loudness.length > 0, 'Strip.tsx has LoudnessValue');
  assert.doesNotMatch(loudness, /useState|useSyncExternalStore/);
});
