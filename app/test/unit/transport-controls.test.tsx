// The transport bar (m5-ui-transport; UI redesign spec 3.0, 3.1): start/stop,
// stop and go-to-start buttons, the position display and auto-scroll in the
// top bar. With no audio device (engine.status device null) the controls
// work in this build but not in this state, so they are disabled and their
// tooltip names the reason: the device error's code in front of the
// catalog's text, in every locale. An engine whose capabilities do not list
// transport.play, transport.stop and transport.locate gets no transport at
// all (rule 3.0, through shell/Capable.tsx). Rendered with react-dom/server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { LOCALES } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';
import { CommandRegistry } from '../../src/renderer/keys/commands';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { parseEngineStatus, type EngineStatus, type EngineStatusSource } from '../../src/renderer/model/engine-status';
import { SessionClient } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { TimeFormatMenu, Transport, transportAvailability } from '../../src/renderer/shell/Transport';

// dist/test/unit -> app/test/unit/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

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

function client(): SessionClient {
  return new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
  });
}

function render(capabilities: Capabilities | null, status: EngineStatus | null): string {
  const session = client();
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
  // The position display and auto-scroll are there, the display's tooltip says bars are 4/4.
  assert.ok(tag(markup, 'position-display').includes(`title="${translator('en')('transport.fourFour')}"`));
  tag(markup, 'position-primary');
  tag(markup, 'position-secondary');
  tag(markup, 'auto-scroll');
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
