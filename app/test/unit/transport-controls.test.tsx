// The transport bar (m5-ui-transport; UI redesign spec 3.0, 3.1): start/stop,
// stop and go-to-start buttons, the position display, undo and redo in the
// top bar. With no audio device (engine.status device null) the controls
// work in this build but not in this state, so they are disabled and their
// tooltip names the reason: the device error's code in front of the
// catalog's text, in every locale. An engine whose capabilities do not list
// transport.play, transport.stop and transport.locate gets no transport at
// all (rule 3.0, through shell/Capable.tsx). Rendered with react-dom/server.
// m5-ui-loop-click adds the cycle button, the locator display and the click
// group with the metronome: they show the engine's state, are disabled with
// the reason without a device, and are absent (their boxes empty) on an
// engine that does not list their methods.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { LOCALES } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';
import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { parseEngineStatus, type EngineStatus, type EngineStatusSource } from '../../src/renderer/model/engine-status';
import { SessionClient } from '../../src/renderer/model/session-client';
import type { LocatorsEntity } from '../../src/renderer/model/document';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import { TransportController } from '../../src/renderer/model/transport';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { ClickLevel, TimeFormatMenu, Transport, transportAvailability } from '../../src/renderer/shell/Transport';
import { sampleSnapshot } from './support/timeline';

// dist/test/unit -> app/test/unit/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');
// The full engine without E-1 (m5-ui-loop-click): no set_cycle, set_click,
// session.set_locators, nor their features.
const WITHOUT_E1: Capabilities = {
  ...FULL,
  methods: FULL.methods!.filter((m) => m !== 'transport.set_cycle' && m !== 'transport.set_click'),
  commands: FULL.commands!.filter((c) => c !== 'session.set_locators'),
  features: Object.fromEntries(Object.entries(FULL.features!).filter(([name]) => !['locators', 'cycle', 'click'].includes(name))),
};

const WITH_DEVICE = parseEngineStatus({
  device: { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 240, outputLatencyFrames: 480 },
  deviceError: null,
  xruns: '0',
});
const NO_DEVICE = parseEngineStatus({ device: null, deviceError: { code: 'device_open_failed', message: 'open failed' }, xruns: '0' });
const NO_DEVICE_NO_ERROR = parseEngineStatus({ device: null, deviceError: null, xruns: '0' });

const CONTROLS = ['transport-play', 'transport-stop', 'transport-to-start'];

function statusSource(snapshot: EngineStatus | null): EngineStatusSource {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}

function modelOf(snapshot: Snapshot | null): ReadModel {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as ReadModel;
}

function client(snapshot: Snapshot | null = null): SessionClient {
  return new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
    model: modelOf(snapshot),
  });
}

interface Extra {
  readonly snapshot?: Snapshot | null;
  readonly state?: { cycle: boolean; click: { enabled: boolean; gainMilliDb: number } } | null;
}

function render(capabilities: Capabilities | null, status: EngineStatus | null, extra: Extra = {}): string {
  const session = client(extra.snapshot ?? null);
  const state = new TransportStateStore(session);
  if (extra.state) state.apply(extra.state);
  const loopClick = new LoopClickController({
    client: session,
    model: session.model,
    state,
    deviceReady: () => status?.device != null,
    capabilities: () => capabilitySelector(capabilities),
    toasts: new ToastStore({ schedule: () => () => undefined }),
    locale: () => 'en',
  });
  const controller = new TransportController({
    client: session,
    playing: () => false,
    toasts: new ToastStore({ schedule: () => () => undefined }),
    locale: () => 'en',
  });
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={capabilities}>
      <Transport
        client={session}
        realtime={null}
        engineStatus={statusSource(status)}
        layout={createLayoutStore({ storage: null })}
        commands={new CommandRegistry()}
        transport={controller}
        loopClick={loopClick}
      />
    </CapabilitiesContext.Provider>,
  );
}

function tag(markup: string, testId: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(markup);
  assert.ok(match, `${testId} in ${markup}`);
  return match[0];
}

test('the transport is enabled with a device and disabled with the reason without one', () => {
  for (const locale of LOCALES) {
    const t = translator(locale);
    assert.deepEqual(transportAvailability(WITH_DEVICE, t), { enabled: true, reason: null }, locale);
    const none = transportAvailability(NO_DEVICE, t);
    assert.equal(none.enabled, false);
    assert.equal(none.reason, `device_open_failed: ${t('transport.noDevice')}`, locale);
    // No error code: the catalog's text alone.
    assert.deepEqual(transportAvailability(NO_DEVICE_NO_ERROR, t), { enabled: false, reason: t('transport.noDevice') });
    // While the engine is away the reason is the connection.
    assert.deepEqual(transportAvailability(null, t, false), { enabled: false, reason: t('error.disconnected') });
    // Connected, before the first engine.status answer: the engine decides.
    assert.deepEqual(transportAvailability(null, t, true), { enabled: true, reason: null });
  }
  // The reason is worded per locale.
  const en = transportAvailability(NO_DEVICE, translator('en')).reason;
  assert.notEqual(transportAvailability(NO_DEVICE, translator('zh-Hant')).reason, en);
  assert.notEqual(transportAvailability(NO_DEVICE, translator('zh-Hans')).reason, en);
});

test('with no device the rendered buttons are disabled and their title gives the reason', () => {
  const markup = render(FULL, NO_DEVICE);
  const reason = `device_open_failed: ${translator('en')('transport.noDevice')}`;
  for (const id of CONTROLS) {
    const button = tag(markup, id);
    assert.match(button, /^<button/, id);
    assert.match(button, /disabled=""/, id);
    assert.ok(button.includes(`title="${reason}"`), `${id}: ${button}`);
  }
  // The position display is there, its tooltip says bars are 4/4. Auto-scroll
  // is the project zone toolbar's (the mockup's), not the top bar's.
  assert.ok(tag(markup, 'position-display').includes(`title="${translator('en')('transport.fourFour')}"`));
  tag(markup, 'position-primary');
  tag(markup, 'position-secondary');
  assert.ok(!markup.includes('data-testid="auto-scroll"'));
});

// agent-rules "UI fidelity": each part carries the mockup's data-part id
// (mockup.html's top bar), and the buttons keep the mockup's order.
test('the transport parts carry the mockup ids in the mockup order', () => {
  const markup = render(FULL, WITH_DEVICE);
  const parts: Array<[string, string]> = [
    ['transport', 'transport'],
    ['transport-to-start', 'transport-start'],
    ['transport-stop', 'transport-stop'],
    ['transport-play', 'transport-play'],
    ['position-display', 'display'],
    ['position-primary', 'display-position'],
    ['position-secondary', 'display-time'],
    ['transport-tempo', 'display-tempo'],
    ['undo', 'undo'],
    ['redo', 'redo'],
  ];
  for (const [id, part] of parts) assert.ok(tag(markup, id).includes(`data-part="${part}"`), `${id}: data-part="${part}"`);
  assert.ok(markup.includes('data-part="transport-buttons"'));
  const order = ['transport-start', 'transport-stop', 'transport-play'].map((part) => markup.indexOf(`data-part="${part}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'go to start, stop, start');
});

test('the capability rule: no transport.* in engine.capabilities, no transport controls in the DOM', () => {
  const full = render(FULL, WITH_DEVICE);
  for (const id of [...CONTROLS, 'position-display']) assert.ok(full.includes(`data-testid="${id}"`), id);
  for (const capabilities of [REDUCED, null]) {
    const reduced = render(capabilities, WITH_DEVICE);
    for (const id of [...CONTROLS, 'position-display', 'position-field']) {
      assert.ok(!reduced.includes(`data-testid="${id}"`), `${id} with ${capabilities ? 'the reduced fixture' : 'no capabilities'}`);
    }
  }
});

test('undo and redo are buttons in the top bar, labelled per locale, live without a device and absent without session.undo/redo', () => {
  const t = translator('en');
  const full = render(FULL, NO_DEVICE);
  for (const [id, key] of [['undo', 'transport.undo'], ['redo', 'transport.redo']] as const) {
    const button = tag(full, id);
    assert.match(button, /^<button/, id);
    assert.ok(button.includes(`aria-label="${t(key)}"`), button);
    assert.ok(!/disabled=""/.test(button), `${id} needs no device: ${button}`);
  }
  for (const locale of LOCALES) assert.ok(translator(locale)('transport.undo').length > 0);
  assert.notEqual(translator('zh-Hant')('transport.undo'), t('transport.undo'));
  // The reduced fixture lists no session.undo / session.redo.
  for (const capabilities of [REDUCED, null]) {
    const reduced = render(capabilities, WITH_DEVICE);
    for (const id of ['undo', 'redo']) assert.ok(!reduced.includes(`data-testid="${id}"`), id);
  }
});

test('the time format menu has two items, Bars+Beats and Seconds, the primary one checked', () => {
  const t = translator('en');
  for (const primary of ['bars', 'seconds'] as const) {
    const markup = renderToStaticMarkup(<TimeFormatMenu primary={primary} x={10} y={20} onChoose={() => undefined} onClose={() => undefined} />);
    assert.match(tag(markup, 'time-format-menu'), /role="menu"/);
    const bars = tag(markup, 'time-format-bars');
    const seconds = tag(markup, 'time-format-seconds');
    assert.match(bars, /role="menuitemradio"/);
    assert.match(seconds, /role="menuitemradio"/);
    assert.ok(bars.includes(`aria-checked="${primary === 'bars'}"`), bars);
    assert.ok(seconds.includes(`aria-checked="${primary === 'seconds'}"`), seconds);
    assert.ok(markup.includes(t('transport.formatBars')) && markup.includes(t('transport.formatSeconds')));
  }
});

// ---------------------------------------------------------------- m5-ui-loop-click

function withLocators(left: string, right: string, snapshot: Snapshot = sampleSnapshot()): Snapshot {
  const locators: LocatorsEntity = { schema: 'siann.entity.locators.v1', id: 'locators', left, right };
  return { ...snapshot, locators };
}

const ON = { cycle: true, click: { enabled: true, gainMilliDb: -12000 } };
const OFF = { cycle: false, click: { enabled: false, gainMilliDb: -12000 } };

test('the cycle and metronome buttons are pressed and lit with the engine\'s state', () => {
  const on = render(FULL, WITH_DEVICE, { state: ON });
  for (const id of ['transport-cycle', 'transport-metronome']) {
    const button = tag(on, id);
    assert.match(button, /^<button/, id);
    assert.match(button, /aria-pressed="true"/, id);
    assert.match(button, /class="[^"]*\blit\b/, id);
  }
  const off = render(FULL, WITH_DEVICE, { state: OFF });
  for (const id of ['transport-cycle', 'transport-metronome']) {
    const button = tag(off, id);
    assert.match(button, /aria-pressed="false"/, id);
    assert.ok(!/class="[^"]*\blit\b/.test(button), id);
  }
  // The mockup's ids and order: start, cycle, stop, play; the click group holds the metronome.
  assert.ok(tag(on, 'transport-cycle').includes('data-part="transport-cycle"'));
  assert.ok(tag(on, 'transport-click').includes('data-part="transport-click"'));
  assert.ok(tag(on, 'transport-metronome').includes('data-part="transport-metronome"'));
  const order = ['transport-start', 'transport-cycle', 'transport-stop', 'transport-play'].map((part) => on.indexOf(`data-part="${part}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const click = on.indexOf('data-part="transport-click"');
  assert.ok(click < on.indexOf('data-part="transport-metronome"') && click > on.indexOf('data-part="display-tempo"'));
});

test('without a device cycle and the metronome are disabled with the reason, in every locale', () => {
  for (const locale of ['en'] as const) {
    const t = translator(locale);
    const markup = render(FULL, NO_DEVICE, { state: OFF });
    for (const [id, key] of [['transport-cycle', 'transport.noDeviceCycle'], ['transport-metronome', 'transport.noDeviceClick']] as const) {
      const button = tag(markup, id);
      assert.match(button, /disabled=""/, id);
      assert.ok(button.includes(`title="device_open_failed: ${t(key)}"`), `${id}: ${button}`);
    }
  }
  for (const key of ['transport.noDeviceCycle', 'transport.noDeviceClick'] as const) {
    assert.notEqual(translator('zh-Hant')(key), translator('en')(key));
    assert.notEqual(translator('zh-Hans')(key), translator('en')(key));
  }
});

const HOLDS = /<span class="(transport-hold [\w-]+|cell display-locators-empty)"[^>]*><\/span>/g;

test('without the E-1 methods none of the controls is in the DOM and their boxes stay empty', () => {
  for (const capabilities of [REDUCED, WITHOUT_E1, null]) {
    const markup = render(capabilities, WITH_DEVICE, { state: ON, snapshot: withLocators('768000', '1152000') });
    for (const id of ['transport-cycle', 'transport-click', 'transport-metronome', 'display-locators']) {
      assert.ok(!markup.includes(`data-testid="${id}"`) && !markup.includes(`data-part="${id}"`), `${id} absent`);
    }
  }
  // With the rest of the transport there, three empty boxes hold the places.
  const markup = render(WITHOUT_E1, WITH_DEVICE, { state: ON, snapshot: withLocators('768000', '1152000') });
  const holds = [...markup.matchAll(HOLDS)].map((m) => m[0]);
  assert.deepEqual(
    holds.map((h) => /class="([^"]+)"/.exec(h)![1]),
    ['transport-hold transport-hold-tbtn', 'cell display-locators-empty', 'transport-hold transport-hold-tgroup'],
  );
  for (const hold of holds) {
    assert.match(hold, /aria-hidden="true"/, hold);
    assert.ok(!/\b(role|tabindex|data-part|data-testid|title|aria-label)=/.test(hold), hold);
  }
  // Each sits where the mockup draws its part: the cycle's between start and stop,
  // the locators' between the display and the tempo, the click's after the tempo.
  const at = (needle: string) => markup.indexOf(needle);
  const [cycle, locators, clickHold] = [...markup.matchAll(HOLDS)].map((m) => m.index!);
  assert.ok(at('data-part="transport-start"') < cycle! && cycle! < at('data-part="transport-stop"'));
  assert.ok(at('data-part="display"') < locators! && locators! < at('data-part="display-tempo"'));
  assert.ok(at('data-part="display-tempo"') < clickHold!);
});

test('the empty boxes take their size from the shell\'s rules: the button\'s rule, and --display-locators-empty-w', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  // The rule whose selector line (outside comments) names the class.
  const rule = (selector: RegExp) => {
    const lines = css.replace(/\/\*[^]*?\*\//g, '').split(/\r?\n/);
    const at = lines.findIndex((line) => selector.test(line) && line.includes('{'));
    assert.ok(at >= 0, `a rule for ${selector}`);
    const rest = lines.slice(at).join('\n');
    return { selector: rest.slice(0, rest.indexOf('{')), body: rest.slice(rest.indexOf('{') + 1, rest.indexOf('}')) };
  };
  // A .tbtn's box (ui/top-bar.css: --transport-w by --transport-h).
  const tbtn = rule(/^\.transport-hold-tbtn \{/);
  assert.match(tbtn.body, /width:\s*var\(--transport-w\)/);
  assert.match(tbtn.body, /height:\s*var\(--transport-h\)/);
  // A .tgroup's around one .tbtn: its padding inside, and its border as a
  // transparent hairline outside the width, so it rounds to device pixels as
  // the .tgroup's and the .lcd's borders do (at 150 % a 1 px border is 2/3 px).
  const frame = rule(/^\.transport-hold-tgroup \{/);
  assert.match(frame.body, /box-sizing:\s*content-box/);
  assert.match(frame.body, /border:\s*var\(--hairline\) solid transparent/);
  const tgroup = rule(/^\.transport-hold-tgroup \{/);
  assert.match(tgroup.body, /width:\s*calc\(var\(--transport-w\) \+ 2 \* var\(--space-3q\)\)/);
  assert.match(tgroup.body, /height:\s*calc\(var\(--transport-h\) \+ 2 \* var\(--space-3q\)\)/);
  // The locator cell: an empty .cell of the display's one .lcd (its border-right
  // is the mockup's), --display-locators-empty-w wide, and the cell's least width.
  assert.match(rule(/^\.display-locators-empty \{/).body, /width:\s*var\(--display-locators-empty-w\)/);
  assert.match(rule(/^\.lcd \.cell\[data-part="display-locators"\] \{/).body, /min-width:\s*var\(--display-locators-empty-w\)/);
  assert.doesNotMatch(css, /\.transport-locators/);
});

test('with full capabilities and no locators the locator cell is the empty box; with locators it reads bars and beats', () => {
  const none = render(FULL, WITH_DEVICE, { state: OFF, snapshot: sampleSnapshot() });
  assert.ok(!none.includes('data-part="display-locators"'));
  assert.ok(none.includes('<span class="cell display-locators-empty" aria-hidden="true"></span>'));
  // 120 BPM at 48 kHz: bars 9.1 and 13.1.
  const set = render(FULL, WITH_DEVICE, { state: OFF, snapshot: withLocators(String(8 * 96000), String(12 * 96000)) });
  const cell = tag(set, 'display-locators');
  assert.ok(cell.includes('data-part="display-locators"'));
  assert.ok(set.includes('>9<em>.</em>1 <em>\u2013</em> 13<em>.</em>1<'), set);
  // The mockup's markup: an .lcd .cell with a .lbl over a .val.sm.
  assert.match(cell, /^<div class="cell"/);
  // One .lcd: the locator cell sits between the time and the tempo, with no wrapper of its own.
  assert.ok(!set.includes('transport-locators'), set);
  const where = (part: string) => set.indexOf(`data-part="${part}"`);
  assert.ok(where('display-time') < where('display-locators') && where('display-locators') < where('display-tempo'));
  assert.ok(set.includes('<span class="lbl" aria-hidden="true">Locators</span><span class="val sm" data-testid="display-locators-value">'), set);
  assert.ok(!set.includes('display-locators-empty'));
  // Across a tempo change: 60 BPM from bar 3, a beat is 1 s.
  const base = sampleSnapshot();
  const tempo = [
    { ticks: '0', milliBpm: 120000 },
    { ticks: String(2 * 7680), milliBpm: 60000 },
  ];
  const slow = { ...base, root: { ...base.root!, tempo } };
  const changed = render(FULL, WITH_DEVICE, { state: OFF, snapshot: withLocators('192000', String(192000 + 5 * 48000), slow) });
  assert.ok(changed.includes('>3<em>.</em>1 <em>\u2013</em> 4<em>.</em>2<'), changed);
});

test('the metronome\'s level control: a fader from -60 to 0 dB showing the engine\'s level', () => {
  const markup = renderToStaticMarkup(<ClickLevel gainMilliDb={-24000} x={10} y={20} onChoose={() => undefined} onClose={() => undefined} />);
  const group = tag(markup, 'click-level');
  assert.ok(group.includes(`aria-label="${translator('en')('transport.clickLevel')}"`));
  const input = tag(markup, 'click-level-input');
  assert.match(input, /type="range"/);
  assert.match(input, /min="-60"/);
  assert.match(input, /max="0"/);
  assert.match(input, /value="-24"/);
  assert.ok(markup.includes('-24 dB'));
});

test('a right-click on the metronome opens its level (the button handles contextmenu)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'shell', 'Transport.tsx'), 'utf8');
  const button = source.slice(source.indexOf('data-part="transport-metronome"'), source.indexOf('</button>', source.indexOf('data-part="transport-metronome"')));
  assert.match(button, /onContextMenu=\{[^]*preventDefault\(\)[^]*setLevel\(/);
  assert.match(source, /<ClickLevel [^>]*onChoose=\{\(value\) => void loopClick\.setClickLevel\(value\)\}/);
});
