// The input selector's choices (m5b-ui-recording; UI redesign 3.5;
// docs/schemas/protocol-engine-v0.md, "Recording": a track's input is
// {port, channels}, port the first device input channel (0-based), channels
// 1 or 2): an open input of N channels gives N mono ports and floor(N / 2)
// stereo pairs on even ports, labelled as the mockup labels its In row
// ("Mono In 1"); a choice is one track.set_input; a track input beyond the
// open input is shown as unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translator } from '../../src/renderer/i18n/t';
import { inputAvailable, inputCommand, inputLabel, inputPorts, portKey, portOfKey } from '../../src/renderer/model/input-ports';

test('N channels give N mono ports and floor(N / 2) stereo pairs', () => {
  assert.deepEqual(inputPorts(2), [
    { port: 0, channels: 1 },
    { port: 1, channels: 1 },
    { port: 0, channels: 2 },
  ]);
  const five = inputPorts(5);
  assert.equal(five.filter((p) => p.channels === 1).length, 5);
  assert.deepEqual(five.filter((p) => p.channels === 2).map((p) => p.port), [0, 2]);
  assert.deepEqual(inputPorts(1), [{ port: 0, channels: 1 }]);
  assert.deepEqual(inputPorts(0), []);
  assert.deepEqual(inputPorts(Number.NaN), []);
});

test('labels: the mockup\'s "Mono In 1", a stereo pair, no input, and an unavailable input', () => {
  const t = translator('en');
  assert.equal(inputLabel({ port: 0, channels: 1 }, 2, t), 'Mono In 1');
  assert.equal(inputLabel({ port: 2, channels: 2 }, 4, t), 'Stereo In 3/4');
  assert.equal(inputLabel(null, 2, t), t('input.none'));
  assert.equal(inputLabel({ port: 2, channels: 2 }, 2, t), t('input.unavailable', { input: 'Stereo In 3/4' }));
  // No input open: every set input is unavailable.
  assert.equal(inputLabel({ port: 0, channels: 1 }, null, t), t('input.unavailable', { input: 'Mono In 1' }));
  const zh = translator('zh-Hant');
  assert.notEqual(inputLabel({ port: 0, channels: 1 }, 2, zh), 'Mono In 1');
});

test('available: port + channels within the open input', () => {
  assert.equal(inputAvailable({ port: 1, channels: 1 }, 2), true);
  assert.equal(inputAvailable({ port: 1, channels: 2 }, 2), false);
  assert.equal(inputAvailable({ port: 0, channels: 2 }, 2), true);
  assert.equal(inputAvailable({ port: 0, channels: 1 }, null), false);
  assert.equal(inputAvailable(null, 2), true);
});

test('a choice is one track.set_input {port, channels} or null; keys round-trip', () => {
  assert.deepEqual(inputCommand('trk_1', { port: 1, channels: 1 }), { op: 'track.set_input', trackId: 'trk_1', input: { port: 1, channels: 1 } });
  assert.deepEqual(inputCommand('trk_1', null), { op: 'track.set_input', trackId: 'trk_1', input: null });
  for (const port of [null, { port: 0, channels: 1 as const }, { port: 2, channels: 2 as const }]) assert.deepEqual(portOfKey(portKey(port)), port);
  assert.equal(portOfKey('garbage'), null);
  assert.notEqual(portKey({ port: 0, channels: 1 }), portKey({ port: 0, channels: 2 }));
});
