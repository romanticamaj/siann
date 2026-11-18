// The insert rack's pure logic (m5b-ui-inserts-master; UI redesign 3.4, 3.0):
// the rack row of a strip holds two slots as the mockup draws it
// (--strip-inserts-h, --insert-slot-h): fewer than two inserts leave empty
// slots in the remaining positions; two or more list every slot in signal
// order and one empty slot after them. The Inspector lists every slot and one
// empty slot. Every empty slot inserts at the end of the chain. A slot's state
// is engine.status plugins[]'s, with the engine's code. The capability gate is
// one helper: features.plugins with plugin.instantiate and plugin.registry;
// each button has its own method or command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buttonsListed, insertIndex, inspectorRows, pluginsListed, rackRows, slotState } from '../../src/renderer/mixer/inserts';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { parseEngineStatus } from '../../src/renderer/model/engine-status';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');

const slot = (slotId: string) => ({ kind: 'slot', slotId });
const EMPTY = { kind: 'empty' };

test('rackRows: two positions, empty slots fill them; two or more slots are all listed, then one empty slot', () => {
  assert.deepEqual(rackRows([]), [EMPTY, EMPTY]);
  assert.deepEqual(rackRows(['slt_1']), [slot('slt_1'), EMPTY]);
  assert.deepEqual(rackRows(['slt_1', 'slt_2']), [slot('slt_1'), slot('slt_2'), EMPTY]);
  assert.deepEqual(rackRows(['slt_5', 'slt_1', 'slt_3', 'slt_2', 'slt_4']), [...['slt_5', 'slt_1', 'slt_3', 'slt_2', 'slt_4'].map(slot), EMPTY], 'signal order, not id order');
  assert.deepEqual(rackRows(undefined), [EMPTY, EMPTY], 'a track without inserts');
});

test('inspectorRows: every slot without a limit, then one empty slot', () => {
  assert.deepEqual(inspectorRows([]), [EMPTY]);
  assert.deepEqual(inspectorRows(['slt_1']), [slot('slt_1'), EMPTY]);
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual(inspectorRows(many), [...many.map(slot), EMPTY]);
});

test('an empty slot inserts at the end of the chain', () => {
  assert.equal(insertIndex(undefined), 0);
  assert.equal(insertIndex([]), 0);
  assert.equal(insertIndex(['slt_1']), 1);
  assert.equal(insertIndex(['slt_1', 'slt_2', 'slt_3']), 3);
});

test('slotState: engine.status plugins[] by slot, running or missing with the engine\'s code; unknown without a row', () => {
  const status = parseEngineStatus({
    device: null,
    xruns: '0',
    plugins: [
      { slotId: 'slt_1', trackId: 'trk_1', format: 'clap', uid: 'u1', state: 'running' },
      { slotId: 'slt_2', trackId: 'trk_1', format: 'clap', uid: 'u2', state: 'missing', error: { code: 'plugin_not_approved', message: 'org.x is not approved' } },
    ],
  });
  assert.deepEqual(slotState(status, 'slt_1'), { state: 'running', error: null });
  assert.deepEqual(slotState(status, 'slt_2'), { state: 'missing', error: { code: 'plugin_not_approved', message: 'org.x is not approved' } });
  assert.deepEqual(slotState(status, 'slt_3'), { state: 'unknown', error: null });
  assert.deepEqual(slotState(null, 'slt_1'), { state: 'unknown', error: null });
});

test('the capability gate: features.plugins and plugin.instantiate and plugin.registry; each button by its own method or command', () => {
  assert.equal(pluginsListed(capabilitySelector(FULL)), true);
  assert.equal(pluginsListed(capabilitySelector(read('capabilities-no-plugins.json'))), false);
  assert.equal(pluginsListed(capabilitySelector({ ...FULL, methods: FULL.methods!.filter((m) => m !== 'plugin.instantiate') })), false);
  assert.equal(pluginsListed(capabilitySelector({ ...FULL, methods: FULL.methods!.filter((m) => m !== 'plugin.registry') })), false);
  assert.equal(pluginsListed(capabilitySelector(null)), false);
  assert.deepEqual(buttonsListed(capabilitySelector(FULL)), { bypass: true, edit: true, remove: true, approve: true });
  const less = capabilitySelector({
    ...FULL,
    commands: FULL.commands!.filter((c) => c !== 'plugin.set_bypass'),
    methods: FULL.methods!.filter((m) => m !== 'plugin.close_editor' && m !== 'plugin.approve'),
  });
  assert.deepEqual(buttonsListed(less), { bypass: false, edit: false, remove: true, approve: false });
  assert.equal(buttonsListed(capabilitySelector({ ...FULL, commands: FULL.commands!.filter((c) => c !== 'plugin.remove') })).remove, false);
});
