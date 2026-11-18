// Studio Setup (m5b-ui-project; UI redesign UR-4, criterion F; Protocol
// engine v0, engine.devices, engine.select_device, engine.status): the
// devices with their input and output channel counts, the selection of the
// output and the input through engine.select_device, and the running
// device's sample rate, buffer, input and output latency and whether
// device-side SRC is active (the device's rate against the session's). A
// refused selection shows the engine's code, and the dialog then selects the
// previous device again (the engine.devices entry marked current, with the
// input engine.status names), unless no device ran. Absent on an engine that
// does not list engine.devices and engine.select_device (UI redesign 3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { parseEngineStatus, type EngineStatus, type EngineStatusSource } from '../../src/renderer/model/engine-status';
import { ProtocolError } from '../../src/renderer/model/session-client';
import { StudioSetupController, initialOutput, parseDevices, setupFields, studioSetupAvailable } from '../../src/renderer/model/studio-setup';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { StudioSetup } from '../../src/renderer/shell/StudioSetup';

const CAPS: Capabilities = { methods: ['engine.devices', 'engine.select_device', 'engine.status'] };
const DEVICES = {
  devices: [
    { id: 'fake', type: 'fake', name: 'fake', isDefault: false, current: true, inputChannels: 2, outputChannels: 2 },
    { id: 'Windows Audio/Speakers', type: 'Windows Audio', name: 'Speakers', isDefault: true, current: false, inputChannels: null, outputChannels: null },
    { id: 'Windows Audio/Microphone', type: 'Windows Audio', name: 'Microphone', isDefault: false, current: false, inputChannels: null, outputChannels: 0 },
  ],
};
const RUNNING = parseEngineStatus({
  device: {
    id: 'default',
    sampleRate: 44100,
    bufferFrames: 256,
    inputLatencyFrames: 441,
    outputLatencyFrames: 882,
    input: { id: 'fake', channels: 2, latencyFrames: 441 },
  },
  deviceError: null,
  xruns: '0',
});
const NONE = parseEngineStatus({ device: null, deviceError: { code: 'device_open_failed', message: 'held' }, xruns: '0' });

function fixedStatus(status: EngineStatus | null): EngineStatusSource {
  return { getSnapshot: () => status, subscribe: () => () => undefined };
}

function scripted(answers: Record<string, unknown>) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sent,
    request(method: string, params: Record<string, unknown>): Promise<unknown> {
      sent.push({ method, params });
      const answer = answers[method];
      if (typeof answer === 'function') {
        const value = (answer as (params: Record<string, unknown>) => unknown)(params);
        return value instanceof ProtocolError ? Promise.reject(value) : Promise.resolve(value);
      }
      return answer instanceof ProtocolError ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

test('engine.status carries the open input (m5b-engine-record): id, channels and latency', () => {
  assert.deepEqual(RUNNING!.device!.input, { id: 'fake', channels: 2, latencyFrames: 441 });
  const noInput = parseEngineStatus({ device: { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 0, outputLatencyFrames: 0, input: null } });
  assert.equal(noInput!.device!.input, null);
});

test('the devices parse with their channel counts, null where unknown', () => {
  const devices = parseDevices(DEVICES);
  assert.deepEqual(devices.map((d) => [d.id, d.inputChannels, d.outputChannels, d.current]), [
    ['fake', 2, 2, true],
    ['Windows Audio/Speakers', null, null, false],
    ['Windows Audio/Microphone', null, 0, false],
  ]);
  assert.deepEqual(parseDevices({ devices: [{ id: 7 }, null, 'x'] }), []);
  assert.deepEqual(parseDevices(null), []);
});

test('the rows show each device with its input and output counts, unknown where the engine says null', async () => {
  const controller = new StudioSetupController({ client: scripted({ 'engine.devices': DEVICES }), status: fixedStatus(RUNNING), locale: () => 'en' });
  await controller.load();
  const t = translator('en');
  const markup = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={CAPS}>
      <StudioSetup open={false} controller={controller} engineStatus={fixedStatus(RUNNING)} sessionRate={48000} onClose={() => undefined} />
    </CapabilitiesContext.Provider>,
  );
  assert.match(markup, /<dialog[^>]*class="studio-setup"[^>]*data-testid="studio-setup"/);
  assert.ok(markup.includes(t('setup.title')));
  const row = (id: string) => {
    const at = markup.indexOf(`data-testid="setup-device-${id}"`);
    assert.ok(at >= 0, `row ${id}`);
    return markup.slice(at, markup.indexOf('</tr>', at));
  };
  assert.match(row('fake'), /data-testid="setup-inputs">2</);
  assert.match(row('fake'), /data-testid="setup-outputs">2</);
  assert.ok(row('Windows Audio/Speakers').includes(`data-testid="setup-inputs">${t('setup.unknown')}<`));
  assert.ok(row('Windows Audio/Microphone').includes('data-testid="setup-outputs">0<'));
  // The output list leaves out an input-only device; the input list has None and every device with inputs.
  const output = markup.slice(markup.indexOf('data-testid="setup-output"'), markup.indexOf('</select>', markup.indexOf('data-testid="setup-output"')));
  assert.ok(output.includes('value="fake"') && output.includes('value="Windows Audio/Speakers"') && !output.includes('Microphone'));
  const input = markup.slice(markup.indexOf('data-testid="setup-input"'), markup.indexOf('</select>', markup.indexOf('data-testid="setup-input"')));
  assert.ok(input.includes('value=""') && input.includes('value="Windows Audio/Microphone"'));
});

test('the status: sample rate, buffer, input and output latency from engine.status; SRC active iff the device rate is not the session\'s', () => {
  const t = translator('en');
  const fields = setupFields(RUNNING, 48000, t)!;
  assert.equal(fields.sampleRate, t('setup.rateValue', { hz: '44100' }));
  assert.equal(fields.buffer, t('setup.bufferValue', { frames: '256' }));
  assert.equal(fields.inputLatency, t('setup.latencyValue', { frames: '441', ms: '10.0' }));
  assert.equal(fields.outputLatency, t('setup.latencyValue', { frames: '882', ms: '20.0' }));
  assert.equal(fields.src, true);
  assert.equal(setupFields(RUNNING, 44100, t)!.src, false);
  assert.equal(setupFields(RUNNING, null, t)!.src, null, 'no session rate known: no claim');
  assert.equal(setupFields(NONE, 48000, t), null, 'no device: no fields');
  const markup = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={CAPS}>
      <StudioSetup open={false} controller={new StudioSetupController({ client: scripted({}), status: fixedStatus(RUNNING), locale: () => 'en' })} engineStatus={fixedStatus(RUNNING)} sessionRate={48000} onClose={() => undefined} />
    </CapabilitiesContext.Provider>,
  );
  assert.ok(markup.includes(`data-testid="setup-src">${t('setup.srcActive')}<`), markup);
  assert.ok(markup.includes(`data-testid="setup-rate">${fields.sampleRate}<`));
});

test('a select sends engine.select_device with the output and the input', async () => {
  const client = scripted({ 'engine.devices': DEVICES, 'engine.select_device': { id: 'fake', sampleRate: 48000 } });
  const controller = new StudioSetupController({ client, status: fixedStatus(RUNNING), locale: () => 'en' });
  await controller.load();
  assert.equal(await controller.select('fake', 'fake'), true);
  assert.equal(await controller.select('Windows Audio/Speakers', null), true);
  assert.deepEqual(client.sent.filter((m) => m.method === 'engine.select_device').map((m) => m.params), [
    { id: 'fake', inputId: 'fake' },
    { id: 'Windows Audio/Speakers' },
  ]);
  assert.equal(controller.getSnapshot().error, null);
});

test('a refusal shows the code, then one select with the previous id and inputId', async () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    let calls = 0;
    const client = scripted({
      'engine.devices': DEVICES,
      'engine.select_device': () => (++calls === 1 ? new ProtocolError('device_open_failed', 'the device is held') : { id: 'fake' }),
    });
    const controller = new StudioSetupController({ client, status: fixedStatus(RUNNING), locale: () => locale });
    await controller.load();
    assert.equal(await controller.select('Windows Audio/Speakers', null), false);
    const selects = client.sent.filter((m) => m.method === 'engine.select_device').map((m) => m.params);
    // The previous device is the current entry (engine.status says `default`, which select_device would answer not_found).
    assert.deepEqual(selects, [{ id: 'Windows Audio/Speakers' }, { id: 'fake', inputId: 'fake' }], locale);
    assert.match(controller.getSnapshot().error ?? '', /^device_open_failed: /, locale);
  }
});

test('with no entry current the output list starts on the default output, else the first, so Apply needs no change event', async () => {
  const notCurrent = (list: ReadonlyArray<Record<string, unknown>>) => ({ devices: list.map((d) => ({ ...d, current: false })) });
  // The current entry wins; without one the default output device; without one the first output.
  assert.equal(initialOutput(parseDevices(DEVICES)), 'fake');
  assert.equal(initialOutput(parseDevices(notCurrent(DEVICES.devices))), 'Windows Audio/Speakers');
  assert.equal(initialOutput(parseDevices(notCurrent(DEVICES.devices.map((d) => ({ ...d, isDefault: false }))))), 'fake');
  // An input-only default is no output.
  assert.equal(initialOutput(parseDevices({ devices: [{ id: 'mic', isDefault: true, outputChannels: 0 }, { id: 'out', outputChannels: 2 }] })), 'out');
  assert.equal(initialOutput([]), '');
  // One output device, not current (no device runs): the shown option is the chosen one, and Apply is live for it.
  const client = scripted({ 'engine.devices': notCurrent([DEVICES.devices[0]]) });
  const controller = new StudioSetupController({ client, status: fixedStatus(NONE), locale: () => 'en' });
  await controller.load();
  const markup = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={CAPS}>
      <StudioSetup open={false} controller={controller} engineStatus={fixedStatus(NONE)} sessionRate={48000} onClose={() => undefined} />
    </CapabilitiesContext.Provider>,
  );
  assert.match(markup, /<option value="fake" selected="">fake<\/option>/, markup);
  assert.match(markup, /<button type="button" data-testid="setup-apply">/, markup);
});

test('nothing is sent back when no device ran', async () => {
  const client = scripted({ 'engine.devices': DEVICES, 'engine.select_device': new ProtocolError('device_open_failed', 'held') });
  const controller = new StudioSetupController({ client, status: fixedStatus(NONE), locale: () => 'en' });
  await controller.load();
  assert.equal(await controller.select('fake', 'fake'), false);
  assert.equal(client.sent.filter((m) => m.method === 'engine.select_device').length, 1);
  assert.match(controller.getSnapshot().error ?? '', /^device_open_failed: /);
});

test('absent on an engine without engine.devices and engine.select_device', () => {
  assert.equal(studioSetupAvailable(capabilitySelector(CAPS)), true);
  assert.equal(studioSetupAvailable(capabilitySelector({ methods: ['engine.devices'] })), false);
  assert.equal(studioSetupAvailable(capabilitySelector({ methods: ['engine.select_device'] })), false);
  const controller = new StudioSetupController({ client: scripted({}), status: fixedStatus(RUNNING), locale: () => 'en' });
  for (const value of [{ methods: ['engine.devices'] }, null]) {
    const markup = renderToStaticMarkup(
      <CapabilitiesContext.Provider value={value}>
        <StudioSetup open controller={controller} engineStatus={fixedStatus(RUNNING)} sessionRate={48000} onClose={() => undefined} />
      </CapabilitiesContext.Provider>,
    );
    assert.equal(markup, '');
  }
});
